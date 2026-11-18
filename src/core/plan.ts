/**
 * Neurix Budget: planeja o gasto mensal com um teto.
 *
 * - Perfil de uso: requisições por dia, dias ativos no mês, tokens de entrada (com a parte fixa que pode ir
 *   para o cache), tokens de saída, taxa de acerto do cache e fatia que pode ir em lote (batch).
 * - Custo por requisição em 4 estratégias: normal, com cache, em lote e cache + lote.
 * - Projeção por dia, mês e ano; quanto do teto usa; em que dia o teto acaba; quantas requisições cabem.
 * - Ritmo de gasto: com o que já foi gasto no mês, projeta o fim do mês.
 * - Checagem de limite (neurix check): o custo passa do máximo?
 */
import type { ModelPrice, Provider } from "../types/models.ts";
import { computeCost, currentPrice } from "./cost.ts";

// ───────────── Lote (batch) por provedor ─────────────

export interface BatchInfo {
  /** Desconto sobre o preço normal (0,5 = metade do preço). null = não oferece / sem dados. */
  discount: number | null;
  /** Nome da API de lote no provedor. */
  api: string | null;
  /** Prazo de entrega das respostas. */
  window: string | null;
}

/**
 * Descontos das APIs de lote publicados pelos provedores (respostas em até 24 h, sem tempo real).
 * Confira na documentação de cada um: podem mudar.
 */
export const BATCH: Record<Provider, BatchInfo> = {
  openai: { discount: 0.5, api: "Batch API", window: "24h" },
  anthropic: { discount: 0.5, api: "Message Batches API", window: "24h" },
  google: { discount: 0.5, api: "Gemini Batch Mode", window: "24h" },
  deepseek: { discount: null, api: null, window: null },
  qwen: { discount: null, api: null, window: null },
  local: { discount: null, api: null, window: null },
};

export const hasBatch = (m: ModelPrice): boolean => BATCH[m.provider]?.discount != null;
export const hasCache = (m: ModelPrice): boolean => {
  const p = currentPrice(m, today());
  return p.cachedInput !== undefined && p.cachedInput < p.input;
};

const today = (): string => new Date().toISOString().slice(0, 10);

// ───────────── Perfil de uso ─────────────

export interface UsageProfile {
  /** Tokens de entrada por requisição (total, incluindo a parte fixa). */
  inputTokens: number;
  /** Quantos desses tokens são fixos (instruções, documento) e podem ficar em cache. */
  cachedTokens: number;
  outputTokens: number;
  /** % das requisições que acham a parte fixa no cache (as outras gravam o cache). */
  cacheHitPct: number;
  /** % das requisições que podem esperar até 24 h e ir em lote. */
  batchPct: number;
  /** Requisições por dia ativo (opcional: sem isso, só mostra quantas cabem). */
  requestsPerDay?: number;
  /** Dias de uso no mês (30 = todo dia, 22 = dias úteis). */
  activeDays: number;
}

export type Strategy = "normal" | "cache" | "batch" | "cacheBatch";
export const STRATEGIES: Strategy[] = ["normal", "cache", "batch", "cacheBatch"];

/**
 * Custo médio de UMA requisição na estratégia (US$). null quando o provedor não oferece.
 * - cache: a parte fixa sai pelo preço de leitura do cache em `cacheHitPct`% das vezes; nas outras,
 *   pelo preço de gravação (sem preço próprio de gravação, o de entrada).
 * - lote: todos os preços com o desconto do provedor (o desconto vale também para tokens em cache).
 */
export function requestCost(m: ModelPrice, u: UsageProfile, s: Strategy): number | null {
  const useCache = s === "cache" || s === "cacheBatch";
  const useBatch = s === "batch" || s === "cacheBatch";
  if (useCache && !hasCache(m)) return null;
  if (useBatch && !hasBatch(m)) return null;

  // computeCost aplica faixa de contexto longo e preço agendado; o cache ajusta só a parte fixa.
  const base = computeCost(m, u.inputTokens, u.outputTokens, today());
  let usd = base.totalUsd;
  if (useCache && u.cachedTokens > 0) {
    const p = base.price;
    const fixed = Math.min(u.cachedTokens, u.inputTokens);
    const hit = Math.min(100, Math.max(0, u.cacheHitPct)) / 100;
    const read = p.cachedInput ?? p.input;
    const write = p.cacheWrite && p.cacheWrite > 0 ? p.cacheWrite : p.input;
    const fixedNormal = (fixed / 1e6) * p.input;
    const fixedCached = (fixed / 1e6) * (hit * read + (1 - hit) * write);
    usd = usd - fixedNormal + fixedCached;
  }
  if (useBatch) usd *= 1 - (BATCH[m.provider].discount ?? 0);
  return usd;
}

/** Custo médio por requisição com o SEU uso: cache (se der) + `batchPct`% em lote (se der). */
export function mixedCost(m: ModelPrice, u: UsageProfile): { usd: number; usesCache: boolean; usesBatch: boolean } {
  const usesCache = hasCache(m) && u.cachedTokens > 0;
  const usesBatch = hasBatch(m) && u.batchPct > 0;
  const now = requestCost(m, u, usesCache ? "cache" : "normal") as number;
  const later = usesBatch ? (requestCost(m, u, usesCache ? "cacheBatch" : "batch") as number) : now;
  const b = usesBatch ? Math.min(100, u.batchPct) / 100 : 0;
  return { usd: (1 - b) * now + b * later, usesCache, usesBatch };
}

// ───────────── Plano por modelo ─────────────

