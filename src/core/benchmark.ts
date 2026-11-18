/**
 * Benchmark real com o Ollama: gera uma resposta, mede tokens/s de verdade (o Ollama devolve os tempos)
 * e, com GPU NVIDIA, mede o consumo da placa a cada 0,5 s durante a geração → Wh por 1M de tokens.
 */
import { nvidiaPowerDraw } from "./hardware.ts";

export const OLLAMA_URL = process.env.OLLAMA_HOST
  ? process.env.OLLAMA_HOST.startsWith("http")
    ? process.env.OLLAMA_HOST
    : `http://${process.env.OLLAMA_HOST}`
  : "http://127.0.0.1:11434";

export interface BenchmarkResult {
  model: string;
  promptTokens: number;
  outputTokens: number;
  /** Tokens/s lendo o prompt e gerando a resposta, medidos pelo Ollama. */
  prefillTps: number;
  decodeTps: number;
  loadSeconds: number;
  totalSeconds: number;
  /** Potência média da GPU durante a geração (W) e amostras — só NVIDIA. */
  avgPowerW: number | null;
  powerSamples: number;
  /** Energia por 1M de tokens gerados (kWh), com a potência medida. */
  kWhPer1M: number | null;
}

export async function ollamaRunning(url = OLLAMA_URL): Promise<boolean> {
  try {
    const r = await fetch(`${url}/api/version`, { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

/** Modelos que o servidor do Ollama conhece (nome:tag). */
export async function ollamaModels(url = OLLAMA_URL): Promise<string[]> {
  const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`Ollama: HTTP ${r.status}`);
  const j = (await r.json()) as { models?: { name: string }[] };
  return (j.models ?? []).map((m) => m.name);
}

export const BENCH_PROMPT =
  "Explique em 5 parágrafos como funciona um modelo de linguagem: tokens, atenção, contexto e geração de texto.";

export async function runOllamaBenchmark(model: string, opts: { prompt?: string; maxTokens?: number; url?: string } = {}): Promise<BenchmarkResult> {
  const url = opts.url ?? OLLAMA_URL;
  const samples: number[] = [];
  let sampling = true;
  // amostra a potência enquanto gera (sem NVIDIA, a primeira leitura volta null e paramos)
  const sampler = (async () => {
    while (sampling) {
      const w = await nvidiaPowerDraw();
      if (w === null) return;
      samples.push(w);
      await new Promise((r) => setTimeout(r, 500));
    }
  })();

  let body: Record<string, number>;
  try {
    const res = await fetch(`${url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: opts.prompt ?? BENCH_PROMPT, stream: false, options: { num_predict: opts.maxTokens ?? 256, temperature: 0 } }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!res.ok) throw new Error(`Ollama: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    body = (await res.json()) as Record<string, number>;
  } finally {
    sampling = false;
    await sampler;
  }

  const ns = (k: string): number => (body[k] ?? 0) / 1e9;
  const decodeTps = ns("eval_duration") > 0 ? (body.eval_count ?? 0) / ns("eval_duration") : 0;
  const prefillTps = ns("prompt_eval_duration") > 0 ? (body.prompt_eval_count ?? 0) / ns("prompt_eval_duration") : 0;
  // descarta a 1ª amostra (a placa ainda está subindo o clock)
  const used = samples.length > 2 ? samples.slice(1) : samples;
  const avgPowerW = used.length ? used.reduce((a, b) => a + b, 0) / used.length : null;
  return {
    model,
    promptTokens: body.prompt_eval_count ?? 0,
    outputTokens: body.eval_count ?? 0,
    prefillTps,
    decodeTps,
    loadSeconds: ns("load_duration"),
    totalSeconds: ns("total_duration"),
    avgPowerW,
    powerSamples: used.length,
    kWhPer1M: avgPowerW !== null && decodeTps > 0 ? ((1e6 / decodeTps / 3600) * avgPowerW) / 1000 : null,
  };
}
