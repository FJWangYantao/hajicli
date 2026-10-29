import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadProviderConfig } from "../packages/cli/dist/provider-config.js";
import { evaluateTask, runProcess, summarize } from "./quality-run.mjs";
import { qualityTasks } from "./quality-tasks.mjs";

// Use credentials in memory only. The isolated CLI receives a placeholder key.
const provider = loadProviderConfig().providers.cndeepseek;
if (!provider?.apiKey || !provider.baseUrl || !provider.model) {
  throw new Error("cndeepseek 配置不完整");
}
const root = path.resolve(process.argv[2] || `.tmp/quality-${Date.now()}`);
fs.mkdirSync(root, { recursive: true });
const home = path.join(root, "home");
fs.mkdirSync(home, { recursive: true });
const limit = 500000;
let active;
const server = http.createServer(async (req, res) => {
  try {
    if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (body.model !== provider.model) {
      res.writeHead(400).end(JSON.stringify({ error: { message: "unexpected evaluation model" } }));
      return;
    }
    // Byte count conservatively reserves input space before starting a request.
    const inputReserve = Buffer.byteLength(JSON.stringify(body));
    const remaining = limit - active.tokens - inputReserve;
    if (active.unknownUsage || remaining < 1) {
      active.blocked++;
      res
        .writeHead(429)
        .end(
          JSON.stringify({ error: { message: "quality token budget exhausted or usage unknown" } }),
        );
      return;
    }
    body.max_tokens = Math.min(body.max_tokens || 8192, 8192, remaining);
    delete body.max_completion_tokens;
    if (body.stream) body.stream_options = { ...body.stream_options, include_usage: true };
    const response = await fetch(`${provider.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${provider.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
    const text = await response.text();
    const usages = [];
    if (body.stream) {
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        try {
          const data = JSON.parse(line.slice(5));
          if (data.usage) usages.push(data.usage);
        } catch {}
      }
    } else {
      try {
        const data = JSON.parse(text);
        if (data.usage) usages.push(data.usage);
      } catch {}
    }
    const usage = usages.at(-1);
    if (response.ok) {
      if (Number.isFinite(usage?.total_tokens)) active.tokens += usage.total_tokens;
      else active.unknownUsage = true;
    }
    active.requests.push({
      status: response.status,
      usage: usage || null,
      reservedInputBytes: inputReserve,
      maxOutputTokens: body.max_tokens,
    });
    res.writeHead(response.status, {
      "Content-Type": response.headers.get("content-type") || "application/json",
    });
    res.end(text);
  } catch (error) {
    active.unknownUsage = true;
    res.writeHead(502).end(JSON.stringify({ error: { message: error.name } }));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const env = {
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  DEEPSEEK_API_KEY: "quality-local-proxy",
  DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
  HAJI_POST_EDIT_VERIFY: "0",
};
for (const key of ["VOLC_API_KEY", "ARK_API_KEY"]) delete env[key];
// Isolated evaluation configuration contains only a loopback placeholder credential.
const configDir = path.join(home, ".haji");
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, "config.json"),
  JSON.stringify({
    providers: {
      cndeepseek: {
        apiKey: "quality-local-proxy",
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
        model: provider.model,
        models: [provider.model],
      },
    },
  }),
);
fs.writeFileSync(
  path.join(configDir, "preferences.json"),
  JSON.stringify({
    provider: "cndeepseek",
    model: provider.model,
    utilityModel: provider.model,
    reasoningEffort: "medium",
  }),
);
for (const key of ["DEEPSEEK_API_KEY", "DEEPSEEK_MODEL", "VOLC_MODEL", "ARK_MODEL"])
  delete env[key];
const entry = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));
const results = [];
try {
  for (const task of qualityTasks.filter(
    (item) => !process.argv[3] || item.id === process.argv[3],
  )) {
    active = { tokens: 0, unknownUsage: false, blocked: 0, requests: [] };
    const result = await evaluateTask(task, {
      root,
      interventions: 0,
      timeoutMs: 180000,
      runner: async (item, cwd, timeoutMs) => {
        const execution = await runProcess(
          process.execPath,
          [
            entry,
            "-p",
            item.prompt,
            "--no-worktree",
            "--permission-mode",
            "accept-edit",
            "--output-format",
            "json",
          ],
          { cwd, env, timeoutMs },
        );
        fs.writeFileSync(
          path.join(root, `${item.id}-execution.json`),
          JSON.stringify(execution, null, 2),
        );
        return execution;
      },
    });
    results.push({ ...result, upstream: active });
    fs.writeFileSync(
      path.join(root, "report.json"),
      JSON.stringify(
        {
          model: provider.model,
          provider: "cndeepseek",
          tokenLimitPerTask: limit,
          summary: summarize(results),
          results,
        },
        null,
        2,
      ),
    );
    console.log(
      `${task.id}: ${result.passed ? "PASS" : "FAIL"}, ${active.tokens} tokens, ${result.wallMs}ms`,
    );
  }
  console.log(JSON.stringify(summarize(results), null, 2));
  console.log(`Artifacts: ${root}`);
} finally {
  server.closeAllConnections();
  server.close();
}
