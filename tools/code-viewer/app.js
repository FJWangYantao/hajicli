/* HAJI CLI 源码阅读器 — 前端应用(由 tools/code-viewer/build.mjs 内嵌到 code-viewer.html) */
"use strict";

/* ============ 数据 ============ */
const DATA = JSON.parse(document.getElementById("app-data").textContent);
const FILES = DATA.files;
const byPath = new Map(FILES.map((f) => [f.path, f]));

/* ============ 全局状态 ============ */
const state = {
  file: null,
  query: "",
  theme: localStorage.getItem("cv-theme") || "dark",
  mode: localStorage.getItem("cv-mode") || "stack",
  fs: Number(localStorage.getItem("cv-fs") || 0),
  wrap: localStorage.getItem("cv-wrap") === "1",
  sidebarHidden: false,
  collapsed: new Set(JSON.parse(localStorage.getItem("cv-collapsed") || "[]")),
  dirCollapsed: new Set(JSON.parse(localStorage.getItem("cv-dircollapsed") || "[]")),
  floats: [],
};

/* ============ 工具函数 ============ */
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._tm);
  toast._tm = setTimeout(() => t.classList.remove("show"), 1600);
}
function copyText(text) {
  navigator.clipboard
    .writeText(text)
    .then(() => toast("已复制"))
    .catch(() => toast("复制失败"));
}

/* ============ 语法高亮 ============ */
const KW_TS = /^(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|delete|typeof|instanceof|in|of|class|extends|implements|interface|type|enum|declare|namespace|import|from|export|as|default|async|await|try|catch|finally|throw|yield|this|super|static|public|private|protected|readonly|abstract|get|set|satisfies|keyof|infer|is|asserts|void|null|undefined|true|false|never|unknown|any|string|number|boolean|object|symbol|bigint)$/;
const KW_RS = /^(fn|let|mut|pub|impl|use|match|struct|enum|trait|async|await|move|ref|const|unsafe|type|where|dyn|self|Self|crate|mod|extern|as|in|for|if|else|while|loop|break|continue|return|true|false|Some|None|Ok|Err|u8|u16|u32|u64|usize|i8|i16|i32|i64|isize|f32|f64|bool|char|str|String|Vec|Option|Result|Box)$/;
const KW_JSON = /^(true|false|null)$/;
const KW_YAML = /^(true|false|null|yes|no|on|off)$/;
const LANGS = {
  ts: { kw: KW_TS, line: "//", block: true },
  mjs: { kw: KW_TS, line: "//", block: true },
  js: { kw: KW_TS, line: "//", block: true },
  rs: { kw: KW_RS, line: "//", block: true },
  json: { kw: KW_JSON, line: null, block: false, jsonKeys: true },
  yml: { kw: KW_YAML, line: "#", block: false },
  yaml: { kw: KW_YAML, line: "#", block: false },
  md: { kw: null, line: null, block: false },
  sh: { kw: /^(if|then|else|fi|for|do|done|while|case|esac|function|return|export|local|echo|exit)$/, line: "#", block: false },
};
function langOf(path) {
  const m = /\.([a-z]+)$/i.exec(path);
  if (!m) return "txt";
  const ext = m[1].toLowerCase();
  if (ext === "ts") return "ts";
  return ext;
}
/* 单遍扫描式高亮:按 comment > string > number > keyword > type > fn > ident 分组着色 */
function highlightLine(line, lang) {
  const conf = LANGS[lang] || LANGS.ts;
  let out = "";
  let i = 0;
  const n = line.length;
  const push = (cls, text) => (out += cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text));
  while (i < n) {
    const ch = line[i];
    // 行注释
    if (conf.line && ch === "/" && line[i + 1] === "/") { push("com", line.slice(i)); break; }
    if (conf.line === "#" && ch === "#") { push("com", line.slice(i)); break; }
    // 块注释(跨行由调用方 pre-process 处理,这里处理行内剩余部分)
    if (conf.block && ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end >= 0) { push("com", line.slice(i, end + 2)); i = end + 2; }
      else { push("com", line.slice(i)); break; }
      continue;
    }
    // 字符串
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (line[j] === "\\") j += 2;
        else if (line[j] === ch) { j++; break; }
        else j++;
      }
      push("str", line.slice(i, j));
      i = j;
      continue;
    }
    // Rust 生命周期 'a / 字符字面量
    if (lang === "rs" && ch === "'" && /[a-z_]/i.test(line[i + 1] || "") && line[i + 2] === "'") {
      push("str", line.slice(i, i + 3));
      i += 3;
      continue;
    }
    // Rust 属性 #[...] / 宏 name!
    if (lang === "rs" && ch === "#" && line[i + 1] === "[") {
      const end = line.indexOf("]", i + 2);
      const stop = end >= 0 ? end + 1 : n;
      push("attr", line.slice(i, stop));
      i = stop;
      continue;
    }
    // 数字
    if (/[0-9]/.test(ch) && !/[\w$]/.test(line[i - 1] || "")) {
      let j = i;
      while (j < n && /[0-9a-fA-FxXoObB._nmu]/.test(line[j])) j++;
      push("num", line.slice(i, j));
      i = j;
      continue;
    }
    // 标识符 / 关键字
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i;
      while (j < n && /[\w$]/.test(line[j])) j++;
      const word = line.slice(i, j);
      const after = line.slice(j);
      if (conf.kw && conf.kw.test(word)) push("kw", word);
      else if (lang === "rs" && after.startsWith("!")) { push("fn", word + "!"); i = j + 1; continue; }
      else if (/^[A-Z][\w$]*/.test(word) && !after.startsWith("(")) push("typ", word);
      else if (after.startsWith("(")) push("fn", word);
      else if (line[i - 1] === ".") push("op", word);
      else push("", word);
      i = j;
      continue;
    }
    // 其他字符原样
    let j = i;
    while (j < n && !/[A-Za-z0-9_$'"`#]/.test(line[j])) j++;
    if (j === i) j = i + 1;
    push("op", line.slice(i, j));
    i = j;
  }
  return out || "&nbsp;";
}

