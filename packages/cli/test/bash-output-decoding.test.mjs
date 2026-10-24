import assert from "node:assert/strict";
import test from "node:test";

import { CommandOutputDecoder } from "@hajicli/plugins";

// 「可用字节 目录」的 GBK 字节（cmd 的 dir 在中文 Windows 上就这么输出）。
const GBK = Buffer.from("bfc9d3c3d7d6bdda20c4bfc2bc", "hex");

test("command output falls back to the console code page on invalid UTF-8", () => {
  let asked = 0;
  const decoder = new CommandOutputDecoder(() => {
    asked += 1;
    return "gbk";
  });
  // 先来一段纯 ASCII，再来 GBK，且一个双字节字符被块边界切开。
  let text = decoder.write(Buffer.from("3 Dir(s) 28,646,481,920 "));
  text += decoder.write(GBK.subarray(0, 3));
  text += decoder.write(GBK.subarray(3));
  text += decoder.end();
  assert.equal(text, "3 Dir(s) 28,646,481,920 可用字节 目录");
  assert.equal(asked, 1);
});

test("valid UTF-8 split across chunks never consults the legacy encoding", () => {
  const decoder = new CommandOutputDecoder(() => {
    throw new Error("should not be asked");
  });
  const bytes = Buffer.from("测试通过 ✓", "utf8");
  let text = "";
  for (const byte of bytes) text += decoder.write(Buffer.from([byte]));
  text += decoder.end();
  assert.equal(text, "测试通过 ✓");
});

test("without a legacy encoding bad bytes become replacement characters", () => {
  const decoder = new CommandOutputDecoder(() => undefined);
  const text = decoder.write(GBK) + decoder.end();
  assert.match(text, /\uFFFD/);
  assert.equal(decoder.write("already text"), "already text");
});
