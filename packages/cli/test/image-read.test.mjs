import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { HookEngine, PermissionEngine, SnapshotEngine, TaskStore } from "@hajicli/core";
import { ReadFileTool } from "@hajicli/plugins";
import { SharedToolExecutor } from "../dist/tool-executor.js";

/** 1x1 透明 PNG：只是让扩展名与内容都像真图片。 */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/gGi7wAAAABJRU5ErkJggg==";

function withWorkspace(run) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "haji-image-read-"));
  const previousCwd = process.cwd();
  process.chdir(cwd);
  return (async () => run(cwd))().finally(() => {
    process.chdir(previousCwd);
    fs.rmSync(cwd, { recursive: true, force: true });
  });
}

test("read 读图片文件时返回图片本身，而不是二进制占位", async () => {
  await withWorkspace(async (cwd) => {
    const target = path.join(cwd, "paste-1.png");
    const bytes = Buffer.from(PNG_BASE64, "base64");
    fs.writeFileSync(target, bytes);

    const result = await new ReadFileTool().execute({ path: "paste-1.png" });

    assert.equal(typeof result, "object", "图片结果必须是结构化结果");
    assert.match(result.output, /\[图片读取结果 - paste-1\.png\]/);
    assert.match(result.output, /类型=image\/png/);
    assert.doesNotMatch(result.output, /未输出二进制内容/);
    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, "image/png");
    assert.equal(result.images[0].path, "paste-1.png");
    assert.deepEqual(Buffer.from(result.images[0].base64, "base64"), bytes);
  });
});

test("read 读文本文件仍然返回纯字符串（保持既有契约）", async () => {
  await withWorkspace(async (cwd) => {
    fs.writeFileSync(path.join(cwd, "note.txt"), "hello\n");

    const result = await new ReadFileTool().execute({ path: "note.txt" });

    assert.equal(typeof result, "string");
    assert.match(result, /1 \| hello/);
  });
});

test("read 的图片超过体积上限时只给文字提示，不发送图片内容", async () => {
  await withWorkspace(async (cwd) => {
    const target = path.join(cwd, "huge.png");
    fs.writeFileSync(target, Buffer.alloc(6 * 1024 * 1024 + 10, 1));

    const result = await new ReadFileTool().execute({ path: "huge.png" });

    // 没有图片可发时保持字符串契约，只是文字里说明超限。
    assert.equal(typeof result, "string");
    assert.match(result, /上限/);
  });
});

test("执行器把 read 返回的图片透传给调用方", async () => {
  await withWorkspace(async (cwd) => {
    const bytes = Buffer.from(PNG_BASE64, "base64");
    fs.writeFileSync(path.join(cwd, "shot.png"), bytes);

    const executor = new SharedToolExecutor({
      cwd,
      tools: new Map([["read", new ReadFileTool()]]),
      hookEngine: new HookEngine(),
      permissionEngine: new PermissionEngine(),
      snapshotEngine: new SnapshotEngine(cwd),
      taskStore: new TaskStore(path.join(cwd, ".haji", "tasks")),
    });

    const result = await executor.execute(
      "read",
      { path: "shot.png" },
      { toolCallId: "call-image-1" },
    );

    assert.equal(result.blocked, false);
    assert.match(result.output, /图片读取结果/);
    assert.equal(result.images?.length, 1);
    assert.equal(result.images[0].mimeType, "image/png");
  });
});