/* ============ 文件树 ============ */
function groupOf(path) {
  const g = DATA.groups.find((gr) => path.startsWith(gr.prefix));
  return g ? g.name : "其他";
}
/* 组内文件 → 嵌套目录树(剥掉分组前缀,文件只挂 basename) */
function buildDirTree(files, stripPrefix) {
  const root = { dirs: new Map(), files: [] };
  for (const f of files) {
    let rel = f.path;
    if (stripPrefix && rel.startsWith(stripPrefix)) rel = rel.slice(stripPrefix.length).replace(/^\//, "");
    const segs = rel.split("/").filter(Boolean);
    const name = segs.pop();
    let node = root;
    for (const s of segs) {
      if (!node.dirs.has(s)) node.dirs.set(s, { dirs: new Map(), files: [] });
      node = node.dirs.get(s);
    }
    node.files.push({ f, name });
  }
  return root;
}
/* 目录节点内文件总数(递归,用于目录行的数量角标) */
function countFiles(node) {
  let n = node.files.length;
  for (const c of node.dirs.values()) n += countFiles(c);
  return n;
}
/* 递归渲染目录:单链目录压缩为 a/b 一行;折叠时直接不渲染子树 */
function dirRows(node, gName, dirPath, depth, filterActive, forceOpen) {
  let html = "";
  for (const [name, child] of node.dirs) {
    let label = name;
    let sub = child;
    let cPath = dirPath ? dirPath + "/" + name : name;
    while (sub.dirs.size === 1 && sub.files.length === 0) {
      const [n2, c2] = [...sub.dirs][0];
      label += "/" + n2;
      cPath += "/" + n2;
      sub = c2;
    }
    const key = gName + "∣" + cPath;
    const closed = !filterActive && state.dirCollapsed.has(key) && !forceOpen.has(key);
    const pad = 12 + depth * 13;
    html += `<div class="dir-item${closed ? " closed" : ""}" data-dir="${esc(key)}" style="padding-left:${pad}px"><span class="arrow">▾</span><span class="dname">📁 ${esc(label)}</span><span class="cnt">${countFiles(sub)}</span></div>`;
    if (!closed) html += dirRows(sub, gName, cPath, depth + 1, filterActive, forceOpen);
  }
  for (const { f, name } of node.files) {
    const active = f.path === state.file ? " active" : "";
    const star = f.segs && f.segs.length > 1 ? `<span class="star" title="含分段注解">★</span>` : "";
    const hit = filterActive ? " markhit" : "";
    const pad = 12 + depth * 13 + 12;
    html += `<div class="file-item${active}${hit}" data-path="${esc(f.path)}" title="${esc(f.path)} (${f.loc} 行)" style="padding-left:${pad}px">${star}<span class="nm">${esc(name)}</span><span class="loc">${f.loc}</span></div>`;
  }
  return html;
}
function renderTree() {
  const tree = $("#tree");
  const filter = $("#tree-filter").value.trim().toLowerCase();
  const filterActive = Boolean(filter);
  const groups = new Map();
  for (const f of FILES) {
    if (filter && !f.path.toLowerCase().includes(filter)) continue;
    const g = DATA.groups.find((gr) => f.path.startsWith(gr.prefix));
    const name = g ? g.name : "其他";
    if (!groups.has(name)) groups.set(name, { prefix: g ? g.prefix : "", files: [] });
    groups.get(name).files.push(f);
  }
  // 当前打开文件所在目录链强制展开(即使被折叠也能看到 active 文件)
  const forceOpen = new Set();
  if (state.file) {
    const g = DATA.groups.find((gr) => state.file.startsWith(gr.prefix));
    const gName = g ? g.name : "其他";
    let rel = state.file;
    if (g && rel.startsWith(g.prefix)) rel = rel.slice(g.prefix.length).replace(/^\//, "");
    const segs = rel.split("/").filter(Boolean);
    let acc = "";
    for (let i = 0; i < segs.length - 1; i++) {
      acc = acc ? acc + "/" + segs[i] : segs[i];
      forceOpen.add(gName + "∣" + acc);
    }
  }
  let html = "";
  for (const [g, { prefix, files }] of groups) {
    const closed = !filterActive && state.collapsed.has(g) ? " closed" : "";
    const annotated = files.reduce((a, f) => a + (f.segs && f.segs.length > 1 ? 1 : 0), 0);
    html += `<div class="group-h${closed}" data-group="${esc(g)}"><span class="arrow">▼</span>${esc(g)}<span class="cnt">${files.length} 文件${annotated ? ` · ${annotated}★` : ""}</span><button class="ghome" data-group="${esc(g)}" title="打开分组导览页">⌂</button></div>`;
    html += `<div class="group-items">`;
    html += dirRows(buildDirTree(files, prefix), g, "", 0, filterActive, forceOpen);
    html += `</div>`;
  }
  tree.innerHTML = html || `<div style="padding:16px;color:var(--muted)">没有匹配的文件</div>`;
  $$(".group-h", tree).forEach((h) =>
    h.addEventListener("click", () => {
      const g = h.dataset.group;
      if (state.collapsed.has(g)) state.collapsed.delete(g);
      else state.collapsed.add(g);
      localStorage.setItem("cv-collapsed", JSON.stringify([...state.collapsed]));
      renderTree();
    })
  );
  $$(".ghome", tree).forEach((b) =>
    b.addEventListener("click", (e) => {
      e.stopPropagation();
      openGroupHome(b.dataset.group);
    })
  );
  $$(".dir-item", tree).forEach((el) =>
    el.addEventListener("click", () => {
      const k = el.dataset.dir;
      if (state.dirCollapsed.has(k)) state.dirCollapsed.delete(k);
      else state.dirCollapsed.add(k);
      localStorage.setItem("cv-dircollapsed", JSON.stringify([...state.dirCollapsed]));
      renderTree();
    })
  );
  $$(".file-item", tree).forEach((el) =>
    el.addEventListener("click", () => openFile(el.dataset.path))
  );
}

/* ============ 总览页 ============ */
function renderOverview() {
  setMacTitle("📖 " + DATA.meta.title);
  const m = DATA.meta;
  const pkgs = DATA.overview.packages
    .map(
      (p) => `<div class="pkg-card" data-pkg="${esc(p.name)}">
        <h3>${esc(p.name)}</h3><p>${p.desc}</p>
        <div class="meta">${p.files} 个文件 · ${p.lines} 行</div></div>`
    )
    .join("");
  const flow = DATA.overview.flow
    .map((s) => `<div class="flow-step"><span class="no">${s.no}</span><span class="t">${s.t}</span><span class="d">${s.d}</span></div>`)
    .join("");
  $("#main").innerHTML = `<div class="overview">
    <h1>${esc(DATA.meta.title)}</h1>
    <p class="lead">${DATA.overview.intro}</p>
    <div class="stat-row">
      <div class="stat-card"><b>${m.totalFiles}</b><span>源码文件</span></div>
      <div class="stat-card"><b>${m.totalLines.toLocaleString()}</b><span>总行数</span></div>
      <div class="stat-card"><b>${m.totalSegs}</b><span>注解段落</span></div>
      <div class="stat-card"><b>${m.packages}</b><span>包 / 模块</span></div>
    </div>
    <h2>📦 包结构</h2>
    <div class="pkg-grid">${pkgs}</div>
    <h2>🔄 一次对话的生命周期(主数据流)</h2>
    <div class="flow-box">${flow}</div>
    <h2>💡 使用提示</h2>
    <ul class="tips">
      <li><b>划选问 AI</b>:用鼠标划选任意代码,选区旁会浮出 <b>✨ AI 解释</b>——点开可拖动的 AI 助手浮窗。已配置模型(Ollama 本地 / DeepSeek / 火山方舟等 OpenAI 兼容端点,⚙️ 里设置)时流式逐点讲解;未配置时给离线即时分析。</li>
      <li><b>点击代码块直接解释</b>:函数、测试用例、配置段落均自动分块,悬停浅色高亮锁定焦点,单击即弹出该块的一句话功能说明(Markdown 渲染),无需划选。</li>
      <li><b>分组导览</b>:目录树每个分组标题右侧的 <b>⌂</b> 打开该层首页——这层的架构说明、主流程与全部文件的用途卡片,点卡片直达文件;地址栏 <kbd>#g:组名</kbd> 可直达。</li>
      <li><b>AI 陪读助手(右侧栏)</b>:一句话看不懂?在 AI 解释面板点 <b>📚 深度理解</b>,代码上下文与那句话会送入右侧陪读栏,导师分层深讲(职责→逐块逻辑→设计意图);底部输入框可继续追问,顶栏 <b>🧑‍🏫 陪读</b> 随时开关。</li>
      <li><b>悬停看注解</b>:鼠标滑过任意<b>代码块</b>会高亮该块并弹出它的中文注解气泡(停留片刻触发,移开/滚动即消失);悬停<b>函数</b>时整个函数以浅色矩形块选中,便于锁定视觉焦点。</li>
      <li><b>一段源码对应一段注解</b>:每个紫色卡片是下方代码段的中文讲解,点卡片右上角 <b>⛶</b> 可把注解拖出成浮动窗口,随意摆放对照阅读。</li>
      <li><b>搜索</b>:顶部搜索框同时检索 <b>代码、注解、文件名</b>;按 <kbd>Ctrl</kbd>+<kbd>K</kbd> 或 <kbd>/</kbd> 聚焦,结果中 <kbd>↑</kbd><kbd>↓</kbd> 选择、<kbd>Enter</kbd> 跳转。</li>
      <li><b>拖动</b>:拖动左侧树与主区之间的分隔条调整宽度;「并排」模式下可拖动代码/注解分栏;注解卡片可双击标题浮出。</li>
      <li><b>视图</b>:工具栏可切换 <b>交错/并排</b> 布局、明暗主题、字号、自动换行;代码块右上角可折叠/复制。</li>
      <li><b>直达</b>:地址栏哈希(如 <kbd>#packages/cli/src/index.ts</kbd>)可直接打开文件,刷新不丢。</li>
    </ul>
  </div>`;
  $$(".pkg-card").forEach((c) =>
    c.addEventListener("click", () => {
      const pkg = DATA.overview.packages.find((p) => p.name === c.dataset.pkg);
      if (pkg && pkg.entry) openFile(pkg.entry);
    })
  );
}

/* ============ 分组导览页(每一层的首页:架构 + 文件卡片) ============ */
function openGroupHome(name) {
  const gr = DATA.groups.find((x) => x.name === name);
  if (!gr) {
    renderOverview();
    return;
  }
  hideCodetip();
  hoverBox = null;
  state.file = null;
  renderTree();
  setMacTitle("分组导览 · " + name);
  const files = FILES.filter((f) => groupOf(f.path) === name);
  const locs = files.reduce((a, f) => a + f.loc, 0);
  const starred = files.filter((f) => f.segs && f.segs.length > 1).length;
  const arch = gr.arch;
  const flowHtml =
    arch && arch.flow && arch.flow.length
      ? `<div class="gh-flow">${arch.flow
          .map((s, i) => `${i ? '<span class="arr">→</span>' : ""}<span class="step">${esc(s)}</span>`)
          .join("")}</div>`
      : "";
  const cards = files
    .map((f) => {
      const star = f.segs && f.segs.length > 1 ? `<span class="star" title="含分段注解">★</span>` : "";
      const d = f.desc || (f.segs && f.segs[0] ? stripNoteHtml(f.segs[0].note) : "") || "（未注解）";
      return `<div class="gfile" data-path="${esc(f.path)}" title="点击打开 ${esc(f.path)}">
        <div class="fh">${star}<span class="fn">${esc(f.path.split("/").pop())}</span><span class="fl">${f.loc} 行</span></div>
        <div class="fp">${esc(f.path)}</div>
        <div class="fd">${esc(d.slice(0, 220))}${d.length > 220 ? "…" : ""}</div>
      </div>`;
    })
    .join("");
  $("#main").innerHTML = `<div class="group-home">
    <div class="gh-crumb">📖 分组导览</div>
    <h1>${esc(name)}</h1>
    <div class="gh-stats">${files.length} 个文件 · ${locs.toLocaleString()} 行 · ${starred} 个含分段注解</div>
    ${arch && arch.desc ? `<div class="gh-arch"><div class="gh-arch-t">🏗 这一层做什么</div><p>${esc(arch.desc)}</p>${flowHtml}</div>` : ""}
    <div class="gh-arch-t gh-files-t">📄 文件总览(点击卡片进入)</div>
    <div class="gfile-grid">${cards}</div>
  </div>`;
  $$(".gfile").forEach((c) => c.addEventListener("click", () => openFile(c.dataset.path)));
  $("#main").scrollTop = 0;
  location.hash = "g:" + name;
}

/* ============ 代码块渲染 ============ */
/* 函数/方法声明检测:在给定行数组(0-based)内找出声明区间,用于悬停矩形高亮 */
function fnDeclRanges(lines, lang) {
  const ranges = [];
  const fnStart =
    lang === "rs"
      ? /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:const\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+[\w$]/
      : /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*[\w$]*\s*\(|^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?(?:\([^)]*\)|[\w$]+)\s*=>\s*\{|^\s*(?:export\s+)?(?:const|let|var)\s+[\w$]+\s*=\s*(?:async\s*)?function\b|^\s+(?:(?:public|private|protected|static|readonly|override|\*)\s+)*(?:async\s+)?(?:get\s+|set\s+)?[\w$#]+\s*(?:<[^>]*>)?\([^)]*\)\s*:?[^{]*\{/;
  const notFn = /^\s*(?:if|for|while|switch|catch|return|else|do|try)\b/;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.includes("{") && fnStart.test(line) && !notFn.test(line)) {
      // 花括号配对找结束行(限 400 行兜底,防止字符串干扰导致区间失控)
      let depth = 0;
      let end = Math.min(i + 400, lines.length - 1);
      for (let j = i; j < lines.length; j++) {
        for (const ch of lines[j]) {
          if (ch === "{") depth++;
          else if (ch === "}") {
            depth--;
            if (depth === 0) {
              end = j;
              j = lines.length;
              break;
            }
          }
        }
      }
      ranges.push([i, end]);
      i = end + 1;
    } else {
      i++;
    }
  }
  return ranges;
}
/* 测试用例检测:test/it/describe/bench 调用按括号配对成块,让没有函数声明的测试文件也能分块可点 */
function testCallRanges(lines) {
  const re = /^\s{0,8}(?:await\s+)?(?:t\.)?(?:test|it|describe|bench)(?:\.(?:skip|only|todo|slow))?\s*\(/;
  const ranges = [];
  let i = 0;
  while (i < lines.length) {
    if (!re.test(lines[i])) {
      i++;
      continue;
    }
    // 括号配对找语句结束行(限 400 行兜底,防字符串干扰导致区间失控)
    let depth = 0;
    let opened = false;
    let end = Math.min(i + 400, lines.length - 1);
    outer: for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === "(") {
          depth++;
          opened = true;
        } else if (ch === ")") {
          depth--;
          if (opened && depth <= 0) {
            end = j;
            break outer;
          }
        }
      }
    }
    ranges.push([i, end]);
    i = end + 1;
  }
  return ranges;
}
/* 归并两组区间:重叠时外层块优先(被包含的丢弃),交叉的向外扩展 */
function mergeRanges(a, b) {
  const all = [...a, ...b].sort((x, y) => x[0] - y[0] || y[1] - x[1]);
  const out = [];
  for (const r of all) {
    const last = out[out.length - 1];
    if (last && r[0] <= last[1]) {
      if (r[1] > last[1]) last[1] = r[1];
    } else out.push([r[0], r[1]]);
  }
  return out;
}
/* 配置/文档类文件的分段起点:JSON/YAML 顶层键、TOML 段落头、Markdown 标题 */
function sectionStarts(lines, lang) {
  const starts = [];
  if (lang === "json") {
    // 取所有缩进键中最小的缩进,即根对象的顶层键
    let ind = null;
    for (const l of lines) {
      const m = /^(\s+)"[^"]*"\s*:/.exec(l);
      if (m && (ind === null || m[1].length < ind.length)) ind = m[1];
    }
    if (ind === null) return starts;
    const re = new RegExp("^" + ind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"[^"]*"\\s*:');
    for (let i = 0; i < lines.length; i++) if (re.test(lines[i])) starts.push(i);
  } else if (lang === "yml" || lang === "yaml") {
    for (let i = 0; i < lines.length; i++) if (/^[^\s#-][^:]*:/.test(lines[i])) starts.push(i);
  } else if (lang === "toml") {
    for (let i = 0; i < lines.length; i++) if (/^\[\[?[^\]]+\]\]?\s*$/.test(lines[i])) starts.push(i);
  } else if (lang === "md") {
    for (let i = 0; i < lines.length; i++) if (/^#{1,4}\s/.test(lines[i])) starts.push(i);
  }
  return starts;
}
/* 起点列表 → 连续区间;首个起点前的非空正文单独成块(纯 { } 括号行不成块) */
function sectionsFromStarts(lines, starts) {
  if (!starts.length) return [];
  const pre = lines.slice(0, starts[0]).filter((l) => l.trim());
  const all = pre.length && !pre.every((l) => /^[\s{}\[\],]*$/.test(l)) ? [0, ...starts] : starts;
  return all.map((s, i) => [s, (all[i + 1] === undefined ? lines.length : all[i + 1]) - 1]);
}
/* 兜底分块:按顶层语句切段,连续单行语句(导入/零散常量)自动合并,避免碎片化 */
function stmtRanges(lines, lang) {
  const cont = /^\s*(?:[})\];,]|else\b|catch\b|finally\b|elif\b|except\b|fi\b|done\b|esac\b)/;
  let starts = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || !/^\S/.test(l) || cont.test(l)) continue;
    starts.push(i);
  }
  if (!starts.length) return [];
  if (starts[0] > 0 && lines.slice(0, starts[0]).some((l) => l.trim())) starts = [0, ...starts];
  // 去掉块尾空行,让悬停矩形贴合实际内容
  const ranges = starts
    .map((s, i) => [s, (starts[i + 1] === undefined ? lines.length : starts[i + 1]) - 1])
    .map(([s, e]) => {
      while (e > s && !lines[e].trim()) e--;
      return [s, e];
    });
  const merged = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    // 仅相邻的单行语句合并(空行隔开的不粘),防止吞掉紧随其后的注释
    if (last && last[1] === last[0] && r[1] === r[0] && r[0] === last[1] + 1) last[1] = r[1];
    else merged.push(r);
  }
  // 紧邻后续块的纯注释块(如声明前的单行 JSDoc)并入后续块
  const isComment = commentTester(lang);
  for (let i = merged.length - 2; i >= 0; i--) {
    const [s, e] = merged[i];
    if (
      merged[i + 1][0] === e + 1 &&
      lines.slice(s, e + 1).every((l) => !l.trim() || isComment(l))
    ) {
      merged[i + 1][0] = s;
      merged.splice(i, 1);
    }
  }
  return merged;
}
/* 行注释判定:// /* * 对所有语言;# 仅限以 # 为注释的语言(C 系的 # 是预处理指令) */
function commentTester(lang) {
  const hash = lang === "py" || lang === "pyi" || lang === "sh" || lang === "yaml" || lang === "yml" || lang === "toml";
  const line = hash ? /^\s*(?:\/\/|\/\*|\*|#)/ : /^\s*(?:\/\/|\/\*|\*)/;
  return (l) => line.test(l);
}
/* 空隙回填:既有块之间的空隙用顶层语句块补齐,让"函数+顶部导入"混合文件整段可点;
   紧邻后续块的纯注释空隙(如函数前的 JSDoc)并入后续块,不单独成块 */
function fillStmtGaps(lines, blocks, lang) {
  const out = [...blocks];
  const gaps = [];
  let prev = -1;
  for (let b = 0; b < blocks.length; b++) {
    const [s, e] = blocks[b];
    if (s > prev + 1) gaps.push([prev + 1, s - 1, b]);
    prev = e;
  }
  if (prev < lines.length - 1) gaps.push([prev + 1, lines.length - 1, -1]);
  const isComment = commentTester(lang);
  for (const [gs, ge, bi] of gaps) {
    const slice = lines.slice(gs, ge + 1);
    const nonblank = slice.filter((l) => l.trim());
    if (!nonblank.length) continue;
    if (bi >= 0 && nonblank.every(isComment)) {
      const firstNb = slice.findIndex((l) => l.trim());
      blocks[bi][0] = gs + firstNb;
      continue;
    }
    for (const [s, e] of stmtRanges(slice, lang)) out.push([s + gs, e + gs]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}
/* 分块总入口:函数声明 + 测试调用优先合并并回填空隙;配置/文档按结构分段;再不行按顶层语句;最后整段一块 */
function computeFnRanges(lines, lang) {
  const decl = fnDeclRanges(lines, lang);
  const tc = testCallRanges(lines);
  if (decl.length || tc.length) return fillStmtGaps(lines, mergeRanges(decl, tc), lang);
  if (lang === "json" || lang === "yml" || lang === "yaml" || lang === "toml" || lang === "md") {
    const sec = sectionsFromStarts(lines, sectionStarts(lines, lang));
    if (sec.length) return sec;
  } else {
    const st = stmtRanges(lines, lang);
    if (st.length) return st;
  }
  return lines.filter((l) => l.trim()).length >= 6 ? [[0, lines.length - 1]] : [];
}
function codeBlockHTML(f, seg, segIdx) {
  const segLines = f.lines.slice(seg.start - 1, seg.end);
  const lang = langOf(f.path);
  const fnRanges = computeFnRanges(segLines, lang);
  const rangeStart = new Map(fnRanges.map(([s]) => [s, true]));
  const rangeEnd = new Map(fnRanges.map(([, e]) => [e, true]));
  let rows = "";
  let openFnb = false;
  for (let k = 0; k < segLines.length; k++) {
    const no = seg.start + k;
    if (rangeStart.has(k)) {
      rows += `<div class="fnb">`;
      openFnb = true;
    }
    rows += `<div class="cl" id="L${no}"><span class="ln">${no}</span><span class="lc">${highlightLine(segLines[k], lang)}</span></div>`;
    if (rangeEnd.has(k)) {
      rows += `</div>`;
      openFnb = false;
    }
  }
  if (openFnb) rows += `</div>`;
  return `<div class="codebox" data-seg="${segIdx}">
    <div class="c-head"><span class="t">L${seg.start}–L${seg.end}</span><span class="sp">
      <button class="fold" title="折叠/展开">▾</button>
      <button class="copyseg" title="复制此段代码">复制</button>
    </span></div>
    <div class="c-body"><pre class="code">${rows}</pre></div>
  </div>`;
}
function annotHTML(f, seg, segIdx) {
  const tags = (seg.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  return `<div class="annot" id="A${segIdx}" data-seg="${segIdx}">
    <div class="a-head">
      <span class="a-title">${esc(seg.title)}</span>
      <span class="a-lines">L${seg.start}–L${seg.end}</span>${tags}
      <button class="a-float" title="拖出为浮动窗口">⛶ 浮出</button>
    </div>
    <div class="a-note">${seg.note}</div>
  </div>`;
}
function segHTML(f, seg, segIdx) {
  return `<div class="seg" id="S${segIdx}">${annotHTML(f, seg, segIdx)}${codeBlockHTML(f, seg, segIdx)}</div>`;
}

/* ============ 文件视图 ============ */
function renderFile(f) {
  const pathHtml = esc(f.path).replace(/^([^\s]+)/, '<span class="pkg">$1</span>');
  const chips = f.segs
    .map((s, i) => `<span class="segchip" data-seg="${i}">${esc(s.title)}</span>`)
    .join("");
  const body =
    state.mode === "split"
      ? `<div id="splitwrap">
          <div class="col-code" id="col-code"><div class="col-head">源码 · ${f.loc} 行</div>${f.segs
            .map((s, i) => codeBlockHTML(f, s, i))
            .join("")}</div>
          <div id="hsplit" title="拖动调整比例"></div>
          <div class="col-annot" id="col-annot"><div class="col-head">注解 · ${f.segs.length} 段</div>${f.segs
            .map((s, i) => annotHTML(f, s, i))
            .join("")}</div>
        </div>`
      : f.segs.map((s, i) => segHTML(f, s, i)).join("");
  $("#main").classList.toggle("split-mode", state.mode === "split");
  $("#main").innerHTML = `<div class="filehead">
      <div class="path">${pathHtml}</div>
      <div class="desc">${f.desc || ""}</div>
      <div class="segchips">${chips}</div>
    </div>${body}${state.mode === "split" ? "" : '<div style="height:40px"></div>'}`;
  // 分段芯片跳转
  $$(".segchip").forEach((c) =>
    c.addEventListener("click", () => {
      const i = c.dataset.seg;
      const el = $(`#S${i}`) || $(`#col-code .codebox[data-seg="${i}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    })
  );
  // 代码块交互
  $$(".codebox").forEach((box) => {
    const idx = Number(box.dataset.seg);
    const seg = f.segs[idx];
    $(".fold", box).addEventListener("click", () => box.classList.toggle("folded"));
    $(".copyseg", box).addEventListener("click", () =>
      copyText(f.lines.slice(seg.start - 1, seg.end).join("\n"))
    );
  });
  // 注解浮出
  $$(".annot").forEach((a) => bindFloat(a, f));
  if (state.mode === "split") bindSplitSync();
}

function openFile(path, opts) {
  const f = byPath.get(path);
  if (!f) return;
  hideCodetip();
  hoverBox = null;
  state.file = path;
  renderTree();
  setMacTitle("📄 " + path.split("/").pop());
  renderFile(f);
  $("#main").scrollTop = 0;
  location.hash = path;
  if (opts && opts.line) {
    setTimeout(() => {
      const el = $(`#L${opts.line}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.add("flash");
        setTimeout(() => el.classList.remove("flash"), 2200);
      }
    }, 60);
  } else if (opts && typeof opts.seg === "number") {
    setTimeout(() => {
      const el = $(`#S${opts.seg}`) || $(`#col-code .codebox[data-seg="${opts.seg}"]`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 60);
  }
}

/* ============ 并排模式滚动同步 ============ */
function bindSplitSync() {
  const left = $("#col-code");
  const right = $("#col-annot");
  if (!left || !right) return;
  let guard = false;
  const sync = (from, to) => () => {
    if (guard) return;
    guard = true;
    const ratio = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = ratio * (to.scrollHeight - to.clientHeight);
    requestAnimationFrame(() => (guard = false));
  };
  left.addEventListener("scroll", sync(left, right));
  right.addEventListener("scroll", sync(right, left));
  // 拖动比例
  const hsplit = $("#hsplit");
  const wrap = $("#splitwrap");
  hsplit.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    hsplit.classList.add("drag");
    const rect = wrap.getBoundingClientRect();
    const move = (ev) => {
      const pct = Math.min(0.8, Math.max(0.2, (ev.clientX - rect.left) / rect.width));
      left.style.flexBasis = `${pct * 100}%`;
    };
    const up = () => {
      hsplit.classList.remove("drag");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

/* ============ 浮动注解窗口 ============ */
function bindFloat(annotEl, f) {
  const segIdx = Number(annotEl.dataset.seg);
  const seg = f.segs[segIdx];
  const btn = $(".a-float", annotEl);
  btn.addEventListener("click", () => floatOut(annotEl, f, seg, segIdx));
  $(".a-title", annotEl).addEventListener("dblclick", () => floatOut(annotEl, f, seg, segIdx));
}
function floatOut(annotEl, f, seg, segIdx) {
  if (state.floats.some((w) => w.key === `${f.path}#${segIdx}`)) {
    toast("该注解已浮出");
    return;
  }
  const win = document.createElement("div");
  win.className = "floatwin";
  const offset = state.floats.length * 26;
  win.style.left = `${Math.min(window.innerWidth - 420, 560 + offset)}px`;
  win.style.top = `${90 + offset}px`;
  win.innerHTML = `<div class="fw-head">
      <span class="fw-title">∭ ${esc(seg.title)}</span>
      <span class="a-lines" style="font-size:10px">L${seg.start}–L${seg.end}</span>
      <button class="fw-close" title="关闭">✕</button>
    </div><div class="fw-body">${seg.note}</div>`;
  document.body.appendChild(win);
  annotEl.classList.add("dimmed");
  const rec = { key: `${f.path}#${segIdx}`, win, annotEl };
  state.floats.push(rec);
  // 拖动
  const head = $(".fw-head", win);
  head.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("fw-close")) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const ox = win.offsetLeft, oy = win.offsetTop;
    const move = (ev) => {
      win.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ox + ev.clientX - sx))}px`;
      win.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, oy + ev.clientY - sy))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  $(".fw-close", win).addEventListener("click", () => {
    win.remove();
    state.floats = state.floats.filter((w) => w !== rec);
    annotEl.classList.remove("dimmed");
  });
}

/* ============ 代码块悬停:高亮 + 注释气泡 ============ */
let codetipEl = null;
let codetipTimer = null;
let hoverBox = null;
let lastMouse = { x: 0, y: 0 };
function ensureCodetip() {
  if (codetipEl) return codetipEl;
  codetipEl = document.createElement("div");
  codetipEl.className = "codetip";
  document.body.appendChild(codetipEl);
  return codetipEl;
}
function hideCodetip() {
  if (codetipTimer) {
    clearTimeout(codetipTimer);
    codetipTimer = null;
  }
  if (codetipEl) codetipEl.classList.remove("show");
}
function showCodetip(segIdx, x, y) {
  // 划选文本时优先选区交互,不弹悬停气泡
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.toString().trim().length > 0) return;
  const f = state.file ? byPath.get(state.file) : null;
  if (!f || !f.segs[segIdx]) return;
  const seg = f.segs[segIdx];
  const tip = ensureCodetip();
  tip.innerHTML = `<div class="t-head">
      <span class="t-title">${esc(seg.title)}</span>
      <span class="t-lines">L${seg.start}–L${seg.end}</span>
    </div><div class="t-note">${seg.note}</div>`;
  tip.classList.add("show");
  // 锚定在鼠标右下 18px,放不下时翻到左侧/顶部
  const r = tip.getBoundingClientRect();
  let tx = x + 18;
  let ty = y + 18;
  if (tx + r.width > window.innerWidth - 10) tx = Math.max(10, x - r.width - 18);
  if (ty + r.height > window.innerHeight - 10) ty = Math.max(10, window.innerHeight - r.height - 10);
  tip.style.left = `${tx}px`;
  tip.style.top = `${ty}px`;
}
function bindCodeHover() {
  const main = $("#main");
  // 悬停到(或离开)某个代码块:mouserover 会随子元素反复触发,用 closest 归并到块级
  main.addEventListener("mouseover", (e) => {
    const box = e.target.closest(".codebox");
    if (box === hoverBox) return;
    if (hoverBox) hoverBox.classList.remove("hovered");
    hoverBox = box;
    if (codetipTimer) clearTimeout(codetipTimer);
    if (!box) {
      hideCodetip();
      return;
    }
    box.classList.add("hovered");
    const segIdx = Number(box.dataset.seg);
    const mx = e.clientX || lastMouse.x;
    const my = e.clientY || lastMouse.y;
    codetipTimer = setTimeout(() => showCodetip(segIdx, mx, my), 240);
  });
  main.addEventListener("mousemove", (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
  });
  main.addEventListener("mouseleave", hideCodetip);
  // 滚动后锚点失效,直接隐藏(捕获以覆盖并排模式的内部滚动列)
  main.addEventListener("scroll", hideCodetip, true);
  window.addEventListener("blur", hideCodetip);
}


/* ============ 全局搜索 ============ */
let searchIndex = null;
function buildIndex() {
  const entries = [];
  for (const f of FILES) {
    entries.push({ type: "file", file: f.path, text: f.path, extra: f.loc + " 行" });
    f.segs.forEach((s, i) => {
      const plain = s.title + " " + s.note.replace(/<[^>]+>/g, " ");
      entries.push({ type: "annot", file: f.path, seg: i, text: s.title, extra: plain });
    });
    f.lines.forEach((line, i) => {
      if (line.trim()) entries.push({ type: "code", file: f.path, line: i + 1, text: line });
    });
  }
  searchIndex = entries;
}
function hl(text, terms) {
  let html = esc(text);
  for (const t of terms) {
    const re = new RegExp(`(${t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "gi");
    html = html.replace(re, "<mark>$1</mark>");
  }
  return html;
}
function runSearch(q) {
  const box = $("#results");
  if (!q || q.length < 2) {
    box.classList.remove("open");
    $("#search-count").textContent = "";
    return;
  }
  if (!searchIndex) buildIndex();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = [];
  for (const e of searchIndex) {
    const hay = e.text.toLowerCase() + " " + (e.extra || "").toLowerCase();
    if (terms.every((t) => hay.includes(t))) {
      hits.push(e);
      if (hits.length >= 300) break;
    }
  }
  $("#search-count").textContent = hits.length >= 300 ? "300+" : String(hits.length);
  if (hits.length === 0) {
    box.innerHTML = `<div class="res-group" style="border-top:0">没有匹配结果</div>`;
    box.classList.add("open");
    return;
  }
  // 文件名命中优先,然后注解,然后代码行(按文件、行号归组排序)
  const order = { file: 0, annot: 1, code: 2 };
  hits.sort(
    (a, b) => order[a.type] - order[b.type] || a.file.localeCompare(b.file) || (a.line || 0) - (b.line || 0)
  );
  let html = "";
  let lastType = null;
  let lastFile = null;
  hits.slice(0, 120).forEach((h, i) => {
    if (h.type === "file") {
      html += `<div class="res-group">📁 文件</div>`;
    } else if (h.type !== lastType || (h.type === "code" && h.file !== lastFile)) {
      html += `<div class="res-group">${h.type === "annot" ? "📝 注解" : "💻 代码 — " + esc(h.file)}</div>`;
    }
    lastType = h.type;
    lastFile = h.file;
    const loc =
      h.type === "file" ? h.extra : h.type === "annot" ? `注解 · ${esc(h.file.split("/").pop())}` : `L${h.line}`;
    const snippet =
      h.type === "code"
        ? `<span class="snippet"><code>${hl(h.text.trim().slice(0, 200), terms)}</code></span>`
        : h.type === "annot"
          ? `<span class="snippet">${hl(h.text, terms)}</span>`
          : "";
    html += `<button class="res-item${i === 0 ? " active" : ""}" data-i="${i}">
      <span class="loc">${loc}</span>${h.type === "file" ? hl(h.text, terms) : hl(h.text, terms)}${snippet}</button>`;
  });
  box.innerHTML = html;
  box.classList.add("open");
  const items = $$(".res-item", box);
  items.forEach((el) => {
    el.addEventListener("click", () => gotoHit(hits[Number(el.dataset.i)]));
    el.addEventListener("mousemove", () => {
      $$(".res-item", box).forEach((x) => x.classList.remove("active"));
      el.classList.add("active");
    });
  });
  box._hits = hits;
  box._items = items;
  box._active = 0;
}
function gotoHit(h) {
  $("#results").classList.remove("open");
  if (h.type === "file") {
    openFile(h.file);
  } else if (h.type === "annot") {
    openFile(h.file, { seg: h.seg });
    setTimeout(() => {
      const a = $(`#A${h.seg}`);
      if (a) {
        a.style.borderColor = "var(--yellow)";
        setTimeout(() => (a.style.borderColor = ""), 1800);
      }
    }, 350);
  } else {
    openFile(h.file, { line: h.line });
  }
}

/* ============ 划选代码 AI 助手 ============ */
const AI_STORAGE_KEY = "cv-ai";
function loadAIConfig() {
  try {
    return JSON.parse(localStorage.getItem(AI_STORAGE_KEY) || "{}");
  } catch {
    return {};
  }
}
function saveAIConfig(cfg) {
  localStorage.setItem(AI_STORAGE_KEY, JSON.stringify(cfg));
}
let selbtnEl = null;
let aipanelEl = null;
let aiAbort = null;
let currentSelInfo = null; // AI 面板当前正在解释的对象(仅由 openAIPanel 设置,选区变化不冲掉)
let selectionInfo = null; // 划选按钮对应的实时选区

function ensureSelBtn() {
  if (selbtnEl) return selbtnEl;
  selbtnEl = document.createElement("div");
  selbtnEl.className = "selbtn";
  selbtnEl.innerHTML = `<button class="ai-explain">✨ AI 解释</button>`;
  document.body.appendChild(selbtnEl);
  selbtnEl.addEventListener("mousedown", (e) => e.preventDefault()); // 保住选区
  $(".ai-explain", selbtnEl).addEventListener("click", () => {
    hideSelBtn();
    const info = selectionInfo || currentSelInfo;
    if (info) openAIPanel(info);
  });
  return selbtnEl;
}
function hideSelBtn() {
  if (selbtnEl) selbtnEl.classList.remove("show");
}

/* 选区 → 结构化信息(文件、行号范围、所属分段、代码文本) */
function readSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return null;
  const raw = sel.toString();
  if (!raw || raw.trim().length < 10) return null;
  const elOf = (node) => {
    const el = node && (node.nodeType === 3 ? node.parentElement : node);
    return el ? el.closest(".code") : null;
  };
  const startCode = elOf(sel.anchorNode);
  const endCode = elOf(sel.focusNode);
  if (!startCode || !endCode || startCode !== endCode) return null;
  // 锚点可能是文本节点(真实拖选)或元素节点+偏移(程序化/双击选区)
  const rowFromPosition = (node, offset) => {
    let el;
    if (!node) return null;
    if (node.nodeType === 3) el = node.parentElement;
    else if (node.childNodes && node.childNodes[offset]) el = node.childNodes[offset];
    else el = node;
    return el && el.closest ? el.closest(".cl") : null;
  };
  const r1 = rowFromPosition(sel.anchorNode, sel.anchorOffset);
  const r2 = rowFromPosition(sel.focusNode, sel.focusOffset);
  let startLine = null;
  let endLine = null;
  let text = raw;
  if (r1 && r2) {
    const n1 = parseInt((r1.id || "").slice(1), 10);
    const n2 = parseInt((r2.id || "").slice(1), 10);
    if (n1 && n2) {
      startLine = Math.min(n1, n2);
      endLine = Math.max(n1, n2);
      // 按行元素取纯代码文本,剔除行号栏数字
      const rows = [];
      for (let n = startLine; n <= endLine; n++) {
        const row = document.getElementById(`L${n}`);
        if (!row) break;
        rows.push(row.querySelector(".lc") ? row.querySelector(".lc").textContent : "");
      }
      if (rows.length === endLine - startLine + 1 && rows.join("").trim().length > 0) {
        text = rows.join("\n");
      }
    }
  } else {
    // 兜底:剥离每行行首的行号
    text = raw.replace(/^\s*\d+(?=[ \t])/gm, "");
  }
  const box = startCode.closest(".codebox");
  const segIdx = box ? Number(box.dataset.seg) : null;
  const f = state.file ? byPath.get(state.file) : null;
  const seg = f && segIdx !== null ? f.segs[segIdx] : null;
  return {
    text,
    file: state.file || "",
    startLine,
    endLine,
    segIdx,
    seg,
    fileDesc: f ? f.desc : "",
  };
}

let selChangeTimer = null;
function bindSelectionAssistant() {
  ensureSelBtn();
  const update = () => {
    const info = readSelection();
    selectionInfo = info;
    if (!info) {
      hideSelBtn();
      return;
    }
    const sel = window.getSelection();
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    const btn = ensureSelBtn();
    btn.classList.add("show");
    const bw = btn.offsetWidth || 170;
    let x = rect.left + rect.width / 2 - bw / 2;
    x = Math.max(8, Math.min(window.innerWidth - bw - 8, x));
    let y = rect.bottom + 6;
    if (y + 34 > window.innerHeight) y = rect.top - 36;
    y = Math.max(8, Math.min(window.innerHeight - 40, y));
    btn.style.left = `${x}px`;
    btn.style.top = `${y}px`;
  };
  document.addEventListener("selectionchange", () => {
    if (selChangeTimer) clearTimeout(selChangeTimer);
    selChangeTimer = setTimeout(update, 250);
  });
  // 滚动后按钮位置失效
  $("#main").addEventListener("scroll", hideSelBtn, true);
}

/* ---------- AI 面板 ---------- */
function ensureAIPanel() {
  if (aipanelEl) return aipanelEl;
  const cfg = loadAIConfig();
  aipanelEl = document.createElement("div");
  aipanelEl.className = "aipanel";
  aipanelEl.style.right = "40px";
  aipanelEl.style.bottom = "60px";
  aipanelEl.innerHTML = `
    <div class="ap-head">
      <span class="ap-title">🤖 AI 助手 · 解释选中代码</span>
      <span class="ap-status"></span>
      <button class="ap-close" title="关闭">✕</button>
    </div>
    <div class="ap-ctx"></div>
    <div class="aiset">
      <div class="row">
        <label>预设</label>
        <select class="as-preset">
          <option value="">自定义</option>
          <option value="proxy-zhipu">本地代理 · 智谱 Coding Plan</option>
          <option value="proxy-deepseek">本地代理 · DeepSeek</option>
          <option value="ollama">Ollama 本地 (localhost:11434)</option>
          <option value="deepseek">DeepSeek 官方(直连)</option>
          <option value="volcengine">火山方舟 Ark</option>
        </select>
      </div>
      <div class="row"><label>Base URL</label><input class="as-base" placeholder="http://localhost:11434/v1"></div>
      <div class="row"><label>API Key</label><input class="as-key" type="password" placeholder="本地服务可留空"></div>
      <div class="row"><label>模型</label><input class="as-model" placeholder="如 qwen2.5-coder / deepseek-chat"></div>
      <div class="row" style="justify-content:flex-end">
        <button class="tbtn as-save">保存</button>
        <button class="tbtn as-test">测试连接</button>
      </div>
      <div class="help">
        配置仅保存在本机浏览器 localStorage,不会上传。Ollama 需先设 <code>OLLAMA_ORIGINS=*</code> 再启动以允许浏览器调用;
        在线服务需允许跨域(CORS)。未配置时点「AI 解释」会给出离线即时分析。
      </div>
    </div>
    <div class="ap-body"><div class="ap-out dim">在代码上划选一段文本,点选区旁的 ✨ AI 解释。</div></div>
    <div class="ap-foot">
      <button class="tbtn ap-rerun" title="重新生成一句话解释">🔁</button>
      <button class="tbtn ap-deep" title="送入右侧陪读栏深入讲解">📚 深度理解</button>
      <button class="tbtn ap-setbtn" title="模型设置(提供商/端点)">⚙️</button>
      <button class="tbtn ap-stop" style="display:none">⏹ 停止</button>
    </div>`;
  document.body.appendChild(aipanelEl);
  // 拖动
  const head = $(".ap-head", aipanelEl);
  head.addEventListener("pointerdown", (e) => {
    if (e.target.classList.contains("ap-close")) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY;
    const rect = aipanelEl.getBoundingClientRect();
    const ox = rect.left, oy = rect.top;
    aipanelEl.style.right = "";
    aipanelEl.style.bottom = "";
    const move = (ev) => {
      aipanelEl.style.left = `${Math.max(0, Math.min(window.innerWidth - 80, ox + ev.clientX - sx))}px`;
      aipanelEl.style.top = `${Math.max(0, Math.min(window.innerHeight - 40, oy + ev.clientY - sy))}px`;
    };
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  $(".ap-close", aipanelEl).addEventListener("click", () => {
    stopAIStream();
    aipanelEl.classList.remove("show");
  });
  $(".ap-setbtn", aipanelEl).addEventListener("click", () => {
    $(".aiset", aipanelEl).classList.toggle("show");
  });
  $(".ap-rerun", aipanelEl).addEventListener("click", () => {
    if (currentSelInfo) runExplain(currentSelInfo);
  });
  $(".ap-deep", aipanelEl).addEventListener("click", () => {
    if (!currentSelInfo) {
      toast("先在代码上点击函数或划选片段");
      return;
    }
    const outEl = $(".ap-out", aipanelEl);
    const answer = outEl ? outEl.textContent.trim() : "";
    // 离线分析/错误信息不作为"一句话解释"送入
    const oneSentence = /^(【|模型调用失败)/.test(answer) ? "" : answer.slice(0, 200);
    dockDeepDive(currentSelInfo, oneSentence);
  });
  $(".ap-stop", aipanelEl).addEventListener("click", stopAIStream);
  // 设置表单
  const baseInput = $(".as-base", aipanelEl);
  const modelInput = $(".as-model", aipanelEl);
  baseInput.value = cfg.baseUrl || "";
  $(".as-key", aipanelEl).value = cfg.apiKey || "";
  modelInput.value = cfg.model || "";
  $(".as-preset", aipanelEl).addEventListener("change", (e) => {
    const presets = {
      "proxy-zhipu": { baseUrl: "/ai-proxy", model: "glm-5.2" },
      "proxy-deepseek": { baseUrl: "/ai-proxy/deepseek", model: "deepseek-v4-flash" },
      ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5-coder" },
      deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
      volcengine: { baseUrl: "https://ark.cn-beijing.volces.com/api/v3", model: "" },
    };
    const p = presets[e.target.value];
    if (p) {
      baseInput.value = p.baseUrl;
      if (p.model) modelInput.value = p.model;
    }
  });
  // 底栏提供商快速切换已并入 ⚙️ 设置的预设菜单(本地代理 · 智谱 / DeepSeek)
  $(".as-save", aipanelEl).addEventListener("click", () => {
    saveAIConfig({
      baseUrl: baseInput.value.trim(),
      apiKey: $(".as-key", aipanelEl).value.trim(),
      model: modelInput.value.trim(),
    });
    toast("AI 配置已保存(仅本机)");
    $(".aiset", aipanelEl).classList.remove("show");
  });
  $(".as-test", aipanelEl).addEventListener("click", async () => {
    const status = $(".ap-status", aipanelEl);
    status.textContent = "测试中…";
    status.classList.add("busy");
    try {
      const res = await chatComplete(
        {
          baseUrl: baseInput.value.trim(),
          apiKey: $(".as-key", aipanelEl).value.trim(),
          model: modelInput.value.trim(),
        },
        [{ role: "user", content: "ping" }],
        { max_tokens: 1 }
      );
      if (!res.ok) {
        let msg = "HTTP " + res.status;
        try {
          const j = await res.json();
          if (j.error && j.error.message) msg = j.error.message;
        } catch {}
        throw new Error(msg);
      }
      status.textContent = "✓ 连接成功";
    } catch (err) {
      status.textContent = "✗ " + String((err && err.message) || err).slice(0, 60);
    } finally {
      status.classList.remove("busy");
    }
  });
  return aipanelEl;
}
function stopAIStream() {
  if (aiAbort) {
    aiAbort.abort();
    aiAbort = null;
  }
}
function setStatus(text, busy) {
  if (!aipanelEl) return;
  const s = $(".ap-status", aipanelEl);
  s.textContent = text || "";
  s.classList.toggle("busy", Boolean(busy));
  $(".ap-stop", aipanelEl).style.display = busy ? "" : "none";
}
function openAIPanel(info) {
  currentSelInfo = info; // 统一登记当前解释对象(点击函数 / 划选两条路径都经过这里)
  const panel = ensureAIPanel();
  panel.classList.add("show");
  const range =
    info.startLine && info.endLine
      ? info.startLine === info.endLine
        ? `L${info.startLine}`
        : `L${info.startLine}–L${info.endLine}`
      : "选区";
  const segTitle = info.seg ? info.seg.title : "—";
  $(".ap-ctx", panel).innerHTML =
    `<span>${esc(info.file.split("/").pop())}</span><span class="chip">${range}</span>` +
    `<span>${info.text.trim().split(/\n/).length} 行</span><span class="chip">所属段:${esc(segTitle)}</span>`;
  runExplain(info);
}

/* ---------- 流式渲染节流:增量只累积进缓冲,按 ~90ms 合并整段重渲染 ----------
 * 全量 md 重解析 + innerHTML 替换是主要开销,若每个 SSE 增量(常为 1~2 字)都渲染,
 * 千级增量下总开销 O(n²),页面会明显卡顿;节流后渲染次数 ≈ 时长/90ms。
 * 滚动采用智能跟随:用户向上滚离底部即停止跟随,滚回底部自动恢复。 */
function followStateOf(el) {
  if (!el) return null;
  if (!el.__followState) {
    const s = { follow: true };
    el.addEventListener(
      "scroll",
      () => {
        s.follow = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
      },
      { passive: true }
    );
    el.__followState = s;
  }
  return el.__followState;
}
function makeStreamRenderer(renderFn, scrollEl) {
  let timer = null;
  const follow = followStateOf(scrollEl);
  const flushNow = () => {
    timer = null;
    renderFn();
    if (scrollEl && follow && follow.follow) scrollEl.scrollTop = scrollEl.scrollHeight;
  };
  return {
    schedule() {
      if (timer) return;
      timer = setTimeout(flushNow, 90);
    },
    flush() {
      if (timer) clearTimeout(timer);
      flushNow();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/* ---------- 讲解执行:优先模型流式,否则离线分析 ---------- */
/* 轻量 Markdown 渲染(AI 解释面板用):围栏代码块 → 转义 → 标题/列表/粗体/行内代码 */
function mdToHtml(src) {
  const blocks = [];
  let text = String(src).replace(/```([a-zA-Z0-9_-]*)\n?([\s\S]*?)```/g, (m, lang, code) => {
    blocks.push(`<pre class="md-code"><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000B${blocks.length - 1}\u0000`;
  });
  const inline = (s) =>
    s
      .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
  let html = "";
  let listType = null;
  const closeList = () => {
    if (listType) {
      html += `</${listType}>`;
      listType = null;
    }
  };
  for (const raw of esc(text).split(/\n/)) {
    const line = raw.trimEnd();
    const li = /^(?:[-*•·]|\d+[.、])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /^\d/.test(line);
      const want = ordered ? "ol" : "ul";
      if (listType !== want) {
        closeList();
        html += `<${want}>`;
        listType = want;
      }
      html += `<li>${inline(li[1])}</li>`;
      continue;
    }
    closeList();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lv = Math.min(h[1].length + 3, 6);
      html += `<h${lv}>${inline(h[2])}</h${lv}>`;
      continue;
    }
    if (!line.trim()) {
      html += `<div class="md-sp"></div>`;
      continue;
    }
    html += `<p>${inline(line)}</p>`;
  }
  closeList();
  html = html.replace(/\u0000B(\d+)\u0000/g, (m, i) => blocks[Number(i)] || "");
  return html || `<span class="dim">(空)</span>`;
}

function stripNoteHtml(html) {
  return html
    .replace(/<code>/g, "`")
    .replace(/<\/code>/g, "`")
    .replace(/<b>|<\/b>/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}
function offlineExplain(info) {
  const parts = [];
  parts.push("【本段既有注解】");
  if (info.seg) {
    parts.push(`${info.seg.title}(L${info.seg.start}–L${info.seg.end})`);
    parts.push(stripNoteHtml(info.seg.note));
  } else {
    parts.push("(该段无细分注解)");
  }
  parts.push("");
  parts.push("【选中代码静态观察】");
  const code = info.text;
  const fns = [...code.matchAll(/(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const methods = [...code.matchAll(/(?:private |public |readonly |async )*[a-zA-Z_$][\w$]*\s*\([^)]*\)\s*\{/g)]
    .map((m) => m[0].replace(/\s*\{$/, "").trim())
    .filter((s) => !/^(if|for|while|switch|catch|return)\s*\(/.test(s));
  const classes = [...code.matchAll(/class\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
  const consts = [...code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1]);
  const feats = [];
  if (/\bawait\b/.test(code)) feats.push("含异步等待(await)");
  if (/\btry\s*\{/.test(code)) feats.push("含异常处理(try/catch)");
  if (/\bfor\b|\bwhile\b/.test(code)) feats.push("含循环");
  if (/new Error|错误:/.test(code)) feats.push("产生/处理错误信息");
  if (/\bimport\b|\bfrom\b/.test(code)) feats.push("模块导入");
  if (/=>/.test(code)) feats.push("使用箭头函数/回调");
  parts.push(`· 共 ${code.trim().split(/\n/).length} 行`);
  if (classes.length) parts.push(`· 类声明:${classes.slice(0, 8).join("、")}${classes.length > 8 ? " 等" : ""}`);
  if (fns.length) parts.push(`· 函数:${fns.slice(0, 10).join("、")}${fns.length > 10 ? " 等" : ""}`);
  if (methods.length) parts.push(`· 方法/签名示例:${methods.slice(0, 3).join(" | ")}`);
  if (consts.length) parts.push(`· 主要常量/变量:${consts.slice(0, 10).join("、")}${consts.length > 10 ? " 等" : ""}`);
  if (feats.length) parts.push(`· 特征:${feats.join(";")}`);
  parts.push("");
  parts.push("【提示】这是离线即时分析。点下方 ⚙️ 模型设置 配置 OpenAI 兼容端点(Ollama 本地免费 / DeepSeek / 火山方舟),即可获得针对选中代码的逐点深入讲解。");
  return parts.join("\n");
}
function buildExplainMessages(info) {
  const code = info.text.length > 6000 ? info.text.slice(0, 6000) + "\n…(超长已截断)" : info.text;
  const note = info.seg ? stripNoteHtml(info.seg.note).slice(0, 600) : info.fileDesc.slice(0, 300);
  return [
    {
      role: "system",
      content:
        "你是代码讲解助手。只输出一句简洁的中文,概括选中代码(函数或逻辑块)的核心功能,不超过 60 字,直接说功能本身,不要任何前缀、标题或分点。仅当选中代码含有明显陷阱或边界情况时,才允许在句末追加一句不超过 30 字的提醒。禁止复述代码、禁止解释你的思考过程。",
    },
    {
      role: "user",
      content: `文件:${info.file}\n选中范围:${info.startLine ? "L" + info.startLine + "–L" + info.endLine : "选区"}\n所属分段的既有注解:${note || "(无)"}\n\n选中代码:\n\`\`\`\n${code}\n\`\`\``,
    },
  ];
}
async function chatComplete(cfg, messages, extra) {
  const url = (cfg.baseUrl || "").replace(/\/+$/, "") + "/chat/completions";
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {}),
    },
    body: JSON.stringify({ model: cfg.model, messages, temperature: 0.3, ...extra }),
  });
}
async function runExplain(info) {
  const panel = ensureAIPanel();
  const out = $(".ap-out", panel);
  out.classList.remove("dim");
  const cfg = loadAIConfig();
  stopAIStream();
  // 未配置模型 → 离线即时分析,并展开设置引导
  if (!cfg.baseUrl || !cfg.model) {
    out.innerHTML = mdToHtml(offlineExplain(info));
    setStatus("离线分析", false);
    $(".aiset", panel).classList.add("show");
    return;
  }
  out.textContent = "";
  setStatus("生成中…", true);
  aiAbort = new AbortController();
  // 新一轮解释:回到顶部并恢复滚动跟随
  const body = out.closest(".ap-body");
  if (body) {
    body.scrollTop = 0;
    followStateOf(body).follow = true;
  }
  // 节流渲染:正文优先;只有思考时显示思考预览(只保留尾部,防超长)
  let reasoningBuf = "";
  let contentBuf = "";
  const renderer = makeStreamRenderer(
    () => {
      if (contentBuf) {
        out.innerHTML = mdToHtml(contentBuf);
        setStatus(`生成中… ${contentBuf.length} 字`, true);
      } else if (reasoningBuf) {
        const tail =
          reasoningBuf.length > 1500 ? "…(已省略前文)…\n" + reasoningBuf.slice(-1500) : reasoningBuf;
        out.innerHTML = `<span class="dim">💭 思考中(${reasoningBuf.length} 字),正文输出后自动替换:\n\n${esc(tail)}</span>`;
        setStatus(`思考中… ${reasoningBuf.length} 字`, true);
      }
    },
    out.closest(".ap-body")
  );
  try {
    const res = await fetch((cfg.baseUrl || "").replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        temperature: 0.2,
        max_tokens: 300,
        thinking: { type: "disabled" },
        messages: buildExplainMessages(info),
      }),
      signal: aiAbort.signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = (j.error && j.error.message) || msg;
      } catch {}
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let done = false;
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") {
          done = true;
          break;
        }
        try {
          const j = JSON.parse(payload);
          const delta = j.choices && j.choices[0] && j.choices[0].delta;
          if (!delta) continue;
          // DeepSeek v4 等推理模型先流式输出 reasoning_content(思考),后输出 content(正文)。
          // 增量只进缓冲,渲染经 renderer 节流合并。
          if (delta.reasoning_content) {
            reasoningBuf += delta.reasoning_content;
            renderer.schedule();
          }
          if (delta.content) {
            contentBuf += delta.content;
            renderer.schedule();
          }
        } catch {}
      }
    }
    renderer.flush();
    // 只有思考没有正文(异常截断)时,保留思考内容作为结果
    if (!contentBuf && reasoningBuf) {
      out.innerHTML = `<span class="dim">💭 模型只输出了思考过程(可能被截断):\n\n${esc(reasoningBuf)}</span>`;
    }
    setStatus("完成", false);
  } catch (err) {
    renderer.cancel();
    if (err && err.name === "AbortError") {
      if (contentBuf) out.innerHTML = mdToHtml(contentBuf);
      setStatus("已停止", false);
    } else {
      const msg = String((err && err.message) || err);
      out.innerHTML =
        `<span class="ap-err">模型调用失败:${esc(msg)}</span>` +
        `<span class="ap-err">\n\n排查建议:\n· 本地 Ollama 需先设 OLLAMA_ORIGINS=* 再启动;\n· 在线端点需允许浏览器跨域(CORS),部分服务只允许服务端调用;\n· 检查 Base URL(以 /v1 结尾)、模型名与 API Key。\n\n下面先给出离线分析:\n\n</span>` +
        mdToHtml(offlineExplain(info));
      setStatus("失败,已回退离线分析", false);
    }
  } finally {
    aiAbort = null;
    $(".ap-stop", panel).style.display = "none";
  }
}

/* ============ 点击函数块 → AI 一句话解释 ============ */
function fnbInfo(fnb) {
  const rows = fnb.querySelectorAll(".cl");
  if (!rows.length) return null;
  const startLine = parseInt(rows[0].id.slice(1), 10);
  const endLine = parseInt(rows[rows.length - 1].id.slice(1), 10);
  if (!startLine || !endLine) return null;
  const text = Array.from(rows)
    .map((r) => {
      const lc = r.querySelector(".lc");
      return lc ? lc.textContent : "";
    })
    .join("\n");
  if (!text.trim()) return null;
  const box = fnb.closest(".codebox");
  const segIdx = box ? Number(box.dataset.seg) : null;
  const f = state.file ? byPath.get(state.file) : null;
  return {
    text,
    file: state.file || "",
    startLine,
    endLine,
    segIdx,
    seg: f && segIdx !== null ? f.segs[segIdx] : null,
    fileDesc: f ? f.desc : "",
  };
}
function bindFnClick() {
  $("#main").addEventListener("click", (e) => {
    if (e.target.closest("button, .c-head, .selbtn, .aipanel, .floatwin, .annot, .codetip, .filehead")) return;
    // 有文本选区时,这次点击属于选区流程(划选 → ✨ 按钮),不触发函数解释
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const fnb = e.target.closest(".fnb");
    if (!fnb) return;
    const info = fnbInfo(fnb);
    if (info) {
      hideSelBtn();
      openAIPanel(info);
    }
  });
}

/* ============ 右侧 AI 陪读助手 ============ */
let dockCtx = null; // 当前陪读代码上下文 {file,startLine,endLine,code,seg}
let dockMessages = []; // 陪读会话历史
let dockAbort = null;

function dockEls() {
  return {
    dock: $("#aidock"),
    thread: $("#ad-thread"),
    status: $("#aidock .ad-status"),
    q: $("#aidock .ad-q"),
  };
}
function dockSetStatus(text, busy) {
  const { status } = dockEls();
  if (!status) return;
  status.textContent = text || "";
  status.classList.toggle("busy", Boolean(busy));
  const stop = $(".ad-stop");
  if (stop) stop.style.display = busy ? "" : "none";
}
function dockOpenToggle(force) {
  const { dock } = dockEls();
  const open = force !== undefined ? force : dock.classList.contains("hidden");
  dock.classList.toggle("hidden", !open);
  $("#btn-dock").classList.toggle("on", open);
  localStorage.setItem("cv-dock", open ? "1" : "0");
}
function dockCard(cls) {
  const { thread } = dockEls();
  const card = document.createElement("div");
  card.className = "ad-msg " + cls;
  card.innerHTML = `<div class="ap-out"></div>`;
  thread.appendChild(card);
  thread.scrollTop = thread.scrollHeight;
  return card.querySelector(".ap-out");
}
function dockTopicCard(info, oneSentence) {
  const { thread } = dockEls();
  const card = document.createElement("div");
  card.className = "ad-topic";
  const range = info.startLine ? `L${info.startLine}–L${info.endLine}` : "选区";
  const meta = `📄 ${info.file.split("/").pop()} · ${range} · ${info.text.trim().split(/\n/).length} 行`;
  card.textContent = oneSentence ? `${meta} — ${oneSentence}` : meta;
  card.title = oneSentence || meta;
  thread.appendChild(card);
  thread.scrollTop = thread.scrollHeight;
}
function dockSystemPrompt() {
  const c = dockCtx;
  return (
    "你是代码陪读导师,面向想深入理解源码的读者。当前讨论的代码:" +
    c.file +
    " L" +
    c.startLine +
    "–L" +
    c.endLine +
    "\n```\n" +
    (c.code || "").slice(0, 6000) +
    "\n```\n用中文讲解:清晰分层(整体职责 → 逐块关键逻辑 → 设计意图与边界),引用真实标识符,可用小标题/列表/短代码块,避免空话与整段复述代码。"
  );
}
async function dockStream(messages, outEl) {
  const cfg = loadAIConfig();
  if (!cfg.baseUrl || !cfg.model) {
    outEl.innerHTML = `<span class="ap-err">未配置模型:请在 AI 解释面板 ⚙️ 模型设置 里选择提供商(本地代理 /ai-proxy 已就绪)。</span>`;
    dockSetStatus("", false);
    return null;
  }
  if (dockAbort) dockAbort.abort();
  dockAbort = new AbortController();
  dockSetStatus("生成中…", true);
  let reasoningBuf = "";
  let contentBuf = "";
  // 节流渲染:增量只累积,~90ms 合并重渲染 + 滚动跟随
  const renderer = makeStreamRenderer(
    () => {
      if (contentBuf) {
        outEl.innerHTML = mdToHtml(contentBuf);
        dockSetStatus(`生成中… ${contentBuf.length} 字`, true);
      } else if (reasoningBuf) {
        outEl.innerHTML = `<span class="dim">💭 思考中(${reasoningBuf.length} 字)…</span>`;
        dockSetStatus(`思考中… ${reasoningBuf.length} 字`, true);
      }
    },
    outEl.closest(".ad-thread")
  );
  // 新一轮回答:恢复滚动跟随(用户此前可能上滚阅读)
  const threadEl = outEl.closest(".ad-thread");
  if (threadEl) followStateOf(threadEl).follow = true;
  let done = false;
  try {
    const res = await fetch(cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.apiKey ? { Authorization: "Bearer " + cfg.apiKey } : {}),
      },
      body: JSON.stringify({
        model: cfg.model,
        stream: true,
        temperature: 0.3,
        max_tokens: 2000,
        thinking: { type: "disabled" },
        messages,
      }),
      signal: dockAbort.signal,
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const j = await res.json();
        msg = (j.error && j.error.message) || msg;
      } catch {}
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop();
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith("data:")) continue;
        const payload = t.slice(5).trim();
        if (payload === "[DONE]") {
          done = true;
          break;
        }
        try {
          const j = JSON.parse(payload);
          const delta = j.choices && j.choices[0] && j.choices[0].delta;
          if (!delta) continue;
          if (delta.reasoning_content) {
            reasoningBuf += delta.reasoning_content;
            renderer.schedule();
          }
          if (delta.content) {
            contentBuf += delta.content;
            renderer.schedule();
          }
        } catch {}
      }
    }
    renderer.flush();
    if (!contentBuf && reasoningBuf) {
      outEl.innerHTML = `<span class="dim">💭 模型只输出了思考过程:\n\n${esc(reasoningBuf)}</span>`;
    } else if (!contentBuf) {
      outEl.innerHTML = mdToHtml("(无输出)");
    }
    dockSetStatus("完成", false);
    return contentBuf || null;
  } catch (err) {
    renderer.cancel();
    if (err && err.name === "AbortError") {
      if (contentBuf) outEl.innerHTML = mdToHtml(contentBuf);
      dockSetStatus("已停止", false);
      return contentBuf || null;
    }
    outEl.innerHTML = `<span class="ap-err">调用失败:${esc(String((err && err.message) || err))}</span>`;
    dockSetStatus("失败", false);
    return null;
  } finally {
    dockAbort = null;
  }
}
async function dockDeepDive(info, oneSentence) {
  dockOpenToggle(true);
  if (dockAbort) dockAbort.abort();
  dockCtx = { file: info.file, startLine: info.startLine, endLine: info.endLine, code: info.text, seg: info.seg };
  dockMessages = [];
  dockTopicCard(info, oneSentence);
  const outEl = dockCard("ai");
  const userMsg =
    (oneSentence ? `已有的一句话解释:${oneSentence}\n` : "") +
    "请深入讲解这段代码:整体职责 → 逐块关键逻辑(引用标识符)→ 设计意图与边界情况。读者觉得一句话解释不够,想要真正理解。";
  dockMessages.push({ role: "user", content: userMsg });
  const answer = await dockStream([{ role: "system", content: dockSystemPrompt() }, ...dockMessages], outEl);
  if (answer) dockMessages.push({ role: "assistant", content: answer });
}
async function dockAsk(q) {
  if (!dockCtx) {
    toast("先点击函数或划选片段,再用「📚 深度理解」送入陪读");
    return;
  }
  if (dockAbort) dockAbort.abort();
  const userEl = dockCard("user");
  userEl.textContent = q;
  dockMessages.push({ role: "user", content: q });
  const outEl = dockCard("ai");
  const answer = await dockStream(
    [{ role: "system", content: dockSystemPrompt() }, ...dockMessages.slice(-12)],
    outEl
  );
  if (answer) dockMessages.push({ role: "assistant", content: answer });
}
function initDock() {
  $("#btn-dock").addEventListener("click", () => dockOpenToggle());
  $(".ad-close").addEventListener("click", () => dockOpenToggle(false));
  const send = () => {
    const { q } = dockEls();
    const val = q.value.trim();
    if (!val) return;
    q.value = "";
    dockAsk(val);
  };
  $(".ad-send").addEventListener("click", send);
  $(".ad-stop").addEventListener("click", () => {
    if (dockAbort) dockAbort.abort();
  });
  $(".ad-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });
  // 拖宽
  const sp = $("#asplit");
  const dock = $("#aidock");
  sp.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sp.classList.add("drag");
    const move = (ev) => {
      const w = Math.min(window.innerWidth - 420, Math.max(280, window.innerWidth - ev.clientX));
      dock.style.width = `${w}px`;
    };
    const up = () => {
      sp.classList.remove("drag");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
  if (localStorage.getItem("cv-dock") === "1") dockOpenToggle(true);
}

/* ============ 侧栏拖宽 ============ */
function bindSidebarDrag() {
  const sp = $("#vsplit");
  const sb = $("#sidebar");
  sp.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    sp.classList.add("drag");
    document.body.style.cursor = "col-resize";
    const move = (ev) => {
      const w = Math.min(520, Math.max(180, ev.clientX));
      sb.style.width = `${w}px`;
    };
    const up = () => {
      sp.classList.remove("drag");
      document.body.style.cursor = "";
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  });
}

/* ============ 初始化 ============ */
function applyTheme() {
  document.documentElement.dataset.theme = state.theme;
  $("#btn-theme").textContent = state.theme === "dark" ? "☀️ 亮色" : "🌙 暗色";
}
function applyMode() {
  $("#btn-mode").textContent = state.mode === "split" ? "⊟ 交错" : "⊞ 并排";
  $("#btn-mode").classList.toggle("on", state.mode === "split");
}
function applyFs() {
  const base = 12.5 + state.fs * 0.5;
  document.documentElement.style.setProperty("--code-fs", `${base}px`);
}
function applyWrap() {
  document.body.classList.toggle("wrap", state.wrap);
  $("#btn-wrap").classList.toggle("on", state.wrap);
}
/* ============ macOS 窗口外壳(红绿灯 / 铺满 / 程序坞 / 时钟 / 标题栏拖动) ============ */
function setMacTitle(t) {
  const el = $("#mac-title");
  if (el) el.textContent = t || "";
}
function macApplyMax(on) {
  const win = $("#macwin");
  if (win) win.classList.toggle("max", Boolean(on));
}
function initMacChrome() {
  const win = $("#macwin");
  if (!win) return;
  // 默认铺满(体验最好),记住上次选择
  macApplyMax(localStorage.getItem("cv-macmax") !== "0");
  // 绿灯:窗口铺满 + 请求浏览器全屏;再点还原
  $("#tl-green").addEventListener("click", async () => {
    const on = !win.classList.contains("max");
    macApplyMax(on);
    localStorage.setItem("cv-macmax", on ? "1" : "0");
    win.style.transform = "";
    win.dataset.dx = 0;
    win.dataset.dy = 0;
    try {
      if (on && !document.fullscreenElement) await document.documentElement.requestFullscreen();
      else if (!on && document.fullscreenElement) await document.exitFullscreen();
    } catch {}
  });
  // 红灯/黄灯:收起到程序坞,点程序坞图标恢复
  const minimize = () => {
    win.style.transform = "";
    win.dataset.dx = 0;
    win.dataset.dy = 0;
    win.classList.add("mini");
    $("#macdock").classList.remove("hidden");
  };
  $("#tl-red").addEventListener("click", minimize);
  $("#tl-yellow").addEventListener("click", minimize);
  $("#macdock-btn").addEventListener("click", () => {
    win.classList.remove("mini");
    $("#macdock").classList.add("hidden");
  });
  // 双击标题栏:切换铺满;拖动标题栏:窗口化时移动窗口
  const title = $("#mactitle");
  title.addEventListener("dblclick", (e) => {
    if (e.target.closest(".tl")) return;
    $("#tl-green").click();
  });
  let drag = null;
  title.addEventListener("pointerdown", (e) => {
    if (e.target.closest(".tl") || win.classList.contains("max")) return;
    drag = { x: e.clientX, y: e.clientY, dx: Number(win.dataset.dx || 0), dy: Number(win.dataset.dy || 0) };
    title.setPointerCapture(e.pointerId);
  });
  title.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = drag.dx + e.clientX - drag.x;
    const dy = drag.dy + e.clientY - drag.y;
    win.dataset.dx = dx;
    win.dataset.dy = dy;
    win.style.transform = `translate(${dx}px, ${dy}px)`;
  });
  const endDrag = () => (drag = null);
  title.addEventListener("pointerup", endDrag);
  title.addEventListener("pointercancel", endDrag);
  // F11 浏览器全屏时窗口同步铺满,退出时还原上次偏好
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) macApplyMax(true);
    else macApplyMax(localStorage.getItem("cv-macmax") !== "0");
  });
  // 菜单栏时钟
  const clock = $("#mac-clock");
  if (clock) {
    const tick = () => {
      const d = new Date();
      const wd = ["日", "一", "二", "三", "四", "五", "六"][d.getDay()];
      clock.textContent = `${d.getMonth() + 1}月${d.getDate()}日 周${wd} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    };
    tick();
    setInterval(tick, 15000);
  }
}
function init() {
  // 工具栏
  $("#logo").addEventListener("click", () => {
    state.file = null;
    location.hash = "";
    renderTree();
    renderOverview();
  });
  $("#btn-mode").addEventListener("click", () => {
    state.mode = state.mode === "split" ? "stack" : "split";
    localStorage.setItem("cv-mode", state.mode);
    applyMode();
    const f = state.file ? byPath.get(state.file) : null;
    if (f) renderFile(f);
  });
  $("#btn-theme").addEventListener("click", () => {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("cv-theme", state.theme);
    applyTheme();
  });
  $("#btn-fs-plus").addEventListener("click", () => {
    state.fs = Math.min(6, state.fs + 1);
    localStorage.setItem("cv-fs", state.fs);
    applyFs();
  });
  $("#btn-fs-minus").addEventListener("click", () => {
    state.fs = Math.max(-4, state.fs - 1);
    localStorage.setItem("cv-fs", state.fs);
    applyFs();
  });
  $("#btn-wrap").addEventListener("click", () => {
    state.wrap = !state.wrap;
    localStorage.setItem("cv-wrap", state.wrap ? "1" : "0");
    applyWrap();
  });
  $("#btn-side").addEventListener("click", () => {
    state.sidebarHidden = !state.sidebarHidden;
    $("#sidebar").classList.toggle("hidden", state.sidebarHidden);
    $("#vsplit").style.display = state.sidebarHidden ? "none" : "";
    $("#btn-side").classList.toggle("on", state.sidebarHidden);
  });
  // 搜索
  const search = $("#search");
  search.addEventListener("input", () => runSearch(search.value.trim()));
  search.addEventListener("focus", () => search.value.trim() && runSearch(search.value.trim()));
  search.addEventListener("keydown", (e) => {
    const box = $("#results");
    if (e.key === "Escape") {
      box.classList.remove("open");
      search.blur();
      return;
    }
    if (!box.classList.contains("open")) return;
    const items = box._items || [];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      box._active = Math.max(0, Math.min(items.length - 1, box._active + (e.key === "ArrowDown" ? 1 : -1)));
      items.forEach((x, i) => x.classList.toggle("active", i === box._active));
      items[box._active] && items[box._active].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      const hits = box._hits || [];
      if (hits[box._active]) gotoHit(hits[box._active]);
    }
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#searchwrap")) $("#results").classList.remove("open");
  });
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      $("#search").focus();
      $("#search").select();
    } else if (e.key === "/" && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) {
      e.preventDefault();
      $("#search").focus();
    }
  });
  $("#tree-filter").addEventListener("input", renderTree);
  $("#totop").addEventListener("click", () => {
    ($("#col-code") || $("#main")).scrollTo({ top: 0, behavior: "smooth" });
  });
  $("#main").addEventListener("scroll", () => {
    $("#totop").style.display = $("#main").scrollTop > 400 ? "block" : "none";
  });

  bindSidebarDrag();
  bindCodeHover();
  bindSelectionAssistant();
  bindFnClick();
  initDock();
  applyTheme();
  applyMode();
  applyFs();
  applyWrap();
  initMacChrome();
  renderTree();

  // hash 直达(文件路径或 g:组名 的分组导览)
  const hash = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (hash && hash.startsWith("g:")) openGroupHome(hash.slice(2));
  else if (hash && byPath.has(hash)) openFile(hash);
  else renderOverview();

  // 统计
  $("#stats").textContent = `${DATA.meta.totalFiles} 文件 · ${DATA.meta.totalLines.toLocaleString()} 行 · ${DATA.meta.totalSegs} 段注解`;
}
document.addEventListener("DOMContentLoaded", init);