export interface PlanRow {
  model: ModelPrice;
  fitsContext: boolean | null;
  /** Custo por requisição em cada estratégia pura. */
  perRequest: Record<Strategy, number | null>;
  /** Custo por requisição com o seu uso (cache + fatia em lote). */
  optimized: number;
  usesCache: boolean;
  usesBatch: boolean;
  /** Quantas requisições cabem no teto, por mês e por dia ativo. */
  maxPerMonth: { normal: number; optimized: number };
  maxPerDay: { normal: number; optimized: number };
  /** Só com requisições por dia informadas. */
  projection?: {
    day: number;
    month: number;
    year: number;
    /** Mesma coisa sem cache e sem lote, para mostrar a economia. */
    monthNormal: number;
    capPct: number;
    /** Dia do mês (1–31) em que o teto acaba; null se não acaba. */
    capDay: number | null;
    /** Dias em que cruza 50%, 80% e 100% do teto (null = não cruza). */
    thresholds: Record<50 | 80 | 100, number | null>;
  };
}

const floorCalls = (budget: number, cost: number): number => (cost > 0 ? Math.floor(budget / cost) : Number.POSITIVE_INFINITY);

/** Em que dia do mês o gasto acumulado passa de `pct`% do teto (gasto espalhado pelos dias ativos). */
function crossingDay(perActiveDay: number, activeDays: number, capUsd: number, pct: number, daysInMonth = 30): number | null {
  const target = (capUsd * pct) / 100;
  const monthly = perActiveDay * activeDays;
  if (monthly <= target || perActiveDay <= 0) return null;
  const activeNeeded = Math.ceil(target / perActiveDay);
  // dias ativos distribuídos no mês (ex.: 22 úteis em 30 corridos)
  return Math.min(daysInMonth, Math.max(1, Math.ceil((activeNeeded * daysInMonth) / activeDays)));
}

export function planBudget(models: ModelPrice[], tokensFor: (m: ModelPrice) => number, u0: UsageProfile, capUsd: number): PlanRow[] {
  return models
    .map((m): PlanRow => {
      const input = tokensFor(m);
      const u: UsageProfile = { ...u0, inputTokens: input, cachedTokens: Math.min(u0.cachedTokens, input) };
      const perRequest = Object.fromEntries(STRATEGIES.map((s) => [s, requestCost(m, u, s)])) as Record<Strategy, number | null>;
      const mix = mixedCost(m, u);
      const normal = perRequest.normal ?? 0;
      const days = Math.max(1, u.activeDays);
      const row: PlanRow = {
        model: m,
        fitsContext: computeCost(m, input, u.outputTokens).fitsContext,
        perRequest,
        optimized: mix.usd,
        usesCache: mix.usesCache,
        usesBatch: mix.usesBatch,
        maxPerMonth: { normal: floorCalls(capUsd, normal), optimized: floorCalls(capUsd, mix.usd) },
        maxPerDay: { normal: floorCalls(capUsd / days, normal), optimized: floorCalls(capUsd / days, mix.usd) },
      };
      if (u.requestsPerDay !== undefined) {
        const day = u.requestsPerDay * mix.usd;
        const month = day * days;
        row.projection = {
          day,
          month,
          year: month * 12,
          monthNormal: u.requestsPerDay * normal * days,
          capPct: capUsd > 0 ? (month / capUsd) * 100 : 0,
          capDay: crossingDay(day, days, capUsd, 100),
          thresholds: { 50: crossingDay(day, days, capUsd, 50), 80: crossingDay(day, days, capUsd, 80), 100: crossingDay(day, days, capUsd, 100) },
        };
      }
      return row;
    })
    .sort((a, b) => a.optimized - b.optimized);
}

// ───────────── Ritmo de gasto (o que já foi gasto no mês) ─────────────

export interface BurnRate {
  dailyAvg: number;
  projectedMonth: number;
  capPct: number;
  /** Dia em que o teto acaba no ritmo atual (null = não acaba este mês). */
  capDay: number | null;
  /** Quanto ainda pode gastar por dia até o fim do mês sem passar do teto. */
  safeDailyLeft: number;
  remaining: number;
}

export function burnRate(spentUsd: number, capUsd: number, now: Date = new Date()): BurnRate {
  const day = now.getDate();
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const dailyAvg = spentUsd / Math.max(1, day);
  const projectedMonth = dailyAvg * daysInMonth;
  const remaining = capUsd - spentUsd;
  const left = daysInMonth - day;
  return {
    dailyAvg,
    projectedMonth,
    capPct: capUsd > 0 ? (projectedMonth / capUsd) * 100 : 0,
    capDay: spentUsd >= capUsd ? day : dailyAvg > 0 && projectedMonth > capUsd ? Math.ceil(capUsd / dailyAvg) : null,
    safeDailyLeft: left > 0 ? Math.max(0, remaining) / left : 0,
    remaining,
  };
}

// ───────────── Checagem de limite (neurix check) ─────────────

export interface Limits {
  maxUsd?: number;
  maxTokens?: number;
}

export interface CheckResult {
  tokens: number;
  costUsd: number;
  fitsContext: boolean | null;
  overCost: boolean;
  overTokens: boolean;
  overContext: boolean;
  ok: boolean;
}

export function checkLimits(m: ModelPrice, inputTokens: number, outputTokens: number, calls: number, limits: Limits): CheckResult {
  const c = computeCost(m, inputTokens, outputTokens);
  const costUsd = c.totalUsd * calls;
  const overCost = limits.maxUsd !== undefined && costUsd > limits.maxUsd;
  const overTokens = limits.maxTokens !== undefined && inputTokens > limits.maxTokens;
  const overContext = c.fitsContext === false;
  return { tokens: inputTokens, costUsd, fitsContext: c.fitsContext, overCost, overTokens, overContext, ok: !overCost && !overTokens && !overContext };
}
