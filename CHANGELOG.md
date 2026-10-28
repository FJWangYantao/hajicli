# 更新记录

## 1.5.0（2026-10-28）

1.4.0 之后的第一次版本号同步，覆盖此前累积的全部改动。

### 新功能

- **启动首页重做**：像素 Logo + 光晕 + 星点，启动动效约 1.8 秒后静止（`HAJI_REDUCED_MOTION=1` 关闭）；
  输入卡片、三张入口卡片、会话时间线，空间不够时按固定顺序让步。
  「继续上次」下面一行说明上次停在哪：目标 · 任务进度 · 正在做的那一项。
- **会话目标**：模型用 `setgoal` / `goalfinish` 自动提炼、推进与收尾，侧栏显示进行中的目标。
- **自动 git worktree**：每个新会话可开独立工作树并行；`/resume` 能发现兄弟工作树的会话，
  `/worktree remove` 归档的会话也会出现在列表里（标「已归档」，选中后取回到当前目录继续）。
- **联网检索**：有 DeepSeek key 时优先走官方 Search（失败静默回落公开源）；
  `webfetch` 改为零依赖 HTML → Markdown。
- **费用**：费用日志 / 回合详情 / 请求详情三层页面；DeepSeek 内置单价与峰谷时段同步官方；
  官方检索按次计费（2026-11-01 起 ¥0.005/次）计入 `/cost` 与侧栏。
- **工具展示**：过程段折叠 + 单个工具块二级折叠（点击展开/收起，`/resume` 回放同样可用）；
  write/edit 完成块显示红绿 diff；聊天流内联图片与 `/view`。
- **外观**：浅色终端改近黑正文，`/appearance light|dark` 持久化；ansi256 量化改 Oklab 最近色。
- **Kero 集成**：自报 working / waiting / idle 状态（OSC 7501）与窗口标题（OSC 2）。

### 行为改进

- 编辑后自动验证：只在发现问题时回注诊断；bash 里 `sed -i`、重定向、`tee` 写源码同样触发。
- 经验召回改随用户消息注入，打分改双字分词 + IDF + 分数下限。
- `read`：截断时附剩余符号提纲（默认开启），批量读取按头部开销分配额度、不再整块丢文件；
  新增 `symbol` 参数按名字取定义块（实验中，默认关闭）。
- 工具调用合并：`grep.queries` / `global.patterns` 一次调用覆盖多个目标。
- 斜杠补全候选按终端高度分档，浮层移到输入框外；「回到底部」浮标可点击。
- 流式渲染加前缀行缓存与代码高亮缓存，单帧成本与新增内容成正比。

### 修复

- 中止回合时工具格不再凭空消失；失败或被拒的子代理不再堵死 `taskfinish`。
- 构建后给 bin 入口补执行位，clean 重建后 `haji` 不再报 Permission denied。
- 图片段与选区行号对齐，复制不再错位。

### 开发者

- `index.ts` / `terminal-input.ts` 拆出 `pricing-commands.ts`、`overlay-navigation.ts`、
  `terminal-keys.ts`、`terminal-menu.ts` 与 `PostEditVerifier`；鼠标与帧渲染按阶段拆成小方法。
- `node scripts/ab-run.mjs` 一键跑 A/B（固定任务 × 轮次 × arm 交替），实验记录见 `design/ab/`。
