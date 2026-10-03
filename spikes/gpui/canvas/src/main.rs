//! GPUI 画布压测 spike(gpui-kit 启动范式)
//!
//! 验证目标(go/no-go 的第一关):
//! 1. N 个带阴影的气泡在满负荷持续重绘下的 FPS(canvas-spike 100 / 1000 / 10000)
//! 2. 拖拽单个气泡是否跟手、无跳变
//! 3. Ctrl+滚轮缩放(光标锚定)、空白处拖拽平移
//! 4. 中文字形渲染是否正常(气泡标签即为中文)
//!
//! 用法:cargo run --release -p canvas-spike -- [气泡数量]

use gpui_kit::*;
use std::time::Instant;

const DEFAULT_COUNT: usize = 120;

struct Bubble {
    x: f32,
    y: f32,
    w: f32,
    h: f32,
    hue: f32,
    label: String,
}

#[derive(Clone, Copy)]
enum DragMode {
    Bubble(usize),
    Pan,
}

struct CanvasApp {
    bubbles: Vec<Bubble>,
    scale: f32,
    pan_x: f32,
    pan_y: f32,
    drag: Option<(DragMode, f32, f32)>,
    frames: u64,
    fps: u64,
    last_tick: Instant,
}

impl CanvasApp {
    fn new(count: usize) -> Self {
        let mut bubbles = Vec::with_capacity(count);
        let mut seed: u64 = 0x2F6E2B1;
        let mut rand = move || {
            seed ^= seed << 13;
            seed ^= seed >> 7;
            seed ^= seed << 17;
            (seed >> 33) as f32 / u32::MAX as f32
        };
        let cols = (count as f32).sqrt().ceil() as usize;
        for i in 0..count {
            bubbles.push(Bubble {
                x: (i % cols) as f32 * 230.0 + rand() * 60.0,
                y: (i / cols) as f32 * 170.0 + rand() * 60.0,
                w: 150.0 + rand() * 80.0,
                h: 90.0 + rand() * 50.0,
                hue: rand() * 360.0,
                label: format!("气泡 {:03}", i),
            });
        }
        Self {
            bubbles,
            scale: 1.0,
            pan_x: 40.0,
            pan_y: 40.0,
            drag: None,
            frames: 0,
            fps: 0,
            last_tick: Instant::now(),
        }
    }

    fn hit_test(&self, sx: f32, sy: f32) -> Option<usize> {
        self.bubbles
            .iter()
            .enumerate()
            .rev()
            .find(|(_, b)| {
                let bx = b.x * self.scale + self.pan_x;
                let by = b.y * self.scale + self.pan_y;
                sx >= bx && sx <= bx + b.w * self.scale && sy >= by && sy <= by + b.h * self.scale
            })
            .map(|(i, _)| i)
    }
}

impl Render for CanvasApp {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // 持续动画帧重绘,FPS 计量的是满负荷持续帧率(不是空闲帧率)
        self.frames += 1;
        let elapsed = self.last_tick.elapsed();
        if elapsed.as_millis() >= 500 {
            self.fps = (self.frames as f64 / elapsed.as_secs_f64()) as u64;
            self.frames = 0;
            self.last_tick = Instant::now();
        }
        window.request_animation_frame();

        let mut root = div()
            .id("canvas")
            .relative()
            .size_full()
            .bg(rgb(0x14161d))
            .font_family("Microsoft YaHei")
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, ev: &MouseDownEvent, _window, _cx| {
                    let (sx, sy) = (ev.position.x.as_f32(), ev.position.y.as_f32());
                    match this.hit_test(sx, sy) {
                        Some(i) => this.drag = Some((DragMode::Bubble(i), sx, sy)),
                        None => this.drag = Some((DragMode::Pan, sx, sy)),
                    }
                }),
            )
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(|this, _ev: &MouseUpEvent, _window, _cx| {
                    this.drag = None;
                }),
            )
            .on_mouse_move(cx.listener(|this, ev: &MouseMoveEvent, _window, cx| {
                if let Some((mode, start_x, start_y)) = this.drag {
                    let (sx, sy) = (ev.position.x.as_f32(), ev.position.y.as_f32());
                    let (dx, dy) = (sx - start_x, sy - start_y);
                    match mode {
                        DragMode::Bubble(i) => {
                            let b = &mut this.bubbles[i];
                            b.x += dx / this.scale;
                            b.y += dy / this.scale;
                        }
                        DragMode::Pan => {
                            this.pan_x += dx;
                            this.pan_y += dy;
                        }
                    }
                    this.drag = Some((mode, sx, sy));
                    cx.notify();
                }
            }))
            .on_scroll_wheel(cx.listener(|this, ev: &ScrollWheelEvent, _window, cx| {
                let (sx, sy) = (ev.position.x.as_f32(), ev.position.y.as_f32());
                let (dx, dy) = match &ev.delta {
                    ScrollDelta::Pixels(d) => (d.x.as_f32(), d.y.as_f32()),
                    ScrollDelta::Lines(l) => (l.x * 32.0, l.y * 32.0),
                };
                if ev.modifiers.control {
                    let old = this.scale;
                    this.scale = (this.scale * (-dy * 0.1).exp()).clamp(0.2, 4.0);
                    // 缩放锚定在光标处
                    let (wx, wy) = ((sx - this.pan_x) / old, (sy - this.pan_y) / old);
                    this.pan_x = sx - wx * this.scale;
                    this.pan_y = sy - wy * this.scale;
                } else {
                    this.pan_x += dx;
                    this.pan_y += dy;
                }
                cx.notify();
            }));

        for b in &self.bubbles {
            let sx = b.x * self.scale + self.pan_x;
            let sy = b.y * self.scale + self.pan_y;
            root = root.child(
                div()
                    .absolute()
                    .left(px(sx))
                    .top(px(sy))
                    .w(px(b.w * self.scale))
                    .h(px(b.h * self.scale))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded_2xl()
                    .shadow_lg()
                    .bg(Hsla {
                        h: b.hue,
                        s: 0.65,
                        l: 0.55,
                        a: 1.0,
                    })
                    .text_size(px(14.0 * self.scale))
                    .text_color(rgb(0xffffff))
                    .child(b.label.clone()),
            );
        }

        root.child(
            div()
                .absolute()
                .top_4()
                .left_4()
                .px_2()
                .py_1()
                .rounded_md()
                .bg(rgb(0x2b2f3a))
                .text_color(rgb(0x7ee787))
                .text_size(px(12.0))
                .child(format!(
                    "FPS {} | scale {:.2} | bubbles {}",
                    self.fps,
                    self.scale,
                    self.bubbles.len()
                )),
        )
    }
}

fn main() {
    let count: usize = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(DEFAULT_COUNT);
    gpui_kit::application().run(move |cx| {
        gpui_kit::init(cx);
        let bounds = Bounds::centered(None, size(px(1400.), px(900.)), cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                ..Default::default()
            },
            cx,
            |_window, cx| cx.new(|_| CanvasApp::new(count)),
        )
        .expect("open window failed");
    });
}
