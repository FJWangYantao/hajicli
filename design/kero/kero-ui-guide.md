# 09 · UI 源码导读：布局 / 配色 / 渲染

> 2026-10-24 建立。Kero 与 mygo 均为公开仓库，本导读基于**与 2.1.13 exe 逐字节对应的
> 精确源码**（build info 锁定）：
>
> | 仓库 | commit | 说明 |
> |---|---|---|
> | `github.com/egoist/kero` | `55e41ee` "Release 2.1.13" | 本体，克隆于 `_src/kero/` |
> | `github.com/egoist/mygo` | `818f07e` | GUI 框架，克隆于 `_src/mygo/` |
>
> 本文取代「从二进制反推 UI」的路线，作为外观/布局/渲染研究的**第一入口**；
> 逆向结论（README、08 §10）此后作独立交叉验证用。

---

## 1. 总体架构：没有"前端"，只有三层 Go

```
Kero.exe
 └─ main 包（_src/kero/*.go）           ← 应用层：窗口组装、侧栏、面板、控件皮肤
     └─ github.com/egoist/mygo
         ├─ ui/                          ← 控件库：flexbox 布局、30+ 控件、主题、动画
         ├─ internal/gpu/d3d11/          ← D3D11 渲染器 + shader.hlsl（单着色器设计）
         ├─ internal/scene, internal/raster ← 场景图 + CPU 软件渲染回退（同一套语义）
         └─ plugins/
             ├─ glass/                   ← 玻璃效果（blur.hlsl + glass.hlsl）
             ├─ terminal/                ← 终端控件 + Ghostty 主题兼容
             └─ updater/                 ← 更新器（HTML/CSS，WebView2，独立配色）
```

**框架哲学**（`mygo/ui/doc.go`，全文 51 行，值得整读）：视图是**状态的函数**，
每帧在主线程重建；控件像 Dear ImGui / egui 那样在构造时取输入；跨帧状态
（焦点、滚动、编辑中文本、动画）**按元素在兄弟间的位置或 Key 保留**。
元素值一帧内有效，不进应用状态。Widgets 取 `Theme.Spacing` 的倍数定尺寸，
全部可换肤（ButtonBase/CheckboxBase/TabsBase 等无皮肤基座 + 皮肤层）。

---

## 2. 布局系统

### 2.1 框架层（mygo/ui）

- **布局模型**：flexbox（`Row`/`Column` + Grow/Shrink/Fill/AlignItems/Gap）与 Grid；
  `MinWidth(0)`/`Shrink(2)`/`Ellipsis("…")` 的组合即"可收缩文本行"惯用法
- **尺寸系统**：`Theme.Spacing`（默认 4pt 网格——间距、内边距、复选框/开关/滑块/
  表格行高全是它的倍数；3 紧凑 5 宽松）+ `Theme.Rem(n)`（跟随 FontSize，同 CSS rem）
- **动画**：`ui.Animation{Duration, Ease: ui.CubicBezier(...)}`，`AnimateTo` 插值
- **控件清单**（`ls mygo/ui/` ≈ 百余文件）：canvas、chart/、richtext、editor、
  colorpicker、combobox、collapsible、date、dragdrop、cellselect（虚拟化大表格）、
  menu、flyout、tooltip……每个都有 `_test.go`，可当文档读

### 2.2 应用层（kero）——布局常量全集

**窗口骨架**（`view.go`）：

| 常量 | 值 | 语义 |
|---|---|---|
| `barMid` | 30 | 标题栏内容居中线：红绿灯、侧栏按钮、面板头都居中于它 |
| `topBar` | 60 | 侧栏的标题栏高 |
| `headerH` | 44 | 卡片头高（`2*(barMid-cardGap)`） |
| `cardGap` | 8 | 卡片周围缝隙（缝隙也能拖动窗口） |
| `rowH` / `rowInset` | 34 / 12 | 侧栏行高 / 行文字起点 |

**侧栏显隐动画**（`view.go` chrome 机制，设计注释极精彩）：
260ms `CubicBezier(0.25,1,0.5,1)`；**所有位置一次取整为整像素**，注释原文
"rounded apart, they would step at different frames, and a title, their sum,
would shake by a pixel as the spring settles"（分开取整会抖一像素，且特意不用弹簧：
弹簧长尾每帧爬不到一像素，整像素化后变成跳与停）。约 13 帧落定。

**右侧面板**（`side.go`）：默认宽 420、最小 300、给面板区留 360；
diff 并排在面板宽过 **760** 时自动启用。文件头粘性置顶（`stickyH=32`），
下一文件头把它顶走（"as the files of a pull request do"）；
切 base 时旧列表**淡出保留 400ms** 而非闪烁消失；diff 懒加载并发上限 4；
`fileCollapsed`：二进制或改动 >600 行默认折叠。

