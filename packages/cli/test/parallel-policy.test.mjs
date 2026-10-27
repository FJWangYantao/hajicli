import assert from "node:assert/strict";
import test from "node:test";

import { createParallelClassifier } from "../dist/parallel-policy.js";

const call = (name, args) => ({
  function: { name, arguments: args === undefined ? undefined : JSON.stringify(args) },
});

test("static arm keeps the built-in read-only allowlist", () => {
  const classify = createParallelClassifier({
    dynamic: false,
    isReadOnlyTool: () => true,
    isReadOnlyCommand: () => true,
  });
  assert.equal(classify(call("read", { path: "a.ts" })), true);
  assert.equal(classify(call("grep", { query: "x" })), true);
  assert.equal(classify(call("bash", { command: "ls" })), false);
  assert.equal(classify(call("mcp_read", {})), false);
});

test("dynamic arm adds read-only bash and read-only MCP but keeps barriers", () => {
  const classify = createParallelClassifier({
    dynamic: true,
    isReadOnlyTool: (name) => name === "mcp_read",
    isReadOnlyCommand: (command) => command === "ls -la",
  });
  assert.equal(classify(call("bash", { command: "ls -la" })), true);
  assert.equal(classify(call("bash", { command: "rm -rf dist" })), false);
  assert.equal(classify(call("bash", { command: "" })), false);
  assert.equal(classify(call("bash", { command: "ls", extra: true })), false);
  assert.equal(classify(call("mcp_read", {})), true);
  assert.equal(classify(call("mcp_write", {})), false);
  assert.equal(classify(call("loadskill", { name: "x" })), false, "loadskill 有加载副作用");
  assert.equal(classify(call("edit", { path: "a.ts" })), false);
  assert.equal(classify(call("subagent", { description: "x" })), false);
});

test("malformed bash arguments are never parallelized", () => {
  const classify = createParallelClassifier({
    dynamic: true,
    isReadOnlyTool: () => false,
    isReadOnlyCommand: () => true,
  });
  assert.equal(classify({ function: { name: "bash", arguments: "{broken" } }), false);
  assert.equal(classify({ function: { name: "bash" } }), false);
});
