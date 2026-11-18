/**
 * Importa a arquitetura de um modelo direto do Hugging Face, no lugar das 5 perguntas do modo personalizado.
 *
 * 1. Busca pelo nome (api/models?search=…), do mais baixado para o menos.
 * 2. Baixa o config.json do repositório escolhido e lê camadas, cabeças KV, dimensão da cabeça e contexto.
 * 3. Parâmetros: contagem exata dos safetensors (API do Hub) → número no nome ("8B") → conta pela arquitetura.
 *
 * Repositórios fechados (ex.: meta-llama/*) pedem HF_TOKEN; sem ele, sugerimos as cópias abertas.
 */
import type { LocalModel } from "./local.ts";

const HUB = "https://huggingface.co";
const TIMEOUT = 20_000;

const headers = (): Record<string, string> => {
  const token = process.env.HF_TOKEN ?? process.env.HUGGING_FACE_HUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export class HfError extends Error {
  readonly kind: "notFound" | "gated" | "network" | "noConfig" | "unsupported";
  constructor(message: string, kind: HfError["kind"]) {
    super(message);
    this.kind = kind;
  }
}

async function get(url: string): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(TIMEOUT) });
  } catch (err) {
    throw new HfError((err as Error).message, "network");
  }
  return res;
}

export interface HfSearchHit {
  id: string;
  downloads: number;
  likes: number;
  gated: boolean;
  pipeline: string | null;
}

export async function searchHfModels(query: string, limit = 8): Promise<HfSearchHit[]> {
  const url = `${HUB}/api/models?search=${encodeURIComponent(query)}&sort=downloads&direction=-1&limit=${limit}&filter=text-generation`;
  let res = await get(url);
  // alguns modelos não têm a tag; sem resultado, busca sem o filtro
  let data = res.ok ? ((await res.json()) as Record<string, unknown>[]) : [];
  if (!data.length) {
    res = await get(url.replace("&filter=text-generation", ""));
    if (!res.ok) throw new HfError(`HTTP ${res.status}`, "network");
    data = (await res.json()) as Record<string, unknown>[];
  }
  return data.map((m) => ({
    id: String(m.id ?? m.modelId),
    downloads: Number(m.downloads ?? 0),
    likes: Number(m.likes ?? 0),
    gated: Boolean(m.gated),
    pipeline: (m.pipeline_tag as string | undefined) ?? null,
  }));
}

type Config = Record<string, unknown>;

