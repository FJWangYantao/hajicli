import assert from "node:assert/strict";
import test from "node:test";

import { resolveToolSubagentAccess } from "../dist/subagent-policy.js";

test("legacy arm keeps non-plan subagents writable", () => {
  for (const role of ["research", "review", "implement", undefined]) {
    assert.equal(
      resolveToolSubagentAccess({ role, permissionMode: "default", roleBased: false }),
      "workspace-write",
    );
  }
});

test("role arm makes research/review readonly and implement writable", () => {
  assert.equal(
    resolveToolSubagentAccess({ role: "research", permissionMode: "default", roleBased: true }),
    "readonly",
  );
  assert.equal(
    resolveToolSubagentAccess({ role: "review", permissionMode: "default", roleBased: true }),
    "readonly",
  );
  assert.equal(
    resolveToolSubagentAccess({ role: "implement", permissionMode: "default", roleBased: true }),
    "workspace-write",
  );
  assert.equal(
    resolveToolSubagentAccess({ role: undefined, permissionMode: "default", roleBased: true }),
    "readonly",
    "缺省 role 是 research",
  );
});

test("plan mode is always readonly regardless of arm", () => {
  assert.equal(
    resolveToolSubagentAccess({ role: "implement", permissionMode: "plan", roleBased: false }),
    "readonly",
  );
  assert.equal(
    resolveToolSubagentAccess({ role: "implement", permissionMode: "plan", roleBased: true }),
    "readonly",
  );
});
