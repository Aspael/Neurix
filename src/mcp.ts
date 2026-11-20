#!/usr/bin/env node
/**
 * Servidor MCP do Neurix (stdio). Funciona em qualquer cliente MCP: Claude Code, Claude Desktop,
 * Cursor, VS Code, Windsurf, Gemini CLI, etc.
 *
 * Regra de ouro do stdio: NADA pode ir para o stdout além do protocolo. Logs vão para o stderr.
 */
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import pkg from "../package.json" with { type: "json" };
import { computeCost, currentPrice } from "./core/cost.ts";
import { detectKind, formatVariants } from "./core/formats.ts";
import { localCounter } from "./core/hf.ts";
import {
  estimateLocal,
  findKv,
  findLocalModel,
  findQuant,
  KV_PRECISIONS,
  LOCAL_MODELS,
  QUANTIZATIONS,
  type LocalModel,
  type KvPrecision,
  type Quantization,
  GIB,
} from "./core/local.ts";
import { simulateRag } from "./core/rag.ts";
import { ollamaModels, ollamaRunning, runOllamaBenchmark } from "./core/benchmark.ts";
import { detectHardware, inferencePowerW, type Gpu } from "./core/hardware.ts";
import { HfError, importHfModel, searchHfModels } from "./core/hfconfig.ts";
import { findInstalledModels } from "./core/installed.ts";
import { defaultGpuW, estimateSpeed, localVsApi, type LocalCostInput } from "./core/localcost.ts";
import { promptCacheSavings } from "./core/budget.ts";
import { BATCH, burnRate, checkLimits, planBudget, type UsageProfile } from "./core/plan.ts";
import { chunkDocument } from "./core/chunking.ts";
import { analyzeFolder, byTopDir } from "./core/folder.ts";
import { optimizePrompt, revealWhitespace } from "./core/optimize.ts";
import { recommendModel, suggestQuality } from "./core/recommend.ts";
import { counterFor, countersFor, type Counter } from "./core/tokens.ts";
import { getUsdBrl, toBrl, type ExchangeRate } from "./currency/exchange.ts";
import { dictFor, loadLang, t } from "./i18n/index.ts";
import { findModel, loadPrices, visibleModels } from "./prices/load.ts";
import type { ModelPrice, PriceDataset } from "./types/models.ts";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

// ───────────── Utilidades ─────────────

const round = (n: number, d = 6): number => Number(n.toFixed(d));
const gb = (gib: number): number => round(gib, 2);

/** Resultado de tool: JSON legível (o modelo lê texto) + structuredContent para clientes que usam. */
function ok(data: Record<string, unknown>) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }], structuredContent: data };
}

function fail(message: string, extra: Record<string, unknown> = {}) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message, ...extra }, null, 2) }], isError: true };
}

/** Texto vindo direto (`text`) ou de um arquivo (`path`); devolve o erro pronto se não der. */
async function textOrFile(text?: string, path?: string): Promise<string | ReturnType<typeof fail>> {
  if (text !== undefined) return text;
  if (!path) return fail("Pass `text` or `path`.");
  const full = resolve(path);
  const s = await stat(full).catch(() => null);
  if (!s?.isFile()) return fail(`File not found: ${full}`);
  if (s.size > MAX_FILE_BYTES) return fail(`File too large (${Math.round(s.size / 1024 / 1024)} MB; max 20 MB).`);
  const buf = await readFile(full);
  if (buf.subarray(0, 8000).includes(0)) return fail("Binary file; only text files are supported.");
  return buf.toString("utf8");
}

/** Descrição de como os tokens foram contados, para a IA repassar ao usuário. */
function countInfo(c: Counter) {
  return {
    exact: c.exact,
    method: c.method,
    ...(c.source && { tokenizer: c.source }),
    ...(c.fallback && { fallback_reason: c.fallback }),
    explanation: t().count.why[c.method],
  };
}

let rateCache: ExchangeRate | null | undefined;
async function rateFor(usdBrl?: number): Promise<ExchangeRate | null> {
  if (usdBrl !== undefined) return { usdBrl, source: "manual", quotedAt: new Date().toISOString() };
  if (rateCache !== undefined) return rateCache;
  try {
    rateCache = await getUsdBrl({});
  } catch {
    rateCache = null;
  }
  return rateCache;
}

const money = (usd: number, rate: ExchangeRate | null, iof: number) => ({
  usd: round(usd, 8),
  brl: rate ? round(toBrl(usd, rate, iof), 8) : null,
});

let dataset: PriceDataset;

function apiModel(id: string): ModelPrice | undefined {
  return findModel(dataset, id);
}

/** Tokens de entrada: a partir do texto (contado com o tokenizer do modelo) ou do número informado. */
async function inputTokensFor(model: ModelPrice, text?: string, tokens?: number) {
  const counter = await counterFor(model);
  if (text !== undefined) return { tokens: counter.count(text), counting: countInfo(counter) };
  return { tokens: tokens ?? 0, counting: { exact: true, method: "given", explanation: "Token count provided by the caller." } };
}

const modelSummary = (m: ModelPrice) => {
  const p = currentPrice(m, new Date().toISOString().slice(0, 10));
  return {
    id: m.id,
    name: m.name,
    provider: m.provider,
    tier: m.tier,
    legacy: m.legacy,
    price_per_1m_usd: { input: p.input, output: p.output, ...(p.cachedInput !== undefined && { cached_input: p.cachedInput }) },
    context_window: m.contextWindow,
    max_output: m.maxOutput,
    token_count: m.tokenizer === "o200k" ? "exact (js-tiktoken o200k_base)" : `estimate (${m.tokenizer})`,
  };
};

function unknownModel(id: string) {
  return fail(`Model not found: ${id}`, {
    api_models: dataset.models.map((m) => m.id),
    local_models: LOCAL_MODELS.map((m) => m.id),
    hint: "Use neurix_list_models to see every id.",
  });
}

const textOrTokens = {
  text: z.string().optional().describe("The text to analyse. It is tokenized with the model's own tokenizer when available."),
  input_tokens: z.number().int().nonnegative().optional().describe("Use instead of `text` when you already know the input token count."),
};
const fxArgs = {
  usd_brl: z.number().positive().optional().describe("Manual USD→BRL rate. If omitted, the current rate is fetched (cached for 1h)."),
  iof_pct: z.number().nonnegative().default(0).describe("Brazilian IOF tax on international card purchases, in % (e.g. 3.5). Default 0."),
};
const outputTokensArg = z
  .number()
  .int()
  .nonnegative()
  .default(300)
  .describe("Expected size of the model's answer, in tokens. Output usually costs 3–5× more than input. Default 300.");

// ───────────── Servidor ─────────────

