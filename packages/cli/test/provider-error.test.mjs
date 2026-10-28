import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { describeModelError, summarizeModelErrorShort } from "../dist/cli-runtime.js";

const providerError = (message, status) => Object.assign(new Error(message), { status });

test("summarizeModelErrorShort prefixes known classes with the category", () => {
  assert.match(
    summarizeModelErrorShort(providerError("Invalid API key provided", 401)),
    /^认证失败（401）：Invalid API key provided$/,
  );
  assert.match(summarizeModelErrorShort(providerError("Rate limit reached", 429)), /^请求过于频繁/);
  assert.match(
    summarizeModelErrorShort(new Error("This model's maximum context length is 65536 tokens")),
    /^上下文超出模型窗口/,
  );
  const networkError = Object.assign(new Error("fetch failed: ECONNRESET"), {
    name: "ConnectionError",
  });
  assert.match(summarizeModelErrorShort(networkError), /^网络连接失败/);
});

test("summarizeModelErrorShort keeps raw text (truncated) for unknown errors", () => {
  const longMessage = `x`.repeat(200);
  const summary = summarizeModelErrorShort(new Error(longMessage));
  assert.equal(summary.length, 60);
  assert.ok(summary.startsWith("x"));
});

test("describeModelError covers provider error classes with actionable hints", () => {
  const cases = [
    [providerError("Authentication Fails", 401), /^认证失败（401）$/, /\/provider/],
    [providerError("Insufficient Balance", 402), /^账户额度不足/, /余额/],
    [providerError("Rate limit reached", 429), /^请求过于频繁/, /\/model/],
    [
      new Error("This model's maximum context length is 65536 tokens"),
      /^上下文超出模型窗口$/,
      /\/compact/,
    ],
    [providerError("Model Not Exist", 400), /^模型不可用/, /\/model/],
    [
      Object.assign(new Error("getaddrinfo ENOTFOUND api.example.com"), {
        name: "ConnectionError",
      }),
      /^网络连接失败$/,
      /代理|Base URL/,
    ],
    [providerError("Service Unavailable", 503), /^模型服务暂时不可用/, /稍后/],
    [new Error("something odd"), /^模型调用出错$/, /\/config/],
  ];
  for (const [error, title, hint] of cases) {
    const described = describeModelError(error);
    assert.match(described.title, title, error.message);
    assert.match(described.hint, hint, error.message);
    assert.equal(described.detail, error.message);
  }
});

test("describeModelError classifies image 400/11135 as an image error, not a network failure", () => {
  const payload = JSON.stringify({
    code: 11135,
    msg: "Please start a new conversation, replace the image, and try again.",
    requestId: "329345dd58b4afb419c4e52d60b134b0",
    extError: {
      code: "invalid_request_error",
      message: "Please start a new conversation, replace the image, and try again.",
      type: "invalid_request_error",
      StatusCode: 400,
    },
    displayMsg: { en: "Image not recognized. Please use another image and retry" },
    displayTips: {
      en: "The image format is unsupported or the file is corrupted and cannot be parsed. Please convert it to JPG or PNG and upload again.",
      zh: "图片格式不支持或文件已损坏，无法解析。请换成 JPG 或 PNG 格式重新上传。",
    },
  });
  const described = describeModelError(providerError(payload, 400));
  assert.match(described.title, /^图片无法识别（400）$/);
  assert.match(described.hint, /JPG|PNG/);
  assert.doesNotMatch(described.title, /网络连接失败/);
  assert.doesNotMatch(described.hint, /HAJI_PROXY|HTTPS_PROXY/);
  assert.match(summarizeModelErrorShort(providerError(payload, 400)), /^图片无法识别（400）/);
});

test("turn-runner retry line uses the classified summary (source assertion)", () => {
  const source = fs.readFileSync(new URL("../src/turn-runner.ts", import.meta.url), "utf8");
  assert.match(source, /summarizeModelErrorShort\(error\)/);
  assert.match(source, /请求失败（\$\{reason\}）/);
});
