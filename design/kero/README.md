# design/kero — Kero UI 设计参考库

Kero（`github.com/egoist/kero`，MIT）是 egoist 用 Go + 自研框架 mygo 写的
终端模拟器，视觉风格为「macOS 式卡片 + 玻璃 + 洗墙渐变」。本目录把它
**与 2.1.13 版本逐字节对应的源码设计资产**导入 hajicli，作为 TUI 装修的
设计令牌与参考。

## 来源与许可

| 项 | 值 |
|---|---|
| kero | `github.com/egoist/kero` @ `55e41ee`（Release 2.1.13），MIT © 2026 EGOIST |
| mygo | `github.com/egoist/mygo` @ `818f07e`，MIT © 2026 MyGo contributors |
| 许可证 | `reference/LICENSE-kero`、`reference/LICENSE-mygo`。**取色值/设计参数自由使用；若把 reference/ 下的代码文件编入发布产物，需随附版权与许可声明** |

## 目录

| 文件 | 内容 |
|---|---|
| `kero-tokens.ts` | **主交付物**：Kero 色系映射为 haji 的 `Theme` 接口（`keroDark`/`keroLight`），另附 ANSI 16 色全表、五个背景渐变、主机色、语义状态色 |
| `kero-ui-guide.md` | UI 源码导读（布局/配色/渲染 + 索引；路径基于导出时的工作区，reference/ 内有同名精选文件） |
| `reference/theme.go` | Kero 应用调色板全表（30+ 语义字段带设计注释）、终端双主题、背景渐变表 |
| `reference/hosts_color.go` | 主机色 8×2 + FNV auto 规则 |
| `reference/view.go` / `controls.go` | 布局常量（标题线 30 / 卡片缝 8 / 侧栏 420-300-360 / diff 阈值 760）与 macOS 风控件皮肤 |
| `reference/mygo-ui-theme.go` / `mygo-ui-color.go` | 框架主题（Tailwind 值默认）与颜色数学 |
| `reference/*.hlsl` | 渲染：SDF 单着色器、效果框架、玻璃（折射透镜）、背景模糊（含亮度染色公式） |

## Theme 字段映射表（kero-tokens.ts 的取值依据）

| haji Theme | Kero 深色取值 | 来源 |
|---|---|---|
| `background` | `#232328` | darkPalette.card（终端卡片底；想要洗墙底用 rex 深色 `#17141f`） |
| `userMsgBg` | `#323237` | card 上叠 chip `rgba(255,255,255,0.07)` 的合成值 |
| `foreground` | `#e6e6ea` | darkTermTheme.Foreground |
| `accent` | `#6b93ff` | darkPalette.accent |
| `muted` | `#a9a9b4` | darkPalette.textMuted |
| `red..cyan` | ANSI 1..6 | darkTermTheme.Palette（Apple 系统色微调） |
| `bright*` | ANSI 9,10,11,14 | 同上亮色档 |

浅色同理（`#ffffff` 卡片 / `#1d1d1f` 前景 / `#3b6cf6` accent）。

## 用法

```ts
// packages/cli/src/theme.ts 的内置默认之外，加一套 Kero 皮肤：
import { keroDark, keroLight } from "../../../design/kero/kero-tokens.js";
```

或作为用户/项目级主题写入 `~/.haji/theme.json`（字段同 Theme 接口）。

状态栏渐变可直接用 haji 现成的 `oklab.hexGradient` 喂 `keroWashes.*.dark`
的停靠点——Kero 自己的渐变就是 Oklab 插值（`Oklab: true`），色彩科学同款。

## 设计要点速记（详见 kero-ui-guide.md）

- 同一色相的浅/深两档**不是提亮，是提饱和**（`#d9453b` → `#ff7a70`），保证双底对比
- 文字可读性只锁一个 WCAG 下限（Kero 默认 3:1，haji 的 `ensureContrast` 是 AA，可保持）
- 玻璃染色的核心公式在 `reference/blur.hlsl`：`lum + (c - lum) * (1 + 饱和系数) + 偏移 * c.a`
