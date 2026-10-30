import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { getModelPricing, MODEL_REGISTRY, messageContentOrParts } from "@hajicli/plugins";
import { CostTracker, estimateRequestCostCny, formatCostCny } from "../dist/cost-tracker.js";
import { expandFileMentions } from "../dist/file-mentions.js";
import { loadImageAttachment, parseImageCommand } from "../dist/image-command.js";
import {
  detectProjectCheckCommand,
  diagnosticsMentionFile,
  formatSelfProjectSkipHint,
  formatVerificationNotice,
  formatVerificationTimeoutHint,
  isSelfProject,
  shouldPushVerificationNotice,
} from "../dist/post-edit-verify.js";
import { resolveUtilityModel } from "../dist/provider-models.js";
import { loadUserModels, userModelsPath } from "../dist/user-models.js";

test("model registry carries pricing and tiers for cost and utility routing", () => {
  const priced = MODEL_REGISTRY.filter((model) => model.pricing);
  assert.ok(priced.length >= 3, "多数内置模型应带单价");
  const flash = getModelPricing("deepseek-v4-flash");
  const pro = getModelPricing("deepseek-v4-pro");
  assert.ok(flash && pro);
  assert.ok(
    flash.inputPerMTokens + flash.outputPerMTokens < pro.inputPerMTokens + pro.outputPerMTokens,
    "flash 应比 pro 便宜",
  );
  assert.equal(getModelPricing("no-such-model"), undefined);
});

