#!/usr/bin/env node
/**
 * 构建收尾：给各包 package.json 里 bin 指向的文件补上执行位
 *
 * 背景：tsc 产出的 JS 一律是 644，而 npm 只在安装/hook 时给 bin 目标补 +x。
 * 本仓库在 Linux/macOS 上的全局 haji 是「指向 dist/index.js 的符号链接」（Windows 是 junction），
 * 因此 `pnpm run clean && pnpm run build` 之后直接跑 haji 会 Permission denied。
 * 这里按 bin 字段统一补 755，幂等；Windows 按扩展名判断执行，不需要这一步。
 */
import fs from "node:fs";
import path from "node:path";

if (process.platform !== "win32") {
  const workspaceRoot = path.resolve(import.meta.dirname, "..");
  const packagesDir = path.join(workspaceRoot, "packages");

  for (const name of fs.readdirSync(packagesDir)) {
    const manifestPath = path.join(packagesDir, name, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    const bins =
      typeof manifest.bin === "string" ? [manifest.bin] : Object.values(manifest.bin ?? {});

    for (const rel of bins) {
      const file = path.resolve(path.dirname(manifestPath), rel);
      if (!fs.existsSync(file)) continue;
      const mode = fs.statSync(file).mode;
      if (mode & 0o100) continue; // 已经有执行位
      fs.chmodSync(file, mode | 0o755);
      console.log(`chmod +x ${path.relative(workspaceRoot, file)}`);
    }
  }
}
