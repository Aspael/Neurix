/**
 * Tabela de preços.
 *
 * Ordem: --prices <arquivo> → a mais nova entre (a embutida no pacote, a baixada do GitHub).
 *
 * O workflow "Update prices" regenera data/models.json todo dia no GitHub. O Neurix baixa esse arquivo
 * (no máximo 1× a cada 24 h, com 2,5 s de limite) e guarda em ~/.neurix/models.json — assim o usuário
 * recebe preço novo sem reinstalar. Sem internet, ou com NEURIX_OFFLINE=1, usa o que tiver.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import bundled from "../../data/models.json" with { type: "json" };
import type { ModelPrice, PriceDataset } from "../types/models.ts";

export const REMOTE_PRICES_URL = process.env.NEURIX_PRICES_URL ?? "https://raw.githubusercontent.com/Aspael/Neurix/main/data/models.json";
const TTL_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 2500;
/** Versão do formato que este código entende (data/models.json → "version"). */
const SCHEMA = 1;

export type PriceSource = "file" | "bundled" | "cache" | "remote";

export interface PriceStatus {
  source: PriceSource;
  generatedAt: string;
  models: number;
  /** Quando a cópia do GitHub foi baixada (cache ou agora). */
  fetchedAt: string | null;
  /** Por que não atualizou (sem internet, arquivo inválido…). */
  error: string | null;
  url: string;
}

let status: PriceStatus | null = null;
export const priceStatus = (): PriceStatus | null => status;

const cachePath = (): string => join(process.env.NEURIX_HOME ?? join(homedir(), ".neurix"), "models.json");
const offline = (): boolean => ["1", "true", "yes"].includes((process.env.NEURIX_OFFLINE ?? "").toLowerCase());

/** Confere o formato antes de confiar num arquivo baixado. */
export function isValidDataset(d: unknown): d is PriceDataset {
  const x = d as PriceDataset;
  return (
    !!x &&
    x.version === SCHEMA &&
    typeof x.generatedAt === "string" &&
    Array.isArray(x.models) &&
    x.models.length > 0 &&
    x.models.every((m) => typeof m.id === "string" && typeof m.input === "number" && typeof m.output === "number" && typeof m.provider === "string")
  );
}

const newer = (a: PriceDataset, b: PriceDataset): PriceDataset => (Date.parse(b.generatedAt) > Date.parse(a.generatedAt) ? b : a);

async function readCache(): Promise<{ fetchedAt: string; dataset: PriceDataset } | null> {
  try {
    const c = JSON.parse(await readFile(cachePath(), "utf8")) as { fetchedAt: string; dataset: unknown };
    return isValidDataset(c.dataset) ? { fetchedAt: c.fetchedAt, dataset: c.dataset } : null;
  } catch {
    return null;
  }
}

async function fetchRemote(): Promise<PriceDataset> {
  const res = await fetch(REMOTE_PRICES_URL, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = (await res.json()) as unknown;
  if (!isValidDataset(d)) throw new Error("formato inválido ou de outra versão");
  return d;
}

export interface LoadOptions {
  /** Ignora o cache de 24 h e baixa agora. */
  refresh?: boolean;
}

export async function loadPrices(path?: string, opts: LoadOptions = {}): Promise<PriceDataset> {
  const url = REMOTE_PRICES_URL;
  if (path) {
    const d = JSON.parse(await readFile(path, "utf8")) as PriceDataset;
    status = { source: "file", generatedAt: d.generatedAt, models: d.models.length, fetchedAt: null, error: null, url };
    return d;
  }
  const base = bundled as PriceDataset;
  const pick = (d: PriceDataset, source: PriceSource, fetchedAt: string | null, error: string | null): PriceDataset => {
    status = { source, generatedAt: d.generatedAt, models: d.models.length, fetchedAt, error, url };
    return d;
  };
  if (offline()) return pick(base, "bundled", null, "offline");

  const cached = await readCache();
  const fresh = cached && Date.now() - Date.parse(cached.fetchedAt) < TTL_MS;
  if (cached && fresh && !opts.refresh) {
    const best = newer(base, cached.dataset);
    return pick(best, best === base ? "bundled" : "cache", cached.fetchedAt, null);
  }

  try {
    const remote = await fetchRemote();
    const fetchedAt = new Date().toISOString();
    try {
      await mkdir(dirname(cachePath()), { recursive: true });
      await writeFile(cachePath(), JSON.stringify({ fetchedAt, dataset: remote }));
    } catch {
      // cache é conveniência
    }
    const best = newer(base, remote);
    return pick(best, best === base ? "bundled" : "remote", fetchedAt, null);
  } catch (err) {
    const msg = (err as Error).name === "TimeoutError" ? "timeout" : (err as Error).message;
    const best = cached ? newer(base, cached.dataset) : base;
    return pick(best, best === base ? "bundled" : "cache", cached?.fetchedAt ?? null, msg);
  }
}

export function findModel(dataset: PriceDataset, id: string): ModelPrice | undefined {
  const q = id.toLowerCase();
  return (
    dataset.models.find((m) => m.id === q) ??
    // aceita "sonnet-5.5" ou "claude-sonnet-5.5"
    dataset.models.find((m) => m.id.replace(/\./g, "-").endsWith(q.replace(/\./g, "-")))
  );
}

/** Modelos da tabela padrão; `all` inclui os não destacados e os antigos. */
export function visibleModels(dataset: PriceDataset, all = false): ModelPrice[] {
  return dataset.models.filter((m) => all || (m.featured && !m.legacy));
}
