/**
 * Detecta modelos instalados no PC, lendo os arquivos GGUF direto do disco:
 *  - Ollama: ~/.ollama/models (ou OLLAMA_MODELS) — funciona mesmo com o Ollama desligado,
 *    lendo os manifestos e abrindo o blob do modelo.
 *  - LM Studio: ~/.lmstudio/models e ~/.cache/lm-studio/models.
 *  - Pastas extras (--dir ou NEURIX_MODELS_DIR) com arquivos .gguf.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readGguf, shapeFromGguf } from "./gguf.ts";
import type { LocalModel, Quantization } from "./local.ts";

export type ModelSource = "ollama" | "lmstudio" | "gguf";

export interface InstalledModel {
  /** Nome como o usuário conhece (ex.: "llama3.1:8b" no Ollama, nome do arquivo no LM Studio). */
  name: string;
  source: ModelSource;
  path: string;
  sizeBytes: number;
  arch: string;
  model: LocalModel;
  /** Quantização real: o rótulo do arquivo e os bits por peso medidos (tamanho × 8 ÷ parâmetros). */
  quant: Quantization;
}

export interface InstalledScan {
  models: InstalledModel[];
  searched: { source: ModelSource; dir: string; found: boolean }[];
  errors: { path: string; error: string }[];
}

export const ollamaDir = (): string => process.env.OLLAMA_MODELS ?? join(homedir(), ".ollama", "models");
export const lmStudioDirs = (): string[] => [join(homedir(), ".lmstudio", "models"), join(homedir(), ".cache", "lm-studio", "models")];

const exists = async (p: string): Promise<boolean> => (await stat(p).catch(() => null)) !== null;

async function toInstalled(path: string, name: string, source: ModelSource): Promise<InstalledModel> {
  const [info, s] = await Promise.all([readGguf(path), stat(path)]);
  const shape = shapeFromGguf(info);
  const bits = shape.paramsB > 0 ? (s.size * 8) / (shape.paramsB * 1e9) : 16;
  return {
    name,
    source,
    path,
    sizeBytes: s.size,
    arch: shape.arch,
    model: {
      id: `${source}:${name}`,
      name,
      paramsB: shape.paramsB,
      layers: shape.layers,
      kvHeads: shape.kvHeads,
      headDim: shape.headDim,
      maxContext: shape.maxContext,
    },
    quant: { id: shape.fileType ?? `${bits.toFixed(1)} bits`, bits },
  };
}

/** Ollama: manifests/<registro>/<namespace>/<modelo>/<tag> → camada do modelo → blobs/sha256-<hash>. */
async function scanOllama(dir: string, out: InstalledScan): Promise<void> {
  const manifests = join(dir, "manifests");
  if (!(await exists(manifests))) return;
  const files: string[] = [];
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 5) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile()) files.push(p);
    }
  }
  await walk(manifests, 0);
  for (const f of files) {
    try {
      const m = JSON.parse(await readFile(f, "utf8")) as { layers?: { mediaType: string; digest: string }[] };
      const layer = m.layers?.find((l) => l.mediaType === "application/vnd.ollama.image.model");
      if (!layer) continue;
      const blob = join(dir, "blobs", layer.digest.replace(":", "-"));
      // nome: .../<namespace>/<modelo>/<tag>; "library" é o namespace padrão e some do nome
      const parts = f.split(/[\\/]/);
      const tag = parts.at(-1) ?? "latest";
      const model = parts.at(-2) ?? "modelo";
      const ns = parts.at(-3);
      const name = `${ns && ns !== "library" ? `${ns}/` : ""}${model}:${tag}`;
      out.models.push(await toInstalled(blob, name, "ollama"));
    } catch (err) {
      out.errors.push({ path: f, error: (err as Error).message });
    }
  }
}

/** Procura .gguf em uma pasta (até 4 níveis). Ignora partes de arquivos divididos além da primeira. */
async function scanGgufDir(dir: string, source: ModelSource, out: InstalledScan): Promise<void> {
  async function walk(d: string, depth: number): Promise<void> {
    if (depth > 4) return;
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p, depth + 1);
      else if (e.isFile() && /\.gguf$/i.test(e.name) && !/-0000[2-9]-of-|mmproj/i.test(e.name)) {
        try {
          out.models.push(await toInstalled(p, basename(e.name, ".gguf"), source));
        } catch (err) {
          out.errors.push({ path: p, error: (err as Error).message });
        }
      }
    }
  }
  await walk(dir, 0);
}

export async function findInstalledModels(extraDirs: string[] = []): Promise<InstalledScan> {
  const out: InstalledScan = { models: [], searched: [], errors: [] };
  const od = ollamaDir();
  out.searched.push({ source: "ollama", dir: od, found: await exists(join(od, "manifests")) });
  await scanOllama(od, out);
  for (const d of lmStudioDirs()) {
    const found = await exists(d);
    out.searched.push({ source: "lmstudio", dir: d, found });
    if (found) await scanGgufDir(d, "lmstudio", out);
  }
  const extras = [...extraDirs, ...(process.env.NEURIX_MODELS_DIR ? process.env.NEURIX_MODELS_DIR.split(/[;:](?![\\/])/) : [])];
  for (const d of extras) {
    const found = await exists(d);
    out.searched.push({ source: "gguf", dir: d, found });
    if (found) await scanGgufDir(d, "gguf", out);
  }
  out.models.sort((a, b) => b.sizeBytes - a.sizeBytes);
  return out;
}