/** Cria o servidor com todas as tools registradas, sem conectar transporte (usado também pela extensão VS Code). */
export async function createMcpServer(): Promise<McpServer> {
  await loadLang();
  dataset = await loadPrices(process.env.NEURIX_PRICES);

  const server = new McpServer(
    { name: "neurix", version: pkg.version },
    {
      instructions:
        "Neurix: LLM token counter and cost calculator (USD and BRL), plus local-model VRAM planner. " +
        "Token counts are EXACT for OpenAI (js-tiktoken) and local models (Hugging Face tokenizers), and ESTIMATES for Claude and Gemini " +
        "(their tokenizers are not public; exact counts only via their official APIs). Always tell the user when a number is an estimate. " +
        "Use neurix_list_models to discover model ids.",
    },
  );
  const RO = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };

  // 1 ─ Contar tokens
  server.registerTool(
    "neurix_count_tokens",
    {
      title: "Count tokens",
      description:
        "Counts how many tokens a text uses. With `model` (API or local id) it uses that model's tokenizer; without it, it returns the count " +
        "for each family: OpenAI (exact, js-tiktoken o200k_base), Claude and Gemini (estimate ~3.5 chars/token, because their tokenizers are " +
        "not public — exact only via their APIs), and optionally local models (exact, Hugging Face tokenizer, downloaded once and cached). " +
        "Use it before sending a big prompt, to check limits, or to compare how tokenizers split the same text.",
      inputSchema: {
        text: z.string().describe("The text to count."),
        model: z.string().optional().describe("Optional model id (e.g. gpt-6.1-sol, claude-sonnet-5-5, qwen2.5-7b). See neurix_list_models."),
        include_local: z.boolean().default(false).describe("Without `model`: also count with every local model tokenizer (may download ~1–10 MB each the first time)."),
      },
      annotations: { ...RO, openWorldHint: true },
    },
    async ({ text, model, include_local }) => {
      const chars = text.length;
      if (model) {
        const api = apiModel(model);
        if (api) {
          const c = await counterFor(api);
          return ok({ model: api.id, characters: chars, tokens: c.count(text), counting: countInfo(c) });
        }
        const local = findLocalModel(model);
        if (local) {
          const c = await localCounter(local);
          return ok({ model: local.id, characters: chars, tokens: c.count(text), counting: countInfo(c) });
        }
        return unknownModel(model);
      }
      const families: Record<string, unknown> = {};
      for (const [family, tokenizer] of [
        ["openai", "o200k"],
        ["claude", "claude"],
        ["gemini", "gemini"],
        ["other_api", "estimate"],
      ] as const) {
        const c = await counterFor({ tokenizer });
        families[family] = { tokens: c.count(text), ...countInfo(c) };
      }
      if (include_local) {
        const local: Record<string, unknown> = {};
        for (const m of LOCAL_MODELS) {
          const c = await localCounter(m);
          local[m.id] = { tokens: c.count(text), exact: c.exact, ...(c.source && { tokenizer: c.source }), ...(c.fallback && { fallback_reason: c.fallback }) };
        }
        families.local = local;
      }
      return ok({ characters: chars, by_family: families });
    },
  );

  // 2 ─ Custo em um modelo
  server.registerTool(
    "neurix_estimate_cost",
    {
      title: "Estimate cost of one call",
      description:
        "Estimates what ONE call to a given API model costs, in US dollars and Brazilian reais: input cost + output cost, the price per 1M tokens " +
        "actually applied (including long-context tiers and scheduled price changes), and whether the text fits the context window. " +
        "Pass `text` (tokenized with the model's tokenizer) or `input_tokens`.",
      inputSchema: {
        model: z.string().describe("API model id, e.g. claude-sonnet-5-5, gpt-6.1-sol, gemini-4-argon."),
        ...textOrTokens,
        output_tokens: outputTokensArg,
        calls: z.number().int().positive().default(1).describe("Multiply by this many calls (e.g. 1000 calls/month). Default 1."),
        ...fxArgs,
      },
      annotations: { ...RO, openWorldHint: true },
    },
    async ({ model, text, input_tokens, output_tokens, calls, usd_brl, iof_pct }) => {
      const m = apiModel(model);
      if (!m) return unknownModel(model);
      if (text === undefined && input_tokens === undefined) return fail("Pass `text` or `input_tokens`.");
      const input = await inputTokensFor(m, text, input_tokens);
      const c = computeCost(m, input.tokens, output_tokens);
      const rate = await rateFor(usd_brl);
      return ok({
        model: modelSummary(m),
        input_tokens: c.inputTokens,
        output_tokens: c.outputTokens,
        counting: input.counting,
        price_applied_per_1m_usd: { input: c.price.input, output: c.price.output },
        ...(c.tierAbove !== undefined && { long_context_price: `Prompt above ${c.tierAbove} tokens: higher price tier applied.` }),
        per_call: { input: money(c.inputUsd, rate, iof_pct), output: money(c.outputUsd, rate, iof_pct), total: money(c.totalUsd, rate, iof_pct) },
        ...(calls > 1 && { calls, total_for_all_calls: money(c.totalUsd * calls, rate, iof_pct) }),
        context: {
          window: m.contextWindow,
          used: c.inputTokens + c.outputTokens,
          fits: c.fitsContext,
          used_pct: m.contextWindow ? round(((c.inputTokens + c.outputTokens) / m.contextWindow) * 100, 3) : null,
        },
        exchange: rate ? { usd_brl: rate.usdBrl, source: rate.source, quoted_at: rate.quotedAt, iof_pct } : "unavailable (USD only)",
      });
    },
  );

  // 3 ─ Comparar modelos
  server.registerTool(
    "neurix_compare_models",
    {
      title: "Compare models",
      description:
        "Ranks API models by the total cost of the same call (cheapest first), in USD and BRL. Each model counts the text with its own " +
        "tokenizer (OpenAI exact; Claude/Gemini estimated), so token counts may differ between rows. Also flags models whose context window " +
        "is too small. Use it to pick the cheapest model that fits a workload.",
      inputSchema: {
        ...textOrTokens,
        output_tokens: outputTokensArg,
        include_all: z.boolean().default(false).describe("Include non-featured and legacy models. Default: only current featured models."),
        providers: z
          .array(z.enum(["anthropic", "openai", "google", "deepseek", "qwen"]))
          .optional()
          .describe("Only these providers."),
        calls: z.number().int().positive().default(1).describe("Multiply each total by this many calls."),
        ...fxArgs,
      },
      annotations: { ...RO, openWorldHint: true },
    },
    async ({ text, input_tokens, output_tokens, include_all, providers, calls, usd_brl, iof_pct }) => {
      if (text === undefined && input_tokens === undefined) return fail("Pass `text` or `input_tokens`.");
      let models = visibleModels(dataset, include_all);
      if (providers?.length) models = models.filter((m) => providers.includes(m.provider as (typeof providers)[number]));
      if (!models.length) return fail("No model matches the filter.");
      const counters = await countersFor(models);
      const rate = await rateFor(usd_brl);
      const rows = models
        .map((m) => {
          const counter = counters.get(m.id) as Counter;
          const tokens = text !== undefined ? counter.count(text) : (input_tokens ?? 0);
          return { m, counter, c: computeCost(m, tokens, output_tokens) };
        })
        .sort((a, b) => a.c.totalUsd - b.c.totalUsd);
      const cheapestFit = rows.find((r) => r.c.fitsContext !== false);
      return ok({
        output_tokens,
        calls,
        ranking: rows.map(({ m, c, counter }, i) => ({
          rank: i + 1,
          id: m.id,
          name: m.name,
          provider: m.provider,
          input_tokens: c.inputTokens,
          tokens_exact: text !== undefined ? counter.exact : true,
          price_per_1m_usd: { input: c.price.input, output: c.price.output },
          total: money(c.totalUsd * calls, rate, iof_pct),
          context_window: m.contextWindow,
          fits_context: c.fitsContext,
        })),
        cheapest_that_fits: cheapestFit?.m.id ?? null,
        note: "Claude and Gemini token counts are estimates (tokenizers not public; exact only via their official APIs). OpenAI counts are exact.",
        exchange: rate ? { usd_brl: rate.usdBrl, source: rate.source, iof_pct } : "unavailable (USD only)",
      });
    },
  );

  // 4 ─ Formato mais barato
  server.registerTool(
    "neurix_suggest_format",
    {
      title: "Suggest the cheapest data format",
      description:
        "Converts the same data (JSON, CSV or plain text) into other formats — indented JSON, minified JSON, YAML, CSV, Markdown table, " +
        "compacted text — and measures the tokens of each with the model's tokenizer. Returns them sorted, the cheapest one, and how much it " +
        "saves per call and per 1,000 calls. Use it before putting structured data in a prompt.",
      inputSchema: {
        content: z.string().describe("The data to convert (JSON, CSV or text)."),
        filename: z.string().optional().describe("Optional file name, helps detect the type (e.g. data.csv)."),
        model: z.string().default("gpt-6.1-sol").describe("API model used to count tokens and price the call."),
        output_tokens: outputTokensArg,
        include_converted: z.boolean().default(false).describe("Also return the converted content of the cheapest format."),
        ...fxArgs,
      },
      annotations: { ...RO, openWorldHint: true },
    },
    async ({ content, filename, model, output_tokens, include_converted, usd_brl, iof_pct }) => {
      const m = apiModel(model);
      if (!m) return unknownModel(model);
      const counter = await counterFor(m);
      const kind = detectKind(content, filename ?? "");
      const variants = formatVariants(content, kind, counter.count).sort((a, b) => a.tokens - b.tokens);
      const base = variants.find((v) => v.original) ?? variants[0];
      const best = variants[0];
      if (!base || !best) return fail("Empty content.");
      const rate = await rateFor(usd_brl);
      const F = t().formats;
      const saved = computeCost(m, base.tokens, output_tokens).totalUsd - computeCost(m, best.tokens, output_tokens).totalUsd;
      return ok({
        detected_type: kind,
        model: m.id,
        counting: countInfo(counter),
        formats: variants.map((v) => ({
          id: v.id,
          name: F.names[v.id],
          why: F.why[v.id],
          characters: v.chars,
          tokens: v.tokens,
          vs_original_pct: base.tokens ? round(((v.tokens - base.tokens) / base.tokens) * 100, 1) : 0,
          cost_per_call: money(computeCost(m, v.tokens, output_tokens).totalUsd, rate, iof_pct),
        })),
        best: best.id,
        saves_tokens_per_call: base.tokens - best.tokens,
        saves_per_call: money(saved, rate, iof_pct),
        saves_per_1000_calls: money(saved * 1000, rate, iof_pct),
        caveat: "Fewer tokens is not always better: models read some formats (e.g. indented JSON, Markdown tables) more reliably.",
        ...(include_converted && { best_content: best.content }),
      });
    },
  );

  // 5 ─ Cabe na minha GPU?
  const localModelArgs = {
    model: z.string().optional().describe(`Local model id: ${LOCAL_MODELS.map((m) => m.id).join(", ")}. Or use \`custom\`.`),
    custom: z
      .object({
        name: z.string().default("Custom model"),
        params_b: z.number().positive().describe("Parameters in billions (e.g. 8)."),
        layers: z.number().int().positive().describe("num_hidden_layers in config.json."),
        kv_heads: z.number().int().positive().describe("num_key_value_heads (GQA)."),
        head_dim: z.number().int().positive().describe("head_dim, or hidden_size ÷ num_attention_heads."),
        max_context: z.number().int().positive().default(131072).describe("max_position_embeddings."),
        hf_repo: z.string().optional().describe("Optional Hugging Face repo with tokenizer.json, for exact token counts."),
      })
      .optional()
      .describe("A model not in the list, described by its config.json."),
  };
  const resolveLocal = (model?: string, custom?: { name: string; params_b: number; layers: number; kv_heads: number; head_dim: number; max_context: number; hf_repo?: string | undefined }): LocalModel | string => {
    if (custom)
      return {
        id: "custom",
        name: custom.name,
        paramsB: custom.params_b,
        layers: custom.layers,
        kvHeads: custom.kv_heads,
        headDim: custom.head_dim,
        maxContext: custom.max_context,
        ...(custom.hf_repo && { hfRepo: custom.hf_repo }),
      };
    if (!model) return "Pass `model` or `custom`.";
    return findLocalModel(model) ?? `Local model not found: ${model}. Options: ${LOCAL_MODELS.map((m) => m.id).join(", ")}`;
  };

  server.registerTool(
    "neurix_check_local_fit",
    {
      title: "Check if a local model fits in VRAM",
      description:
        "Estimates the memory to run an LLM on your own machine (llama.cpp / Ollama / LM Studio): weights + KV cache + overhead = total VRAM. " +
        "With `vram_gb` it says whether everything fits on the GPU, how many layers fit if not (partial offload), the largest context that " +
        "fits, and what to change. Pass `text` to size the context from it (counted exactly with the model's Hugging Face tokenizer). " +
        "Local models have no per-token cost.",
      inputSchema: {
        ...localModelArgs,
        quant: z.enum(QUANTIZATIONS.map((q) => q.id) as [string, ...string[]]).default("Q4_K_M").describe("GGUF quantization. Q4_K_M is the usual sweet spot."),
        context: z.number().int().positive().optional().describe("Context tokens to reserve (input + answer). Default: from `text`, else 8192."),
        text: z.string().optional().describe("Optional text: context = its exact token count + output_tokens."),
        output_tokens: outputTokensArg,
        kv: z.enum(KV_PRECISIONS.map((k) => k.id) as [string, ...string[]]).default("F16").describe("KV cache precision. Q8_0 halves it with little quality loss."),
        vram_gb: z.number().nonnegative().optional().describe("GPU VRAM in GB (e.g. 8, 12, 24; 0 = no GPU). Omit with detect_gpu=true to use the detected GPU."),
        detect_gpu: z.boolean().default(true).describe("When vram_gb is omitted, detect the machine's GPU (nvidia-smi / Windows / Linux / Apple) and also estimate speed."),
        hf_repo: z.string().optional().describe("Import the architecture from a Hugging Face repo's config.json instead of `model`/`custom` (e.g. Qwen/Qwen2.5-7B-Instruct)."),
        parallel: z.number().int().positive().default(1).describe("Simultaneous conversations (each one has its own KV cache)."),
      },
      annotations: { ...RO, openWorldHint: true },
    },
    async ({ model, custom, quant, context, text, output_tokens, kv, vram_gb: vramIn, detect_gpu, hf_repo, parallel }) => {
      let lm: LocalModel | string;
      if (hf_repo) {
        try {
          lm = (await importHfModel(hf_repo)).model;
        } catch (err) {
          return fail((err as Error).message, { hint: "Gated repo? Set HF_TOKEN or use an open copy (e.g. unsloth/...). Or pass `custom`." });
        }
      } else lm = resolveLocal(model, custom);
      if (typeof lm === "string") return fail(lm);
      const hw = vramIn === undefined && detect_gpu ? await detectHardware() : null;
      const detected = hw?.best && !(hw.best.integrated && hw.best.vendor !== "apple") ? hw.best : null;
      const vram_gb = vramIn ?? (detected ? detected.vramGib : hw ? 0 : undefined);
      const q = findQuant(quant);
      const k = findKv(kv);
      if (!q || !k) return fail("Unknown quant or kv.");
      let textInfo: Record<string, unknown> | undefined;
      let ctx = context;
      if (text !== undefined) {
        const c = await localCounter(lm);
        const tokens = c.count(text);
        textInfo = { tokens, counting: countInfo(c) };
        ctx ??= tokens + output_tokens;
      }
      ctx ??= Math.min(8192, lm.maxContext);
      const est = estimateLocal({ model: lm, quant: q, kv: k, context: ctx, parallel, ...(vram_gb !== undefined && vram_gb > 0 && { vramGib: vram_gb }) });
      const speed = hw
        ? estimateSpeed(lm, q, k, ctx, { ramGib: hw.ramGib, ramBandwidthGBs: hw.ramBandwidthGBs, gpu: detected })
        : null;

      const suggestions: string[] = [];
      if (est.gpu && !est.gpu.fits) {
        const smaller = QUANTIZATIONS.filter((x) => x.bits < q.bits && x.bits >= 4).slice(0, 2).map((x) => x.id);
        if (smaller.length) suggestions.push(`Use a smaller quantization: ${smaller.join(" or ")}.`);
        suggestions.push("Reserve less context.");
        const cheaperKv = KV_PRECISIONS.find((x) => x.bytes < k.bytes);
        if (cheaperKv) suggestions.push(`Use KV cache ${cheaperKv.id}.`);
        if (parallel > 1) suggestions.push("Run fewer parallel conversations.");
        suggestions.push("Pick a smaller model (see neurix_find_local_models).");
      }
      return ok({
        model: { id: lm.id, name: lm.name, params_b: lm.paramsB, layers: lm.layers, kv_heads: lm.kvHeads, head_dim: lm.headDim, max_context: lm.maxContext },
        quant: q.id,
        kv_cache_precision: k.id,
        context_tokens: ctx,
        parallel,
        ...(ctx > lm.maxContext && { warning: `Context above the model's native maximum (${lm.maxContext}).` }),
        ...(textInfo && { text: textInfo }),
        memory_gb: {
          weights: gb(est.weightsGib),
          kv_cache: gb(est.kvGib),
          overhead: gb(est.overheadGib),
          total: gb(est.totalGib),
        },
        kv_cache_kb_per_token: round(est.kvBytesPerToken / 1024, 1),
        ...(est.gpu && {
          gpu: {
            vram_gb: est.gpu.vramGib,
            fits_entirely: est.gpu.fits,
            free_gb: est.gpu.fits ? gb(est.gpu.vramGib - est.totalGib) : 0,
            layers_on_gpu: est.gpu.layersOnGpu,
            total_layers: lm.layers,
            max_context_fully_on_gpu: Math.min(est.gpu.maxContextOnGpu, lm.maxContext),
            verdict: est.gpu.fits
              ? "Fits entirely on the GPU."
              : est.gpu.layersOnGpu > 0
                ? `Partial offload: ${est.gpu.layersOnGpu}/${lm.layers} layers on GPU, the rest on CPU (slower).`
                : "Does not fit on the GPU; would run on CPU (much slower).",
          },
        }),
        ...(hw && { detected_hardware: { gpu: detected?.name ?? null, vram_gb: detected ? gb(detected.vramGib) : null, ram_gb: gb(hw.ramGib) } }),
        ...(speed && {
          estimated_speed: {
            runs_on: speed.placement,
            generation_tokens_per_s: round(speed.decodeTps, 1),
            prompt_tokens_per_s: round(speed.prefillTps, 0),
            verdict: speed.verdict,
            note: "Estimated from memory bandwidth (~60% efficiency). Measure for real with neurix_benchmark_ollama.",
          },
        }),
        ...(suggestions.length && { suggestions }),
        cost: "US$ 0 per token (runs on your machine).",
        note: "Approximation: each runtime (llama.cpp, Ollama, LM Studio, vLLM) allocates a bit differently.",
      });
    },
  );

  // 6 ─ Quais modelos locais cabem?
  server.registerTool(
    "neurix_find_local_models",
    {
      title: "Find local models that fit my GPU",
      description:
        "Given your GPU VRAM and the context you need, lists every known local model with the best-quality quantization that still fits " +
        "entirely on the GPU (from F16 down to Q2_K), sorted from largest to smallest model. Use it to answer 'what can I run on my 8 GB GPU?'.",
      inputSchema: {
        vram_gb: z.number().positive().describe("GPU VRAM in GB."),
        context: z.number().int().positive().default(8192).describe("Context tokens to reserve. Default 8192."),
        kv: z.enum(KV_PRECISIONS.map((k) => k.id) as [string, ...string[]]).default("F16").describe("KV cache precision."),
        min_quality: z
          .enum(QUANTIZATIONS.map((q) => q.id) as [string, ...string[]])
          .default("Q3_K_M")
          .describe("Lowest quantization you accept. Below Q4 the quality drops noticeably."),
      },
      annotations: RO,
    },
    async ({ vram_gb, context, kv, min_quality }) => {
      const k = findKv(kv);
      const floor = findQuant(min_quality);
      if (!k || !floor) return fail("Unknown kv or min_quality.");
      const quants = QUANTIZATIONS.filter((q) => q.bits >= floor.bits); // já vem do maior para o menor
      const fits: unknown[] = [];
      const doesNotFit: unknown[] = [];
      for (const m of [...LOCAL_MODELS].sort((a, b) => b.paramsB - a.paramsB)) {
        const ctx = Math.min(context, m.maxContext);
        const best = quants
          .map((q) => ({ q, est: estimateLocal({ model: m, quant: q, kv: k, context: ctx, vramGib: vram_gb }) }))
          .find((x) => x.est.gpu?.fits);
        if (best)
          fits.push({
            id: m.id,
            name: m.name,
            params_b: m.paramsB,
            best_quant: best.q.id,
            total_gb: gb(best.est.totalGib),
            context: ctx,
            ...(ctx < context && { note: `Native max context is ${m.maxContext}.` }),
          });
        else {
          const smallest = quants.at(-1) as (typeof quants)[number];
          const est = estimateLocal({ model: m, quant: smallest, kv: k, context: ctx });
          doesNotFit.push({ id: m.id, name: m.name, needs_gb_at_lowest_quant: gb(est.totalGib), lowest_quant: smallest.id });
        }
      }
      return ok({
        vram_gb,
        context,
        kv_cache_precision: k.id,
        fits,
        does_not_fit: doesNotFit,
        recommendation: fits[0] ? `Largest model that fits: ${(fits[0] as { name: string }).name}.` : "No known model fits; try less context, KV Q8_0/Q4_0, or more VRAM.",
      });
    },
  );

  // 7 ─ RAG vs arquivo inteiro
  server.registerTool(
    "neurix_rag_cost",
    {
      title: "RAG vs whole document cost",
      description:
        "Simulates using a document as a knowledge base with RAG (split into chunks, embed once, send only the top-K relevant chunks per " +
        "question) versus sending the whole document on every question. Returns chunks, indexing cost, cost per question and per month for " +
        "both, and whether the whole document even fits the context window. Pass `text` (the document) or `doc_tokens`.",
      inputSchema: {
        model: z.string().describe("API model that answers the questions."),
        text: z.string().optional().describe("The document text."),
        doc_tokens: z.number().int().positive().optional().describe("Document size in tokens, instead of `text`."),
        chunk_size: z.number().int().positive().default(512).describe("Tokens per chunk. Default 512."),
        overlap_pct: z.number().min(0).max(50).default(10).describe("Overlap between chunks, % of chunk_size. Default 10."),
        top_k: z.number().int().positive().default(5).describe("Chunks retrieved per question. Default 5."),
        queries_per_month: z.number().int().positive().default(1000).describe("Questions per month. Default 1000."),
        embed_price_per_1m: z.number().nonnegative().default(0.02).describe("Embedding model price in USD per 1M tokens. Default 0.02."),
        system_tokens: z.number().int().nonnegative().default(200).describe("System prompt tokens per call."),
        question_tokens: z.number().int().nonnegative().default(50).describe("Question tokens per call."),
        output_tokens: outputTokensArg,
        ...fxArgs,
      },
      annotations: { ...RO, openWorldHint: true },
    },
    async (a) => {
      const m = apiModel(a.model);
      if (!m) return unknownModel(a.model);
      if (a.text === undefined && a.doc_tokens === undefined) return fail("Pass `text` or `doc_tokens`.");
      const doc = await inputTokensFor(m, a.text, a.doc_tokens);
      const input = {
        docTokens: doc.tokens,
        chunkSize: a.chunk_size,
        overlap: Math.round((a.chunk_size * a.overlap_pct) / 100),
        topK: a.top_k,
        questionTokens: a.question_tokens,
        systemTokens: a.system_tokens,
        outputTokens: a.output_tokens,
        queriesPerMonth: a.queries_per_month,
        embedPricePer1M: a.embed_price_per_1m,
      };
      const r = simulateRag(m, input);
      const rate = await rateFor(a.usd_brl);
      const ragMonth = r.ragMonthUsd + r.indexUsd;
      return ok({
        model: m.id,
        doc_tokens: doc.tokens,
        counting: doc.counting,
        chunks: r.chunks,
        indexing: { tokens_embedded: r.indexedTokens, cost_once: money(r.indexUsd, rate, a.iof_pct) },
        rag: {
          input_tokens_per_question: r.rag.inputTokens,
          per_question: money(r.ragPerQueryUsd, rate, a.iof_pct),
          per_month_including_indexing: money(ragMonth, rate, a.iof_pct),
          fits_context: r.rag.fitsContext,
        },
        whole_document: {
          input_tokens_per_question: r.full.inputTokens,
          per_question: money(r.fullPerQueryUsd, rate, a.iof_pct),
          per_month: money(r.fullMonthUsd, rate, a.iof_pct),
          fits_context: r.full.fitsContext,
        },
        cheaper: ragMonth < r.fullMonthUsd ? "rag" : "whole_document",
        savings_pct: r.fullMonthUsd > 0 ? Math.floor((1 - ragMonth / r.fullMonthUsd) * 100) : 0,
        tradeoff: "RAG is cheaper on big documents but the model only sees the retrieved chunks; if retrieval misses, the answer misses.",
      });
    },
  );

  // 8 ─ Contar um arquivo do disco
  server.registerTool(
    "neurix_count_file",
    {
      title: "Count tokens and cost of a file",
      description:
        "Reads a text file from the local disk (up to 20 MB, binary files rejected) and returns its characters, tokens with the model's " +
        "tokenizer and the cost of sending it as input. Useful to check if a file fits a model's context before attaching it.",
      inputSchema: {
        path: z.string().describe("Path to the file (absolute, or relative to the server's working directory)."),
        model: z.string().default("gpt-6.1-sol").describe("API or local model id used to count (and price, for API models)."),
        output_tokens: outputTokensArg,
        ...fxArgs,
      },
      annotations: RO,
    },
    async ({ path, model, output_tokens, usd_brl, iof_pct }) => {
      const full = resolve(path);
      const s = await stat(full).catch(() => null);
      if (!s?.isFile()) return fail(`File not found: ${full}`);
      if (s.size > MAX_FILE_BYTES) return fail(`File too large (${Math.round(s.size / 1024 / 1024)} MB; max 20 MB).`);
      const buf = await readFile(full);
      if (buf.subarray(0, 8000).includes(0)) return fail("Binary file; only text files are supported.");
      const content = buf.toString("utf8");
      const api = apiModel(model);
      if (api) {
        const counter = await counterFor(api);
        const c = computeCost(api, counter.count(content), output_tokens);
        const rate = await rateFor(usd_brl);
        return ok({
          file: basename(full),
          bytes: s.size,
          characters: content.length,
          model: api.id,
          tokens: c.inputTokens,
          counting: countInfo(counter),
          cost_as_input: money(c.totalUsd, rate, iof_pct),
          context: { window: api.contextWindow, fits: c.fitsContext },
        });
      }
      const local = findLocalModel(model);
      if (!local) return unknownModel(model);
      const counter = await localCounter(local);
      const tokens = counter.count(content);
      return ok({
        file: basename(full),
        bytes: s.size,
        characters: content.length,
        model: local.id,
        tokens,
        counting: countInfo(counter),
        context: { max: local.maxContext, fits: tokens + output_tokens <= local.maxContext },
      });
    },
  );

  // 9 ─ Listar modelos
  server.registerTool(
    "neurix_list_models",
    {
      title: "List models",
      description:
        "Lists the models Neurix knows: API models with price per 1M tokens (USD), context window, max output and whether token counts are " +
        "exact or estimated; and local models with parameters, layers, KV heads, max context and the Hugging Face tokenizer repo. " +
        "Call it to discover valid ids for the other tools.",
      inputSchema: {
        kind: z.enum(["api", "local", "all"]).default("all").describe("Which list to return."),
        include_all: z.boolean().default(true).describe("API: include non-featured and legacy models."),
        provider: z.enum(["anthropic", "openai", "google", "deepseek", "qwen"]).optional().describe("API: only this provider."),
      },
      annotations: RO,
    },
    async ({ kind, include_all, provider }) => {
      const api = visibleModels(dataset, include_all).filter((m) => !provider || m.provider === provider);
      return ok({
        prices_generated_at: dataset.generatedAt,
        ...(kind !== "local" && { api_models: api.map(modelSummary) }),
        ...(kind !== "api" && {
          local_models: LOCAL_MODELS.map((m) => ({
            id: m.id,
            name: m.name,
            params_b: m.paramsB,
            layers: m.layers,
            kv_heads: m.kvHeads,
            head_dim: m.headDim,
            max_context: m.maxContext,
            tokenizer: m.hfRepo ?? null,
          })),
          quantizations: QUANTIZATIONS.map((q) => ({ id: q.id, bits_per_weight: q.bits })),
          kv_precisions: KV_PRECISIONS.map((k) => ({ id: k.id, bytes_per_element: k.bytes })),
        }),
      });
    },
  );

  // 10 ─ Câmbio
  server.registerTool(
    "neurix_exchange_rate",
    {
      title: "USD to BRL exchange rate",
      description:
        "Returns the current US dollar → Brazilian real rate used to convert prices (AwesomeAPI, with Central Bank PTAX and Frankfurter as " +
        "fallbacks; cached for 1 hour). Optionally converts an amount and adds IOF tax.",
      inputSchema: {
        amount_usd: z.number().nonnegative().optional().describe("Optional amount in USD to convert."),
        iof_pct: z.number().nonnegative().default(0).describe("IOF tax in %, e.g. 3.5."),
        refresh: z.boolean().default(false).describe("Ignore the 1h cache and fetch now."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ amount_usd, iof_pct, refresh }) => {
      try {
        const rate = await getUsdBrl({ refresh });
        rateCache = rate;
        return ok({
          usd_brl: rate.usdBrl,
          source: rate.source,
          quoted_at: rate.quotedAt,
          ...(rate.stale && { stale: true }),
          ...(amount_usd !== undefined && { amount_usd, amount_brl: round(toBrl(amount_usd, rate, iof_pct), 6), iof_pct }),
        });
      } catch (err) {
        return fail(`Could not get the exchange rate: ${(err as Error).message}`);
      }
    },
  );

  // 11 ─ Glossário
  server.registerTool(
    "neurix_explain_term",
    {
      title: "Explain an LLM term",
      description:
        "Explains in plain language, grouped by category, the terms used by Neurix: token, tokenizer, exact vs estimate, context window, prompt caching, batch, RAG, chunk, embedding, " +
        "quantization, GGUF, KV cache, VRAM, offload, tokens/s, TDP, kWh, MCP and more. Without `term` returns the whole glossary. Answers in Portuguese or English.",
      inputSchema: {
        term: z.string().optional().describe("Term to explain (partial match, case-insensitive). Omit for the full glossary."),
        lang: z.enum(["pt", "en"]).optional().describe("Language. Default: the user's saved Neurix language (pt)."),
      },
      annotations: RO,
    },
    async ({ term, lang }) => {
      const cats = (lang ? dictFor(lang) : t()).glossaryCats;
      const q = term?.toLowerCase();
      const items = cats.flatMap((c) =>
        c.terms.filter(([name, text]) => !q || name.toLowerCase().includes(q) || text.toLowerCase().includes(q)).map(([name, text]) => ({ term: name, category: c.title, explanation: text })),
      );
      if (!items.length) return fail(`Term not found: ${term}`, { terms: cats.flatMap((c) => c.terms.map(([n]) => n)) });
      return ok({ terms: items });
    },
  );

  // 12 ─ Otimizador de prompt
  server.registerTool(
    "neurix_optimize_prompt",
    {
      title: "Optimize a prompt (find wasted tokens)",
      description:
        "Finds tokens wasted without adding meaning and removes them: invisible characters, indented JSON (minified), trailing spaces, " +
        "indentation outside code blocks, repeated spaces and extra blank lines. Repeated lines are only pointed out (removing them changes " +
        "the meaning). Returns each issue with occurrences, tokens saved and example lines from the ORIGINAL text, the total savings in " +
        "tokens and money, and the optimized text. Code blocks (```) and nested list indentation are preserved.",
      inputSchema: {
        text: z.string().optional().describe("The prompt to optimize."),
        path: z.string().optional().describe("Or a text file to read the prompt from."),
        model: z.string().default("gpt-6.1-sol").describe("API model whose tokenizer measures the savings and whose price values them."),
        include_optimized: z.boolean().default(true).describe("Return the optimized text."),
        ...fxArgs,
      },
      annotations: RO,
    },
    async ({ text, path, model, include_optimized, usd_brl, iof_pct }) => {
      const m = apiModel(model);
      if (!m) return unknownModel(model);
      const src = await textOrFile(text, path);
      if (typeof src !== "string") return src;
      const counter = await counterFor(m);
      const r = optimizePrompt(src, counter.count);
      const saved = r.originalTokens - r.optimizedTokens;
      const usd = computeCost(m, saved, 0).inputUsd;
      const rate = await rateFor(usd_brl);
      const K = dictFor("en").tools;
      return ok({
        model: m.id,
        counting: countInfo(counter),
        original_tokens: r.originalTokens,
        optimized_tokens: r.optimizedTokens,
        tokens_saved: saved,
        saved_pct: r.originalTokens ? round((saved / r.originalTokens) * 100, 1) : 0,
        savings: { per_call: money(usd, rate, iof_pct), per_1000_calls: money(usd * 1000, rate, iof_pct) },
        issues: r.issues.map((i) => ({
          kind: i.kind,
          name: K.kinds[i.kind],
          why: K.kindWhy[i.kind],
          occurrences: i.occurrences,
          tokens_saved: i.tokensSaved,
          applied: i.applied,
          examples: i.examples.map((e) => ({ line: e.line, ...(e.end && { end_line: e.end }), text: i.kind === "blankLines" ? `${e.text} blank lines` : revealWhitespace(e.text) })),
        })),
        legend: "In examples: · = space, → = tab, ¤ = invisible character.",
        ...(include_optimized && { optimized_text: r.optimized }),
      });
    },
  );

  // 13 ─ Análise de pasta / repositório
  server.registerTool(
    "neurix_analyze_folder",
    {
      title: "Count tokens per file in a folder or repository",
      description:
        "Walks a folder (e.g. a git repository) and counts the tokens of every text file with the model's tokenizer. Skips node_modules, " +
        ".git, build folders, binaries, lockfiles, files over 2 MB and whatever matches the root .gitignore. Returns totals, the largest " +
        "files, totals per extension and per top-level folder, and whether everything fits each model's context window and what it would " +
        "cost as input. Use it before stuffing a codebase into a prompt.",
      inputSchema: {
        path: z.string().describe("Folder to analyse (absolute, or relative to the server's working directory)."),
        model: z.string().default("gpt-6.1-sol").describe("API model whose tokenizer counts the files."),
        top: z.number().int().positive().max(500).default(20).describe("How many of the largest files to list."),
        extensions: z.array(z.string()).optional().describe("Only these extensions, e.g. [\"ts\", \"md\"]."),
        include_hidden: z.boolean().default(false).describe("Include hidden files and folders (.something)."),
        ...fxArgs,
      },
      annotations: RO,
    },
    async ({ path, model, top, extensions, include_hidden, usd_brl, iof_pct }) => {
      const m = apiModel(model);
      if (!m) return unknownModel(model);
      const root = resolve(path);
      const s = await stat(root).catch(() => null);
      if (!s?.isDirectory()) return fail(`Folder not found: ${root}`);
      const counter = await counterFor(m);
      const res = await analyzeFolder(root, counter.count, { includeHidden: include_hidden, ...(extensions && { extensions }) });
      const rate = await rateFor(usd_brl);
      const share = (n: number): number => (res.totalTokens ? round((n / res.totalTokens) * 100, 1) : 0);
      return ok({
        root: res.root,
        model: m.id,
        counting: countInfo(counter),
        files: res.files.length,
        total_tokens: res.totalTokens,
        total_bytes: res.totalBytes,
        skipped: res.skipped,
        used_gitignore: res.usedGitignore,
        largest_files: res.files.slice(0, top).map((f) => ({ path: f.path, tokens: f.tokens, pct: share(f.tokens), bytes: f.bytes })),
        by_extension: res.byExt.map((e) => ({ ...e, pct: share(e.tokens) })),
        by_folder: byTopDir(res.files).map((d) => ({ ...d, pct: share(d.tokens) })),
        send_everything: visibleModels(dataset, false).map((x) => {
          const c = computeCost(x, res.totalTokens, 0);
          return { model: x.id, context_window: x.contextWindow, fits: c.fitsContext, input_cost: money(c.inputUsd, rate, iof_pct) };
        }),
        note: "send_everything uses the token total counted with the chosen model's tokenizer for every model (approximation for the others).",
      });
    },
  );

  // 14 ─ Chunking para RAG
  server.registerTool(
    "neurix_chunk_document",
    {
      title: "Chunk a document for RAG (with overlap)",
      description:
        "Splits a document into RAG chunks of `chunk_size` tokens with `overlap_pct` overlap, cutting by real tokens when the tokenizer is " +
        "available (OpenAI) and by characters otherwise (Claude/Gemini: ~3.5 chars per token). For each chunk returns its token range, size, " +
        "the overlap with the previous chunk, a preview (or the full text) and whether it ends in the middle of a sentence. Also returns " +
        "totals (chunks, tokens indexed including repeated overlap) and advice. Use it to tune chunk size/overlap before indexing.",
      inputSchema: {
        text: z.string().optional().describe("The document."),
        path: z.string().optional().describe("Or a text file to read."),
        model: z.string().default("gpt-6.1-sol").describe("API model whose tokenizer cuts the chunks."),
        chunk_size: z.number().int().positive().default(512).describe("Tokens per chunk."),
        overlap_pct: z.number().min(0).max(50).default(10).describe("Overlap between chunks, % of chunk_size."),
        include_text: z.boolean().default(false).describe("Return the full text of each chunk (can be large) instead of a preview."),
        max_chunks: z.number().int().positive().default(50).describe("Return at most this many chunks in the list (totals always cover all)."),
      },
      annotations: RO,
    },
    async ({ text, path, model, chunk_size, overlap_pct, include_text, max_chunks }) => {
      const m = apiModel(model);
      if (!m) return unknownModel(model);
      const src = await textOrFile(text, path);
      if (typeof src !== "string") return src;
      const counter = await counterFor(m);
      const plan = chunkDocument(src, chunk_size, Math.round((chunk_size * overlap_pct) / 100), counter);
      const preview = (s: string): string => {
        const one = s.replace(/\s+/g, " ").trim();
        return one.length > 160 ? `${one.slice(0, 77)} … ${one.slice(-77)}` : one;
      };
      const advice: string[] = [];
      if (plan.cutsSentence > 0) advice.push(`${plan.cutsSentence} of ${plan.chunks.length} chunks end mid-sentence: raise the overlap (10–20%) or use a paragraph-aware splitter.`);
      if (plan.overlap === 0 && plan.chunks.length > 1) advice.push("No overlap: an idea cut in half is split across two chunks and retrieval may find only half.");
      return ok({
        model: m.id,
        cut_by: plan.byTokens ? `exact tokens (${counter.source})` : "characters (~3.5 per token; this tokenizer is not public)",
        doc_tokens: plan.docTokens,
        chunk_size: plan.chunkSize,
        overlap_tokens: plan.overlap,
        chunks: plan.chunks.length,
        tokens_indexed: plan.indexedTokens,
        overlap_overhead_pct: plan.docTokens ? round(((plan.indexedTokens - plan.docTokens) / plan.docTokens) * 100, 1) : 0,
        chunks_cutting_sentences: plan.cutsSentence,
        list: plan.chunks.slice(0, max_chunks).map((c) => ({
          index: c.index,
          start_token: c.start,
          end_token: c.end,
          tokens: c.tokens,
          overlap_with_previous: include_text ? c.overlapText : preview(c.overlapText).slice(-80),
          ...(include_text ? { text: c.overlapText + c.newText } : { preview: preview(c.overlapText + c.newText) }),
          ends_mid_sentence: c.cutsSentence,
        })),
        ...(plan.chunks.length > max_chunks && { truncated: `${plan.chunks.length - max_chunks} more chunks not listed` }),
        advice,
      });
    },
  );

  // 15 ─ Recomendador de modelo
  server.registerTool(
    "neurix_recommend_model",
    {
      title: "Recommend the cheapest model for a prompt",
      description:
        "Given a prompt, recommends the cheapest API model RIGHT NOW (today's prices, long-context tiers, scheduled price changes) that " +
        "fits the context window and meets a minimum quality level. With quality='auto' the level is suggested from the prompt itself " +
        "(code, reasoning or math requests, prompt/answer size, simple tasks like translate/summarize). Returns the recommendation, " +
        "alternatives, the cheapest model of each level (budget, mid-range, flagship) and how much more each level costs.",
      inputSchema: {
        prompt: z.string().optional().describe("The prompt to send."),
        input_tokens: z.number().int().nonnegative().optional().describe("Or just its size in tokens (no quality auto-detection signals from text)."),
        output_tokens: outputTokensArg,
        quality: z.enum(["auto", "cheap", "mid", "flagship"]).default("auto").describe("Minimum quality: auto (from the prompt), cheap, mid or flagship."),
        providers: z.array(z.enum(["anthropic", "openai", "google", "deepseek", "qwen"])).optional().describe("Only these providers."),
        include_all: z.boolean().default(false).describe("Include non-featured and legacy models."),
        ...fxArgs,
      },
      annotations: RO,
    },
    async ({ prompt, input_tokens, output_tokens, quality, providers, include_all, usd_brl, iof_pct }) => {
      if (prompt === undefined && input_tokens === undefined) return fail("Pass `prompt` or `input_tokens`.");
      let models = visibleModels(dataset, include_all);
      if (providers?.length) models = models.filter((m) => providers.includes(m.provider as (typeof providers)[number]));
      if (!models.length) return fail("No model matches the filter.");
      const counters = await countersFor(models);
      const ref = await counterFor({ tokenizer: "o200k" });
      const refTokens = prompt !== undefined ? ref.count(prompt) : (input_tokens ?? 0);
      const sug = suggestQuality(prompt ?? "", refTokens, output_tokens);
      const level = quality === "auto" ? sug.quality : quality;
      const rec = recommendModel(prompt ?? null, input_tokens ?? null, output_tokens, models, counters, level);
      const rate = await rateFor(usd_brl);
      const entry = (c: NonNullable<typeof rec.best>) => ({
        id: c.model.id,
        name: c.model.name,
        tier: c.model.tier,
        input_tokens: c.cost.inputTokens,
        tokens_exact: c.exact,
        per_call: money(c.cost.totalUsd, rate, iof_pct),
        x_recommended: rec.best ? round(c.cost.totalUsd / Math.max(rec.best.cost.totalUsd, 1e-12), 2) : null,
      });
      return ok({
        quality_level: level,
        quality_source: quality === "auto" ? "suggested from the prompt" : "given",
        signals: sug.signals,
        recommended: rec.best ? entry(rec.best) : null,
        alternatives: rec.alternatives.map(entry),
        cheapest_per_level: Object.fromEntries(Object.entries(rec.perTier).map(([k, c]) => [k, c ? entry(c) : null])),
        too_small_context: rec.tooSmall.map((m) => m.id),
        ...(!rec.best && { message: "No model at this level fits the prompt. Try a lower level or RAG." }),
        note: "Claude and Gemini token counts are estimates (tokenizers not public); OpenAI counts are exact. Quality levels come from Neurix's model catalog tiers.",
      });
    },
  );

  // 16 ─ Neurix Budget
  server.registerTool(
    "neurix_budget",
    {
      title: "Neurix Budget: monthly cap, projection, caching and batch",
      description:
        "Plans AI spending under a MONTHLY CAP (USD or BRL). Describe the usage — requests per day, active days per month, input tokens " +
        "per request (or a sample text), how much of the input is fixed and can be prompt-cached, cache hit rate, output tokens and the " +
        "share that can wait up to 24 h for a batch API — and get, per model: cost per request in 4 strategies (normal, +cache, +batch, " +
        "cache+batch), cost per day/month/year with your usage, % of the cap, the day of the month the cap runs out, the days it crosses " +
        "50/80/100%, and how many requests fit in the cap. With `spent_so_far` it also projects the month from the current spending pace " +
        "and says how much can still be spent per day. Batch discounts per provider: OpenAI, Anthropic and Google 50% (24 h); DeepSeek and " +
        "Qwen have no discounted batch API.",
      inputSchema: {
        cap: z.number().positive().describe("Monthly cap (in `currency`)."),
        currency: z.enum(["brl", "usd"]).default("brl").describe("Currency of `cap` and `spent_so_far`."),
        requests_per_day: z.number().nonnegative().optional().describe("Requests per active day. Omit to only see how many requests fit."),
        active_days: z.number().int().min(1).max(31).default(30).describe("Days of use per month (30 = every day, 22 = weekdays)."),
        text: z.string().optional().describe("A typical request input (counted with each model's tokenizer)."),
        input_tokens: z.number().int().nonnegative().default(2000).describe("Input tokens per request (if no `text`)."),
        cached_tokens: z.number().int().nonnegative().optional().describe("Fixed tokens per request that can be prompt-cached."),
        cached_pct: z.number().min(0).max(100).optional().describe("Or the fixed part as % of the input."),
        cache_hit_pct: z.number().min(0).max(100).default(90).describe("% of requests that hit the cache (the rest write it)."),
        output_tokens: outputTokensArg,
        batch_pct: z.number().min(0).max(100).default(0).describe("% of requests that can go through a batch API (answers within 24 h)."),
        spent_so_far: z.number().nonnegative().optional().describe("Amount already spent this month (in `currency`), to project the pace."),
        include_all: z.boolean().default(false).describe("Include non-featured and legacy models."),
        ...fxArgs,
      },
      annotations: { ...RO, openWorldHint: true },
    },
    async (a) => {
      const rate = await rateFor(a.usd_brl);
      if (a.currency === "brl" && !rate) return fail("No USD→BRL rate available; pass usd_brl or use currency 'usd'.");
      const toUsd = (v: number): number => (a.currency === "brl" && rate ? v / toBrl(1, rate, a.iof_pct) : v);
      const inCur = (usd: number): number => round(a.currency === "brl" && rate ? toBrl(usd, rate, a.iof_pct) : usd, 4);
      const capUsd = toUsd(a.cap);

      const models = visibleModels(dataset, a.include_all);
      const counters = await countersFor(models);
      const ref = await counterFor({ tokenizer: "o200k" });
      const inputTokens = a.text !== undefined ? ref.count(a.text) : a.input_tokens;
      const fixed = Math.round(a.cached_tokens ?? (a.cached_pct !== undefined ? (inputTokens * a.cached_pct) / 100 : 0));
      const profile: UsageProfile = {
        inputTokens,
        cachedTokens: Math.min(fixed, inputTokens),
        outputTokens: a.output_tokens,
        cacheHitPct: a.cache_hit_pct,
        batchPct: a.batch_pct,
        activeDays: a.active_days,
        ...(a.requests_per_day !== undefined && a.requests_per_day > 0 && { requestsPerDay: a.requests_per_day }),
      };
      const rows = planBudget(models, (m) => (a.text !== undefined ? (counters.get(m.id) as Counter).count(a.text) : inputTokens), profile, capUsd);
      const burn = a.spent_so_far !== undefined ? burnRate(toUsd(a.spent_so_far), capUsd) : null;
      const fin = (n: number): number | null => (Number.isFinite(n) ? n : null);

      return ok({
        cap: { amount: a.cap, currency: a.currency, usd: round(capUsd, 4) },
        profile: {
          input_tokens: profile.inputTokens,
          cached_tokens: profile.cachedTokens,
          cache_hit_pct: profile.cacheHitPct,
          output_tokens: profile.outputTokens,
          batch_pct: profile.batchPct,
          requests_per_day: profile.requestsPerDay ?? null,
          active_days: profile.activeDays,
        },
        ...(burn && {
          spending_pace: {
            spent_so_far: a.spent_so_far,
            daily_average: inCur(burn.dailyAvg),
            projected_month: inCur(burn.projectedMonth),
            projected_pct_of_cap: round(burn.capPct, 1),
            cap_runs_out_on_day: burn.capDay,
            remaining: inCur(burn.remaining),
            safe_daily_spend_left: inCur(burn.safeDailyLeft),
          },
        }),
        models: rows.map((r) => ({
          id: r.model.id,
          name: r.model.name,
          provider: r.model.provider,
          tier: r.model.tier,
          fits_context: r.fitsContext,
          per_request_usd: {
            normal: r.perRequest.normal,
            cache: r.perRequest.cache,
            batch: r.perRequest.batch,
            cache_batch: r.perRequest.cacheBatch,
            your_usage: round(r.optimized, 8),
          },
          uses_cache: r.usesCache,
          uses_batch: r.usesBatch,
          max_requests_per_month: { normal: fin(r.maxPerMonth.normal), your_usage: fin(r.maxPerMonth.optimized) },
          max_requests_per_active_day: fin(r.maxPerDay.optimized),
          ...(r.projection && {
            projection: {
              currency: a.currency,
              day: inCur(r.projection.day),
              month: inCur(r.projection.month),
              year: inCur(r.projection.year),
              month_without_cache_or_batch: inCur(r.projection.monthNormal),
              pct_of_cap: round(r.projection.capPct, 1),
              cap_runs_out_on_day: r.projection.capDay,
              crosses_pct_on_day: r.projection.thresholds,
            },
          }),
        })),
        batch_by_provider: BATCH,
        notes: [
          "per_request_usd values of null mean the provider has no prompt caching or no discounted batch API.",
          "Cache: fixed part billed at cache read price on hits, cache write price on misses. Batch: provider discount on all tokens (answers within 24 h).",
          "Batch discounts come from each provider's documentation and may change.",
        ],
      });
    },
  );

  // 16b ─ Alerta de custo
  server.registerTool(
    "neurix_check_cost",
    {
      title: "Cost alert: is this over the limit?",
      description:
        "Checks whether sending a text, file or whole folder to a model stays under a cost and/or token limit — the same check as the " +
        "`neurix check` CLI used in CI. Returns tokens, cost (times `calls`), whether it fits the context window and ok=false with the " +
        "reasons when any limit is exceeded. Use it before an expensive call or to guard a pipeline.",
      inputSchema: {
        text: z.string().optional().describe("The content to check."),
        path: z.string().optional().describe("Or a file or folder (folders sum all text files, respecting .gitignore)."),
        model: z.string().default("gpt-6.1-sol").describe("API model used to count and price."),
        max_usd: z.number().positive().optional().describe("Maximum cost in USD."),
        max_brl: z.number().positive().optional().describe("Maximum cost in BRL."),
        max_tokens: z.number().int().positive().optional().describe("Maximum input tokens."),
        calls: z.number().int().positive().default(1).describe("Multiply the cost by this many calls."),
        output_tokens: z.number().int().nonnegative().default(0).describe("Answer tokens per call."),
        ...fxArgs,
      },
      annotations: RO,
    },
    async (a) => {
      const m = apiModel(a.model);
      if (!m) return unknownModel(a.model);
      const counter = await counterFor(m);
      let tokens: number;
      if (a.text !== undefined) tokens = counter.count(a.text);
      else if (a.path) {
        const full = resolve(a.path);
        const s = await stat(full).catch(() => null);
        if (!s) return fail(`Not found: ${full}`);
        if (s.isDirectory()) tokens = (await analyzeFolder(full, counter.count)).totalTokens;
        else {
          const src = await textOrFile(undefined, full);
          if (typeof src !== "string") return src;
          tokens = counter.count(src);
        }
      } else return fail("Pass `text` or `path`.");

      const rate = await rateFor(a.usd_brl);
      if (a.max_brl !== undefined && !rate) return fail("No USD→BRL rate to convert max_brl; pass usd_brl or use max_usd.");
      const limits = [a.max_usd, a.max_brl !== undefined && rate ? a.max_brl / toBrl(1, rate, a.iof_pct) : undefined].filter((x): x is number => x !== undefined);
      const maxUsd = limits.length ? Math.min(...limits) : undefined;
      const r = checkLimits(m, tokens, a.output_tokens, a.calls, {
        ...(maxUsd !== undefined && { maxUsd }),
        ...(a.max_tokens !== undefined && { maxTokens: a.max_tokens }),
      });
      const reasons: string[] = [];
      if (r.overCost && maxUsd !== undefined) reasons.push(`cost US$ ${round(r.costUsd, 6)} is over the maximum US$ ${round(maxUsd, 6)}`);
      if (r.overTokens) reasons.push(`${tokens} tokens are over the maximum ${a.max_tokens}`);
      if (r.overContext) reasons.push(`${tokens} tokens don't fit the ${m.contextWindow}-token context window`);
      return ok({
        model: m.id,
        tokens,
        counting: countInfo(counter),
        calls: a.calls,
        cost: money(r.costUsd, rate, a.iof_pct),
        limits: { max_usd: maxUsd ?? null, max_tokens: a.max_tokens ?? null },
        fits_context: r.fitsContext,
        ok: r.ok,
        ...(reasons.length && { reasons }),
        ...(maxUsd === undefined && a.max_tokens === undefined && { note: "No limit given: only the context window was checked." }),
      });
    },
  );

  // 17 ─ Cache de prompt
  server.registerTool(
    "neurix_prompt_cache_savings",
    {
      title: "Prompt caching savings",
      description:
        "When the same fixed part of the prompt (system instructions, a document, few-shot examples) is repeated across many calls, " +
        "providers bill cached tokens at a much lower price. Given the fixed part, the variable part, the answer size and the number of " +
        "calls, returns the total cost with and without caching for each model and the savings. Assumes the cache stays warm between calls " +
        "(5 min to 1 h without use, depending on the provider); the first call writes the cache.",
      inputSchema: {
        fixed_text: z.string().optional().describe("The fixed part repeated in every call."),
        fixed_tokens: z.number().int().nonnegative().optional().describe("Or its size in tokens."),
        variable_tokens: z.number().int().nonnegative().default(100).describe("Tokens that change on every call (the question)."),
        output_tokens: outputTokensArg,
        calls: z.number().int().positive().default(100).describe("Number of calls."),
        model: z.string().optional().describe("Only this model (default: all featured models)."),
        ...fxArgs,
      },
      annotations: { ...RO, openWorldHint: true },
    },
    async ({ fixed_text, fixed_tokens, variable_tokens, output_tokens, calls, model, usd_brl, iof_pct }) => {
      if (fixed_text === undefined && fixed_tokens === undefined) return fail("Pass `fixed_text` or `fixed_tokens`.");
      let models = visibleModels(dataset, false);
      if (model) {
        const m = apiModel(model);
        if (!m) return unknownModel(model);
        models = [m];
      }
      const counters = await countersFor(models);
      const rate = await rateFor(usd_brl);
      const rows = models
        .map((m) => {
          const fixed = fixed_text !== undefined ? (counters.get(m.id) as Counter).count(fixed_text) : (fixed_tokens ?? 0);
          return { fixed, r: promptCacheSavings(m, { fixedTokens: fixed, variableTokens: variable_tokens, outputTokens: output_tokens, calls }) };
        })
        .sort((a, b) => a.r.withCacheUsd - b.r.withCacheUsd);
      return ok({
        calls,
        variable_tokens,
        output_tokens,
        models: rows.map(({ fixed, r }) => ({
          id: r.model.id,
          name: r.model.name,
          fixed_tokens: fixed,
          caching_supported: r.supported,
          cache_prices_per_1m_usd: r.supported ? { read: r.cachedInput, write: r.cacheWrite } : null,
          without_cache: money(r.withoutCacheUsd, rate, iof_pct),
          with_cache: money(r.withCacheUsd, rate, iof_pct),
          saved: money(r.savedUsd, rate, iof_pct),
          saved_pct: round(r.savedPct, 1),
        })),
      });
    },
  );

  // 19 ─ Detectar hardware
  server.registerTool(
    "neurix_detect_hardware",
    {
      title: "Detect GPU, VRAM, power and RAM",
      description:
        "Detects the machine's hardware with no input: GPUs with VRAM (NVIDIA via nvidia-smi with free VRAM, live power draw and power " +
        "limit; AMD/Intel via the Windows registry or Linux sysfs; Apple Silicon unified memory), RAM, CPU, memory bandwidth and TDP from a " +
        "GPU table, and the biggest built-in model that runs well (≥8 tok/s) at Q4 or better with 8k context. Use it before recommending a " +
        "local model.",
      inputSchema: {},
      annotations: RO,
    },
    async () => {
      const hw = await detectHardware(true);
      const kv = findKv("F16") as KvPrecision;
      let biggest: Record<string, unknown> | null = null;
      outer: for (const m of [...LOCAL_MODELS].sort((a, b) => b.paramsB - a.paramsB))
        for (const q of QUANTIZATIONS.filter((x) => x.bits >= 4.9)) {
          const s = estimateSpeed(m, q, kv, Math.min(8192, m.maxContext), { ramGib: hw.ramGib, ramBandwidthGBs: hw.ramBandwidthGBs, gpu: hw.best });
          if (s.verdict === "great" || s.verdict === "good") {
            biggest = { model: m.id, quant: q.id, runs_on: s.placement, generation_tokens_per_s: round(s.decodeTps, 1) };
            break outer;
          }
        }
      return ok({
        platform: `${hw.platform} ${hw.arch}`,
        cpu: hw.cpu,
        ram_gb: gb(hw.ramGib),
        free_ram_gb: gb(hw.freeRamGib),
        gpus: hw.gpus.map((g) => ({
          name: g.name,
          vendor: g.vendor,
          vram_gb: gb(g.vramGib),
          free_gb: g.freeGib !== undefined ? gb(g.freeGib) : null,
          integrated: g.integrated,
          power_now_w: g.powerDrawW ?? null,
          power_limit_w: g.powerLimitW ?? null,
          tdp_w_table: g.tdpW ?? null,
          bandwidth_gbs_table: g.bandwidthGBs ?? null,
          source: g.source,
        })),
        best_gpu_for_llm: hw.best?.name ?? null,
        inference_power_w: inferencePowerW(hw.best),
        biggest_model_that_runs_well: biggest,
        note: hw.best ? "Bandwidth/TDP are approximate (table by GPU name)." : "No dedicated GPU: models run on CPU/RAM (much slower).",
      });
    },
  );

  // 20 ─ Modelos instalados
  server.registerTool(
    "neurix_installed_models",
    {
      title: "Installed local models and which run well",
      description:
        "Finds the models installed on this machine by reading GGUF files directly (Ollama — even when it isn't running —, LM Studio, and " +
        "extra folders) and reads their real architecture from the GGUF header (layers, KV heads, head dim, native context, exact parameter " +
        "count, real quantization and file size). For each one, estimates where it runs on the detected hardware (whole GPU, GPU+CPU, CPU, " +
        "doesn't fit), generation speed in tokens/s and a verdict.",
      inputSchema: {
        extra_dirs: z.array(z.string()).optional().describe("Other folders with .gguf files."),
        context: z.number().int().positive().default(8192).describe("Context tokens for the speed/memory estimate."),
      },
      annotations: RO,
    },
    async ({ extra_dirs, context }) => {
      const [hw, scan] = await Promise.all([detectHardware(), findInstalledModels(extra_dirs ?? [])]);
      const kv = findKv("F16") as KvPrecision;
      return ok({
        hardware: { gpu: hw.best?.name ?? null, vram_gb: hw.best ? gb(hw.best.vramGib) : null, ram_gb: gb(hw.ramGib) },
        searched: scan.searched,
        models: scan.models.map((m) => {
          const s = estimateSpeed(m.model, m.quant, kv, Math.min(context, m.model.maxContext), { ramGib: hw.ramGib, ramBandwidthGBs: hw.ramBandwidthGBs, gpu: hw.best });
          return {
            name: m.name,
            source: m.source,
            path: m.path,
            size_gb: gb(m.sizeBytes / GIB),
            architecture: m.arch,
            params_b: round(m.model.paramsB, 2),
            layers: m.model.layers,
            kv_heads: m.model.kvHeads,
            head_dim: m.model.headDim,
            native_context: m.model.maxContext,
            quant: m.quant.id,
            bits_per_weight: round(m.quant.bits, 2),
            runs_on: s.placement,
            memory_gb: gb(s.totalGib),
            generation_tokens_per_s: round(s.decodeTps, 1),
            verdict: s.verdict,
          };
        }),
        ...(scan.errors.length && { errors: scan.errors }),
        ...(!scan.models.length && { hint: "No GGUF found. Install with `ollama pull llama3.1:8b` or LM Studio, or pass extra_dirs." }),
      });
    },
  );

  // 21 ─ Importar do Hugging Face
  server.registerTool(
    "neurix_import_hf_model",
    {
      title: "Import a model's architecture from Hugging Face",
      description:
        "Replaces the manual 'custom model' questions: searches Hugging Face by name (or takes an exact repo id), downloads config.json and " +
        "returns layers, KV heads, head dimension, max context and parameter count (exact from safetensors metadata when available, else from " +
        "the name or estimated from the architecture). Gated repos (meta-llama/*, google/gemma-*) need HF_TOKEN; open copies are suggested. " +
        "Pass the result's `repo` as `hf_repo` to neurix_check_local_fit.",
      inputSchema: {
        query: z.string().describe("Model name to search (e.g. 'qwen2.5 7b instruct') or exact repo id (e.g. 'Qwen/Qwen2.5-7B-Instruct')."),
        pick: z.number().int().min(1).max(10).default(1).describe("When searching, which result to import (1 = most downloaded)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ query, pick }) => {
      let repo = query.trim();
      let hits: { id: string; downloads: number }[] = [];
      if (!repo.includes("/")) {
        try {
          hits = await searchHfModels(repo, 10);
        } catch (err) {
          return fail(`Can't reach Hugging Face: ${(err as Error).message}`);
        }
        if (!hits.length) return fail(`Nothing found for "${query}".`);
        repo = hits[Math.min(pick, hits.length) - 1]?.id ?? repo;
      }
      try {
        const imp = await importHfModel(repo);
        return ok({
          repo: imp.repo,
          architecture: imp.architecture,
          params_b: round(imp.model.paramsB, 3),
          params_source: imp.paramsSource,
          layers: imp.model.layers,
          kv_heads: imp.model.kvHeads,
          head_dim: imp.model.headDim,
          max_context: imp.model.maxContext,
          config_fields: imp.fields,
          ...(hits.length && { other_results: hits.map((h) => h.id) }),
        });
      } catch (err) {
        const e = err as HfError;
        let alternatives: string[] = [];
        if (e.kind === "gated") {
          const owner = repo.split("/")[0];
          alternatives = (await searchHfModels(repo.split("/").pop() ?? repo, 10).catch(() => []))
            .filter((h) => h.id.split("/")[0] !== owner && !/gguf|awq|gptq|exl2|mlx/i.test(h.id))
            .map((h) => h.id)
            .slice(0, 5);
        }
        return fail(e.message, { kind: e.kind, ...(alternatives.length && { open_copies: alternatives }) });
      }
    },
  );

  // 22 ─ Local vs API
  server.registerTool(
    "neurix_local_vs_api",
    {
      title: "Local vs API: is running locally worth it?",
      description:
        "Compares running a model on this machine (electricity: hours × (GPU power + rest of the PC) × tariff, plus optional hardware " +
        "amortization) with paying each API for the same monthly tokens. GPU power comes from nvidia-smi's power limit or the TDP table " +
        "(75% while generating); speed from memory bandwidth. Returns hours/month, whether one PC keeps up, kWh, local cost per month and " +
        "per 1M tokens, each API's monthly cost, savings and how many months the hardware takes to pay off. Quality is NOT compared: match " +
        "the local model with an API model of the same level.",
      inputSchema: {
        model: z.string().default("llama-3.1-8b").describe("Built-in local model id, installed model name (e.g. llama3.1:8b) — or use hf_repo."),
        hf_repo: z.string().optional().describe("Hugging Face repo to import the architecture from."),
        quant: z.enum(QUANTIZATIONS.map((q) => q.id) as [string, ...string[]]).default("Q4_K_M").describe("Quantization."),
        requests_per_day: z.number().positive().default(500),
        days_per_month: z.number().int().min(1).max(31).default(30),
        input_tokens: z.number().int().nonnegative().default(1500).describe("Input tokens per request."),
        output_tokens: z.number().int().positive().default(400).describe("Output tokens per request."),
        tariff_per_kwh: z.number().nonnegative().optional().describe("Electricity price per kWh in `currency` (default R$ 0.85 or US$ 0.16)."),
        currency: z.enum(["brl", "usd"]).default("brl"),
        gpu_w: z.number().nonnegative().optional().describe("GPU power while generating (W). Default: 75% of detected limit/TDP."),
        system_w: z.number().nonnegative().default(60).describe("Rest of the PC while running (W)."),
        hardware_price: z.number().nonnegative().default(0).describe("Hardware price to amortize, in `currency` (0 = already owned)."),
        amortize_months: z.number().int().positive().default(24),
        vram_gb: z.number().nonnegative().optional().describe("Simulate a GPU with this VRAM instead of the detected one."),
        ...fxArgs,
      },
      annotations: { ...RO, openWorldHint: true },
    },
    async (a) => {
      let model: LocalModel | undefined;
      let quant = findQuant(a.quant) as Quantization;
      if (a.hf_repo) {
        try {
          model = (await importHfModel(a.hf_repo)).model;
        } catch (err) {
          return fail((err as Error).message);
        }
      } else {
        model = findLocalModel(a.model);
        if (!model) {
          const inst = (await findInstalledModels()).models.find((m) => m.name.toLowerCase().startsWith(a.model.toLowerCase()));
          if (inst) {
            model = inst.model;
            quant = inst.quant;
          }
        }
      }
      if (!model) return unknownModel(a.model);
      const hw = await detectHardware();
      const detected = hw.best && !(hw.best.integrated && hw.best.vendor !== "apple") ? hw.best : null;
      const gpu: Gpu | null = a.vram_gb !== undefined ? (a.vram_gb > 0 ? { name: "GPU", vendor: "other", vramGib: a.vram_gb, integrated: false, source: "manual" } : null) : detected;
      const rate = await rateFor(a.usd_brl);
      if (a.currency === "brl" && !rate) return fail("No USD→BRL rate; pass usd_brl or use currency 'usd'.");
      const toUsd = (v: number): number => (a.currency === "brl" && rate ? v / toBrl(1, rate, a.iof_pct) : v);
      const kv = findKv("F16") as KvPrecision;
      const speed = estimateSpeed(model, quant, kv, Math.min(4096, model.maxContext), { ramGib: hw.ramGib, ramBandwidthGBs: hw.ramBandwidthGBs, gpu });
      const input: LocalCostInput = {
        inputTokens: a.requests_per_day * a.days_per_month * a.input_tokens,
        outputTokens: a.requests_per_day * a.days_per_month * a.output_tokens,
        tariffUsdKwh: toUsd(a.tariff_per_kwh ?? (a.currency === "brl" ? 0.85 : 0.16)),
        gpuW: gpu ? (a.gpu_w ?? defaultGpuW(gpu)) : 0,
        systemW: a.system_w,
        hardwareUsd: toUsd(a.hardware_price),
        amortMonths: a.amortize_months,
      };
      const res = localVsApi(speed, input, visibleModels(dataset, false));
      return ok({
        model: { name: model.name, params_b: round(model.paramsB, 2), quant: quant.id },
        hardware: { gpu: gpu?.name ?? null, vram_gb: gpu ? gb(gpu.vramGib) : null, ram_gb: gb(hw.ramGib) },
        speed: { runs_on: speed.placement, generation_tokens_per_s: round(speed.decodeTps, 1), prompt_tokens_per_s: round(speed.prefillTps, 0), verdict: speed.verdict },
        monthly_tokens: { input: input.inputTokens, output: input.outputTokens },
        ...(speed.placement === "noFit"
          ? { error: `Needs ${gb(speed.totalGib)} GB and fits neither the GPU nor RAM.` }
          : {
              local: {
                hours_per_month: round(res.hoursPerMonth, 1),
                one_pc_keeps_up: res.keepsUp,
                power_w: input.gpuW + input.systemW,
                kwh: round(res.kWh, 2),
                kwh_per_1m_generated: round(res.kWhPer1MOut, 3),
                energy: money(res.energyUsd, rate, a.iof_pct),
                amortization: money(res.amortUsd, rate, a.iof_pct),
                total_per_month: money(res.totalUsd, rate, a.iof_pct),
                per_1m_tokens: money(res.per1MUsd, rate, a.iof_pct),
              },
              apis: res.api.map((x) => ({
                id: x.model.id,
                name: x.model.name,
                tier: x.model.tier,
                per_month: money(x.usd, rate, a.iof_pct),
                local_saves_per_month: money(x.savedUsd, rate, a.iof_pct),
                hardware_pays_off_months: x.breakEvenMonths !== null ? round(x.breakEvenMonths, 1) : null,
              })),
              local_cheaper_than: res.api.filter((x) => x.savedUsd > 0).map((x) => x.model.id),
            }),
        note: "Quality is not compared: a local 8B model is not equivalent to a flagship API model.",
      });
    },
  );

  // 23 ─ Benchmark real (Ollama)
  server.registerTool(
    "neurix_benchmark_ollama",
    {
      title: "Real benchmark with Ollama (speed and power)",
      description:
        "Runs one generation on the local Ollama server and MEASURES real prompt and generation tokens/s (from Ollama's timings) and, with " +
        "an NVIDIA GPU, the average power draw sampled every 0.5 s → kWh per 1M generated tokens. Without `model`, lists Ollama's models. " +
        "Loads the model into memory and uses the GPU for a few seconds. Needs Ollama running (ollama serve).",
      inputSchema: {
        model: z.string().optional().describe("Ollama model name (e.g. llama3.2:3b). Omit to list available models."),
        max_tokens: z.number().int().min(16).max(2048).default(256).describe("Tokens to generate."),
        prompt: z.string().optional().describe("Custom prompt (default: a fixed explanatory prompt)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ model, max_tokens, prompt }) => {
      if (!(await ollamaRunning())) return fail("Ollama isn't running. Start the Ollama app or run `ollama serve`.");
      const names = await ollamaModels().catch(() => [] as string[]);
      if (!model) return ok({ ollama_models: names, ...(!names.length && { hint: "Pull one: ollama pull llama3.2:3b" }) });
      try {
        const r = await runOllamaBenchmark(model, { maxTokens: max_tokens, ...(prompt && { prompt }) });
        const hw = await detectHardware();
        const estW = r.avgPowerW ?? inferencePowerW(hw.best);
        return ok({
          model: r.model,
          generation_tokens_per_s: round(r.decodeTps, 2),
          prompt_tokens_per_s: round(r.prefillTps, 1),
          prompt_tokens: r.promptTokens,
          output_tokens: r.outputTokens,
          load_seconds: round(r.loadSeconds, 2),
          total_seconds: round(r.totalSeconds, 2),
          power: r.avgPowerW !== null ? { measured_w: round(r.avgPowerW, 1), samples: r.powerSamples } : { estimated_w: estW, note: "No NVIDIA GPU: power not measurable, estimated from TDP." },
          kwh_per_1m_generated: estW && r.decodeTps > 0 ? round(((1e6 / r.decodeTps / 3600) * estW) / 1000, 3) : null,
        });
      } catch (err) {
        return fail((err as Error).message, { available: names });
      }
    },
  );

  return server;
}

export async function startMcpServer(): Promise<void> {
  const server = await createMcpServer();
  await server.connect(new StdioServerTransport());
  console.error(`Neurix MCP ${pkg.version} rodando (stdio).`);
}

// Executado direto (neurix-mcp) ou via "neurix mcp".
const direct = process.argv[1] && /mcp(\.(ts|js))?$/.test(process.argv[1]);
if (direct) {
  startMcpServer().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