test("cost tracker aggregates usage and estimates cost by model", () => {
  // 内置模型有峰谷分档，时刻钉在官方峰时（北京工作日 10:00），否则会按谷时五折挂。
  const BEIJING_PEAK = Date.parse("2025-01-02T02:00:00Z");
  const tracker = new CostTracker();
  assert.equal(tracker.getSummary().requests, 0);
  tracker.record(
    "deepseek-v4-pro",
    {
      prompt_tokens: 1_000_000,
      completion_tokens: 500_000,
      total_tokens: 1_500_000,
    },
    "主线回合",
    BEIJING_PEAK,
  );
  tracker.record(
    "custom-x",
    {
      prompt_tokens: 100,
      completion_tokens: 100,
      total_tokens: 200,
    },
    "主线回合",
    BEIJING_PEAK,
  );
  const summary = tracker.getSummary();
  assert.equal(summary.requests, 2);
  assert.equal(summary.hasUnpriced, true, "custom-x 未定价");
  // pro 官方峰时价：1M*9 + 0.5M*27 = 22.5 元
  assert.equal(summary.totalCostCny, 22.5);
  const byModel = new Map(summary.byModel.map((entry) => [entry.model, entry]));
  assert.equal(byModel.get("custom-x").costCny, null);
  const report = tracker.formatCostReport();
  assert.match(report[0], /本会话费用估算：¥22\.50/);
  assert.match(report.join("\n"), /未定价/);
  // 格式：小于 1 元保留 4 位
  assert.equal(formatCostCny(0.000015), "¥0.0000");
  assert.equal(formatCostCny(12.5), "¥12.50");
  assert.equal(
    estimateRequestCostCny(
      "deepseek-v4-flash",
      { prompt_tokens: 1_000_000, completion_tokens: 0, total_tokens: 1_000_000 },
      undefined,
      BEIJING_PEAK,
    ),
    2,
  );
  assert.equal(
    estimateRequestCostCny(
      "unknown",
      { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      undefined,
      BEIJING_PEAK,
    ),
    null,
  );
});

test("resolveUtilityModel prefers preference then cheapest then heuristic", () => {
  const available = [{ value: "deepseek-v4-pro" }, { value: "deepseek-v4-flash" }];
  assert.equal(resolveUtilityModel(undefined, available), "deepseek-v4-flash");
  assert.equal(resolveUtilityModel("deepseek-v4-pro", available), "deepseek-v4-pro");
  // 偏好指定的模型不可用 → 回退主模型（undefined），绝不静默换选
  assert.equal(resolveUtilityModel("glm-5.2", available), undefined);
  // 无单价信息时按命名惯例
  assert.equal(
    resolveUtilityModel(undefined, [{ value: "my-model-mini" }, { value: "my-model" }]),
    "my-model-mini",
  );
  assert.equal(resolveUtilityModel(undefined, [{ value: "only-model" }]), undefined);
});

test("utility routing prices candidates by their declared channel, not only the builtin table", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-utility-pricing-"));
  const pricingPath = path.join(root, "pricing.json");
  fs.writeFileSync(
    pricingPath,
    JSON.stringify({
      models: {
        // 自建渠道的模型只有覆盖表里有价：只看内置注册表会把它们全部过滤掉，
        // 最后选中一个归属被误判、渠道又没配 Key 的模型（glm-5.2 那种情况）。
        "globaldeepseek/global:deepseek-v4.1-flash": {
          inputPerMTokens: 0.3,
          outputPerMTokens: 1.2,
        },
        "zai/glm-5.2": { inputPerMTokens: 2, outputPerMTokens: 8 },
      },
    }),
    "utf8",
  );
  // 覆盖表按 mtime 缓存：给临时文件一个独有时间戳，避免命中真实 pricing.json 的缓存。
  const stamp = new Date(1_700_000_000_000);
  fs.utimesSync(pricingPath, stamp, stamp);
  const previous = process.env.HAJI_PRICING_PATH;
  process.env.HAJI_PRICING_PATH = pricingPath;
  try {
    assert.equal(
      resolveUtilityModel(undefined, [
        { value: "glm-5.2", provider: "zai" },
        { value: "global:deepseek-v4.1-flash", provider: "globaldeepseek" },
      ]),
      "global:deepseek-v4.1-flash",
      "渠道价参与比较后，最便宜的应该是 deepseek flash 而不是 glm-5.2",
    );
    // 渠道价按 <provider>/<model> 区分：同一个模型换个渠道，价格不同，排序也应跟着变。
    assert.equal(
      resolveUtilityModel(undefined, [
        { value: "glm-5.2", provider: "zai" },
        { value: "global:deepseek-v4.1-flash", provider: "other-channel" },
      ]),
      "glm-5.2",
    );
  } finally {
    if (previous === undefined) delete process.env.HAJI_PRICING_PATH;
    else process.env.HAJI_PRICING_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function withTempWorkspace(run) {
  const previousCwd = process.cwd();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-feat-"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  try {
    run(root, home);
  } finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = previousUserProfile;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("expandFileMentions attaches in-workspace files and strips the @ prefix", () => {
  withTempWorkspace((root) => {
    fs.writeFileSync(path.join(root, "notes.md"), "# 标题\n正文内容", "utf8");
    fs.mkdirSync(path.join(root, "sub"), { recursive: true });
    fs.writeFileSync(path.join(root, "sub", "a.txt"), "AAA", "utf8");
    fs.mkdirSync(path.join(root, "outside"), { recursive: true });
    fs.writeFileSync(path.join(root, "outside", "secret.txt"), "S", "utf8");
    const result = expandFileMentions("看看 @notes.md 和 @sub/a.txt 以及 @missing.txt", root);
    assert.deepEqual(result.attached, ["notes.md", "sub/a.txt"]);
    // 读失败的原因不止「不存在」：权限、目录、非法路径都会走到同一分支，文案保持合并描述。
    assert.deepEqual(result.skipped, ["missing.txt（不存在或无法读取）"]);
    assert.ok(!result.prompt.includes("@notes.md"), "前缀已去掉");
    assert.ok(result.prompt.includes('<attached_file path="notes.md">'));
    assert.ok(result.prompt.includes("# 标题"));
    assert.ok(result.prompt.includes('<attached_file path="sub/a.txt">\nAAA\n</attached_file>'));
    // 未命中与不存在的 token 原样保留
    assert.ok(result.prompt.includes("@missing.txt"));

    // 工作区外的文件不附加（../outside/secret.txt 相对 root 解析后越界）
    const outside = expandFileMentions(`@${path.join("..", "outside", "secret.txt")}`, root);
    assert.deepEqual(outside.attached, []);

    // 没有 @ 引用时原样返回
    assert.deepEqual(expandFileMentions("普通消息 user@host.com", root), {
      prompt: "普通消息 user@host.com",
      attached: [],
      skipped: [],
    });
  });
});

test("user models file loads with tolerance and dedupes are applied downstream", () => {
  withTempWorkspace((_root, home) => {
    const modelsFile = path.join(home, ".haji", "models.json");
    assert.equal(userModelsPath(), modelsFile);
    assert.deepEqual(loadUserModels(), []);
    fs.mkdirSync(path.join(home, ".haji"), { recursive: true });
    fs.writeFileSync(modelsFile, "{ broken json", "utf8");
    assert.deepEqual(loadUserModels(), []);
    fs.writeFileSync(
      modelsFile,
      JSON.stringify({
        models: [
          { model: "glm-5.5", provider: "volcengine", contextWindowTokens: 200_000 },
          { model: "", provider: "volcengine" },
          { nope: true },
        ],
      }),
      "utf8",
    );
    const entries = loadUserModels();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, "glm-5.5");
    assert.equal(entries[0].provider, "volcengine");
  });
});

test("post-edit verify detects check commands and formats notices", () => {
  withTempWorkspace((root) => {
    const env = {};
    assert.equal(
      detectProjectCheckCommand(root, { ...env, HAJI_POST_EDIT_VERIFY: "0" }),
      undefined,
    );
    assert.equal(
      detectProjectCheckCommand(root, { ...env, HAJI_POST_EDIT_VERIFY: "eslint ." }),
      "eslint .",
    );
    // 无 package.json → 不启用
    assert.equal(detectProjectCheckCommand(root, env), undefined);
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", scripts: { typecheck: "tsc --noEmit" } }),
      "utf8",
    );
    assert.equal(detectProjectCheckCommand(root, env), "npm run typecheck --silent");
    // 验证通过不注入：实测这条消息换不来「少自检」，只有上下文成本。
    assert.equal(
      formatVerificationNotice({ ok: true, timedOut: false, output: "" }, "cmd"),
      undefined,
    );
    assert.match(
      formatVerificationNotice({ ok: false, timedOut: false, output: "TS2345: bad type" }, "cmd"),
      /TS2345: bad type/,
    );
    // 超时不回注模型：模型拿不到诊断，塞进上下文只会让它误以为项目有问题。
    assert.equal(
      formatVerificationNotice({ ok: false, timedOut: true, output: "" }, "cmd"),
      undefined,
    );
    assert.match(formatVerificationTimeoutHint("cmd"), /超过时限/);
    assert.match(formatSelfProjectSkipHint(), /haji 本身/);
    // 与本次编辑无关的既有诊断：不催模型修，也不把小结标成失败。
    const unrelated = formatVerificationNotice(
      { ok: false, timedOut: false, output: "packages/core/src/x.ts:461:9 lint × 非空断言" },
      "npm run check",
      "packages/cli/src/tui-sidebar.ts",
    );
    assert.match(unrelated, /没有提到本次编辑的文件/);
    assert.match(unrelated, /项目既有问题/);
    assert.match(unrelated, /不要为此修改其他文件/);
    assert.equal(
      diagnosticsMentionFile("packages/core/src/x.ts:1 lint", "packages/cli/src/tui-sidebar.ts"),
      false,
    );
    assert.equal(
      diagnosticsMentionFile(
        "packages\\cli\\src\\tui-sidebar.ts:10:1 error",
        "packages/cli/src/tui-sidebar.ts",
      ),
      true,
    );
    // 本次编辑自己的诊断仍然要求修复。
    assert.match(
      formatVerificationNotice(
        { ok: false, timedOut: false, output: "packages/cli/src/tui-sidebar.ts:10:1 × err" },
        "npm run check",
        "packages/cli/src/tui-sidebar.ts",
      ),
      /优先修复/,
    );
    // 同一条验证结论在窗口内只注入一次。
    const previous = { text: "same", at: 1_000 };
    assert.equal(shouldPushVerificationNotice(previous, "same", 2_000), false);
    assert.equal(shouldPushVerificationNotice(previous, "same", 70_000), true);
    assert.equal(shouldPushVerificationNotice(previous, "other", 2_000), true);
    assert.equal(shouldPushVerificationNotice(undefined, "same", 2_000), true);
  });
});

test("post-edit verify ignores composite check scripts and picks tsc -b for references", () => {
  withTempWorkspace((root) => {
    const env = {};
    // 只有 check（lint && test）这类组合脚本：不探测，否则每次编辑都跑整套测试直到超时。
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", scripts: { check: "pnpm lint && pnpm test" } }),
      "utf8",
    );
    assert.equal(detectProjectCheckCommand(root, env), undefined);

    // typecheck 脚本优先级最高。
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", scripts: { typecheck: "tsc --noEmit", check: "pnpm test" } }),
      "utf8",
    );
    assert.equal(detectProjectCheckCommand(root, env), "npm run typecheck --silent");

    // references 结构：`tsc --noEmit` 会「假通过」，必须走增量构建。
    fs.writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({ name: "x", scripts: {} }),
      "utf8",
    );
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ files: [], references: [{ path: "./packages/a" }] }),
      "utf8",
    );
    assert.equal(detectProjectCheckCommand(root, env), "npx tsc -b");

    // 带注释的 tsconfig 解析失败时按文本粗判，不能退化成 --noEmit。
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      '{\n  // 根配置只做聚合\n  "files": [],\n  "references": [{ "path": "./packages/a" }]\n}\n',
      "utf8",
    );
    assert.equal(detectProjectCheckCommand(root, env), "npx tsc -b");

    // 普通 tsconfig：单项目检查。
    fs.writeFileSync(
      path.join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
      "utf8",
    );
    assert.equal(detectProjectCheckCommand(root, env), "npx tsc --noEmit");
  });
});

