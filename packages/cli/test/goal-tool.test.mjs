import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { PermissionEngine, SessionManager } from "@hajicli/core";
import {
  formatSelfState,
  GOAL_TEXT_MAX_LENGTH,
  GoalFinishTool,
  SetGoalTool,
} from "@hajicli/plugins";

import { formatGoalPromptPart, GoalPromptPart } from "../dist/goal-prompt.js";
import { setThemePreset } from "../dist/theme.js";
import { buildSidebarRows, wrapSidebarText } from "../dist/tui-sidebar.js";

setThemePreset("default");

/**
 * 会话目标是纯模型驱动的能力：setgoal 记录、goalfinish 收尾，没有用户侧 /goal 指令。
 * 这里测工具行为与校验、权限口径、提示词分片、持久化与可见性（侧栏 / selfstate）。
 * 全部纯函数或临时目录隔离，不读写真实 ~/.haji。
 */

const MESSAGES = [
  { role: "system", content: "系统提示" },
  { role: "user", content: "帮我把 goal 功能做完" },
  { role: "assistant", content: "好，开始。" },
];

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "haji-goal-"));
}

/** 去掉 ANSI 转义后再断言，避免把颜色码当成内容。 */
function plain(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** 用内存状态模拟 CLI 侧的 setGoalFromTool / finishGoal 落地回调。 */
function makeGoalRuntime() {
  const state = { goal: undefined, events: [] };
  const applyGoal = (goal) => {
    state.goal = goal;
    state.events.push(goal);
  };
  return {
    state,
    setGoalFromTool: (text) => {
      const previous = state.goal;
      applyGoal({ text, status: "active", createdAt: new Date().toISOString() });
      return {
        ok: true,
        message: previous?.status === "active" ? "已替换会话目标。" : "已记录会话目标。",
      };
    },
    finishGoal: (evidence) => {
      const goal = state.goal;
      if (!goal) return { ok: false, message: "错误：当前会话没有目标，无需调用 goalfinish。" };
      if (goal.status === "achieved") {
        return { ok: false, message: "错误：目标已标记达成，请勿重复调用 goalfinish。" };
      }
      applyGoal({ ...goal, status: "achieved", achievedAt: new Date().toISOString(), evidence });
      return { ok: true, message: "目标已标记达成并停止注入后续请求。" };
    },
  };
}

test("setgoal 工具：空白压缩、空文本与超长拒绝，结果透传落地回调", async () => {
  const runtime = makeGoalRuntime();
  const tool = new SetGoalTool((text) => runtime.setGoalFromTool(text));

  const ok = await tool.execute({ text: "  修复 登录 超时\n并补测试  " });
  assert.ok(ok.includes("已记录"));
  assert.equal(runtime.state.goal.text, "修复 登录 超时 并补测试");
  assert.equal(runtime.state.goal.status, "active");

  const empty = await tool.execute({ text: "   " });
  assert.ok(empty.includes("错误"));
  const tooLong = await tool.execute({ text: "x".repeat(GOAL_TEXT_MAX_LENGTH + 1) });
  assert.ok(tooLong.includes("错误"));
  assert.equal(runtime.state.events.length, 1);
});

test("goalfinish 工具：evidence 必填，无目标 / 重复调用拒绝", async () => {
  const runtime = makeGoalRuntime();
  const setTool = new SetGoalTool((text) => runtime.setGoalFromTool(text));
  const finishTool = new GoalFinishTool((evidence) => runtime.finishGoal(evidence));

  // 没有目标时收尾直接拒绝。
  const noGoal = await finishTool.execute({ evidence: "做了点事" });
  assert.ok(noGoal.includes("错误"));

  await setTool.execute({ text: "给项目添加 goal 功能" });
  assert.ok((await finishTool.execute({ evidence: "" })).includes("错误"));
  const ok = await finishTool.execute({ evidence: "验收点 → pnpm test 通过" });
  assert.ok(ok.includes("已标记达成"));
  assert.equal(runtime.state.goal.status, "achieved");
  assert.equal(runtime.state.goal.evidence, "验收点 → pnpm test 通过");
  assert.ok((await finishTool.execute({ evidence: "再来一次" })).includes("错误"));
  assert.equal(runtime.state.events.length, 2);
});

test("goal* 只写会话元数据：全模式自动放行；Plan 只放行 setgoal", async () => {
  const engine = new PermissionEngine();
  for (const mode of ["default", "accept-edit", "auto", "bypass-permissions"]) {
    for (const toolName of ["setgoal", "goalfinish"]) {
      const result = await engine.evaluate({ mode, toolName, args: {} });
      assert.equal(result.action, "allow", `${mode} 应放行 ${toolName}`);
    }
  }
  // Plan 是调研档：setgoal 属计划元数据可放行；goalfinish 是实施后的收尾，与 taskfinish 同口径。
  assert.equal(
    (await engine.evaluate({ mode: "plan", toolName: "setgoal", args: {} })).action,
    "allow",
  );
  assert.equal(
    (await engine.evaluate({ mode: "plan", toolName: "goalfinish", args: {} })).action,
    "deny",
  );
});

test("formatGoalPromptPart：激活目标注入审计约束与 goalfinish 指引", () => {
  const goal = {
    text: "给项目添加 goal 功能",
    status: "active",
    createdAt: "2026-10-26T02:00:00.000Z",
  };
  const content = formatGoalPromptPart(goal);
  assert.ok(content.includes("给项目添加 goal 功能"));
  assert.ok(content.includes("当前会话目标"));
  assert.ok(content.includes("完成审计"));
  assert.ok(content.includes("goalfinish"));
  // 目标原文是任务数据不是指令：防注入边界必须写明。
  assert.ok(content.includes("任务数据"));
  // 工具不可用（如 Plan 模式 goalfinish 被过滤）时指引退回「报告结果」，不提 goalfinish。
  const noTool = formatGoalPromptPart(goal, false);
  assert.ok(!noTool.includes("goalfinish"));
  assert.ok(noTool.includes("报告结果"));
  assert.equal(formatGoalPromptPart(undefined), "");
  assert.equal(
    formatGoalPromptPart({ ...goal, status: "achieved", achievedAt: goal.createdAt }),
    "",
  );
  // 超长目标截断到上限，避免目标本身把系统提示词撑爆。
  const long = formatGoalPromptPart({ ...goal, text: "长".repeat(GOAL_TEXT_MAX_LENGTH + 100) });
  assert.ok(!long.includes("长".repeat(GOAL_TEXT_MAX_LENGTH + 1)));
});

test("GoalPromptPart 分片：按上下文工具表决定 goalfinish 指引", () => {
  const getGoal = () => ({
    text: "写完 README",
    status: "active",
    createdAt: "2026-10-26T02:00:00.000Z",
  });
  const part = new GoalPromptPart(getGoal);
  assert.equal(part.id, "goal");
  assert.equal(typeof part.priority, "number");
  assert.ok(part.getContent({ tools: ["read", "goalfinish"] }).includes("goalfinish"));
  assert.ok(!part.getContent({ tools: ["read"] }).includes("goalfinish"));
  assert.equal(new GoalPromptPart(() => undefined).getContent({}), "");
});

test("会话目标随会话文件落盘：仅目标变化也写盘，达成证据一并留档", async () => {
  const dir = makeTempDir();
  const writer = new SessionManager(dir);
  const id = writer.getCurrentSession().id;

  writer.saveCurrentSession(MESSAGES);
  writer.setGoal({
    text: "给项目添加 goal 功能",
    status: "achieved",
    createdAt: "2026-10-26T02:00:00.000Z",
    achievedAt: "2026-10-26T03:00:00.000Z",
    evidence: "验收点 → pnpm test 通过",
  });
  // 消息没变、只有目标变了：必须仍然落盘（与 usage 同一口径）。
  writer.saveCurrentSession(MESSAGES);
  await writer.flush();

  const filePath = path.join(dir, `session_${id}.json`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(raw.goal.status, "achieved");
  assert.equal(raw.goal.evidence, "验收点 → pnpm test 通过");

  const loaded = new SessionManager(dir).loadSession(id);
  assert.ok(loaded);
  assert.equal(loaded.goal.evidence, "验收点 → pnpm test 通过");

  // /clear（startNewSession）后目标归零，侧栏与提示词不再看到旧目标。
  writer.startNewSession();
  assert.equal(writer.getCurrentSession().goal, undefined);

  // 老会话文件没有 goal 字段：按未设定处理，不报错。
  delete raw.goal;
  fs.writeFileSync(filePath, JSON.stringify(raw), "utf8");
  const legacy = new SessionManager(dir).loadSession(id);
  assert.ok(legacy);
  assert.equal(legacy.goal, undefined);
});

test("侧栏只渲染进行中的目标；长文按两行截断", () => {
  const base = { usedTokens: 1000, maxTokens: 100000 };
  const withGoal = buildSidebarRows(
    { ...base, goal: { text: "给项目添加 goal 功能", status: "active" } },
    28,
    30,
  ).map(plain);
  assert.ok(withGoal.some((line) => line.includes("目标 · 进行中")));
  assert.ok(withGoal.some((line) => line.includes("给项目添加")));

  // 达成后侧栏不再占行：收尾反馈由对话区的 goalfinish 工具格承担。
  const achieved = buildSidebarRows(
    { ...base, goal: { text: "给项目添加 goal 功能", status: "achieved" } },
    28,
    30,
  ).map(plain);
  assert.ok(!achieved.some((line) => line.includes("目标")));

  const without = buildSidebarRows(base, 28, 30).map(plain);
  assert.ok(!without.some((line) => line.includes("目标")));

  // 折行：宽字符按 2 列计，超过两行在末行加省略号。
  const two = wrapSidebarText("一二三四五六七八九十一二三四五六七八九十一", 10, 2);
  assert.equal(two.length, 2);
  assert.ok(plain(two[1]).includes("…"));
  const short = wrapSidebarText("短目标", 10, 2);
  assert.deepEqual(short, ["短目标"]);
});

test("selfstate：会话带目标时输出目标摘要与完成审计，长文截断", () => {
  const snapshot = {
    cwd: "/repo",
    os: "Linux 6.8 x64",
    roots: [{ path: "/repo", source: "cwd" }],
    permissionMode: "auto",
    model: "glm-5.2",
    provider: "volcengine",
    reasoningEffort: "high",
    context: {
      usedTokens: 1000,
      windowTokens: 128000,
      triggerTokens: 89600,
      emergencyTokens: 115200,
      armed: true,
    },
    session: {
      id: "sess-1",
      title: "goal 功能",
      userTurns: 2,
      goal: {
        text: "给项目添加 goal 功能并补齐测试",
        status: "active",
        createdAt: "2026-10-26T02:00:00.000Z",
      },
    },
  };
  const text = formatSelfState(snapshot);
  assert.ok(text.includes("目标：进行中"));
  assert.ok(text.includes("给项目添加 goal 功能并补齐测试"));

  const done = formatSelfState({
    ...snapshot,
    session: {
      ...snapshot.session,
      goal: {
        ...snapshot.session.goal,
        status: "achieved",
        achievedAt: "2026-10-26T03:00:00.000Z",
        evidence: "验收点 → 全量测试通过",
      },
    },
  });
  assert.ok(done.includes("目标：已达成"));
  assert.ok(done.includes("验收点 → 全量测试通过"));

  const longGoal = {
    ...snapshot,
    session: {
      ...snapshot.session,
      goal: { ...snapshot.session.goal, text: "长".repeat(80) },
    },
  };
  assert.ok(!formatSelfState(longGoal).includes("长".repeat(61)));
});
