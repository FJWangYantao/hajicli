#!/usr/bin/env node
/**
 * 截图工具：把网页 / 本地 HTML / 任意 GUI 程序截成图片，供 read 工具在终端里内联显示
 *
 * 为什么需要它：harness 只在「工具返回图片部件」时才把图渲染到终端（opentui 按
 * kitty graphics > sixel > blocks 半块字符自动降级），所以流程固定为
 * 「截图落盘 → read 该文件」。本脚本负责前一步，并默认按宽度缩放，避免一张大图吃掉太多上下文。
 *
 * 模式：
 *   1) 网页模式（默认，跨平台，走 headless Chrome）
 *      node scripts/shot.mjs <url|本地html路径>
 *   2) 窗口模式（仅 Linux：Xvfb 里跑 GUI 程序，用 ffmpeg x11grab 抓一帧）
 *      node scripts/shot.mjs --app "xterm -e top"
 *
 * 用法：
 *   node scripts/shot.mjs https://example.com
 *   node scripts/shot.mjs ./report.html --full --format jpeg          # 整页截图（走 CDP）
 *   node scripts/shot.mjs --app "python3 my_gui.py" --wait 3000
 *   node scripts/shot.mjs ./already.png --convert-only --max-width 900 # 只缩放/转码
 *
 * 选项：
 *   --full              整页截图（仅网页模式）：经 CDP 取页面内容尺寸后一次拍完
 *   --out <path>        输出路径（默认 <tmp>/opencode-shots/shot-<时间戳>.<ext>）
 *   --size WxH          视口尺寸，默认 1280x800；--full 时高度只是初始视口
 *   --max-width <px>    截图后缩到该宽度，默认 1400；0 表示不缩放
 *   --format png|jpeg   输出格式，默认 png（jpeg 更省 token，适合照片/长图）
 *   --quality <1-31>    jpeg 质量（ffmpeg -q:v），默认 4，数字越小越清晰
 *   --wait <ms>         渲染/启动等待，默认 1500
 *   --app "<命令>"      窗口模式：在 Xvfb 里启动该命令再截图（Linux only）
 *   --convert-only      输入已是图片，只做缩放/格式转换
 *   --keep-raw          缩放/转码时把未处理的原始图另存为 <out>.raw.png
 *   -h, --help          显示帮助
 *
 * 依赖：headless Chrome（或 CHROME_PATH）；缩放/转码用 ffmpeg（缺失时若无需缩放则原样输出）；
 *       窗口模式需要 Xvfb + ffmpeg。
 */
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Chrome 单次可渲染的高度上限：超过就得截断（想全要请分段） */
const MAX_FULL_HEIGHT = 16384;
const CDP_TIMEOUT = 30000;

const HELP = `用法: node scripts/shot.mjs <url|html|图片> [选项]
      node scripts/shot.mjs --app "<gui 命令>" [选项]

选项:
  --full             整页截图（仅网页模式，走 CDP）
  --out <path>       输出路径
  --size WxH         视口尺寸（默认 1280x800）
  --max-width <px>   截图后缩放到该宽度（默认 1400，0=不缩放）
  --format png|jpeg  输出格式（默认 png，按 --out 扩展名推断）
  --quality <1-31>   jpeg 质量（默认 4，越小越清晰）
  --wait <ms>        渲染/启动等待（默认 1500）
  --app "<命令>"     在 Xvfb 里启动后截图（仅 Linux）
  --convert-only     输入是已有图片，只缩放/转格式
  --keep-raw         缩放时另存原始图 <out>.raw.png
  -h, --help         显示帮助

截完用 read 工具读输出路径，终端里就能内联看到图片。`;

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--out") args.out = argv[++i];
    else if (a === "--size") args.size = argv[++i];
    else if (a === "--max-width") args.maxWidth = Number(argv[++i]);
    else if (a === "--format") args.format = argv[++i];
    else if (a === "--quality") args.quality = Number(argv[++i]);
    else if (a === "--wait") args.wait = Number(argv[++i]);
    else if (a === "--app") args.app = argv[++i];
    else if (a === "--full") args.full = true;
    else if (a === "--convert-only") args.convertOnly = true;
    else if (a === "--keep-raw") args.keepRaw = true;
    else if (a === "-h" || a === "--help") args.help = true;
    else args._.push(a);
  }
  return args;
}

function parseSize(size) {
  const m = /^(\d+)x(\d+)$/i.exec(size || "");
  if (!m) throw new Error(`--size 需要 WxH 形式，收到: ${size}`);
  return { width: Number(m[1]), height: Number(m[2]) };
}

