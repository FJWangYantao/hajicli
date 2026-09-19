import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ExperienceStore, SkillRegistry } from "@hajicli/core";
import { handleInstinctCommand, handleMemoryCommand } from "../dist/experience-commands.js";

function createStoreWithTmp() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "haji-cmd-"));
  const cwd = path.join(tmp, "project");
  const userDir = path.join(tmp, "user", ".haji");
  const projectDir = path.join(cwd, ".haji");
  fs.mkdirSync(cwd, { recursive: true });
  const store = new ExperienceStore({ cwd, userDir, projectDir });
  return { store, tmp };
}

const noColor = {
  purple: (s) => s,
  gray: (s) => s,
  green: (s) => s,
  red: (s) => s,
  yellow: (s) => s,
  bold: (s) => s,
};

function makeCtx(store, outputs, userSkillsDir) {
  return {
    store,
    provider: () => null,
    model: () => "mock",
    pendingObservations: () => [],
    writeLine: (line) => outputs.push(line),
    writeChat: (content) => outputs.push(content),
    ...(userSkillsDir ? { userSkillsDir } : {}),
  };
}

// ─── /memory ──────────────────────────────────────────────────────────────────

test("/memory shows empty hint when no memories", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand([], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("暂无记忆")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory add creates active memory then list shows it", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    const ctx = makeCtx(store, outputs);
    await handleMemoryCommand(["add", "project", "uses", "pnpm", "workspace"], ctx, noColor);
    assert.ok(outputs.some((l) => l.includes("已添加")));
    outputs.length = 0;
    await handleMemoryCommand([], ctx, noColor);
    assert.ok(outputs.some((l) => l.includes("active 1")));
    assert.ok(outputs.some((l) => l.includes("pnpm")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory add rejects invalid type", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(["add", "invalid-type", "content"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("类型必须是")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory add requires content", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(["add", "project"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("用法")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory confirm promotes staging to active", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 先放一条 staging
    await store.stageMemory({
      id: "cand-1",
      name: "test",
      type: "feedback",
      content: "wait for confirm",
      status: "staging",
      confidence: 0.7,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      keywords: ["confirm"],
    });
    const outputs = [];
    await handleMemoryCommand(["confirm", "cand-1"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("已确认")));
    assert.equal(store.loadMemories("active").length, 1);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory confirm reports unknown id", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(["confirm", "nope"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("未找到")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory confirm user type reports user-level placement", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.stageMemory({
      id: "cand-user",
      name: "test",
      type: "user",
      content: "prefer kebab-case",
      status: "staging",
      confidence: 0.7,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      keywords: ["kebab"],
    });
    const outputs = [];
    await handleMemoryCommand(["confirm", "cand-user"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("用户级")));
    // 落点验证：用户级 active 有文件，项目级无
    assert.ok(
      fs.existsSync(path.join(tmp, "user", ".haji", "memory", "active", "user__cand-user.md")),
    );
    assert.ok(
      !fs.existsSync(path.join(tmp, "project", ".haji", "memory", "active", "user__cand-user.md")),
    );
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory forget removes memory", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertMemory({
      id: "m1",
      name: "n",
      type: "project",
      content: "c",
      status: "active",
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      keywords: ["c"],
    });
    const outputs = [];
    await handleMemoryCommand(["forget", "m1"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("已删除")));
    assert.equal(store.loadMemories("active").length, 0);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── /instinct ────────────────────────────────────────────────────────────────

test("/instinct shows empty hint when no rules", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleInstinctCommand([], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("暂无规则")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct lists rules sorted by confidence", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: "high",
      trigger: "t",
      action: "high action",
      confidence: 0.9,
      domain: "workflow",
      source: "statistical",
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 5,
    });
    await store.upsertInstinct({
      id: "low",
      trigger: "t",
      action: "low action",
      confidence: 0.6,
      domain: "testing",
      source: "llm",
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 2,
    });
    const outputs = [];
    await handleInstinctCommand([], makeCtx(store, outputs), noColor);
    const joined = outputs.join("\n");
    assert.ok(joined.includes("high"));
    assert.ok(joined.includes("low"));
    // high 应排在 low 前（按 confidence 降序）
    assert.ok(joined.indexOf("high") < joined.indexOf("low"));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct stats shows domain breakdown", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: "r1",
      trigger: "t",
      action: "a",
      confidence: 0.8,
      domain: "workflow",
      source: "statistical",
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 3,
    });
    await store.upsertInstinct({
      id: "r2",
      trigger: "t",
      action: "a",
      confidence: 0.7,
      domain: "workflow",
      source: "llm",
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 2,
    });
    await store.upsertInstinct({
      id: "r3",
      trigger: "t",
      action: "a",
      confidence: 0.75,
      domain: "testing",
      source: "statistical",
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 1,
    });
    const outputs = [];
    await handleInstinctCommand(["stats"], makeCtx(store, outputs), noColor);
    const joined = outputs.join("\n");
    assert.ok(joined.includes("active ·"));
    assert.ok(joined.includes("workflow"));
    assert.ok(joined.includes("testing"));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct forget removes rule", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: "to-remove",
      trigger: "t",
      action: "a",
      confidence: 0.8,
      domain: "workflow",
      source: "manual",
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 1,
    });
    const outputs = [];
    await handleInstinctCommand(["forget", "to-remove"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("已删除")));
    assert.equal(store.loadInstincts(true).length, 0);
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct distill reports when no observations", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleInstinctCommand(["distill"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("暂无待提炼")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── promote 子命令 ──────────────────────────────────────────────────────────

