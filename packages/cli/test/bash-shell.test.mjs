import assert from "node:assert/strict";
import test from "node:test";

import {
  BashTool,
  describeEnvironment,
  describeShell,
  detectShellDialect,
  resolveShell,
  resolveShellEnvironment,
  selectShell,
} from "@hajicli/plugins";

const GIT_BASH = "D:\\Program Files\\Git\\bin\\bash.exe";

function windowsEnv(extra = {}) {
  return {
    PATH: "C:\\Windows\\System32;D:\\Program Files\\Git\\cmd",
    ProgramFiles: "C:\\Program Files",
    ...extra,
  };
}

test("non-Windows platforms keep the default POSIX shell", () => {
  const shell = resolveShell("linux", {}, () => false);
  assert.equal(shell.kind, "sh");
  assert.equal(shell.file, undefined);
});

test("POSIX prefers /bin/bash when it exists", () => {
  const environment = resolveShellEnvironment(
    "linux",
    {},
    (candidate) => candidate === "/bin/bash",
  );
  assert.equal(environment.preferred.kind, "bash");
  assert.equal(environment.preferred.file, "/bin/bash");
  assert.deepEqual(
    environment.alternatives.map((spec) => spec.kind),
    ["sh"],
  );
});

test("Windows prefers Git Bash and never mistakes WSL's System32 bash for it", () => {
  const shell = resolveShell("win32", windowsEnv(), (candidate) => candidate === GIT_BASH);
  assert.equal(shell.kind, "bash");
  assert.equal(shell.file, GIT_BASH);
  assert.deepEqual(shell.args, ["-c"]);

  // PATH 里只有 System32（WSL bash）时不应被选中。
  const wslOnly = resolveShell(
    "win32",
    { PATH: "C:\\Windows\\System32", ProgramFiles: "C:\\Program Files" },
    (candidate) => candidate === "C:\\Windows\\System32\\bash.exe",
  );
  assert.equal(wslOnly.kind, "powershell");
});

test("Windows falls back to PowerShell when Git Bash is absent", () => {
  const shell = resolveShell("win32", windowsEnv(), () => false);
  assert.equal(shell.kind, "powershell");
  assert.equal(shell.file, "powershell.exe");
  assert.ok(shell.args.includes("-Command"));
});

test("HAJI_SHELL can force cmd or PowerShell", () => {
  const cmd = resolveShell("win32", windowsEnv({ HAJI_SHELL: "cmd" }), () => true);
  assert.equal(cmd.kind, "cmd");
  assert.deepEqual(cmd.args, ["/d", "/s", "/c"]);

  const powershell = resolveShell(
    "win32",
    windowsEnv({ HAJI_SHELL: "powershell" }),
    (candidate) => candidate === GIT_BASH,
  );
  assert.equal(powershell.kind, "powershell");
});

test("all installed shells stay available as fallbacks", () => {
  const environment = resolveShellEnvironment(
    "win32",
    windowsEnv(),
    (candidate) => candidate === GIT_BASH,
  );
  assert.deepEqual(
    [environment.preferred, ...environment.alternatives].map((spec) => spec.kind),
    ["bash", "powershell", "cmd"],
  );
});

test("tool description names the dialect the model must write", () => {
  const bash = describeShell({ kind: "bash", file: GIT_BASH, args: ["-c"] });
  assert.match(bash, /bash/);
  assert.match(bash, /heredoc/);

  const powershell = describeShell({ kind: "powershell", args: [] });
  assert.match(powershell, /PowerShell/);
  assert.match(powershell, /;/);
  assert.match(powershell, /here-string/);
  assert.match(powershell, /不支持 &&/);

  const cmd = describeShell({ kind: "cmd", args: [] });
  assert.match(cmd, /cmd\.exe/);
  assert.match(cmd, /&&/);
  assert.match(cmd, /不支持 heredoc/);
});

test("default tool description matches the resolved environment", () => {
  const tool = new BashTool();
  assert.equal(
    tool.definition.function.description,
    describeEnvironment(resolveShellEnvironment()),
  );
});