/** 在 PATH 与常见安装位置里找可执行文件（不经过 shell） */
function findExecutable(names, extraPaths = []) {
  const candidates = [...extraPaths];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) candidates.push(path.join(dir, name));
  }
  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isFile()) {
        fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      }
    } catch {
      // 继续找下一个
    }
  }
  return undefined;
}

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  if (process.platform === "win32") {
    const roots = [
      process.env.PROGRAMFILES,
      process.env["PROGRAMFILES(X86)"],
      process.env.LOCALAPPDATA,
    ].filter(Boolean);
    const win = roots.flatMap((root) => [
      path.join(root, "Google/Chrome/Application/chrome.exe"),
      path.join(root, "Microsoft/Edge/Application/msedge.exe"),
      path.join(root, "Chromium/Application/chrome.exe"),
    ]);
    return findExecutable(["chrome.exe", "msedge.exe"], win);
  }
  if (process.platform === "darwin") {
    return findExecutable(
      ["chrome", "chromium"],
      [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ],
    );
  }
  return findExecutable([
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
    "chrome",
    "microsoft-edge",
  ]);
}

function findFfmpeg() {
  return process.env.FFMPEG_PATH || findExecutable(["ffmpeg", "ffmpeg.exe"]);
}

function defaultOut(format) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  return path.join(
    os.tmpdir(),
    "opencode-shots",
    `shot-${stamp}.${format === "jpeg" ? "jpg" : "png"}`,
  );
}

function toUrl(target) {
  if (/^(https?|data|file|about|chrome):/i.test(target)) return target;
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new Error(`文件不存在: ${abs}`);
  return pathToFileURL(abs).href;
}

function chromeArgs(profileDir, size, extra) {
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-dev-shm-usage",
    `--user-data-dir=${profileDir}`,
    `--window-size=${size.width},${size.height}`,
    ...extra,
  ];
  if (process.getuid?.() === 0) args.unshift("--no-sandbox");
  return args;
}

/** 一次性截图（只截视口），不启调试端口，最快 */
async function captureViewport(chrome, url, rawPath, { profileDir, size, wait }) {
  const args = chromeArgs(profileDir, size, [
    `--virtual-time-budget=${Math.max(500, wait)}`,
    `--screenshot=${rawPath}`,
    url,
  ]);
  await execFileAsync(chrome, args, { timeout: wait + 30000, maxBuffer: 8 * 1024 * 1024 });
  if (!fs.existsSync(rawPath)) throw new Error("Chrome 没有写出截图文件（检查 URL 是否可达）");
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(100);
  }
  throw new Error(`等待超时: ${what}`);
}

