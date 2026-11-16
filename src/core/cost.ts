import type { ModelPrice, Price } from "../types/models.ts";

export interface CostBreakdown {
  inputTokens: number;
  outputTokens: number;
  /** Preço efetivamente aplicado (considera faixa de contexto e nextPrice). */
  price: Price;
  /** Faixa aplicada, se o prompt passou de algum limite (ex.: 200000). */
  tierAbove?: number;
  inputUsd: number;
  outputUsd: number;
  totalUsd: number;
  fitsContext: boolean | null;
}

/** Preço vigente na data: usa nextPrice se já entrou em vigor. */
export function currentPrice(model: ModelPrice, today: string): Price {
  return model.nextPrice && model.nextPrice.from <= today ? model.nextPrice : model;
}

export function computeCost(
  model: ModelPrice,
  inputTokens: number,
  outputTokens: number,
  today: string = new Date().toISOString().slice(0, 10),
): CostBreakdown {
  let price = currentPrice(model, today);
  let tierAbove: number | undefined;
  // Faixa de maior limite que o prompt ultrapassou.
  const tier = [...(model.tiers ?? [])].sort((a, b) => b.above - a.above).find((t) => inputTokens > t.above);
  if (tier && price === model) {
    price = tier;
    tierAbove = tier.above;
  }

  const inputUsd = (inputTokens / 1_000_000) * price.input;
  const outputUsd = (outputTokens / 1_000_000) * price.output;
  return {
    inputTokens,
    outputTokens,
    price,
    ...(tierAbove !== undefined && { tierAbove }),
    inputUsd,
    outputUsd,
    totalUsd: inputUsd + outputUsd,
    fitsContext: model.contextWindow === null ? null : inputTokens + outputTokens <= model.contextWindow,
  };
}
