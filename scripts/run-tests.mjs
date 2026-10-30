#!/usr/bin/env node
/** 显式枚举测试文件，兼容不会替 Node 展开通配符的 Windows shell。 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packagesDir = path.join(root, "packages");
const files = fs
  .readdirSync(packagesDir)
  .map((name) => path.join(packagesDir, name, "test"))
  .filter((dir) => fs.existsSync(dir))
  .flatMap((dir) =>
    fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".test.mjs"))
      .map((name) => path.join(dir, name)),
  )
  .sort();
if (files.length === 0) throw new Error("未找到测试文件");
const result = spawnSync(process.execPath, ["--test", ...files], {
  cwd: root,
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