/** 客户端 WebSocket：只实现 CDP 需要的文本帧 + 掩码 + ping/pong，避免引依赖 */
class WsClient {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = 0;
    this.onmessage = () => {};
    this.onclose = () => {};
    socket.on("data", (chunk) => this.consume(chunk));
    socket.on("close", () => this.onclose());
    socket.on("error", () => {});
  }

  static async connect(url) {
    const target = new URL(url);
    const socket = net.connect(Number(target.port || 80), target.hostname);
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const key = randomBytes(16).toString("base64");
    socket.write(
      [
        `GET ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
    let buffer = Buffer.alloc(0);
    const rest = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket 握手超时")), 10000);
      const onData = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        clearTimeout(timer);
        socket.removeListener("data", onData);
        const head = buffer.subarray(0, end).toString("latin1");
        if (!/^HTTP\/1\.1 101/.test(head)) {
          reject(new Error(`WebSocket 握手失败: ${head.split("\r\n")[0]}`));
          return;
        }
        resolve(buffer.subarray(end + 4));
      };
      socket.on("data", onData);
      socket.once("error", reject);
    });
    const client = new WsClient(socket);
    if (rest.length) client.consume(rest);
    return client;
  }

  send(text) {
    const payload = Buffer.from(text, "utf8");
    const mask = randomBytes(4);
    let header;
    if (payload.length < 126) {
      header = Buffer.from([0x81, 0x80 | payload.length]);
    } else if (payload.length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x81;
      header[1] = 0x80 | 126;
      header.writeUInt16BE(payload.length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 0x80 | 127;
      header.writeBigUInt64BE(BigInt(payload.length), 2);
    }
    const masked = Buffer.alloc(payload.length);
    for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  close() {
    if (this.socket.destroyed) return;
    this.socket.write(Buffer.from([0x88, 0x80, 0, 0, 0, 0]));
    this.socket.end();
    this.socket.destroy();
  }

  consume(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const frame = readFrame(this.buffer);
      if (!frame) return;
      this.buffer = this.buffer.subarray(frame.length);
      this.handleFrame(frame);
    }
  }

  handleFrame({ opcode, payload, fin }) {
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode === 0x9) {
      const mask = randomBytes(4);
      const masked = Buffer.alloc(payload.length);
      for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i % 4];
      this.socket.write(Buffer.concat([Buffer.from([0x8a, 0x80 | payload.length]), mask, masked]));
      return;
    }
    if (opcode === 0xa) return;
    if (opcode === 0x1 || opcode === 0x2) {
      this.fragments = [payload];
      this.fragmentOpcode = opcode;
    } else if (opcode === 0x0) {
      this.fragments.push(payload);
    } else {
      return;
    }
    if (!fin) return;
    const full = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === 0x1) this.onmessage(full.toString("utf8"));
  }
}

/** 从缓冲区切出一个帧；数据不完整返回 undefined */
function readFrame(buffer) {
  if (buffer.length < 2) return undefined;
  const fin = (buffer[0] & 0x80) !== 0;
  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskEnd = masked ? offset + 4 : offset;
  if (buffer.length < maskEnd + length) return undefined;
  let payload = buffer.subarray(maskEnd, maskEnd + length);
  if (masked) {
    const mask = buffer.subarray(offset, maskEnd);
    payload = Buffer.from(payload.map((byte, i) => byte ^ mask[i % 4]));
  }
  return { opcode, payload, fin, length: maskEnd + length };
}

/** 极简 CDP 客户端：request/response + 一次性事件等待 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    ws.onmessage = (text) => this.dispatch(text);
    ws.onclose = () => {
      for (const entry of this.pending.values()) {
        clearTimeout(entry.timer);
        entry.reject(new Error("CDP 连接已关闭"));
      }
      this.pending.clear();
    };
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 超时: ${method}`));
      }, CDP_TIMEOUT);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  dispatch(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      clearTimeout(entry.timer);
      if (message.error) entry.reject(new Error(message.error.message || "CDP 调用失败"));
      else entry.resolve(message.result);
      return;
    }
    const handler = this.listeners.get(message.method);
    if (handler) {
      this.listeners.delete(message.method);
      handler(message.params);
    }
  }

  waitFor(method, timeoutMs = CDP_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(method);
        reject(new Error(`等待事件超时: ${method}`));
      }, timeoutMs);
      this.listeners.set(method, (params) => {
        clearTimeout(timer);
        resolve(params);
      });
    });
  }
}

/** 整页截图：取 cssContentSize 后带 clip 一次拍完，超过 MAX_FULL_HEIGHT 截断 */
async function captureFullPage(chrome, url, rawPath, { profileDir, size, wait }) {
  const portFile = path.join(profileDir, "DevToolsActivePort");
  const chromeProc = spawn(
    chrome,
    chromeArgs(profileDir, size, ["--remote-debugging-port=0", "about:blank"]),
    {
      stdio: "ignore",
    },
  );
  let ws;
  try {
    await waitFor(() => fs.existsSync(portFile), 15000, "Chrome 调试端口就绪");
    const port = Number.parseInt(fs.readFileSync(portFile, "utf8").split("\n")[0], 10);
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (!page) throw new Error("Chrome 没有可用的页面目标");
    ws = await WsClient.connect(page.webSocketDebuggerUrl);
    const cdp = new Cdp(ws);
    await cdp.send("Page.enable");
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: size.width,
      height: size.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    const loaded = cdp.waitFor("Page.loadEventFired", Math.max(CDP_TIMEOUT, wait + 10000));
    await cdp.send("Page.navigate", { url });
    // load 事件可能早于监听或压根不触发（about:blank / 缓存），超时不致命
    await loaded.catch(() => {});
    await sleep(Math.max(300, wait));

    const metrics = await cdp.send("Page.getLayoutMetrics");
    const content = metrics.cssContentSize ||
      metrics.contentSize || { width: size.width, height: size.height };
    const width = Math.max(size.width, Math.ceil(content.width) || size.width);
    let height = Math.ceil(content.height);
    if (!Number.isFinite(height) || height <= 0) height = size.height;
    if (height > MAX_FULL_HEIGHT) {
      console.error(
        `提示: 整页高度 ${height}px 超过 Chrome 上限，已截断到 ${MAX_FULL_HEIGHT}px（可分段截）`,
      );
      height = MAX_FULL_HEIGHT;
    }
    const shot = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    fs.writeFileSync(rawPath, Buffer.from(shot.data, "base64"));
  } finally {
    try {
      ws?.close();
    } catch {
      // 关闭失败无所谓，下面还会杀进程
    }
    await stopProcess(chromeProc);
  }
}

