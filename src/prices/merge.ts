import type {
  ModelPrice,
  OpenRouterPrice,
  OverlayEntry,
  Price,
  PriceTier,
  Provider,
  Tokenizer,
} from "../types/models.ts";
import type { LiteLLMData, LiteLLMEntry, OpenRouterModel } from "./sources.ts";

/** Diferença relativa acima da qual oficial × OpenRouter vira conflito. */
export const CONFLICT_THRESHOLD = 0.05;

/** Provedor do Neurix → `litellm_provider` oficial e prefixo de chave. */
const LITELLM_OFFICIAL: Record<Exclude<Provider, "local">, { providers: string[]; prefix: string }> = {
  anthropic: { providers: ["anthropic"], prefix: "" },
  openai: { providers: ["openai"], prefix: "" },
  google: { providers: ["gemini"], prefix: "gemini/" },
  deepseek: { providers: ["deepseek"], prefix: "deepseek/" },
  qwen: { providers: ["dashscope"], prefix: "dashscope/" },
};

/** Provedor do Neurix → prefixo do id na OpenRouter. */
const OPENROUTER_PREFIX: Record<Exclude<Provider, "local">, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  deepseek: "deepseek",
  qwen: "qwen",
};

const PER_MILLION = 1_000_000;
/** Arredonda para evitar lixo de ponto flutuante (0.30000000000000004). */
const perMillion = (perToken: number): number => Math.round(perToken * PER_MILLION * 1e6) / 1e6;
const num = (v: unknown): number | undefined =>
  typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined;

export interface MergeIssue {
  id: string;
  kind: "conflict" | "missing" | "openrouter-only" | "manual" | "scheduled-due";
  message: string;
}

export interface MergeResult {
  models: ModelPrice[];
  issues: MergeIssue[];
}

// ───────────────────────── LiteLLM ─────────────────────────

function findLiteLLM(entry: OverlayEntry, data: LiteLLMData): [string, LiteLLMEntry] | undefined {
  const official = LITELLM_OFFICIAL[entry.provider];
  const keys = entry.litellmKey ? [entry.litellmKey] : [`${official.prefix}${entry.id}`, entry.id];
  for (const key of keys) {
    const e = data[key];
    if (!e || typeof e.input_cost_per_token !== "number") continue;
    // Com chave forçada aceita qualquer provedor; senão só o oficial.
    if (entry.litellmKey || official.providers.includes(e.litellm_provider ?? "")) return [key, e];
  }
  return undefined;
}

/** Lê campos `input_cost_per_token_above_<N>k_tokens` (só o preço padrão, sem batch/flex/priority). */
function litellmTiers(e: LiteLLMEntry): PriceTier[] | undefined {
  const tiers: PriceTier[] = [];
  for (const key of Object.keys(e)) {
    const m = /^input_cost_per_token_above_(\d+)k_tokens$/.exec(key);
    if (!m) continue;
    const k = m[1];
    const input = num(e[key]);
    const output = num(e[`output_cost_per_token_above_${k}k_tokens`]);
    if (input === undefined || output === undefined) continue;
    const cachedInput = num(e[`cache_read_input_token_cost_above_${k}k_tokens`]);
    const cacheWrite = num(e[`cache_creation_input_token_cost_above_${k}k_tokens`]);
    tiers.push({
      above: Number(k) * 1000,
      input: perMillion(input),
      output: perMillion(output),
      ...(cachedInput !== undefined && { cachedInput: perMillion(cachedInput) }),
      ...(cacheWrite !== undefined && { cacheWrite: perMillion(cacheWrite) }),
    });
  }
  return tiers.length ? tiers.sort((a, b) => a.above - b.above) : undefined;
}

function litellmPrice(e: LiteLLMEntry): Price {
  return {
    input: perMillion(e.input_cost_per_token ?? 0),
    output: perMillion(e.output_cost_per_token ?? 0),
    ...(e.cache_read_input_token_cost !== undefined && {
      cachedInput: perMillion(e.cache_read_input_token_cost),
    }),
    ...(e.cache_creation_input_token_cost !== undefined && {
      cacheWrite: perMillion(e.cache_creation_input_token_cost),
    }),
  };
}

