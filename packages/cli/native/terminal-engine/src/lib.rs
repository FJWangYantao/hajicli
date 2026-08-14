use napi_derive::napi;
use unicode_segmentation::UnicodeSegmentation;

const ANSI_RESET: &str = "\x1b[0m";

#[napi(object)]
pub struct WrappedAnsiResult {
    pub rows: Vec<String>,
    #[napi(js_name = "activeStyle")]
    pub active_style: String,
}

#[napi(object)]
pub struct AnsiLayoutRow {
    pub ansi: String,
    pub plain: String,
    #[napi(js_name = "startOffset")]
    pub start_offset: u32,
    #[napi(js_name = "endOffset")]
    pub end_offset: u32,
}

#[napi(object)]
pub struct AnsiTextLayout {
    pub rows: Vec<AnsiLayoutRow>,
    pub document: String,
}

fn ansi_sequence_end(bytes: &[u8], start: usize) -> Option<usize> {
    if bytes.get(start) != Some(&0x1b) || bytes.get(start + 1) != Some(&b'[') {
        return None;
    }

    let mut offset = start + 2;
    while matches!(bytes.get(offset), Some(0x30..=0x3f)) {
        offset += 1;
    }
    while matches!(bytes.get(offset), Some(0x20..=0x2f)) {
        offset += 1;
    }
    if matches!(bytes.get(offset), Some(0x40..=0x7e)) {
        Some(offset + 1)
    } else {
        None
    }
}

fn update_active_style(sequence: &str, active_style: &mut String) {
    if !sequence.ends_with('m') {
        return;
    }
    if sequence == "\x1b[m" || sequence == ANSI_RESET {
        active_style.clear();
    } else {
        active_style.push_str(sequence);
    }
}

fn is_zero_width(code_point: u32) -> bool {
    code_point == 0x200d
        || (0x0300..=0x036f).contains(&code_point)
        || (0xfe00..=0xfe0f).contains(&code_point)
        || (0xe0100..=0xe01ef).contains(&code_point)
}

fn is_wide(code_point: u32) -> bool {
    code_point >= 0x1100
        && (code_point <= 0x115f
            || code_point == 0x2329
            || code_point == 0x232a
            || ((0x2e80..=0xa4cf).contains(&code_point) && code_point != 0x303f)
            || (0xac00..=0xd7a3).contains(&code_point)
            || (0xf900..=0xfaff).contains(&code_point)
            || (0xfe10..=0xfe19).contains(&code_point)
            || (0xfe30..=0xfe6f).contains(&code_point)
            || (0xff00..=0xff60).contains(&code_point)
            || (0xffe0..=0xffe6).contains(&code_point)
            || (0x1f300..=0x1faff).contains(&code_point)
            || (0x20000..=0x3fffd).contains(&code_point))
}

fn grapheme_width(grapheme: &str) -> usize {
    let mut all_zero_width = true;
    let mut has_wide = false;
    for character in grapheme.chars() {
        let code_point = character as u32;
        all_zero_width &= is_zero_width(code_point);
        has_wide |= is_wide(code_point);
    }
    if all_zero_width {
        0
    } else if has_wide {
        2
    } else {
        1
    }
}

fn utf16_len(value: &str) -> u32 {
    value.encode_utf16().count().min(u32::MAX as usize) as u32
}

fn push_wrapped_row(rows: &mut Vec<String>, row: &mut String, active_style: &str) {
    row.push_str(ANSI_RESET);
    rows.push(std::mem::take(row));
    row.push_str(active_style);
}

