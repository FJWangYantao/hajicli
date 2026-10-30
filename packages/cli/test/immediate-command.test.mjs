import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSlashCommandCatalog,
  classifyCommandTiming,
  expandCommandInput,
  listImmediateCommands,
} from "../dist/cli-help.js";

/**
 * 立即执行通道的判定口径（cli-help.ts）。
 * 这里只测纯函数：命令能不能在回合进行中绕过待处理队列。
 */

test("immediate 指令：回合进行中直接执行", () => {
  for (const input of [
    "/model",
    "/model glm-5.2",
    "/effort",
    "/effort low",
    "/cost",
    "/cost agent",
    "/help",
    "/sidebar",
    "/sidebar off",
    "/fold",
    "/fold on",
    "/think",
    "/think off",
    "/compact-stream",
    "/compact-stream off",
  ]) {
    assert.equal(classifyCommandTiming(input), "immediate", `${input} 应可立即执行`);
  }
});

test("改动会话状态或发起新回合的指令必须排队", () => {
  for (const input of [
    "/theme",
    "/theme kero",
    "/appearance",
    "/appearance light",
    "/appearance dark",
    "/compact",
    "/clear",
    "/resume",
    "/rewind",
    "/undo",
    "/image shot.png 看看",
    "/skill rust-review",
    "/agents new 帮我改代码",
    "/agents stop all",
    "/permission rules",
    "/workspace add D:/other",
    "/cost config",
    "/cost price glm-5.2 1 2",
    "/output",
    "/diff",
    "hello",
    "/",
  ]) {
    assert.equal(classifyCommandTiming(input), "queued", `${input} 应继续排队`);
  }
});

test("别名先归一再看时机：/new 与 /permissions 不会因别名绕过队列", () => {
  assert.equal(expandCommandInput("/new"), "/clear");
  assert.equal(classifyCommandTiming("/new"), "queued");
  // /permissions 是 /permission rules 的别名：改的是永久规则，必须排队。
  assert.equal(classifyCommandTiming("/permissions"), "queued");
});

test("参数白名单按子命令生效，不因父指令声明了 immediate 而放行", () => {
  assert.equal(classifyCommandTiming("/cost agent"), "immediate");
  assert.equal(classifyCommandTiming("/cost config"), "queued");
  // 未知子命令同样保守排队，避免新子命令默默拿到立即执行权限。
  assert.equal(classifyCommandTiming("/cost something-new"), "queued");
});

test("补全目录带出 immediate 标记（UI 与分发共用同一份元数据）", () => {
  const catalog = buildSlashCommandCatalog();
  const byCommand = new Map(catalog.map((entry) => [entry.command, entry]));
  assert.equal(byCommand.get("/model")?.immediate, true);
  assert.equal(byCommand.get("/appearance")?.immediate, false);
  assert.equal(byCommand.get("/cost")?.immediate, true);
  assert.equal(byCommand.get("/cost agent")?.immediate, true);
  assert.equal(byCommand.get("/cost config")?.immediate, false);
  assert.equal(byCommand.get("/compact")?.immediate, false);
  assert.equal(byCommand.get("/agents new")?.immediate, false);
  // 纯展示开关：回合中改的是渲染 / 偏好，不碰对话历史。
  assert.equal(byCommand.get("/sidebar")?.immediate, true);
  assert.equal(byCommand.get("/fold")?.immediate, true);
  assert.equal(byCommand.get("/think")?.immediate, true);
  assert.equal(byCommand.get("/compact-stream")?.immediate, true);
});

test("listImmediateCommands 覆盖声明过的顶层与成员指令", () => {
  const commands = listImmediateCommands();
  for (const expected of [
    "/help",
    "/model",
    "/effort",
    "/cost",
    "/sidebar",
    "/fold",
    "/think",
    "/compact-stream",
  ]) {
    assert.ok(commands.includes(expected), `${expected} 应出现在立即指令清单里`);
  }
});