// ───────────────────────── OpenRouter ─────────────────────────

function findOpenRouter(entry: OverlayEntry, models: OpenRouterModel[]): OpenRouterModel | undefined {
  const prefix = OPENROUTER_PREFIX[entry.provider];
  // A OpenRouter usa ponto na versão: claude-sonnet-5-5 → claude-sonnet-5.5
  const ids = entry.openrouterId
    ? [entry.openrouterId]
    : [`${prefix}/${entry.id}`, `${prefix}/${entry.id.replace(/(\d)-(\d)/g, "$1.$2")}`];
  for (const id of ids) {
    const m = models.find((x) => x.id === id);
    if (m) return m;
  }
  return undefined;
}

function openrouterPrice(m: OpenRouterModel): OpenRouterPrice {
  const p = m.pricing;
  const cachedInput = num(p.input_cache_read);
  const cacheWrite = num(p.input_cache_write);
  const tiers: PriceTier[] = (p.overrides ?? [])
    .filter((o) => o.min_prompt_tokens && o.prompt && o.completion)
    .map((o) => ({
      above: o.min_prompt_tokens as number,
      input: perMillion(Number(o.prompt)),
      output: perMillion(Number(o.completion)),
      ...(o.input_cache_read && { cachedInput: perMillion(Number(o.input_cache_read)) }),
      ...(o.input_cache_write && { cacheWrite: perMillion(Number(o.input_cache_write)) }),
    }));
  return {
    id: m.id,
    input: perMillion(Number(p.prompt)),
    output: perMillion(Number(p.completion)),
    ...(cachedInput !== undefined && { cachedInput: perMillion(cachedInput) }),
    ...(cacheWrite !== undefined && { cacheWrite: perMillion(cacheWrite) }),
    ...(tiers.length && { tiers }),
  };
}

function tokenizerFrom(m: OpenRouterModel | undefined, provider: Provider): Tokenizer {
  const t = m?.architecture?.tokenizer?.toLowerCase() ?? "";
  if (t.includes("claude") || provider === "anthropic") return "claude";
  if (t.includes("gpt") || provider === "openai") return "o200k";
  if (t.includes("gemini") || provider === "google") return "gemini";
  return "estimate";
}

const cleanName = (name: string): string => name.replace(/^[^:]+:\s*/, "");

const diffPct = (a: number, b: number): number => {
  const base = Math.max(Math.abs(a), Math.abs(b));
  return base === 0 ? 0 : Math.abs(a - b) / base;
};

// ───────────────────────── Merge ─────────────────────────

/**
 * Junta o catálogo curado (overlay) com os preços do LiteLLM e da OpenRouter.
 *
 * Regras:
 *  1. Preço oficial no LiteLLM (provedor original) → fonte principal.
 *  2. Só na OpenRouter → usa o preço da OpenRouter, marcado como tal.
 *  3. Os dois diferem > CONFLICT_THRESHOLD → mantém o oficial e registra conflito (nunca faz média).
 *  4. Nenhuma fonte → usa `manual` do overlay, se houver.
 */