async function captureWeb(target, rawPath, { size, wait, full }) {
  const chrome = findChrome();
  if (!chrome) {
    throw new Error("找不到 Chrome/Chromium：装一个，或用 CHROME_PATH 指向可执行文件（Edge 也行）");
  }
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-chrome-"));
  try {
    const url = toUrl(target);
    if (full) await captureFullPage(chrome, url, rawPath, { profileDir, size, wait });
    else await captureViewport(chrome, url, rawPath, { profileDir, size, wait });
  } catch (e) {
    const tail = String(e.stderr || e.stdout || e.message || "")
      .trim()
      .split("\n")
      .slice(-5)
      .join("\n");
    throw new Error(`Chrome 截图失败: ${tail}`);
  } finally {
    // Chrome 的 helper 进程可能比主进程晚一步收尾，rm 带重试，避免残留 profile 目录
    fs.rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (!fs.existsSync(rawPath)) throw new Error("Chrome 没有写出截图文件（检查 URL 是否可达）");
}

function pickDisplay() {
  for (let n = 99; n >= 90; n--) {
    if (!fs.existsSync(`/tmp/.X11-unix/X${n}`)) return n;
  }
  throw new Error("没有空闲的 X display（:90-:99 都被占用）");
}

async function stopProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  proc.kill("SIGTERM");
  for (let i = 0; i < 10; i++) {
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await sleep(100);
  }
  proc.kill("SIGKILL");
}

/** Xvfb 里跑 GUI 程序，再用 ffmpeg 抓一帧；仅 Linux */
async function captureApp(command, rawPath, { size, wait }) {
  if (process.platform !== "linux") throw new Error("--app 模式依赖 Xvfb，仅支持 Linux");
  const xvfb = findExecutable(["Xvfb"]);
  if (!xvfb) throw new Error("找不到 Xvfb，请先安装（apt install xvfb）");
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) throw new Error("抓取 X 画面需要 ffmpeg（apt install ffmpeg）");

  const display = `:${pickDisplay()}`;
  const xvfbProc = spawn(
    xvfb,
    [display, "-screen", "0", `${size.width}x${size.height}x24`, "-nolisten", "tcp"],
    {
      stdio: "ignore",
    },
  );
  let appProc;
  try {
    await waitFor(() => fs.existsSync(`/tmp/.X11-unix/X${display.slice(1)}`), 5000, "Xvfb 启动");
    appProc = spawn("/bin/sh", ["-c", command], {
      stdio: "ignore",
      // 补一个 UTF-8 locale，否则 X11 应用（xmessage 等）会把中文按 Latin-1 渲染成乱码
      env: { ...process.env, DISPLAY: display, LANG: process.env.LANG || "C.UTF-8" },
    });
    appProc.on("error", () => {});
    await sleep(Math.max(200, wait));
    await execFileAsync(
      ffmpeg,
      [
        "-v",
        "error",
        "-y",
        "-f",
        "x11grab",
        "-video_size",
        `${size.width}x${size.height}`,
        "-i",
        display,
        "-frames:v",
        "1",
        rawPath,
      ],
      { timeout: 30000 },
    );
  } finally {
    await stopProcess(appProc);
    await stopProcess(xvfbProc);
  }
  if (!fs.existsSync(rawPath)) throw new Error("ffmpeg 没有写出截图文件");
}

/** 读 PNG/JPEG 头部取尺寸；认不出来返回 0（此时不缩放，避免把小图放大） */
function probeImageSize(file) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(256 * 1024);
    const read = fs.readSync(fd, buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, read);
    if (bytes.length > 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
      return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
    }
    if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xff) {
          i++;
          continue;
        }
        const marker = bytes[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          i += 2;
          continue;
        }
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)) {
          return { width: bytes.readUInt16BE(i + 7), height: bytes.readUInt16BE(i + 5) };
        }
        i += 2 + bytes.readUInt16BE(i + 2);
      }
    }
    return { width: 0, height: 0 };
  } finally {
    fs.closeSync(fd);
  }
}

