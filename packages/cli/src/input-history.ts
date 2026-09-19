import { spawn } from "node:child_process";
import { stdout } from "node:process";

export class InputHistoryBuffer {
  private readonly entries: string[] = [];
  private cursor = 0;
  private draft = "";

  begin(draft = ""): void {
    this.cursor = this.entries.length;
    this.draft = draft;
  }

  record(value: string): void {
    if (value.trim()) {
      this.entries.push(value);
    }
    this.begin();
  }

  move(direction: -1 | 1, currentValue: string): string | undefined {
    if (this.entries.length === 0) {
      return undefined;
    }

    if (direction === -1) {
      if (this.cursor === this.entries.length) {
        this.draft = currentValue;
      }
      if (this.cursor === 0) {
        return undefined;
      }
      this.cursor -= 1;
      return this.entries[this.cursor];
    }

    if (this.cursor >= this.entries.length) {
      return undefined;
    }
    this.cursor += 1;
    return this.cursor === this.entries.length ? this.draft : this.entries[this.cursor];
  }

  isBrowsing(): boolean {
    return this.cursor < this.entries.length;
  }
}

export class ClipboardWriter {
  private child?: ReturnType<typeof spawn>;
  private outputBuffer = "";
  private readonly pending: Array<(success: boolean) => void> = [];

  start(): void {
    if (process.platform !== "win32" || this.child) return;

    const script = [
      "[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)",
      "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)",
      "while (($line = [Console]::In.ReadLine()) -ne $null) {",
      "  try {",
      "    $bytes = [Convert]::FromBase64String($line)",
      "    $text = [Text.Encoding]::UTF8.GetString($bytes)",
      "    Set-Clipboard -Value $text",
      "    [Console]::Out.WriteLine('OK')",
      "  } catch {",
      "    [Console]::Out.WriteLine('ERR')",
      "  }",
      "}",
    ].join("; ");

    const child = spawn(
      "powershell.exe",
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    this.child = child;
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      this.outputBuffer += chunk;
      let newlineIndex = this.outputBuffer.indexOf("\n");
      while (newlineIndex >= 0) {
        const result = this.outputBuffer.slice(0, newlineIndex).trim();
        this.outputBuffer = this.outputBuffer.slice(newlineIndex + 1);
        this.pending.shift()?.(result === "OK");
        newlineIndex = this.outputBuffer.indexOf("\n");
      }
    });
    const failPending = () => {
      if (this.child !== child) return;
      this.child = undefined;
      this.outputBuffer = "";
      for (const resolve of this.pending.splice(0)) resolve(false);
    };
    child.once("error", failPending);
    child.once("exit", failPending);
  }

  write(text: string): Promise<boolean> {
    if (!text) return Promise.resolve(false);
    if (process.platform !== "win32") {
      stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
      return Promise.resolve(true);
    }

    this.start();
    const child = this.child;
    if (!child?.stdin?.writable) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      this.pending.push(resolve);
      child.stdin!.write(`${Buffer.from(text, "utf8").toString("base64")}\n`, (error) => {
        if (!error) return;
        const pendingIndex = this.pending.indexOf(resolve);
        if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1);
        resolve(false);
      });
    });
  }

  close(): void {
    const child = this.child;
    this.child = undefined;
    this.outputBuffer = "";
    for (const resolve of this.pending.splice(0)) resolve(false);
    child?.stdin?.end();
  }
}