test("detects the dialect from the command instead of guessing", () => {
  assert.equal(detectShellDialect("cat <<'EOF'\nline\nEOF"), "bash");
  assert.equal(detectShellDialect("echo $(date)"), "bash");
  assert.equal(detectShellDialect("[[ -f package.json ]] && echo yes"), "bash");
  assert.equal(detectShellDialect("ls -la && cat package.json"), "bash");
  assert.equal(detectShellDialect("Get-ChildItem -Name package.json"), "powershell");
  assert.equal(detectShellDialect("Write-Output $(Get-Date)"), "powershell");
  assert.equal(detectShellDialect("$env:PATH"), "powershell");
  assert.equal(detectShellDialect("Get-Content a.txt | Select-Object -First 1"), "powershell");
  assert.equal(detectShellDialect("dir /b && type package.json"), "cmd");
  assert.equal(detectShellDialect("echo %PATH%"), "cmd");
  // 引号里的词是数据，不参与判断。
  assert.equal(detectShellDialect('rg "Get-ChildItem" .'), undefined);
  assert.equal(detectShellDialect("git status --short"), undefined);
});

test("selectShell prefers explicit choice, then the command dialect, then the environment", () => {
  const environment = {
    preferred: { kind: "bash", file: GIT_BASH, args: ["-c"] },
    alternatives: [
      { kind: "powershell", file: "powershell.exe", args: ["-Command"] },
      { kind: "cmd", file: "cmd.exe", args: ["/c"] },
    ],
  };

  assert.equal(selectShell(environment, "Get-ChildItem").kind, "powershell");
  assert.equal(selectShell(environment, "cat <<'EOF'\nx\nEOF").kind, "bash");
  assert.equal(selectShell(environment, "dir /b").kind, "cmd");
  assert.equal(selectShell(environment, "git status").kind, "bash");
  assert.equal(selectShell(environment, "git status", "powershell").kind, "powershell");

  // 方言不可用时退回环境首选，而不是报错。
  const powershellOnly = {
    preferred: { kind: "powershell", file: "powershell.exe", args: ["-Command"] },
    alternatives: [],
  };
  assert.equal(selectShell(powershellOnly, "cat <<'EOF'\nx\nEOF").kind, "powershell");

  // PowerShell 5.1 不认 && / ||，有 cmd 时交给 cmd；; 仍留在 PowerShell。
  const powershellWithCmd = {
    preferred: { kind: "powershell", file: "powershell.exe", args: ["-Command"] },
    alternatives: [{ kind: "cmd", file: "cmd.exe", args: ["/c"] }],
  };
  assert.equal(selectShell(powershellWithCmd, "pnpm run build && pnpm test").kind, "cmd");
  assert.equal(selectShell(powershellWithCmd, "pnpm run build; pnpm test").kind, "powershell");
});

const activeShell = resolveShell();
const environment = resolveShellEnvironment();
const availableShells = [environment.preferred, ...environment.alternatives];

test("the bash tool accepts heredoc, semicolons and Chinese output", {
  skip: activeShell.kind !== "bash" && activeShell.kind !== "sh",
}, async () => {
  const result = await new BashTool().execute({
    command: [
      "printf 'first\\nsecond\\n' | head -1",
      "cat <<'EOF'",
      "多行提交信息",
      "EOF",
      "echo 你好; echo done",
    ].join("\n"),
  });

  assert.match(result, /退出码 0/);
  assert.match(result, /^first$/m);
  assert.match(result, /多行提交信息/);
  assert.match(result, /你好/);
  assert.match(result, /done/);
});

test("the bash tool switches to PowerShell for a PowerShell command", {
  skip: !availableShells.some((spec) => spec.kind === "powershell"),
}, async () => {
  const result = await new BashTool().execute({ command: "Get-ChildItem -Name package.json" });
  assert.match(result, /退出码 0/);
  assert.match(result, /package\.json/);
});

test("an unknown shell override is rejected instead of silently ignored", async () => {
  const result = await new BashTool().execute({
    command: "git status",
    shell: "fish",
  });
  assert.match(result, /不支持 shell "fish"/);
  assert.match(result, /可用：/);
});
