/**
 * Recomendador de modelo: recebe um prompt e diz qual é o modelo mais barato que dá conta dele agora
 * (preço vigente hoje, cabe no contexto, qualidade mínima).
 *
 * A qualidade necessária é sugerida por sinais simples do prompt (tamanho, código, pedidos de raciocínio
 * ou de tarefas simples). É uma heurística: o usuário pode escolher outra.
 */
import type { ModelPrice, Tier } from "../types/models.ts";
import { computeCost, type CostBreakdown } from "./cost.ts";
import type { Counter } from "./tokens.ts";

export type Quality = "cheap" | "mid" | "flagship";
export const TIER_RANK: Record<Tier, number> = { cheap: 0, mid: 1, flagship: 2 };

export type Signal =
  | "code"
  | "reasoning"
  | "math"
  | "longPrompt"
  | "veryLongPrompt"
  | "longOutput"
  | "simpleTask"
  | "shortPrompt";

const REASONING = /\b(analis[ea]r?|analy[sz]e|raciocin|reason(ing)?|step[- ]by[- ]step|passo a passo|estrat[ée]gi|strateg|arquitetur|architect|compar[ae]r? .* (prós|pros)|trade-?offs?|avali[ae]|evaluat|critiq|debug|refator|refactor|planej|plan (a|the)|demonstr|prove|proof|justifi)/i;
const MATH = /(\bequa[çc][ãa]o|\bequation|\bintegral|\bderivad|\bderivative|\bteorema|\btheorem|\bprobabilidad|\bprobabilit|∑|∫|√|\bmatriz\b|\bmatrix\b)/i;
const SIMPLE = /\b(traduz|translat|resum[ao]|summar|classifi|extrai|extract|corrij[ao] (a )?ortografia|spell|formata|format (this|as)|lista[r]? |list the|sentiment|categori[sz]|tag(ue)?ar|rotul)/i;
const CODE = /```|\b(function|const|let|def|class|import|public static|#include|SELECT .* FROM)\b/;

export interface QualitySuggestion {
  quality: Quality;
  signals: Signal[];
}

export function suggestQuality(prompt: string, inputTokens: number, outputTokens: number): QualitySuggestion {
  const signals: Signal[] = [];
  if (CODE.test(prompt)) signals.push("code");
  if (REASONING.test(prompt)) signals.push("reasoning");
  if (MATH.test(prompt)) signals.push("math");
  if (inputTokens > 50_000) signals.push("veryLongPrompt");
  else if (inputTokens > 8_000) signals.push("longPrompt");
  if (outputTokens >= 4000) signals.push("longOutput");
  if (SIMPLE.test(prompt)) signals.push("simpleTask");
  if (inputTokens < 200) signals.push("shortPrompt");

  let score = 0;
  if (signals.includes("code")) score += 1;
  if (signals.includes("reasoning")) score += 2;
  if (signals.includes("math")) score += 2;
  if (signals.includes("longPrompt")) score += 1;
  if (signals.includes("veryLongPrompt")) score += 2;
  if (signals.includes("longOutput")) score += 1;
  if (signals.includes("simpleTask")) score -= 2;
  const quality: Quality = score >= 4 ? "flagship" : score >= 2 ? "mid" : "cheap";
  return { quality, signals };
}

export interface Candidate {
  model: ModelPrice;
  cost: CostBreakdown;
  exact: boolean;
}

export interface Recommendation {
  inputTokens: Record<string, number>;
  quality: Quality;
  /** Mais barato que cabe e atende a qualidade mínima. */
  best: Candidate | null;
  /** Os próximos mais baratos que também atendem. */
  alternatives: Candidate[];
  /** O mais barato de cada faixa (para comparar quanto custa subir de nível). */
  perTier: Partial<Record<Quality, Candidate>>;
  /** Modelos que atenderiam a qualidade mas não cabem no contexto. */
  tooSmall: ModelPrice[];
}

export function recommendModel(
  prompt: string | null,
  inputTokensGiven: number | null,
  outputTokens: number,
  models: ModelPrice[],
  counters: Map<string, Counter>,
  quality: Quality,
): Recommendation {
  const candidates: Candidate[] = models.map((m) => {
    const counter = counters.get(m.id);
    const tokens = prompt !== null && counter ? counter.count(prompt) : (inputTokensGiven ?? 0);
    return { model: m, cost: computeCost(m, tokens, outputTokens), exact: prompt === null || Boolean(counter?.exact) };
  });
  const sorted = [...candidates].sort((a, b) => a.cost.totalUsd - b.cost.totalUsd);
  const fits = sorted.filter((c) => c.cost.fitsContext !== false);
  const ok = fits.filter((c) => TIER_RANK[c.model.tier] >= TIER_RANK[quality]);
  const perTier: Partial<Record<Quality, Candidate>> = {};
  for (const c of fits) perTier[c.model.tier] ??= c;
  return {
    inputTokens: Object.fromEntries(candidates.map((c) => [c.model.id, c.cost.inputTokens])),
    quality,
    best: ok[0] ?? null,
    alternatives: ok.slice(1, 4),
    perTier,
    tooSmall: sorted.filter((c) => c.cost.fitsContext === false && TIER_RANK[c.model.tier] >= TIER_RANK[quality]).map((c) => c.model),
  };
}
