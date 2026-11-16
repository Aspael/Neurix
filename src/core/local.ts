/**
 * Estimativa de memória para rodar um LLM localmente (llama.cpp / Ollama / LM Studio).
 *
 * VRAM total = pesos + KV cache + overhead
 *   pesos    = parâmetros × bits por peso ÷ 8
 *   KV cache = 2 (K e V) × camadas × cabeças KV × dimensão da cabeça × tokens × bytes por elemento
 *   overhead = runtime + buffers de cálculo + margem de fragmentação
 *
 * Os valores são aproximações: cada runtime aloca um pouco diferente.
 */

export interface LocalModel {
  id: string;
  name: string;
  /** Parâmetros em bilhões. */
  paramsB: number;
  layers: number;
  /** Cabeças de atenção que guardam K/V (com GQA é menor que o total de cabeças). */
  kvHeads: number;
  headDim: number;
  /** Contexto máximo de fábrica, em tokens. */
  maxContext: number;
}

export interface Quantization {
  id: string;
  /** Bits médios por peso no arquivo GGUF (inclui escalas e embeddings). */
  bits: number;
}

export interface KvPrecision {
  id: string;
  bytes: number;
}

export const GIB = 1024 ** 3;

/** Memória fixa do runtime (contexto CUDA/Metal, bibliotecas). */
export const RUNTIME_GIB = 0.5;
/** Buffers temporários das contas (ativações, logits). */
export const BUFFERS_GIB = 0.3;
/** Margem para fragmentação e alocações extras. */
export const MARGIN_PCT = 5;

export const QUANTIZATIONS: Quantization[] = [
  { id: "F16", bits: 16 },
  { id: "Q8_0", bits: 8.5 },
  { id: "Q6_K", bits: 6.6 },
  { id: "Q5_K_M", bits: 5.7 },
  { id: "Q4_K_M", bits: 4.9 },
  { id: "Q3_K_M", bits: 4.0 },
  { id: "Q2_K", bits: 3.2 },
];

export const KV_PRECISIONS: KvPrecision[] = [
  { id: "F16", bytes: 2 },
  { id: "Q8_0", bytes: 1.0625 },
  { id: "Q4_0", bytes: 0.5625 },
];

export const LOCAL_MODELS: LocalModel[] = [
  { id: "llama-3.2-1b", name: "Llama 3.2 1B", paramsB: 1.24, layers: 16, kvHeads: 8, headDim: 64, maxContext: 131_072 },
  { id: "llama-3.2-3b", name: "Llama 3.2 3B", paramsB: 3.21, layers: 28, kvHeads: 8, headDim: 128, maxContext: 131_072 },
  { id: "phi-3-mini", name: "Phi-3 Mini 3.8B (4k)", paramsB: 3.82, layers: 32, kvHeads: 32, headDim: 96, maxContext: 4096 },
  { id: "mistral-7b", name: "Mistral 7B v0.3", paramsB: 7.25, layers: 32, kvHeads: 8, headDim: 128, maxContext: 32_768 },
  { id: "qwen2.5-7b", name: "Qwen2.5 7B", paramsB: 7.62, layers: 28, kvHeads: 4, headDim: 128, maxContext: 32_768 },
  { id: "llama-3.1-8b", name: "Llama 3.1 8B", paramsB: 8.03, layers: 32, kvHeads: 8, headDim: 128, maxContext: 131_072 },
  { id: "qwen3-8b", name: "Qwen3 8B", paramsB: 8.19, layers: 36, kvHeads: 8, headDim: 128, maxContext: 32_768 },
  { id: "gemma-2-9b", name: "Gemma 2 9B", paramsB: 9.24, layers: 42, kvHeads: 8, headDim: 256, maxContext: 8192 },
  { id: "qwen2.5-14b", name: "Qwen2.5 14B", paramsB: 14.7, layers: 48, kvHeads: 8, headDim: 128, maxContext: 32_768 },
  { id: "qwen2.5-32b", name: "Qwen2.5 32B", paramsB: 32.8, layers: 64, kvHeads: 8, headDim: 128, maxContext: 32_768 },
  { id: "llama-3.1-70b", name: "Llama 3.1 70B", paramsB: 70.6, layers: 80, kvHeads: 8, headDim: 128, maxContext: 131_072 },
];

/** 32768 → "32k", 131072 → "128k" (contextos locais são potências de 2). */
export function formatLocalContext(tokens: number): string {
  return tokens >= 1024 && tokens % 1024 === 0 ? `${tokens / 1024}k` : String(tokens);
}

export function findLocalModel(id: string): LocalModel | undefined {
  const q = id.toLowerCase().replace(/\./g, "-");
  return LOCAL_MODELS.find((m) => m.id.replace(/\./g, "-") === q || m.id.replace(/\./g, "-").endsWith(q));
}

export const findQuant = (id: string): Quantization | undefined =>
  QUANTIZATIONS.find((q) => q.id.toLowerCase() === id.toLowerCase());

export const findKv = (id: string): KvPrecision | undefined =>
  KV_PRECISIONS.find((k) => k.id.toLowerCase() === id.toLowerCase());

export interface LocalEstimate {
  weightsGib: number;
  /** Bytes de KV cache por token de contexto. */
  kvBytesPerToken: number;
  kvGib: number;
  overheadGib: number;
  totalGib: number;
  /** Só quando uma GPU foi informada. */
  gpu?: {
    vramGib: number;
    fits: boolean;
    /** Camadas que cabem na GPU quando não cabe tudo. */
    layersOnGpu: number;
    /** Maior contexto que cabe com tudo na GPU (0 se nem os pesos cabem). */
    maxContextOnGpu: number;
  };
}

export interface LocalInput {
  model: LocalModel;
  quant: Quantization;
  kv: KvPrecision;
  /** Tokens de contexto reservados (entrada + resposta). */
  context: number;
  /** Conversas simultâneas (cada uma tem seu próprio KV cache). */
  parallel?: number;
  vramGib?: number;
}

export function estimateLocal(input: LocalInput): LocalEstimate {
  const { model, quant, kv, context } = input;
  const parallel = input.parallel ?? 1;

  const weightsGib = (model.paramsB * 1e9 * quant.bits) / 8 / GIB;
  const kvBytesPerToken = 2 * model.layers * model.kvHeads * model.headDim * kv.bytes;
  const kvGib = (kvBytesPerToken * context * parallel) / GIB;
  const overheadGib = RUNTIME_GIB + BUFFERS_GIB + ((weightsGib + kvGib) * MARGIN_PCT) / 100;
  const totalGib = weightsGib + kvGib + overheadGib;

  const result: LocalEstimate = { weightsGib, kvBytesPerToken, kvGib, overheadGib, totalGib };

  if (input.vramGib !== undefined) {
    const vram = input.vramGib;
    const fixed = RUNTIME_GIB + BUFFERS_GIB;
    const k = 1 + MARGIN_PCT / 100;
    // Por camada: sua fatia de pesos + sua fatia de KV cache.
    const perLayer = ((weightsGib + kvGib) / model.layers) * k;
    const layersOnGpu = Math.max(0, Math.min(model.layers, Math.floor((vram - fixed) / perLayer)));
    // vram = fixed + (weights + kvPerToken × ctx × parallel) × k  →  isola ctx
    const free = (vram - fixed) / k - weightsGib;
    const maxContextOnGpu = free > 0 ? Math.floor((free * GIB) / (kvBytesPerToken * parallel)) : 0;
    result.gpu = { vramGib: vram, fits: totalGib <= vram, layersOnGpu, maxContextOnGpu };
  }
  return result;
}
