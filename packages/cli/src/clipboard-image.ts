import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** 剪贴板取图的等待上限：PowerShell 冷启动通常 < 2s，超时视为失败。 */
const CLIPBOARD_TIMEOUT_MS = 15_000;

/** 暂存目录（工作区内，已被 .gitignore 的 .haji/ 覆盖）：读图工具只能读工作区内文件。 */
const ATTACHMENT_DIR = path.join(".haji", "attachments");

/**
 * 把剪贴板位图另存为 PNG。目标路径经环境变量传入，避免路径里的引号/空格
 * 破坏 PowerShell 字符串字面量。
 */
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "$image = [System.Windows.Forms.Clipboard]::GetImage()",
  "if ($null -eq $image) { Write-Output 'NOIMAGE'; exit 0 }",
  "try { $image.Save($env:HAJICLI_CLIPBOARD_TARGET, [System.Drawing.Imaging.ImageFormat]::Png) }",
  "finally { $image.Dispose() }",
  "Write-Output 'OK'",
].join("\n");

function runPowerShell(script: string, targetPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-STA", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      {
        env: { ...process.env, HAJICLI_CLIPBOARD_TARGET: targetPath },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let output = "";
    let errorOutput = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("读取剪贴板超时"));
    }, CLIPBOARD_TIMEOUT_MS);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(errorOutput.trim() || `PowerShell 退出码 ${code}`));
        return;
      }
      resolve(output);
    });
  });
}

/** 粘贴到输入框的图片：落盘成工作区文件，提交时只需把路径交给模型 read。 */
export interface PastedImage {
  /** 工作区相对路径（正斜杠），直接用于 read 工具的 path 参数。 */
  path: string;
  /** 输入框上方 chip 显示的文件名。 */
  displayName: string;
  bytes: number;
}

export type ClipboardCaptureResult =
  | { ok: true; image: PastedImage }
  | { ok: false; error: string };

function timestampName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    "paste-",
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    "-",
    String(now.getMilliseconds()).padStart(3, "0"),
    ".png",
  ].join("");
}

/**
 * 读取系统剪贴板中的位图，另存为工作区下的 PNG 并返回路径。
 * 目前仅 Windows 可用（借道 PowerShell + System.Windows.Forms）；其他平台返回错误而不是抛异常。
 */
export async function captureClipboardImage(
  cwd = process.cwd(),
  now = new Date(),
): Promise<ClipboardCaptureResult> {
  if (process.platform !== "win32") {
    return { ok: false, error: "剪贴板取图目前仅支持 Windows" };
  }

  const directory = path.resolve(cwd, ATTACHMENT_DIR);
  const fileName = timestampName(now);
  const targetPath = path.join(directory, fileName);
  try {
    fs.mkdirSync(directory, { recursive: true });
    const output = await runPowerShell(POWERSHELL_SCRIPT, targetPath);
    if (output.includes("NOIMAGE")) {
      return { ok: false, error: "剪贴板里没有图片（请先截图或复制图片）" };
    }
    if (!fs.existsSync(targetPath)) {
      return { ok: false, error: "读取剪贴板失败（未生成图片）" };
    }
    // 图片要留着给 read 工具读，这里只记体积，不删除文件。
    const bytes = fs.statSync(targetPath).size;
    return {
      ok: true,
      image: {
        path: path.relative(cwd, targetPath).split(path.sep).join("/"),
        displayName: fileName,
        bytes,
      },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, error: `读取剪贴板失败：${detail}` };
  }
}
