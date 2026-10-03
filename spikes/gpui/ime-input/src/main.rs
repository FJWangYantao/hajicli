//! GPUI 中文输入法 spike(gpui-kit 启动范式,Root 由 open_window 自动挂载)
//!
//! 验证目标(go/no-go 的第二关,权重最高):
//! 用微软拼音在 Input 组件里输入长中文句子,逐项检查:
//! 1. 组合中(未上屏)文本是否正常显示、光标位置是否正确
//! 2. 候选词窗口是否出现在输入位置附近,而不是屏幕角落/不出现
//! 3. 空格/数字键选词、Enter 上屏英文原文的行为是否符合预期
//! 4. 输入过程中窗口失焦再聚焦,组合状态是否错乱
//! 5. 中英混排、删除组合中文本的行为

use gpui_kit::component::input::{Input, InputState};
use gpui_kit::*;

struct ImeTest {
    input: Entity<InputState>,
}

impl Render for ImeTest {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let input = self.input.clone();
        div()
            .size_full()
            .flex()
            .flex_col()
            .items_center()
            .justify_center()
            .gap_4()
            .bg(rgb(0x14161d))
            .font_family("Microsoft YaHei")
            .child(div().w(px(520.)).child(Input::new(&input)))
            .child(
                div()
                    .text_color(rgb(0x9aa4b2))
                    .text_size(px(13.0))
                    .child("用微软拼音输入长句,观察候选窗位置、组合中文本、空格/Enter 行为"),
            )
    }
}

fn main() {
    gpui_kit::application().run(|cx| {
        gpui_kit::init(cx);
        gpui_kit::open_window(WindowOptions::default(), cx, |window, cx| {
            cx.new(|cx| {
                let input = cx.new(|cx| InputState::new(window, cx));
                ImeTest { input }
            })
        })
        .expect("open window failed");
    });
}
