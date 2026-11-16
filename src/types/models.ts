export type Provider = "anthropic" | "openai" | "google" | "deepseek" | "qwen" | "local";
export type Tier = "flagship" | "mid" | "cheap";

/** Define como os tokens são contados e qual margem de erro mostrar. */
export type Tokenizer =
  | "o200k" // OpenAI: contagem exata via js-tiktoken
  | "claude" // Anthropic: exata só via count_tokens (--exact); senão estimativa
  | "gemini" // Google: estimativa
  | "estimate"; // heurística chars / 3.5

/** De onde veio o preço principal do modelo. */
export type PriceSource = "litellm" | "openrouter" | "manual";

/** Preço base. Todos os valores em US$ por 1M de tokens. */
export interface Price {
  input: number;
  output: number;
  cachedInput?: number;
  cacheWrite?: number;
}

/** Preço cobrado quando o prompt passa de `above` tokens. */
export interface PriceTier extends Price {
  above: number;
}

/** Preço que entra em vigor a partir de `from` (ex.: fim de promoção). */
export interface ScheduledPrice extends Price {
  from: string; // ISO date
}

/** Preço cobrado pela OpenRouter (usado em `--via openrouter`). */
export interface OpenRouterPrice extends Price {
  id: string;
  tiers?: PriceTier[];
}

export interface ModelPrice extends Price {
  id: string;
  name: string;
  provider: Provider;
  tier: Tier;
  /** Aparece na tabela comparativa padrão. */
  featured: boolean;
  legacy: boolean;
  tokenizer: Tokenizer;
  contextWindow: number | null;
  maxOutput: number | null;
  tiers?: PriceTier[];
  validUntil?: string;
  nextPrice?: ScheduledPrice;
  source: PriceSource;
  sourceUrl?: string;
  /** Preço oficial e preço da OpenRouter divergem acima do limite. */
  priceConflict?: { openrouter: Price; diffPct: number };
  openrouter?: OpenRouterPrice;
  note?: string;
}

export interface PriceDataset {
  version: number;
  generatedAt: string;
  currency: "USD";
  unit: "per_1m_tokens";
  sources: Record<"litellm" | "openrouter", { url: string; fetchedAt: string } | null>;
  models: ModelPrice[];
}

/** Entrada do catálogo curado (data/overlay.json). */
export interface OverlayEntry {
  id: string;
  provider: Exclude<Provider, "local">;
  tier: Tier;
  featured?: boolean;
  legacy?: boolean;
  name?: string;
  tokenizer?: Tokenizer;
  /** Força a chave no LiteLLM quando a convenção padrão não acha. */
  litellmKey?: string;
  /** Força o id na OpenRouter quando a convenção padrão não acha. */
  openrouterId?: string;
  validUntil?: string;
  nextPrice?: ScheduledPrice;
  /** Usado só se nenhuma fonte tiver o modelo. */
  manual?: Price & { contextWindow?: number; maxOutput?: number };
  note?: string;
}
