/**
 * Tokenizer de cada modelo local, direto do Hugging Face (tokenizer.json + tokenizer_config.json).
 *
 * Na primeira vez os arquivos são baixados e ficam em ~/.neurix/tokenizers/; depois funciona offline.
 * Sem internet e sem cache, a contagem volta para a estimativa e o resultado avisa.
 */
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import type { LocalModel } from "./local.ts";
import { estimateCounter, type Counter } from "./tokens.ts";

const FILES = ["tokenizer.json", "tokenizer_config.json"] as const;
const TIMEOUT_MS = 60_000;

const cacheDir = (repo: string): string =>
  join(process.env.NEURIX_HOME ?? join(homedir(), ".neurix"), "tokenizers", repo.replace(/[\\/]/g, "__"));

async function readCached(repo: string): Promise<unknown[] | null> {
  try {
    const dir = cacheDir(repo);
    return await Promise.all(FILES.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")) as unknown));
  } catch {
    return null;
  }
}

async function download(repo: string): Promise<unknown[]> {
  // HF_TOKEN permite usar repositórios fechados (ex.: meta-llama/*).
  const token = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
  const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
  const texts = await Promise.all(
    FILES.map(async (f) => {
      const res = await fetch(`https://huggingface.co/${repo}/resolve/main/${f}`, {
        headers,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
      return res.text();
    }),
  );
  const data = texts.map((s) => JSON.parse(s) as unknown);
  try {
    const dir = cacheDir(repo);
    await mkdir(dir, { recursive: true });
    await Promise.all(FILES.map((f, i) => writeFile(join(dir, f), texts[i] ?? "")));
  } catch {
    // cache é conveniência; a contagem já funciona nesta sessão
  }
  return data;
}

const loaded = new Map<string, Tokenizer>();

/** True se o tokenizer já está na memória ou no disco (não vai precisar baixar). */
export async function isCached(repo: string): Promise<boolean> {
  if (loaded.has(repo)) return true;
  try {
    await Promise.all(FILES.map((f) => access(join(cacheDir(repo), f))));
    return true;
  } catch {
    return false;
  }
}

export async function loadHfTokenizer(repo: string): Promise<Tokenizer> {
  let tk = loaded.get(repo);
  if (!tk) {
    const [json, config] = (await readCached(repo)) ?? (await download(repo));
    tk = new Tokenizer(json as object, config as object);
    loaded.set(repo, tk);
  }
  return tk;
}

/** Contador exato do modelo local; sem tokenizer disponível, cai na estimativa com o motivo. */
export async function localCounter(model: LocalModel): Promise<Counter> {
  if (!model.hfRepo) return estimateCounter("estimate");
  try {
    const tk = await loadHfTokenizer(model.hfRepo);
    return {
      method: "huggingface",
      exact: true,
      source: model.hfRepo,
      // Só o texto: sem o token de início (<s>, <|begin_of_text|>) que o runtime acrescenta.
      count: (text) => (text ? tk.encode(text, { add_special_tokens: false }).ids.length : 0),
      encode: (text) => (text ? tk.encode(text, { add_special_tokens: false }).ids : []),
      decode: (ids) => tk.decode(ids, { skip_special_tokens: true }),
    };
  } catch (err) {
    const e = err as Error;
    return estimateCounter("estimate", e.name === "TimeoutError" ? "timeout" : e.message);
  }
}
