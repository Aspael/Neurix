export const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";
export const OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

/** Entrada do LiteLLM: preços em US$ POR TOKEN. Muitos campos opcionais. */
export type LiteLLMEntry = {
  litellm_provider?: string;
  mode?: string;
  max_input_tokens?: number;
  max_output_tokens?: number;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  source?: string;
  [key: string]: unknown;
};
export type LiteLLMData = Record<string, LiteLLMEntry>;

/** Modelo da OpenRouter: preços em US$ POR TOKEN, como string. */
export type OpenRouterModel = {
  id: string;
  name: string;
  created: number;
  context_length: number | null;
  architecture?: { tokenizer?: string };
  top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
  pricing: {
    prompt: string;
    completion: string;
    input_cache_read?: string;
    input_cache_write?: string;
    overrides?: Array<{
      min_prompt_tokens?: number;
      prompt?: string;
      completion?: string;
      input_cache_read?: string;
      input_cache_write?: string;
    }>;
  };
};

async function fetchJson<T>(url: string, timeoutMs = 30_000): Promise<T> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "User-Agent": "neurix-cli" },
  });
  if (!res.ok) throw new Error(`${url} respondeu HTTP ${res.status}`);
  return (await res.json()) as T;
}

export async function fetchLiteLLM(): Promise<LiteLLMData> {
  const data = await fetchJson<LiteLLMData>(LITELLM_URL);
  delete data.sample_spec; // entrada de documentação, não é modelo
  return data;
}

export async function fetchOpenRouter(): Promise<OpenRouterModel[]> {
  const body = await fetchJson<{ data: OpenRouterModel[] }>(OPENROUTER_URL);
  return body.data;
}
