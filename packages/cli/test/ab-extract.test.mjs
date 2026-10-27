import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeSession(dir, id, timestamp, experiments, events) {
  const lines = [
    JSON.stringify({
      type: "experiment_assignment",
      timestamp,
      data: { timestamp, unitId: id, experiments },
    }),
    JSON.stringify({ type: "user_input", timestamp, content: "任务" }),
    ...events.map((event) =>
      JSON.stringify({
        type: event.type,
        timestamp,
        data: { timestamp, ...event.data },
      }),
    ),
  ];
  fs.writeFileSync(path.join(dir, `session_${id}.events.jsonl`), `${lines.join("\n")}\n`);
  fs.writeFileSync(
    path.join(dir, `session_${id}.meta.json`),
    JSON.stringify({ startTime: timestamp, endTime: timestamp }),
  );
}

function run(dir, args) {
  const output = execFileSync(
    process.execPath,
    ["scripts/ab-extract.mjs", "--dir", dir, "--json", ...args],
    { cwd: process.cwd(), encoding: "utf8" },
  );
  return JSON.parse(output);
}

test("ab-extract 统计请求/token，并按时间窗过滤会话", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "haji-ab-extract-"));
  try {
    const llm = (prompt, completion) => ({
      type: "llm_call",
      data: {
        model: "unknown-model",
        messages: [{ role: "system", content: "sys" }],
        usage: { prompt_tokens: prompt, completion_tokens: completion },
      },
    });
    writeSession(dir, "old", "2026-10-27T00:00:00.000Z", { demo: "a" }, [
      llm(100, 10),
      { type: "tool_execution", data: { name: "read", arguments: { path: "a.ts" } } },
    ]);
    writeSession(dir, "new", "2026-10-27T01:00:00.000Z", { demo: "b" }, [
      llm(200, 20),
      llm(300, 30),
      { type: "tool_execution", data: { name: "grep", arguments: { query: "x" } } },
    ]);

    const all = run(dir, ["--experiment", "demo"]);
    assert.equal(all.sessions.length, 2);
    assert.equal(all.byArm.a.avgRequests, 1);
    assert.equal(all.byArm.a.avgPromptTokens, 100);
    assert.equal(all.byArm.b.avgRequests, 2);
    assert.equal(all.byArm.b.avgPromptTokens, 500);
    assert.equal(all.byArm.b.avgToolCalls, 1);
    assert.equal(all.byArm.b.avgRequestsPerTool, 2);
    // 没配单价：费用为空，但 token 照常统计。
    assert.equal(all.byArm.b.avgCostCny, null);
    assert.equal(all.byArm.b.unpricedRequests, 2);

    const windowed = run(dir, ["--experiment", "demo", "--since", "2026-10-27T00:30:00Z"]);
    assert.equal(windowed.sessions.length, 1);
    assert.equal(windowed.sessions[0].arm, "b");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
