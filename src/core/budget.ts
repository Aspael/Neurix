/**
 * Duas contas de planejamento:
 *  - Orçamento: quantas chamadas cabem em X dólares/reais por modelo.
 *  - Cache de prompt: quanto se economiza quando a mesma parte fixa (instruções, documento) se repete
 *    em várias chamadas e o provedor cobra menos por tokens em cache.
 */
import type { ModelPrice } from "../types/models.ts";
import { computeCost, currentPrice } from "./cost.ts";

export interface BudgetRow {
  model: ModelPrice;
  costPerCallUsd: number;
  calls: number;
  fitsContext: boolean | null;
}

export function callsForBudget(models: ModelPrice[], tokensFor: (m: ModelPrice) => number, outputTokens: number, budgetUsd: number): BudgetRow[] {
  return models
    .map((m) => {
      const c = computeCost(m, tokensFor(m), outputTokens);
      return { model: m, costPerCallUsd: c.totalUsd, calls: c.totalUsd > 0 ? Math.floor(budgetUsd / c.totalUsd) : Number.POSITIVE_INFINITY, fitsContext: c.fitsContext };
    })
    .sort((a, b) => b.calls - a.calls);
}

export interface CacheInput {
  /** Parte que se repete em todas as chamadas (instruções, documento, exemplos). */
  fixedTokens: number;
  /** Parte que muda a cada chamada (a pergunta). */
  variableTokens: number;
  outputTokens: number;
  calls: number;
}

export interface CacheResult {
  model: ModelPrice;
  supported: boolean;
  withoutCacheUsd: number;
  withCacheUsd: number;
  savedUsd: number;
  savedPct: number;
  /** Preços usados (US$/1M): leitura do cache e escrita no cache. */
  cachedInput: number | null;
  cacheWrite: number | null;
}

/**
 * Sem cache: toda chamada paga o fixo como entrada normal.
 * Com cache: a 1ª chamada grava o fixo (preço de escrita; sem preço, entrada normal), as demais leem do
 * cache (preço de leitura). A parte variável e a resposta custam o normal sempre.
 * Supõe que o cache não expira entre as chamadas (na prática dura de 5 min a 1 h sem uso).
 */
export function promptCacheSavings(m: ModelPrice, i: CacheInput): CacheResult {
  const p = currentPrice(m, new Date().toISOString().slice(0, 10));
  const per = (tokens: number, price: number): number => (tokens / 1e6) * price;
  const base = per(i.variableTokens, p.input) + per(i.outputTokens, p.output);
  const without = i.calls * (per(i.fixedTokens, p.input) + base);
  const supported = p.cachedInput !== undefined && p.cachedInput < p.input;
  if (!supported) {
    return { model: m, supported, withoutCacheUsd: without, withCacheUsd: without, savedUsd: 0, savedPct: 0, cachedInput: null, cacheWrite: null };
  }
  const write = p.cacheWrite && p.cacheWrite > 0 ? p.cacheWrite : p.input;
  const withCache = per(i.fixedTokens, write) + Math.max(0, i.calls - 1) * per(i.fixedTokens, p.cachedInput as number) + i.calls * base;
  return {
    model: m,
    supported,
    withoutCacheUsd: without,
    withCacheUsd: withCache,
    savedUsd: without - withCache,
    savedPct: without > 0 ? ((without - withCache) / without) * 100 : 0,
    cachedInput: p.cachedInput ?? null,
    cacheWrite: write,
  };
}
