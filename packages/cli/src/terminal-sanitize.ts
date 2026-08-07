const ESC = 0x1b;
const BEL = 0x07;
const C1_DCS = 0x90;
const C1_SOS = 0x98;
const C1_CSI = 0x9b;
const C1_ST = 0x9c;
const C1_OSC = 0x9d;
const C1_PM = 0x9e;
const C1_APC = 0x9f;

function consumeCsi(value: string, offset: number): number {
  let cursor = offset;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code >= 0x40 && code <= 0x7e) {
      return cursor + 1;
    }
    if (code >= 0x20 && code <= 0x3f) {
      cursor += 1;
      continue;
    }
    // The sequence is malformed. Leave the invalid character for the main
    // scanner so printable text and normalized newlines are not swallowed.
    return cursor;
  }
  return cursor;
}

function consumeControlString(value: string, offset: number, allowBell: boolean): number {
  let cursor = offset;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (allowBell && code === BEL) {
      return cursor + 1;
    }
    if (code === C1_ST) {
      return cursor + 1;
    }
    if (code === ESC && value.charCodeAt(cursor + 1) === 0x5c) {
      return cursor + 2;
    }
    cursor += 1;
  }
  // An unterminated control string owns the remaining input. Dropping the
  // tail is safer than exposing a partial OSC/DCS payload as terminal text.
  return cursor;
}

function consumeEscape(value: string, offset: number): number {
  const nextOffset = offset + 1;
  if (nextOffset >= value.length) {
    return value.length;
  }

  const next = value.charCodeAt(nextOffset);
  if (next === 0x5b) return consumeCsi(value, nextOffset + 1); // CSI: ESC [
  if (next === 0x5d) return consumeControlString(value, nextOffset + 1, true); // OSC: ESC ]
  if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
    // DCS, SOS, PM and APC are all terminated by ST.
    return consumeControlString(value, nextOffset + 1, false);
  }
  if (next === 0x5c) return nextOffset + 1; // ST: ESC \

  // Other ECMA-48 escape sequences contain zero or more intermediate bytes
  // followed by one final byte. Unknown and private sequences are removed too.
  let cursor = nextOffset;
  while (cursor < value.length) {
    const code = value.charCodeAt(cursor);
    if (code >= 0x20 && code <= 0x2f) {
      cursor += 1;
      continue;
    }
    if (code >= 0x30 && code <= 0x7e) {
      return cursor + 1;
    }
    // ESC followed by a control or non-ASCII character is malformed. Remove
    // only ESC and preserve the following character for normal processing.
    return nextOffset;
  }
  return cursor;
}

/**
 * Convert untrusted text into terminal-safe plain text.
 *
 * All ECMA-48 control sequences and C0/C1 controls are removed. Newlines and
 * tabs are retained, CRLF/lone CR are normalized to LF, and printable Unicode
 * (including Chinese text and emoji) is preserved.
 */
export function sanitizeTerminalText(value: string): string {
  let output = '';
  let offset = 0;

  while (offset < value.length) {
    const code = value.charCodeAt(offset);

    if (code === ESC) {
      offset = consumeEscape(value, offset);
      continue;
    }
    if (code === C1_CSI) {
      offset = consumeCsi(value, offset + 1);
      continue;
    }
    if (code === C1_OSC) {
      offset = consumeControlString(value, offset + 1, true);
      continue;
    }
    if (code === C1_DCS || code === C1_SOS || code === C1_PM || code === C1_APC) {
      offset = consumeControlString(value, offset + 1, false);
      continue;
    }

    if (code === 0x0d) {
      output += '\n';
      offset += value.charCodeAt(offset + 1) === 0x0a ? 2 : 1;
      continue;
    }
    if (code === 0x0a) {
      output += '\n';
      offset += 1;
      continue;
    }
    if (code === 0x09) {
      output += '\t';
      offset += 1;
      continue;
    }

    if (code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f)) {
      offset += 1;
      continue;
    }

    output += value[offset];
    offset += 1;
  }

  return output;
}

/**
 * Hide legacy inline provider credentials before input is rendered or stored.
 * The command itself remains useful in history: recalling it opens the masked
 * credential prompt instead of replaying the previous secret.
 */
export function redactSensitiveCommand(
  value: string,
  replacement = '[API Key 已隐藏]'
): string {
  const match = /^(\s*\/provider\s+set\s+\S+)([\s\S]*)$/iu.exec(value);
  if (!match) return value;
  const args = match[2].trim().split(/\s+/u).filter(Boolean);
  const scopeFlags = args.filter(arg => ['--project', '--global', '--user'].includes(arg.toLowerCase()));
  const hasSecret = args.some(arg => !scopeFlags.includes(arg));
  if (!hasSecret) return value;
  const scopeSuffix = scopeFlags.length > 0 ? ` ${scopeFlags.join(' ')}` : '';
  return replacement ? `${match[1]} ${replacement}${scopeSuffix}` : `${match[1]}${scopeSuffix}`;
}