test("isSelfProject only matches the repo the running CLI lives in", () => {
  withTempWorkspace((root) => {
    const moduleFile = path.join(root, "packages", "cli", "dist", "post-edit-verify.js");
    fs.mkdirSync(path.dirname(moduleFile), { recursive: true });
    fs.writeFileSync(moduleFile, "", "utf8");
    const moduleUrl = pathToFileURL(moduleFile).href;
    assert.equal(isSelfProject(root, moduleUrl), true);
    const other = path.join(root, "elsewhere");
    fs.mkdirSync(other, { recursive: true });
    assert.equal(isSelfProject(other, moduleUrl), false);
  });
});

test("image command parses args and loads attachments with validation", () => {
  assert.equal(parseImageCommand(["image"]), undefined);
  const parsed = parseImageCommand(["image", "D:\\shot.png", "这是什么", "报错"]);
  assert.equal(parsed.imagePath, "D:\\shot.png");
  assert.equal(parsed.prompt, "这是什么 报错");
  assert.equal(parseImageCommand(["image", "a.png"]).prompt, "请分析这张图片。");

  withTempWorkspace((root) => {
    const png = path.join(root, "pic.png");
    // 1x1 PNG
    fs.writeFileSync(
      png,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    const ok = loadImageAttachment(png);
    assert.equal(ok.ok, true);
    if (ok.ok) assert.equal(ok.mimeType, "image/png");

    assert.equal(loadImageAttachment(path.join(root, "nope.png")).ok, false);
    const txt = path.join(root, "note.txt");
    fs.writeFileSync(txt, "x", "utf8");
    assert.match(loadImageAttachment(txt).error, /不支持的图片格式/);
  });
});

test("messageContentOrParts converts attachments to multimodal parts", () => {
  assert.equal(messageContentOrParts({ content: "纯文本" }), "纯文本");
  const parts = messageContentOrParts({
    content: "看图",
    attachments: [{ mimeType: "image/png", base64: "QUJD" }],
  });
  assert.ok(Array.isArray(parts));
  assert.deepEqual(parts[0], { type: "text", text: "看图" });
  assert.deepEqual(parts[1], {
    type: "image_url",
    image_url: { url: "data:image/png;base64,QUJD" },
  });
});

test("index.ts wires the new feature batch end to end", () => {
  const source = fs.readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  // 费用
  assert.ok(source.includes("new CostTracker("), "费用记账器（注入注册表+本地覆盖的定价解析）");
  assert.ok(source.includes("recordCost:"), "turnDeps 注入记账回调");
  assert.ok(source.includes('command === "cost"'), "/cost 命令");
  // utility 路由
  assert.ok(source.includes("resolveUtilityModel("), "杂活模型解析");
  assert.ok(source.includes("getTitleUtility: getUtilityRuntime"), "标题走杂活模型");
  assert.ok(source.includes("utility?.provider ?? provider"), "distill/压缩走杂活模型");
  assert.ok(source.includes('utilityCall("上下文压缩")'), "压缩记账");
  // 无头 v2
  assert.ok(source.includes('headlessRequest?.outputFormat === "json"'), "JSON 模式静音");
  assert.ok(source.includes("JSON.stringify("), "JSON 输出");
  assert.ok(source.includes('headlessRequest?.prompt === "-"'), "stdin 管道 prompt");
  // @ 引用与 /image
  assert.ok(source.includes("expandFileMentions(trimmedInput"), "@ 引用展开");
  assert.ok(source.includes('command === "image"'), "/image 命令");
  assert.ok(source.includes("promptAttachments:"), "附件传入回合");
  // post-edit 验证
  assert.ok(source.includes("detectProjectCheckCommand"), "编辑后验证探测");
  assert.ok(source.includes("postEditVerifier.afterToolUse("), "冷却式验证执行");
});

test("turn-runner reports usage and passes attachments through", () => {
  const source = fs.readFileSync(new URL("../src/turn-runner.ts", import.meta.url), "utf8");
  assert.ok(source.includes("deps.recordCost?.(selectedModel, usage"), "onUsage 记账");
  assert.ok(source.includes("deps.getTitleUtility?.()"), "标题杂活注入");
  assert.ok(
    /messages\.push\(\{\s*\n\s*role: "user",\s*\n\s*content: recallBlock \?[^\n]*: promptInput,\s*\n\s*\.\.\.\(input\.promptAttachments/.test(
      source,
    ),
    "附件随用户消息入队（经验召回块也在同一条消息里）",
  );
});

test("providers map attachments via the shared converter", () => {
  for (const file of ["deepseek.ts", "volcengine.ts", "openai-compatible.ts"]) {
    const source = fs.readFileSync(new URL(`../../plugins/src/${file}`, import.meta.url), "utf8");
    assert.ok(source.includes("messageContentOrParts(msg)"), `${file} 使用共享转换`);
  }
});