#[napi]
pub fn wrap_ansi(value: String, width: u32, initial_style: Option<String>) -> WrappedAnsiResult {
    let width = width as usize;
    let mut rows = Vec::new();
    let mut active_style = initial_style.unwrap_or_default();
    let mut row = active_style.clone();
    let mut row_width = 0usize;
    let bytes = value.as_bytes();
    let mut offset = 0usize;

    while offset < bytes.len() {
        if bytes[offset] == 0x1b {
            if let Some(end) = ansi_sequence_end(bytes, offset) {
                let sequence = &value[offset..end];
                row.push_str(sequence);
                update_active_style(sequence, &mut active_style);
                offset = end;
                continue;
            }
        }

        let text_end = bytes[offset..]
            .iter()
            .position(|byte| *byte == 0x1b)
            .map_or(bytes.len(), |relative| offset + relative);
        if text_end == offset {
            let character = &value[offset..offset + 1];
            let character_width = grapheme_width(character);
            if row_width + character_width > width && row_width > 0 {
                push_wrapped_row(&mut rows, &mut row, &active_style);
                row_width = 0;
            }
            row.push_str(character);
            row_width += character_width;
            offset += 1;
            continue;
        }

        let raw_text = &value[offset..text_end];
        let normalized_text;
        let text = if raw_text.contains('\r') {
            normalized_text = raw_text.replace('\r', "");
            normalized_text.as_str()
        } else {
            raw_text
        };
        for grapheme in UnicodeSegmentation::graphemes(text, true) {
            if grapheme == "\n" {
                push_wrapped_row(&mut rows, &mut row, &active_style);
                row_width = 0;
                continue;
            }
            let character_width = grapheme_width(grapheme);
            if row_width + character_width > width && row_width > 0 {
                push_wrapped_row(&mut rows, &mut row, &active_style);
                row_width = 0;
            }
            row.push_str(grapheme);
            row_width += character_width;
        }
        offset = text_end;
    }

    row.push_str(ANSI_RESET);
    rows.push(row);
    WrappedAnsiResult { rows, active_style }
}

fn push_layout_row(
    rows: &mut Vec<AnsiLayoutRow>,
    row_ansi: &mut String,
    row_plain: &mut String,
    active_style: &str,
    row_start_offset: u32,
    document_end_offset: u32,
) {
    row_ansi.push_str(ANSI_RESET);
    rows.push(AnsiLayoutRow {
        ansi: std::mem::take(row_ansi),
        plain: std::mem::take(row_plain),
        start_offset: row_start_offset,
        end_offset: document_end_offset,
    });
    row_ansi.push_str(active_style);
}

#[napi]
pub fn layout_ansi_document(value: String, width: u32) -> AnsiTextLayout {
    let width = width as usize;
    let mut rows = Vec::new();
    let mut row_ansi = String::new();
    let mut row_plain = String::new();
    let mut row_width = 0usize;
    let mut active_style = String::new();
    let mut document = String::new();
    let mut document_offset = 0u32;
    let mut row_start_offset = 0u32;
    let bytes = value.as_bytes();
    let mut offset = 0usize;

    while offset < bytes.len() {
        if bytes[offset] == 0x1b {
            if let Some(end) = ansi_sequence_end(bytes, offset) {
                let sequence = &value[offset..end];
                row_ansi.push_str(sequence);
                update_active_style(sequence, &mut active_style);
                offset = end;
                continue;
            }
        }

        let text_end = bytes[offset..]
            .iter()
            .position(|byte| *byte == 0x1b)
            .map_or(bytes.len(), |relative| offset + relative);
        let safe_text_end = if text_end == offset {
            offset + 1
        } else {
            text_end
        };
        let raw_text = &value[offset..safe_text_end];
        let normalized_text;
        let text = if raw_text.contains('\r') {
            normalized_text = raw_text.replace('\r', "");
            normalized_text.as_str()
        } else {
            raw_text
        };

        for grapheme in UnicodeSegmentation::graphemes(text, true) {
            if grapheme == "\n" {
                push_layout_row(
                    &mut rows,
                    &mut row_ansi,
                    &mut row_plain,
                    &active_style,
                    row_start_offset,
                    document_offset,
                );
                row_width = 0;
                document.push('\n');
                document_offset = document_offset.saturating_add(1);
                row_start_offset = document_offset;
                continue;
            }

            let character_width = grapheme_width(grapheme);
            if row_width + character_width > width && row_width > 0 {
                push_layout_row(
                    &mut rows,
                    &mut row_ansi,
                    &mut row_plain,
                    &active_style,
                    row_start_offset,
                    document_offset,
                );
                row_width = 0;
                row_start_offset = document_offset;
            }
            row_ansi.push_str(grapheme);
            row_plain.push_str(grapheme);
            row_width += character_width;
            document.push_str(grapheme);
            document_offset = document_offset.saturating_add(utf16_len(grapheme));
        }
        offset = safe_text_end;
    }

    push_layout_row(
        &mut rows,
        &mut row_ansi,
        &mut row_plain,
        &active_style,
        row_start_offset,
        document_offset,
    );
    AnsiTextLayout { rows, document }
}
