/**
 * 源码阅读器本地预览服务(含 AI 同源代理)
 *
 * 用法: node tools/code-viewer/serve.mjs   → http://127.0.0.1:8642/code-viewer.html
 *
 * 为什么需要代理:浏览器直连 api.z.ai 等端点会被 CORS 拦截。
 * /ai-proxy/chat/completions 由本机服务端转发请求,API Key 只留在本机,
 * 页面里 Base URL 填相对路径 /ai-proxy 即可。
 *
 * 上游与 Key 配置在 tools/code-viewer/ai.config.local.json(已被 .gitignore 忽略):
 *   { "upstream": "https://api.z.ai/api/coding/paas/v4", "apiKey": "..." }
 */
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { Readable } from "node:stream";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const port = 8642;

let aiCfg = null;
try {
  const parsed = JSON.parse(readFileSync(join(here, "ai.config.local.json"), "utf8"));
  // 新格式:{ default, upstreams: { <name>: { upstream, apiKey } } }
  if (parsed && parsed.upstreams) {
    aiCfg = { default: parsed.default || Object.keys(parsed.upstreams)[0], upstreams: parsed.upstreams };
  } else if (parsed && parsed.upstream && parsed.apiKey) {
    // 旧单上游格式兼容
    aiCfg = { default: "default", upstreams: { default: parsed } };
  } else {
    aiCfg = null;
  }
} catch {
  aiCfg = null;
}

/** 网络层瞬断自动重试一次(本机到部分端点首次连接偶发 fetch failed) */
async function fetchWithRetry(url, options) {
  try {
    return await fetch(url, options);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error; // 非 fetch failed(如 AbortError)不重试
    return fetch(url, options);
  }
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

function sendJson(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  /* ---- AI 同源代理:POST /ai-proxy/chat/completions(默认上游)或 /ai-proxy/<name>/chat/completions ---- */
  const proxyMatch = url.pathname.match(/^\/ai-proxy(?:\/([a-z0-9_-]+))?\/chat\/completions$/i);
  if (proxyMatch && req.method === "POST") {
    if (!aiCfg) {
      sendJson(res, 503, {
        error: { message: "AI 代理未配置:请创建 tools/code-viewer/ai.config.local.json(含 upstreams)" },
      });
      return;
    }
    const name = (proxyMatch[1] || aiCfg.default).toLowerCase();
    const entry = aiCfg.upstreams[name];
    if (!entry || !entry.upstream || !entry.apiKey) {
      sendJson(res, 404, { error: { message: `未知的 AI 上游: ${name}(可用: ${Object.keys(aiCfg.upstreams).join(", ")})` } });
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    try {
      const upstream = entry.upstream.replace(/\/+$/, "") + "/chat/completions";
      const upstreamRes = await fetchWithRetry(upstream, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${entry.apiKey}`,
        },
        body: Buffer.concat(chunks),
      });
      res.writeHead(upstreamRes.status, {
        "Content-Type": upstreamRes.headers.get("content-type") || "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-AI-Upstream": upstream,
      });
      if (upstreamRes.body) Readable.fromWeb(upstreamRes.body).pipe(res);
      else res.end();
    } catch (error) {
      sendJson(res, 502, { error: { message: `代理请求上游失败: ${error}` } });
    }
    return;
  }

  /* ---- 静态文件 ---- */
  let rel = decodeURIComponent(url.pathname).replace(/^\//, "");
  if (!rel || rel.endsWith("/")) rel += "code-viewer.html";
  const filePath = join(root, rel);
  if (!filePath.startsWith(root) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.statusCode = 404;
    res.end("not found");
    return;
  }
  res.setHeader("Content-Type", MIME[extname(filePath).toLowerCase()] || "application/octet-stream");
  res.setHeader("Cache-Control", "no-store");
  res.end(readFileSync(filePath));
});

server.listen(port, "127.0.0.1", () => {
  console.log(`code-viewer: http://127.0.0.1:${port}/code-viewer.html`);
  if (aiCfg) {
    for (const [name, entry] of Object.entries(aiCfg.upstreams)) {
      const mark = name === aiCfg.default ? "(默认)" : "";
      console.log(`ai-proxy /${name}: ${entry.label || name} → ${entry.upstream} ${mark}`.replace("//", "/"));
    }
  } else {
    console.log("ai-proxy: 未配置(缺少 ai.config.local.json)");
  }
});
