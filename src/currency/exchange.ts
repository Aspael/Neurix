import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { t } from "../i18n/index.ts";

export type RateSource = "awesomeapi" | "bcb-ptax" | "frankfurter" | "cache" | "manual";

export interface ExchangeRate {
  /** Quantos reais vale 1 dólar. */
  usdBrl: number;
  source: RateSource;
  /** Momento da cotação (ISO). */
  quotedAt: string;
  /** true quando veio de cache vencido porque todas as APIs falharam. */
  stale?: boolean;
}


const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hora
const TIMEOUT_MS = 5_000;

export const cachePath = (): string =>
  process.env.NEURIX_HOME ? join(process.env.NEURIX_HOME, "fx.json") : join(homedir(), ".neurix", "fx.json");

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "User-Agent": "neurix-cli" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

const valid = (n: number): boolean => Number.isFinite(n) && n > 0;

// ───────────── Provedores ─────────────

/** Cotação comercial quase em tempo real. Usa `ask` (venda = o que você paga). */
async function fromAwesomeApi(): Promise<ExchangeRate> {
  const body = await getJson<{ USDBRL: { ask: string; timestamp: string } }>(
    "https://economia.awesomeapi.com.br/json/last/USD-BRL",
  );
  const usdBrl = Number(body.USDBRL.ask);
  if (!valid(usdBrl)) throw new Error("resposta inválida");
  return { usdBrl, source: "awesomeapi", quotedAt: new Date(Number(body.USDBRL.timestamp) * 1000).toISOString() };
}

/** Banco Central: PTAX oficial, um fechamento por dia útil. Busca os últimos 7 dias para cobrir fins de semana. */
async function fromBcbPtax(): Promise<ExchangeRate> {
  const fmt = (d: Date): string =>
    `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
  const end = new Date();
  const start = new Date(end.getTime() - 7 * 86_400_000);
  const url =
    "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/" +
    "CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)" +
    `?@moeda='USD'&@dataInicial='${fmt(start)}'&@dataFinalCotacao='${fmt(end)}'` +
    "&$format=json&$orderby=dataHoraCotacao%20desc&$top=1";
  const body = await getJson<{ value: Array<{ cotacaoVenda: number; dataHoraCotacao: string }> }>(url);
  const last = body.value[0];
  if (!last || !valid(last.cotacaoVenda)) throw new Error("sem cotação no período");
  return {
    usdBrl: last.cotacaoVenda,
    source: "bcb-ptax",
    quotedAt: new Date(last.dataHoraCotacao.replace(" ", "T").slice(0, 19) + "-03:00").toISOString(),
  };
}

/** Frankfurter: taxa de referência do Banco Central Europeu (diária). */
async function fromFrankfurter(): Promise<ExchangeRate> {
  const body = await getJson<{ date: string; rates: { BRL: number } }>(
    "https://api.frankfurter.dev/v1/latest?base=USD&symbols=BRL",
  );
  if (!valid(body.rates.BRL)) throw new Error("resposta inválida");
  return { usdBrl: body.rates.BRL, source: "frankfurter", quotedAt: new Date(body.date).toISOString() };
}

/** Exportado para testes. */
export const PROVIDERS: Array<[RateSource, () => Promise<ExchangeRate>]> = [
  ["awesomeapi", fromAwesomeApi],
  ["bcb-ptax", fromBcbPtax],
  ["frankfurter", fromFrankfurter],
];

// ───────────── Cache ─────────────

interface CacheFile extends ExchangeRate {
  fetchedAt: string;
}

async function readCache(): Promise<CacheFile | null> {
  try {
    const c = JSON.parse(await readFile(cachePath(), "utf8")) as CacheFile;
    return valid(c.usdBrl) ? c : null;
  } catch {
    return null;
  }
}

async function writeCache(rate: ExchangeRate): Promise<void> {
  try {
    await mkdir(dirname(cachePath()), { recursive: true });
    await writeFile(cachePath(), JSON.stringify({ ...rate, fetchedAt: new Date().toISOString() }, null, 2));
  } catch {
    // cache é conveniência; falhar aqui não pode derrubar a CLI
  }
}

// ───────────── API pública ─────────────

export interface GetRateOptions {
  /** Cotação manual (--usd 5.4). Tem prioridade sobre tudo. */
  manual?: number;
  /** Ignora o cache fresco e consulta as APIs. */
  refresh?: boolean;
}

/**
 * Obtém a cotação USD→BRL.
 * Ordem: --usd / NEURIX_USD → cache com menos de 1h → cotação comercial → BCB PTAX → Frankfurter → cache vencido.
 * Lança erro só se tudo falhar e não houver cache algum.
 */
export async function getUsdBrl(opts: GetRateOptions = {}): Promise<ExchangeRate> {
  const manual = opts.manual ?? (process.env.NEURIX_USD ? Number(process.env.NEURIX_USD) : undefined);
  if (manual !== undefined) {
    if (!valid(manual)) throw new Error(`cotação manual inválida: ${manual}`);
    return { usdBrl: manual, source: "manual", quotedAt: new Date().toISOString() };
  }

  const cached = await readCache();
  if (cached && !opts.refresh && Date.now() - new Date(cached.fetchedAt).getTime() < CACHE_TTL_MS) {
    return { usdBrl: cached.usdBrl, source: cached.source, quotedAt: cached.quotedAt };
  }

  const errors: string[] = [];
  for (const [name, provider] of PROVIDERS) {
    try {
      const rate = await provider();
      await writeCache(rate);
      return rate;
    } catch (err) {
      errors.push(`${name === "awesomeapi" ? "comercial" : name}: ${(err as Error).message}`);
    }
  }

  if (cached) return { usdBrl: cached.usdBrl, source: "cache", quotedAt: cached.quotedAt, stale: true };
  throw new Error(t().fx.failed(errors.join("; ")));
}

/** Converte US$ → R$, aplicando IOF opcional (em %, ex.: 3.5). */
export function toBrl(usd: number, rate: ExchangeRate, iofPct = 0): number {
  return usd * rate.usdBrl * (1 + iofPct / 100);
}