export function mergePrices(
  overlay: OverlayEntry[],
  litellm: LiteLLMData | null,
  openrouter: OpenRouterModel[] | null,
  today: string = new Date().toISOString().slice(0, 10),
): MergeResult {
  const models: ModelPrice[] = [];
  const issues: MergeIssue[] = [];

  for (const entry of overlay) {
    const ll = litellm ? findLiteLLM(entry, litellm) : undefined;
    const or = openrouter ? findOpenRouter(entry, openrouter) : undefined;
    const orPrice = or ? openrouterPrice(or) : undefined;

    let base: Price;
    let tiers: PriceTier[] | undefined;
    let source: ModelPrice["source"];
    let sourceUrl: string | undefined;

    if (ll) {
      const [, e] = ll;
      base = litellmPrice(e);
      tiers = litellmTiers(e);
      source = "litellm";
      sourceUrl = typeof e.source === "string" ? e.source : undefined;
    } else if (orPrice) {
      base = orPrice;
      tiers = orPrice.tiers;
      source = "openrouter";
      issues.push({
        id: entry.id,
        kind: "openrouter-only",
        message: `sem preço oficial no LiteLLM; usando preço da OpenRouter (${orPrice.id})`,
      });
    } else if (entry.manual) {
      base = entry.manual;
      source = "manual";
      issues.push({ id: entry.id, kind: "manual", message: "nenhuma fonte tem o modelo; usando preço manual do overlay" });
    } else {
      issues.push({ id: entry.id, kind: "missing", message: "não encontrado no LiteLLM nem na OpenRouter; modelo ignorado" });
      continue;
    }

    let priceConflict: ModelPrice["priceConflict"];
    if (source === "litellm" && orPrice) {
      const d = Math.max(diffPct(base.input, orPrice.input), diffPct(base.output, orPrice.output));
      if (d > CONFLICT_THRESHOLD) {
        priceConflict = {
          openrouter: { input: orPrice.input, output: orPrice.output },
          diffPct: Math.round(d * 1000) / 10,
        };
        issues.push({
          id: entry.id,
          kind: "conflict",
          message: `oficial $${base.input}/$${base.output} × OpenRouter $${orPrice.input}/$${orPrice.output} (${priceConflict.diffPct}%)`,
        });
      }
    }

    if (entry.nextPrice && entry.nextPrice.from <= today) {
      issues.push({
        id: entry.id,
        kind: "scheduled-due",
        message: `nextPrice (${entry.nextPrice.from}) já está em vigor; confira se a fonte atualizou e remova do overlay`,
      });
    }

    const llEntry = ll?.[1];
    models.push({
      id: entry.id,
      name: entry.name ?? (or ? cleanName(or.name) : entry.id),
      provider: entry.provider,
      tier: entry.tier,
      featured: entry.featured ?? false,
      legacy: entry.legacy ?? false,
      tokenizer: entry.tokenizer ?? tokenizerFrom(or, entry.provider),
      // Janela total: OpenRouter informa contexto total; LiteLLM às vezes só o máximo de input.
      contextWindow: or?.context_length ?? llEntry?.max_input_tokens ?? entry.manual?.contextWindow ?? null,
      maxOutput:
        llEntry?.max_output_tokens ?? or?.top_provider?.max_completion_tokens ?? entry.manual?.maxOutput ?? null,
      ...base,
      ...(tiers && { tiers }),
      ...(entry.validUntil && { validUntil: entry.validUntil }),
      ...(entry.nextPrice && { nextPrice: entry.nextPrice }),
      source,
      ...(sourceUrl && { sourceUrl }),
      ...(priceConflict && { priceConflict }),
      ...(orPrice && { openrouter: orPrice }),
      ...(entry.note && { note: entry.note }),
    });
  }

  return { models, issues };
}

/** Modelos recentes da OpenRouter, dos provedores acompanhados, que ainda não estão no overlay. */
export function discoverNewModels(
  overlay: OverlayEntry[],
  openrouter: OpenRouterModel[],
  sinceDays = 60,
  now: Date = new Date(),
): OpenRouterModel[] {
  const prefixes = new Set(Object.values(OPENROUTER_PREFIX));
  const known = new Set(
    overlay.flatMap((e) => {
      const p = OPENROUTER_PREFIX[e.provider];
      return [e.openrouterId, `${p}/${e.id}`, `${p}/${e.id.replace(/(\d)-(\d)/g, "$1.$2")}`];
    }),
  );
  const cutoff = now.getTime() / 1000 - sinceDays * 86_400;
  return openrouter
    .filter(
      (m) =>
        prefixes.has(m.id.split("/")[0] ?? "") &&
        !m.id.includes(":") && // variantes como ":batch" e ":free" não são modelos novos
        !known.has(m.id) &&
        m.created >= cutoff,
    )
    .sort((a, b) => b.created - a.created);
}
