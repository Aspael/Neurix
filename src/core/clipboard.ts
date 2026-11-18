/**
 * Lê a área de transferência — o jeito confiável de trazer um prompt longo (com linhas em branco) para o
 * menu, sem depender de colar no terminal.
 *   Windows: PowerShell Get-Clipboard · macOS: pbpaste · Linux: wl-paste, xclip ou xsel.
 */
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const candidates = (): [string, string[]][] => {
  const p = platform();
  if (p === "win32") {
    const ps = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    // UTF-8 na saída para não estragar acentos
    const cmd = "[Console]::OutputEncoding=[Text.Encoding]::UTF8; Get-Clipboard -Raw";
    return [
      [ps, ["-NoProfile", "-NonInteractive", "-Command", cmd]],
      ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd]],
      ["pwsh", ["-NoProfile", "-NonInteractive", "-Command", cmd]],
    ];
  }
  if (p === "darwin") return [["pbpaste", []]];
  return [
    ["wl-paste", ["--no-newline"]],
    ["xclip", ["-selection", "clipboard", "-o"]],
    ["xsel", ["--clipboard", "--output"]],
  ];
};

/** Texto da área de transferência, ou null se não deu para ler (sem ferramenta, sem texto). */
export async function readClipboard(): Promise<string | null> {
  for (const [exe, args] of candidates()) {
    try {
      const { stdout } = await run(exe, args, { timeout: 5000, windowsHide: true, maxBuffer: 50 * 1024 * 1024, encoding: "utf8" });
      // o PowerShell acrescenta uma quebra de linha no fim
      return stdout.replace(/\r\n/g, "\n").replace(/\n$/, "");
    } catch {
      // tenta o próximo
    }
  }
  return null;
}
