/**
 * Contagem de tokens.
 *
 * - OpenAI: exata, com o tokenizer oficial (js-tiktoken, o200k_base).
 * - Modelos locais: exata, com o tokenizer de cada modelo baixado do Hugging Face (ver hf.ts).
 * - Claude e Gemini: estimativa. Os tokenizers não são públicos; a contagem exata só sai pela API
 *   oficial de cada empresa (count_tokens / countTokens).
 * - Demais (DeepSeek, Qwen via API): estimativa.
 */
import type { Tiktoken } from "js-tiktoken/lite";
import type { ModelPrice, Tokenizer } from "../types/models.ts";

/** PT-BR gera ~20–30% mais tokens que inglês; chars/3.5 é a estimativa padrão do Neurix. */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

/** Por que a contagem é a que é. */
export type CountMethod =
  | "tiktoken" // exata, tokenizer oficial da OpenAI
  | "huggingface" // exata, tokenizer do modelo no Hugging Face
  | "claude" // estimativa: exata só via API da Anthropic
  | "gemini" // estimativa: exata só via API do Google
  | "estimate"; // estimativa genérica

export interface Counter {
  method: CountMethod;
  exact: boolean;
  /** Nome do tokenizer usado (ex.: "o200k_base" ou "Qwen/Qwen2.5-7B-Instruct"). */
  source?: string;
  /** Motivo de ter caído na estimativa quando a exata era esperada (ex.: sem internet). */
  fallback?: string;
  count(text: string): number;
  /** Ids dos tokens e o caminho de volta; só nos tokenizers reais (usado para cortar pedaços de RAG). */
  encode?: (text: string) => number[];
  decode?: (ids: number[]) => string;
}

export const estimateCounter = (method: CountMethod = "estimate", fallback?: string): Counter => ({
  method,
  exact: false,
  ...(fallback && { fallback }),
  count: estimateTokens,
});

let o200k: Tiktoken | undefined;

/** Carrega o tokenizer da OpenAI só quando precisa (o arquivo de ranks é grande). */
async function loadO200k(): Promise<Tiktoken> {
  if (!o200k) {
    const [{ Tiktoken }, ranks] = await Promise.all([import("js-tiktoken/lite"), import("js-tiktoken/ranks/o200k_base")]);
    o200k = new Tiktoken(ranks.default);
  }
  return o200k;
}

const ESTIMATED: Record<Exclude<Tokenizer, "o200k">, CountMethod> = {
  claude: "claude",
  gemini: "gemini",
  estimate: "estimate",
};

/** Contador certo para um modelo de API. */
export async function counterFor(model: Pick<ModelPrice, "tokenizer">): Promise<Counter> {
  if (model.tokenizer !== "o200k") return estimateCounter(ESTIMATED[model.tokenizer]);
  try {
    const enc = await loadO200k();
    return {
      method: "tiktoken",
      exact: true,
      source: "o200k_base",
      count: (text) => enc.encode(text).length,
      encode: (text) => enc.encode(text),
      decode: (ids) => enc.decode(ids),
    };
  } catch (err) {
    return estimateCounter("estimate", (err as Error).message);
  }
}

/** Um contador por modelo, reaproveitando o mesmo tokenizer entre modelos iguais. */
export async function countersFor(models: ModelPrice[]): Promise<Map<string, Counter>> {
  const byTokenizer = new Map<Tokenizer, Counter>();
  const out = new Map<string, Counter>();
  for (const m of models) {
    let c = byTokenizer.get(m.tokenizer);
    if (!c) {
      c = await counterFor(m);
      byTokenizer.set(m.tokenizer, c);
    }
    out.set(m.id, c);
  }
  return out;
}