test("/memory promote moves memory to user level", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertMemory({
      id: "m1",
      name: "n",
      type: "project",
      content: "c",
      status: "active",
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      keywords: ["c"],
    });
    const outputs = [];
    await handleMemoryCommand(["promote", "m1"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("已提升到用户级")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory promote reports already-user-level", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    // 先 promote 一次（项目级 -> 用户级）
    await store.upsertMemory({
      id: "m2",
      name: "n",
      type: "project",
      content: "c",
      status: "active",
      confidence: 0.8,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      keywords: ["c"],
    });
    await store.promoteMemory("m2");
    // 再 promote 应报告 already-user-level
    const outputs = [];
    await handleMemoryCommand(["promote", "m2"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("已在用户级")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory promote requires id", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(["promote"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("用法")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct promote moves rule to user level", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    await store.upsertInstinct({
      id: "to-promote",
      trigger: "t",
      action: "a",
      confidence: 0.8,
      domain: "workflow",
      source: "statistical",
      deprecated: false,
      observedAt: new Date().toISOString(),
      occurrenceCount: 3,
    });
    const outputs = [];
    await handleInstinctCommand(["promote", "to-promote"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("已提升到用户级")));
    // 确认 source 改为 manual
    const loaded = store.loadInstincts(true);
    const found = loaded.find((i) => i.id === "to-promote");
    assert.ok(found);
    assert.equal(found.source, "manual");
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct promote reports not-found", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleInstinctCommand(["promote", "nope"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("未找到项目级")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── 作用域展示 ──────────────────────────────────────────────────────────────

test("/memory list shows scope tags for user and project entries", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const base = { name: "n", content: "content", status: "active", confidence: 0.8, keywords: [] };
    const now = new Date().toISOString();
    await store.upsertMemory({
      ...base,
      id: "user-pref",
      type: "user",
      createdAt: now,
      updatedAt: now,
    });
    await store.upsertMemory({
      ...base,
      id: "proj-fact",
      type: "project",
      createdAt: now,
      updatedAt: now,
    });
    const outputs = [];
    await handleMemoryCommand([], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("[用户级]")));
    assert.ok(outputs.some((l) => l.includes("[项目级]")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/memory add user reports user-level placement", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleMemoryCommand(
      ["add", "user", "prefer kebab-case"],
      makeCtx(store, outputs),
      noColor,
    );
    assert.ok(outputs.some((l) => l.includes("用户级")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct list shows scope tags", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const now = new Date().toISOString();
    await store.upsertInstinct({
      id: "user-rule",
      trigger: "t",
      action: "a",
      confidence: 0.8,
      domain: "workflow",
      source: "manual",
      deprecated: false,
      observedAt: now,
      occurrenceCount: 1,
    });
    await store.upsertInstinct({
      id: "proj-rule",
      trigger: "t2",
      action: "a2",
      confidence: 0.7,
      domain: "testing",
      source: "llm",
      deprecated: false,
      observedAt: now,
      occurrenceCount: 1,
    });
    const outputs = [];
    await handleInstinctCommand([], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("user-rule") && l.includes("[用户级]")));
    assert.ok(outputs.some((l) => l.includes("proj-rule") && l.includes("[项目级]")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct stats shows observation health", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const obs = (toolName, failed) => ({
      ts: new Date().toISOString(),
      sessionId: "s",
      toolName,
      args: {},
      output: failed ? "error" : "ok",
      failed,
    });
    for (let i = 0; i < 6; i++) store.appendObservation(obs("edit", i === 0));
    for (let i = 0; i < 4; i++) store.appendObservation(obs("bash", i < 2));
    await store.flushObservations();
    const outputs = [];
    await handleInstinctCommand(["stats"], makeCtx(store, outputs), noColor);
    const statLine = outputs.find((l) => l.includes("观测健康"));
    assert.ok(statLine);
    assert.ok(statLine.includes("10 次"));
    assert.ok(statLine.includes("失败 3 次"));
    const topLine = outputs.find((l) => l.includes("失败集中"));
    assert.ok(topLine.includes("bash 2/4"));
    assert.ok(topLine.includes("edit 1/6"));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

// ─── /instinct skill 蒸馏 ──────────────────────────────────────────────────────

function makeHighConfidenceInstinct(overrides = {}) {
  const now = new Date().toISOString();
  return {
    id: "read-before-edit",
    trigger: "about to edit a file",
    action: "Read the file and check hash first",
    confidence: 0.85,
    domain: "workflow",
    source: "llm",
    deprecated: false,
    observedAt: now,
    occurrenceCount: 5,
    ...overrides,
  };
}

test("/instinct skill lists only rules above the distill threshold", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const now = new Date().toISOString();
    // 低置信度与低观测次数的规则不应入选
    await store.upsertInstinct(
      makeHighConfidenceInstinct({
        id: "weak-rule",
        confidence: 0.7,
        occurrenceCount: 5,
        observedAt: now,
      }),
    );
    await store.upsertInstinct(
      makeHighConfidenceInstinct({
        id: "rare-rule",
        confidence: 0.9,
        occurrenceCount: 1,
        observedAt: now,
      }),
    );
    await store.upsertInstinct(makeHighConfidenceInstinct());
    const outputs = [];
    await handleInstinctCommand(["skill"], makeCtx(store, outputs), noColor);
    const listBlock = outputs.find((l) => l.includes("可蒸馏为 Skill 的规则"));
    assert.ok(listBlock.includes("1）"));
    assert.ok(outputs.some((l) => l.includes("read-before-edit")));
    assert.ok(!outputs.some((l) => l.includes("weak-rule") || l.includes("rare-rule")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct skill reports when no rule qualifies", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleInstinctCommand(["skill"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("暂无可蒸馏规则")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct skill <id> generates a skill the registry can scan", async () => {
  const { store, tmp } = createStoreWithTmp();
  const skillsDir = path.join(tmp, "user-skills");
  try {
    await store.upsertInstinct(
      makeHighConfidenceInstinct({
        trigger: '触发场景: 含冒号与 "引号" 的描述',
        action: "执行要点: 先读文件、校验 hash，再编辑",
      }),
    );
    const outputs = [];
    await handleInstinctCommand(
      ["skill", "read-before-edit"],
      makeCtx(store, outputs, skillsDir),
      noColor,
    );
    assert.ok(outputs.some((l) => l.includes("已生成用户级 Skill 草稿")));
    const manifest = path.join(skillsDir, "read-before-edit", "SKILL.md");
    assert.ok(fs.existsSync(manifest));

    // 强验证：生成物必须能被真实 SkillRegistry 扫描识别
    const registry = new SkillRegistry({ cwd: tmp, userSkillsDir: skillsDir });
    const scan = await registry.scan();
    assert.equal(scan.issues.filter((i) => i.severity === "error").length, 0);
    const skill = registry.list().find((s) => s.name === "read-before-edit");
    assert.ok(skill, "生成的 skill 应出现在注册表中");
    assert.equal(skill.whenToUse, '触发场景: 含冒号与 "引号" 的描述');
    assert.equal(skill.userInvocable, true);
    assert.ok(skill.description.includes("执行要点"));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct skill refuses to overwrite an existing skill", async () => {
  const { store, tmp } = createStoreWithTmp();
  const skillsDir = path.join(tmp, "user-skills");
  try {
    await store.upsertInstinct(makeHighConfidenceInstinct());
    await handleInstinctCommand(
      ["skill", "read-before-edit"],
      makeCtx(store, [], skillsDir),
      noColor,
    );
    const outputs = [];
    await handleInstinctCommand(
      ["skill", "read-before-edit"],
      makeCtx(store, outputs, skillsDir),
      noColor,
    );
    assert.ok(outputs.some((l) => l.includes("已拒绝覆盖")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});

test("/instinct skill reports unknown id", async () => {
  const { store, tmp } = createStoreWithTmp();
  try {
    const outputs = [];
    await handleInstinctCommand(["skill", "nope"], makeCtx(store, outputs), noColor);
    assert.ok(outputs.some((l) => l.includes("未找到")));
  } finally {
    fsp.rm(tmp, { recursive: true, force: true });
  }
});
