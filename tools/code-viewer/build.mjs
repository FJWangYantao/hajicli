/**
 * 构建交互式源码阅读器 code-viewer.html
 *
 * 用法: node tools/code-viewer/build.mjs
 * 产物: 仓库根目录 code-viewer.html(自包含单文件,离线可用)
 *
 * 注解定义在 ./annotations.mjs:每条 seg 的 at 字段是源码中某一行的
 * 唯一前缀(取该行 trimmed 内容做 includes 匹配,须在文件中首个命中),
 * 构建时解析为 [start, end] 行号区间,段与段之间自动衔接覆盖全文件。
 */
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ANNOTATIONS, OVERVIEW, GROUP_ARCH } from "./annotations.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rel = (p) => join(root, p);
const read = (p) => readFileSync(rel(p), "utf8");

/* ---------- 收集文件清单 ---------- */
function walk(dir, out = []) {
  for (const name of readdirSync(rel(dir))) {
    if (name === "node_modules" || name === "dist" || name === "target") continue;
    const p = `${dir}/${name}`;
    const st = statSync(rel(p));
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const srcFiles = [
  ...walk("packages/core/src"),
  ...walk("packages/plugins/src"),
  ...walk("packages/cli/src"),
];
const nativeFiles = walk("packages/cli/native/terminal-engine")
  .filter((p) => /\.(rs|toml|md)$/.test(p));
const testFiles = walk("packages/cli/test");
const scriptFiles = walk("scripts");
const configFiles = [
  "README.md",
  ".agents/AGENTS.md",
  "package.json",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "biome.json",
  "packages/core/package.json",
  "packages/plugins/package.json",
  "packages/cli/package.json",
  ".github/workflows/ci.yml",
  ".github/workflows/release.yml",
].filter((p) => {
  try {
    statSync(rel(p));
    return true;
  } catch {
    return false;
  }
});

const GROUPS = [
  { name: "CLI · 终端交互层", prefix: "packages/cli/src/", files: srcFiles.filter((p) => p.startsWith("packages/cli/src/")) },
  { name: "Core · 引擎内核", prefix: "packages/core/src/", files: srcFiles.filter((p) => p.startsWith("packages/core/src/")) },
  { name: "Plugins · 工具与模型接入", prefix: "packages/plugins/src/", files: srcFiles.filter((p) => p.startsWith("packages/plugins/src/")) },
  { name: "Rust · 原生终端引擎", prefix: "packages/cli/native/", files: nativeFiles },
  { name: "Tests · 测试", prefix: "packages/cli/test/", files: testFiles },
  { name: "Scripts · 构建脚本", prefix: "scripts/", files: scriptFiles },
  { name: "配置与文档", prefix: "", files: configFiles },
];

/* ---------- 解析注解 → 行号区间 ---------- */
function resolveSegs(path, lines) {
  const ann = ANNOTATIONS[path];
  if (!ann || !ann.segs || ann.segs.length === 0) {
    return [
      {
        title: path.split("/").pop(),
        note: ann && ann.desc ? ann.desc : "（该文件未做分段注解，可结合同目录其他文件与调用方理解。）",
        start: 1,
        end: lines.length,
        tags: [],
      },
    ];
  }
  const starts = ann.segs.map((seg, i) => {
    const idx = lines.findIndex(
      (l) => l.trim().length > 0 && l.trim().includes(seg.at)
    );
    if (idx < 0)
      throw new Error(`注解标记未命中: ${path} 第 ${i + 1} 段 "${seg.at}"`);
    return idx + 1; // 1-based
  });
  for (let i = 1; i < starts.length; i++) {
    if (starts[i] <= starts[i - 1])
      throw new Error(`注解标记顺序错误: ${path} 第 ${i + 1} 段 "${ann.segs[i].at}" (${starts[i]} ≤ ${starts[i - 1]})`);
  }
  if (starts[0] !== 1) {
    // 第一段之前的行(通常是 import 区)并入第一段
    starts[0] = 1;
  }
  return ann.segs.map((seg, i) => ({
    title: seg.title,
    note: seg.note,
    tags: seg.tags || [],
    start: starts[i],
    end: i + 1 < starts.length ? starts[i + 1] - 1 : lines.length,
  }));
}

/* ---------- 组装数据 ---------- */
const files = [];
for (const g of GROUPS) {
  for (const p of g.files.sort()) {
    const content = read(p);
    const lines = content.split(/\r?\n/);
    if (lines[lines.length - 1] === "") lines.pop();
    const ann = ANNOTATIONS[p];
    files.push({
      path: p,
      loc: lines.length,
      desc: ann && ann.desc ? ann.desc : "",
      segs: resolveSegs(p, lines),
      lines,
    });
  }
}

const totalLines = files.reduce((a, f) => a + f.loc, 0);
const totalSegs = files.reduce((a, f) => a + f.segs.length, 0);
const pkgStat = (prefix) => {
  const list = files.filter((f) => f.path.startsWith(prefix));
  return { files: list.length, lines: list.reduce((a, f) => a + f.loc, 0) };
};
const cliStat = pkgStat("packages/cli/src/");
const coreStat = pkgStat("packages/core/src/");
const pluginsStat = pkgStat("packages/plugins/src/");
const nativeStat = pkgStat("packages/cli/native/");

const DATA = {
  meta: {
    title: "HAJI CLI · 源码阅读器",
    generated: new Date().toISOString().slice(0, 10),
    totalFiles: files.length,
    totalLines,
    totalSegs,
    packages: GROUPS.length,
  },
  groups: GROUPS.map((g) => ({ name: g.name, prefix: g.prefix, arch: GROUP_ARCH[g.name] || null })),
  overview: {
    intro: OVERVIEW.intro,
    flow: OVERVIEW.flow,
    packages: [
      { name: "packages/cli", ...cliStat, desc: OVERVIEW.pkgCli, entry: "packages/cli/src/index.ts" },
      { name: "packages/core", ...coreStat, desc: OVERVIEW.pkgCore, entry: "packages/core/src/agent-manager.ts" },
      { name: "packages/plugins", ...pluginsStat, desc: OVERVIEW.pkgPlugins, entry: "packages/plugins/src/index.ts" },
      { name: "native/terminal-engine", ...nativeStat, desc: OVERVIEW.pkgNative, entry: "packages/cli/native/terminal-engine/src/lib.rs" },
      { name: "packages/cli/test", ...pkgStat("packages/cli/test/"), desc: OVERVIEW.pkgTests, entry: "packages/cli/test/agent-manager.test.mjs" },
    ],
  },
  files,
};

/* ---------- 生成 HTML ---------- */
const json = JSON.stringify(DATA).replace(/</g, "\\u003c");
const css = read("tools/code-viewer/style.css");
const js = read("tools/code-viewer/app.js");

const html = `<!DOCTYPE html>
<html lang="zh-CN" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HAJI CLI 源码阅读器</title>
<style>
${css}
</style>
</head>
<body>
<div id="macdesk">
  <div id="macbar">
    <span class="mb-l"><span class="mb-apple">🍎</span><b class="mb-app">源码阅读器</b><span class="mb-menu"><span>文件</span><span>编辑</span><span>视图</span><span>前往</span><span>帮助</span></span></span>
    <span class="mb-r"><span id="mac-clock"></span></span>
  </div>
  <div id="macwin">
    <div id="mactitle">
      <div class="traffic">
        <button class="tl red" id="tl-red" title="收起到程序坞"></button>
        <button class="tl yellow" id="tl-yellow" title="收起到程序坞"></button>
        <button class="tl green" id="tl-green" title="全屏 / 还原"></button>
      </div>
      <div class="mac-doc" id="mac-title">📖 ${DATA.meta.title}</div>
    </div>
    <div id="app">
  <div id="toolbar">
    <span id="logo">📖 HAJI 源码阅读器<span class="sub">v${DATA.meta.generated}</span></span>
    <div id="searchwrap">
      <span class="icon">🔍</span>
      <input id="search" type="text" placeholder="搜索代码 / 注解 / 文件名…（Ctrl+K）" autocomplete="off">
      <span id="search-count"></span><span class="kbd">↵</span>
      <div id="results"></div>
    </div>
    <button class="tbtn" id="btn-mode" title="切换 交错/并排 布局"></button>
    <button class="tbtn" id="btn-dock" title="AI 陪读助手(右侧栏)">🧑‍🏫 陪读</button>
    <button class="tbtn" id="btn-theme"></button>
    <button class="tbtn" id="btn-fs-minus" title="减小代码字号">A-</button>
    <button class="tbtn" id="btn-fs-plus" title="增大代码字号">A+</button>
    <button class="tbtn" id="btn-wrap" title="代码自动换行">⏎ 换行</button>
    <button class="tbtn" id="btn-side" title="收起/展开文件树">▤ 侧栏</button>
    <span id="stats"></span>
  </div>
  <div id="body">
    <div id="sidebar">
      <div id="tree-filter-wrap"><input id="tree-filter" type="text" placeholder="过滤文件名…"></div>
      <div id="tree"></div>
    </div>
    <div id="vsplit" title="拖动调整宽度"></div>
    <div id="main"></div>
    <div id="asplit" title="拖动调整宽度"></div>
    <div id="aidock" class="hidden">
      <div class="ad-head">
        <span class="t">🧑‍🏫 AI 陪读</span>
        <span class="ad-status"></span>
        <button class="tbtn ad-close" title="收起">✕</button>
      </div>
      <div class="ad-thread" id="ad-thread">
        <div class="ad-hint">点击函数或划选代码,在解释面板点「📚 深度理解」送入;底部可继续追问。</div>
      </div>
      <div class="ad-ask">
        <textarea class="ad-q" placeholder="追问这段代码…(Enter 发送)"></textarea>
        <div class="ad-askbtns">
          <button class="tbtn ad-send">发送</button>
          <button class="tbtn ad-stop" style="display:none" title="停止生成">⏹</button>
        </div>
      </div>
    </div>
  </div>
</div>
</div>
<div id="macdock" class="hidden"><button id="macdock-btn" title="恢复窗口">📖</button></div>
</div>
<button id="totop" title="回到顶部">↑</button>
<div id="toast"></div>
<script id="app-data" type="application/json">${json}</script>
<script>
${js}
</script>
</body>
</html>
`;

const outPath = rel("code-viewer.html");
writeFileSync(outPath, html);
console.log(`✓ 已生成 ${outPath}`);
console.log(`  文件 ${files.length} 个 · ${totalLines.toLocaleString()} 行 · 注解段 ${totalSegs} 段 · ${(html.length / 1024 / 1024).toFixed(2)} MB`);