**分屏**（`panes.go`）：面板间距 `paneGap=8`；布局树 `proto.Layout`
（Leaf/分裂 + Ratio，非法 ratio 回落 0.5）；拖拽标题换位有 **9 宫格落区**
（四边/四角/中央交换）；`zoneAt` 判定"中间=交换，否则吸附最近边"。

**控件皮肤**（`controls.go`，文件头注释：**"as macOS 27 draws its own"**）：
常规控件高 24，弹钮 28（内含 22 圆盘装双向箭头）；菜单内边距 5、条目高 24、
文字起点 22（过了勾选位）；弹钮开菜单时**当前项正对按钮**（macOS 行为）。

### 2.3 布局读法建议

入口链：`view()`（view.go:83，组装 backdrop→侧栏→主卡列→浮层）→
`sidebar()`（view.go）→ `panes()`（panes.go:94，zoom 单 pane 或递归 `layoutNode`）→
`paneCard()` → `paneTerminal()`。右侧面板：`sidePanel()`（side.go:145）→
`changesView()`（side.go:229，最有研究价值的一个函数，状态管理教科书）。

---

## 3. 配色系统（详见 08 §10 源码校验，此处只给索引）

| 层 | 源文件 | 要点 |
|---|---|---|
| ① 应用外观 | `kero/theme.go` | `lightPalette`/`darkPalette` 30+ 语义字段带设计注释；`washTable` 五背景（rex 显示名 "Petal"）双套渐变+225° 辉光，Oklab 插值；vibrancy 时 alpha 0.95/0.82 |
| ② 终端 | 同上 + `mygo/plugins/terminal/` | "kero" 主题=Apple 系统色微调（浅/深两套 16 色）；`theme.go` 有 VS Code/经典 Win 控制台两套兜底；`ghostty_themes.go` 兼容 Ghostty 全生态 |
| ③ 主机色 | `kero/hosts_color.go` | 8 色 × 浅/深两档；auto=FNV-1a(小写主机名)%8；本机用 textMuted 灰 |
| ④ 代码高亮 | `mygo/ui/editor/theme.go` 等 | Theme 继承解析（`resolve`），未暴露给用户 |

**框架默认主题**（`mygo/ui/theme.go`，Kero 未直接用它而是 SetTheme 覆盖）：
一套 **Tailwind 值**——浅色 `#ffffff/#f4f4f5(zinc-100)/#18181b(zinc-900)/#2563eb(blue-600)`，
深色 `#18181b(zinc-900)/#27272a(zinc-800)/#3b82f6(blue-500)`。
08 §1.5 识别出的"Tailwind 标准值"正是这层——**归因正确，归属是框架默认主题**。

---

## 4. 渲染系统（D3D11，单着色器设计）

### 4.1 核心思想（`shader.hlsl` 文件头注释）

**整个场景的每个绘制操作 = 一个实例化四边形**；像素着色器用**有向距离场（SDF）**
现场计算圆角矩形/边框/渐变/条纹/阴影的覆盖率——与 CPU 软件渲染器
（`internal/raster`）同一套语义。颜色是**直 alpha（非预乘）**、
**在 sRGB 空间混合"as in browsers"**，配双源混合输出每通道源 alpha——亚像素字形需要。

### 4.2 shader.hlsl（606 行）要点

- `Inst` 实例结构：rect/radii/inner/color/color2/border/grad/uv/clip/transform×3/params，
  3×3 投影变换支持**透视**（perspectiveCoverage 按 4×4 采样 SDF）
- `sdRoundRect`：经典圆角矩形 SDF；`rectCoverage` 方角区**精确像素面积**、圆角区距离
- `textCoverage`：**Direct2D 风格文字混合**——按文字颜色深浅增强对比度 + gamma 校正
  （注释：enhances the contrast, the more the darker c is）
- `subpixelCoverage`：亚像素三通道版（RGB 各自覆盖率，双源混合目标）
- `boxShadow`：**Evan Wallace 的精确圆角盒模糊**——x 向用 erf 解析积分、
  y 向 4 采样（注释原文标注出处）
- `oklab/fromOklab`：完整 Oklab 变换；`stopsAt` 渐变停靠点支持 **sRGB 或 Oklab 插值**
  （washTable 的 `Oklab: true` 在这里落地）
- `paint` 的 7 种模式：纯色/线性 sRGB/线性 Oklab/条纹/stops 线性/stops 锥形(含 Oklab)
- `dash`：虚线边框，奇数段等长（约 3 倍边宽），**乘回校验**修补 GPU 除法不精确
- `passvs/downps/blurps`：效果的背景计算 pass——方块降采样 + 可分离高斯

### 4.3 effect.hlsl + 玻璃插件

- `effect.hlsl`：效果框架的头尾——效果着色器读**背景纹理**（`sampleBackdrop`
  双线性重采样），实现 `effect(p, e)` 即可接入
