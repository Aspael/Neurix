/**
 * Análise de pasta / repositório: conta tokens de cada arquivo de texto.
 *
 * Pula o que não interessa a uma IA: node_modules, .git, builds, binários, lockfiles e o que estiver no
 * .gitignore da raiz (padrões simples: nome, *.ext, pasta/, /raiz, **).
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";

export interface FileTokens {
  path: string;
  ext: string;
  bytes: number;
  chars: number;
  tokens: number;
}

export interface ExtTotal {
  ext: string;
  files: number;
  tokens: number;
}

export interface FolderResult {
  root: string;
  files: FileTokens[];
  totalTokens: number;
  totalChars: number;
  totalBytes: number;
  byExt: ExtTotal[];
  /** Pastas e arquivos pulados, por motivo. */
  skipped: { ignored: number; binary: number; tooBig: number; lockfile: number; limit: number };
  usedGitignore: boolean;
}

export interface FolderOptions {
  maxFiles?: number;
  maxFileBytes?: number;
  includeHidden?: boolean;
  /** Extensões a incluir (ex.: [".ts", ".md"]); vazio = todas as de texto. */
  extensions?: string[];
}

export const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".hg", ".svn", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit", "coverage",
  "__pycache__", ".venv", "venv", "env", ".tox", ".mypy_cache", ".pytest_cache", "target", "vendor", ".gradle",
  ".idea", ".turbo", ".cache", ".parcel-cache", "bin", "obj",
]);

const LOCKFILES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "composer.lock", "Cargo.lock", "poetry.lock",
  "Pipfile.lock", "Gemfile.lock", "go.sum",
]);

const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".pdf", ".zip", ".gz", ".tar", ".7z", ".rar", ".exe",
  ".dll", ".so", ".dylib", ".bin", ".wasm", ".mp3", ".mp4", ".mov", ".avi", ".woff", ".woff2", ".ttf", ".otf",
  ".eot", ".class", ".jar", ".pyc", ".o", ".a", ".lib", ".db", ".sqlite", ".gguf", ".safetensors", ".onnx", ".pt",
]);

/** Converte um padrão simples do .gitignore em teste para caminho relativo (com "/"). */
function gitignoreMatcher(lines: string[]): (rel: string, isDir: boolean) => boolean {
  const rules = lines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && !l.startsWith("!"))
    .map((raw) => {
      const dirOnly = raw.endsWith("/");
      let p = raw.replace(/\/$/, "");
      const anchored = p.startsWith("/") || p.includes("/");
      p = p.replace(/^\//, "");
      const re = p
        .split("**")
        .map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]"))
        .join(".*");
      return { re: new RegExp(anchored ? `^${re}(/|$)` : `(^|/)${re}(/|$)`), dirOnly };
    });
  return (rel, isDir) => rules.some((r) => (!r.dirOnly || isDir) && r.re.test(rel));
}

export async function analyzeFolder(root: string, count: (s: string) => number, opts: FolderOptions = {}): Promise<FolderResult> {
  const maxFiles = opts.maxFiles ?? 5000;
  const maxBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  const exts = opts.extensions?.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase());
  const skipped = { ignored: 0, binary: 0, tooBig: 0, lockfile: 0, limit: 0 };
  const files: FileTokens[] = [];

  let ignored: (rel: string, isDir: boolean) => boolean = () => false;
  let usedGitignore = false;
  try {
    ignored = gitignoreMatcher((await readFile(join(root, ".gitignore"), "utf8")).split(/\r?\n/));
    usedGitignore = true;
  } catch {
    // sem .gitignore
  }

  async function walk(dir: string): Promise<void> {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const full = join(dir, e.name);
      const rel = relative(root, full).split(sep).join("/");
      const hidden = e.name.startsWith(".") && e.name !== ".gitignore";
      if (e.isDirectory()) {
        if (IGNORED_DIRS.has(e.name) || (hidden && !opts.includeHidden) || ignored(rel, true)) {
          skipped.ignored++;
          continue;
        }
        await walk(full);
        continue;
      }
      if (!e.isFile()) continue;
      if ((hidden && !opts.includeHidden) || ignored(rel, false)) {
        skipped.ignored++;
        continue;
      }
      if (LOCKFILES.has(e.name)) {
        skipped.lockfile++;
        continue;
      }
      const ext = extname(e.name).toLowerCase();
      if (BINARY_EXT.has(ext)) {
        skipped.binary++;
        continue;
      }
      if (exts?.length && !exts.includes(ext)) {
        skipped.ignored++;
        continue;
      }
      if (files.length >= maxFiles) {
        skipped.limit++;
        continue;
      }
      const s = await stat(full).catch(() => null);
      if (!s) continue;
      if (s.size > maxBytes) {
        skipped.tooBig++;
        continue;
      }
      const buf = await readFile(full).catch(() => null);
      if (!buf) continue;
      if (buf.subarray(0, 8000).includes(0)) {
        skipped.binary++;
        continue;
      }
      const content = buf.toString("utf8");
      files.push({ path: rel, ext: ext || "(sem)", bytes: s.size, chars: content.length, tokens: count(content) });
    }
  }

  await walk(root);
  files.sort((a, b) => b.tokens - a.tokens);

  const byExtMap = new Map<string, ExtTotal>();
  for (const f of files) {
    const t = byExtMap.get(f.ext) ?? { ext: f.ext, files: 0, tokens: 0 };
    t.files++;
    t.tokens += f.tokens;
    byExtMap.set(f.ext, t);
  }
  return {
    root,
    files,
    totalTokens: files.reduce((a, f) => a + f.tokens, 0),
    totalChars: files.reduce((a, f) => a + f.chars, 0),
    totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    byExt: [...byExtMap.values()].sort((a, b) => b.tokens - a.tokens),
    skipped,
    usedGitignore,
  };
}

/** Totais por pasta de primeiro nível (ex.: src, docs, tests). */
export function byTopDir(files: FileTokens[]): { dir: string; files: number; tokens: number }[] {
  const m = new Map<string, { dir: string; files: number; tokens: number }>();
  for (const f of files) {
    const dir = f.path.includes("/") ? `${f.path.split("/")[0]}/` : ".";
    const t = m.get(dir) ?? { dir, files: 0, tokens: 0 };
    t.files++;
    t.tokens += f.tokens;
    m.set(dir, t);
  }
  return [...m.values()].sort((a, b) => b.tokens - a.tokens);
}