const n = (c: Config, ...keys: string[]): number | undefined => {
  for (const k of keys) {
    const v = c[k];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return undefined;
};

export interface HfImport {
  model: LocalModel;
  repo: string;
  /** De onde veio o número de parâmetros. */
  paramsSource: "safetensors" | "name" | "estimate";
  /** Campos usados do config.json (para mostrar ao usuário). */
  fields: Record<string, number | string>;
  architecture: string | null;
}

/** Lê o config.json (inclusive os multimodais, que guardam o texto em text_config / llm_config). */
export function shapeFromConfig(cfg0: Config): Omit<LocalModel, "id" | "name" | "paramsB"> & { fields: Record<string, number | string>; est: number } {
  const cfg = ((cfg0.text_config ?? cfg0.llm_config ?? cfg0.language_config ?? cfg0) as Config) || cfg0;
  const layers = n(cfg, "num_hidden_layers", "n_layer", "num_layers", "n_layers");
  const heads = n(cfg, "num_attention_heads", "n_head", "num_heads");
  const hidden = n(cfg, "hidden_size", "n_embd", "d_model", "dim");
  if (!layers || !heads || !hidden) throw new HfError("config.json sem camadas/cabeças/hidden_size", "unsupported");
  const kvHeads = n(cfg, "num_key_value_heads", "n_head_kv", "num_kv_heads") ?? (cfg.multi_query === true ? 1 : heads);
  const headDim = n(cfg, "head_dim") ?? Math.round(hidden / heads);
  const maxContext = n(cfg, "max_position_embeddings", "n_positions", "max_sequence_length", "seq_length", "max_seq_len") ?? 4096;

  // Estimativa de parâmetros pela arquitetura (quando o Hub não informa): embeddings + atenção + MLP (× especialistas).
  const vocab = n(cfg, "vocab_size") ?? 32000;
  const inter = n(cfg, "intermediate_size", "ffn_dim", "n_inner") ?? hidden * 4;
  const experts = n(cfg, "num_local_experts", "num_experts", "n_routed_experts") ?? 1;
  const moeInter = n(cfg, "moe_intermediate_size") ?? inter;
  const tied = cfg.tie_word_embeddings === true;
  const attn = hidden * (heads * headDim) + 2 * hidden * (kvHeads * headDim) + heads * headDim * hidden;
  const mlp = 3 * hidden * (experts > 1 ? moeInter * experts : inter);
  const est = vocab * hidden * (tied ? 1 : 2) + layers * (attn + mlp);

  return {
    layers,
    kvHeads,
    headDim,
    maxContext,
    est,
    fields: {
      num_hidden_layers: layers,
      num_attention_heads: heads,
      num_key_value_heads: kvHeads,
      head_dim: headDim,
      hidden_size: hidden,
      max_position_embeddings: maxContext,
      ...(experts > 1 && { experts }),
    },
  };
}

/** "Llama-3.1-8B" → 8; "Qwen2.5-0.5B" → 0.5; "Mixtral-8x7B" → 56 (aproximado). */
export function paramsFromName(repo: string): number | null {
  const name = repo.split("/").pop() ?? repo;
  const moe = name.match(/(\d+)x(\d+(?:\.\d+)?)b/i);
  if (moe) return Number(moe[1]) * Number(moe[2]);
  const m = name.match(/(?:^|[-_.])(\d+(?:\.\d+)?)b(?:$|[-_.])/i);
  return m ? Number(m[1]) : null;
}

export async function importHfModel(repo: string): Promise<HfImport> {
  const r = repo.trim().replace(/^https?:\/\/huggingface\.co\//, "").replace(/\/$/, "");
  const cfgRes = await get(`${HUB}/${r}/resolve/main/config.json`);
  if (cfgRes.status === 401 || cfgRes.status === 403) throw new HfError(`${r} é fechado (gated): defina HF_TOKEN ou use uma cópia aberta`, "gated");
  if (cfgRes.status === 404) {
    const exists = await get(`${HUB}/api/models/${r}`);
    throw new HfError(exists.ok ? `${r} não tem config.json (ex.: só GGUF)` : `${r} não existe no Hugging Face`, exists.ok ? "noConfig" : "notFound");
  }
  if (!cfgRes.ok) throw new HfError(`config.json: HTTP ${cfgRes.status}`, "network");
  const cfg = (await cfgRes.json()) as Config;
  const shape = shapeFromConfig(cfg);

  let params: number | null = null;
  let paramsSource: HfImport["paramsSource"] = "estimate";
  const info = await get(`${HUB}/api/models/${r}?expand[]=safetensors`);
  if (info.ok) {
    const j = (await info.json()) as { safetensors?: { total?: number } };
    if (j.safetensors?.total) {
      params = j.safetensors.total;
      paramsSource = "safetensors";
    }
  }
  if (params === null) {
    const byName = paramsFromName(r);
    if (byName) {
      params = byName * 1e9;
      paramsSource = "name";
    } else params = shape.est;
  }
  const arch = Array.isArray(cfg.architectures) ? String(cfg.architectures[0]) : ((cfg.model_type as string) ?? null);
  return {
    repo: r,
    paramsSource,
    architecture: arch,
    fields: { ...shape.fields, parameters: params },
    model: {
      id: `hf:${r}`,
      name: r.split("/").pop() ?? r,
      paramsB: params / 1e9,
      layers: shape.layers,
      kvHeads: shape.kvHeads,
      headDim: shape.headDim,
      maxContext: shape.maxContext,
      hfRepo: r,
    },
  };
}