- `plugins/glass/blur.hlsl`：通用背景模糊——沿两点渐变插值模糊半径，
  `lum + (c-lum)*(1+饱和系数) + 偏移*c.a` 的**亮度基调染色**。
  ⚠️ 这正是 08 §3.2 从二进制字符串里挖出的那行公式——逆向发现与源码逐字吻合
- `plugins/glass/glass.hlsl`：真·玻璃模拟，三个部件：
  - `glassLens`：**斯涅尔折射**（n=1.5，含菲涅尔近似 `/1.118` ）算透镜位移
  - `glassNormal`：圆角盒法线场（圆角放大 1.5 倍）
  - `glassTone`：亮度自适应染色（暗底提亮多、亮底少）
  - 边缘高光：法线与光线方向点积 × 高斯衰减
  - 同一效果在 macOS 走 `glass.metal`（Metal）、无 GPU 走 `pixels.go`（CPU）

### 4.4 渲染读法建议

`shader.hlsl` 文件头 12 行注释 + `ps()` 主函数（463 行起）是两小时能吃透的路径；
配合 `mygo/internal/scene/`（场景图语义）与 `internal/raster/`（CPU 参考实现）对照。

---

## 5. 源码索引（按研究主题）

### 布局
| 文件 | 内容 |
|---|---|
| `mygo/ui/doc.go` | 框架哲学总纲（51 行，必读第一篇） |
| `mygo/ui/base.go` | Element/Context 基座 |
| `mygo/ui/theme.go` | 框架主题 + Spacing/Rem 尺寸系统 |
| `mygo/window.go` `loop.go` | 窗口与帧循环（1815/138 行） |
| `kero/view.go` | 窗口骨架、chrome 动画、侧栏、tooltip/kbd |
| `kero/side.go` | 右侧面板：Changes 视图全套（状态管理范本） |
| `kero/panes.go` | 分屏：布局树、拖拽落区、面板卡 |
| `kero/controls.go` | macOS 风控件皮肤：弹钮/菜单/文本框 |
| `kero/app.go` | App 装配：termThemes/termOptions（含 Padding 16×6） |
| `mygo/ui/` 其余 | 每控件一文件 + 测试，按需查 |

### 配色
| 文件 | 内容 |
|---|---|
| `kero/theme.go` | ①层全部：双 palette、终端双主题、washTable 渐变 |
| `kero/hosts_color.go` | ③层：8 色×2 档、FNV auto、菜单 |
| `mygo/ui/theme.go` | 框架默认主题（Tailwind 值）+ Theme 结构 |
| `mygo/ui/color.go` | 颜色数学：Hex/RGBA/Mix/Alpha |
| `mygo/plugins/terminal/theme.go` | ②层兜底（VS Code + 经典 Win 控制台两套） |
| `mygo/plugins/terminal/ghostty_themes.go` | Ghostty 主题名表与加载 |
| `mygo/ui/editor/theme.go` | ④层代码高亮（resolve 继承链） |
| `kero/internal/settings/settings.go` | 默认值（Appearance/Background/Vibrancy） |

### 渲染
| 文件 | 内容 |
|---|---|
| `mygo/internal/gpu/d3d11/shader.hlsl` | 主着色器：SDF 覆盖率/文字/阴影/Oklab/虚线 + 效果 pass |
| `mygo/internal/gpu/d3d11/effect.hlsl` | 效果框架（背景采样 + effectps） |
| `mygo/plugins/glass/blur.hlsl` | 背景模糊 + 亮度染色（= 08 §3.2 逆向公式） |
| `mygo/plugins/glass/glass.hlsl` | 玻璃：折射透镜 + 法线 + 染色 + 边缘光 |
| `mygo/internal/gpu/d3d11/d3d11.go` 等 | 设备/管线/着色器编译（`go generate` 出 shaders.go） |
| `mygo/internal/scene/`、`internal/raster/` | 场景语义与 CPU 参考实现 |

### 辅助
| 文件 | 内容 |
|---|---|
| `kero/CLAUDE.md`、`mygo/AGENTS.md` | 作者给 AI 的开发说明（设计意图富矿） |
| `kero/plans/` | 开发计划文档 |
| `kero/docs/`、`mygo/docs/`、`mygo/examples/` | 文档与可跑示例 |

---

## 6. 与逆向结论的交叉验证记要

- blur.hlsl 的染色公式与 08 §3.2 从 `.rdata` 挖出的 HLSL 片段**逐字一致**
- `lightTermTheme` 浅色 16 值里 `#d3302f/#22863a/#b08800/#2f5bd8` 确认了
  data/palette.txt 的提取正确，但 08 §1.5 的"GitHub Primer 归因"是同值巧合
  （实为 Apple 系统色微调，见 08 §10.1）
- 框架默认主题的 Tailwind 值（zinc/blue 系）解释了 palette.txt 里另一批值的来源
- `subpixelCoverage`/`glassTone`/`blurSample` 等符号名与报告 §5.1 从函数名推断的
  能力清单完全对应
