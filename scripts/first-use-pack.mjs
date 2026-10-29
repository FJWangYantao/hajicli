import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { firstUseSmoke } from "./first-use-smoke.mjs";
import { runProcess } from "./quality-run.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
// pnpm exec 不保证设置 npm_execpath；优先使用运行脚本的包管理器路径。
const pnpmScript = process.env.npm_execpath;
if (!pnpmScript || !fs.existsSync(pnpmScript)) {
  throw new Error("请使用 pnpm run first-use:pack，以取得本机包管理器路径");
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "haji-pack-install-"));
const bundle = path.join(root, "bundles");
const install = path.join(root, "install");
fs.mkdirSync(bundle);
fs.mkdirSync(path.join(install, "node_modules", "@hajicli"), { recursive: true });
try {
  // pnpm pack 生成真实发布物，随后仅从本地产物安装依赖树，不读取registry。
  for (const name of ["core", "plugins", "cli"]) {
    const packed = await runProcess(
      process.execPath,
      [pnpmScript, "pack", "--pack-destination", bundle],
      { cwd: path.join(repository, "packages", name), timeoutMs: 60000 },
    );
    if (packed.code !== 0)
      throw new Error(`${name} 打包失败，请用 pnpm exec node scripts/first-use-pack.mjs 运行`);
  }
  for (const [name, tgz] of [
    ["core", "hajicli-core"],
    ["plugins", "hajicli-plugins"],
    ["cli", "hajicli-"],
  ]) {
    const file = fs
      .readdirSync(bundle)
      .find(
        (f) => f.startsWith(tgz) && (name !== "cli" || /^hajicli-\d/.test(f)) && f.endsWith(".tgz"),
      );
    if (!file) throw new Error(`${name} 缺少打包文件`);
    const destination = path.join(
      install,
      "node_modules",
      name === "cli" ? "hajicli" : `@hajicli/${name}`,
    );
    fs.mkdirSync(destination, { recursive: true });
    const extracted = await runProcess(
      "tar",
      ["-xf", file, "--strip-components=1", "-C", destination],
      { cwd: bundle, timeoutMs: 10000 },
    );
    if (extracted.code !== 0) throw new Error(`${name} 解包失败`);
  }
  // 第三方依赖从已冻结的本地依赖树复制，保持检查离线且无需全局安装。
  const specs = [
    ["core", "yaml"],
    ["plugins", "undici"],
    ["cli", "diff"],
  ];
  for (const [owner, dependency] of specs) {
    const require = createRequire(path.join(repository, "packages", owner, "package.json"));
    let directory = path.dirname(require.resolve(dependency));
    while (
      !fs.existsSync(path.join(directory, "package.json")) ||
      JSON.parse(fs.readFileSync(path.join(directory, "package.json"))).name !== dependency
    ) {
      const parent = path.dirname(directory);
      if (parent === directory) throw new Error(`无法定位依赖 ${dependency}`);
      directory = parent;
    }
    fs.cpSync(directory, path.join(install, "node_modules", dependency), { recursive: true });
  }
  const result = await firstUseSmoke(
    path.join(install, "node_modules", "hajicli", "dist", "index.js"),
  );
  console.log(
    JSON.stringify({
      ...result,
      packageInstall: "local-tarballs",
      thirdPartyDependencies: "frozen-local-copy",
    }),
  );
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