/** 把原始截图整理成最终文件：按需缩放 + 转码；不需要动就复制 */
async function finalize(rawPath, out, { maxWidth, format, quality, keepRaw }) {
  const size = probeImageSize(rawPath);
  const needScale = maxWidth > 0 && size.width > maxWidth;
  const needJpeg = format === "jpeg";

  if (!needScale && !needJpeg) {
    if (path.resolve(rawPath) !== path.resolve(out)) fs.copyFileSync(rawPath, out);
    return { ...size, scaled: false };
  }

  const ffmpeg = findFfmpeg();
  if (!ffmpeg) {
    if (needJpeg) throw new Error("转 jpeg 需要 ffmpeg，请安装或设置 FFMPEG_PATH");
    console.error("提示: 没找到 ffmpeg，跳过缩放，直接输出原始截图");
    fs.copyFileSync(rawPath, out);
    return { ...size, scaled: false };
  }

  if (keepRaw && needScale) {
    const kept = out.replace(/(\.[a-z]+)$/i, ".raw.png");
    fs.copyFileSync(rawPath, kept);
    console.error(`原始截图保留在: ${kept}`);
  }

  const args = ["-v", "error", "-y", "-i", rawPath];
  if (needScale) args.push("-vf", `scale=${maxWidth}:-2:flags=lanczos`);
  if (needJpeg)
    args.push("-q:v", String(Math.min(31, Math.max(1, quality))), "-pix_fmt", "yuvj420p");
  args.push(out);
  await execFileAsync(ffmpeg, args, { timeout: 60000 });
  const finalSize = probeImageSize(out);
  return { ...finalSize, scaled: needScale };
}

function report(file, info) {
  const bytes = fs.statSync(file).size;
  const dims =
    info?.width && info?.height
      ? `, ${info.width}×${info.height}${info.scaled ? "（已缩放）" : ""}`
      : "";
  console.log(`截图: ${file}  (${(bytes / 1024).toFixed(0)} KB${dims})`);
  if (info?.height > 8000) {
    console.error("提示: 图太高，终端里 blocks 降级会很难看清，建议配合 --max-width 缩小或分段截");
  }
  if (bytes > 20 * 1024 * 1024) {
    console.error(
      "警告: 超过 read 工具 20 MiB 上限，请调小 --size / --max-width 或改用 --format jpeg",
    );
  }
  if (file.startsWith(path.join(os.tmpdir(), "opencode-shots"))) {
    console.log("下一步: 用 read 工具读取该路径即可在终端内联显示（临时目录，重启后可能被清理）");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP);
    return;
  }
  const target = args._[0];
  if (!target && !args.app) {
    console.error(HELP);
    process.exit(2);
  }
  if (args.full && (args.app || args.convertOnly)) {
    throw new Error("--full 只能用于网页模式，不能和 --app / --convert-only 一起用");
  }

  const format = (args.format || (/\.jpe?g$/i.test(args.out || "") ? "jpeg" : "png")).toLowerCase();
  if (!["png", "jpeg"].includes(format))
    throw new Error(`--format 只支持 png / jpeg，收到: ${format}`);
  const size = parseSize(args.size || "1280x800");
  const wait = Number.isFinite(args.wait) ? args.wait : 1500;
  const maxWidth = Number.isFinite(args.maxWidth) ? args.maxWidth : 1400;
  const quality = Number.isFinite(args.quality) ? args.quality : 4;

  let out = path.resolve(args.out || defaultOut(format));
  if (!/\.(png|jpe?g)$/i.test(out)) out = `${out}.${format === "jpeg" ? "jpg" : "png"}`;
  fs.mkdirSync(path.dirname(out), { recursive: true });

  const rawDir = fs.mkdtempSync(path.join(os.tmpdir(), "shot-raw-"));
  const rawPath = path.join(rawDir, "raw.png");
  try {
    if (args.convertOnly) {
      if (!target) throw new Error("--convert-only 需要传入已有图片路径");
      const src = path.resolve(target);
      if (!fs.existsSync(src)) throw new Error(`文件不存在: ${src}`);
      fs.copyFileSync(src, rawPath);
    } else if (args.app) {
      await captureApp(args.app, rawPath, { size, wait });
    } else {
      await captureWeb(target, rawPath, { size, wait, full: args.full });
    }
    const info = await finalize(rawPath, out, { maxWidth, format, quality, keepRaw: args.keepRaw });
    report(out, info);
  } finally {
    fs.rmSync(rawDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error("截图出错:", e.message);
  process.exit(1);
});
