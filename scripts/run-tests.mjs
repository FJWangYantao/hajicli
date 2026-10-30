#!/usr/bin/env node
/** 显式枚举测试文件，兼容不会替 Node 展开通配符的 Windows shell。 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const testDir = path.join(root, "packages", "cli", "test");
const files = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();
if (files.length === 0) throw new Error("未找到 CLI 测试文件");
const result = spawnSync(
  process.execPath,
  ["--test", ...files.map((name) => path.join(testDir, name))],
  {
    cwd: root,
    stdio: "inherit",
  },
);
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
