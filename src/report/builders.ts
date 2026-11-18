/**
 * Um construtor de relatório para cada parte do Neurix. Recebe os mesmos dados que a tela usa e devolve
 * um Report com números crus (as telas formatam; o Markdown/HTML formatam de novo; CSV/JSON ficam crus).
 */
import type { BenchmarkResult } from "../core/benchmark.ts";
import type { CacheResult } from "../core/budget.ts";
import type { ChunkPlan } from "../core/chunking.ts";
import { computeCost, type CostBreakdown } from "../core/cost.ts";
import { byTopDir, type FolderResult } from "../core/folder.ts";
import type { FormatVariant } from "../core/formats.ts";
import type { Gpu, Hardware } from "../core/hardware.ts";
import type { InstalledModel, InstalledScan } from "../core/installed.ts";
import type { LocalEstimate, LocalInput, LocalModel, Quantization } from "../core/local.ts";
import type { LocalCostInput, LocalCostResult, SpeedEstimate } from "../core/localcost.ts";
import type { OptimizeResult } from "../core/optimize.ts";
import { BATCH, type BurnRate, type CheckResult, type PlanRow, type UsageProfile } from "../core/plan.ts";
import type { RagInput, RagResult } from "../core/rag.ts";
import type { Recommendation } from "../core/recommend.ts";
import type { Counter } from "../core/tokens.ts";
import { toBrl, type ExchangeRate } from "../currency/exchange.ts";
import { t } from "../i18n/index.ts";
import type { ModelPrice } from "../types/models.ts";
import { newReport, type Cell, type Report } from "./report.ts";

const r6 = (n: number): number => Number(n.toFixed(6));
const r2 = (n: number): number => Number(n.toFixed(2));
const brl = (usd: number, rate: ExchangeRate | null, iof = 0): number | null => (rate ? r6(toBrl(usd, rate, iof)) : null);
const fx = (rate: ExchangeRate | null): Record<string, Cell> => (rate ? { usd_brl: rate.usdBrl, fx_source: rate.source } : {});
const counting = (c: Counter): string => (c.exact ? `exact · ${c.source ?? c.method}` : `estimate · ${c.method}`);

// ───────────── Texto ─────────────

export function detailReport(text: string, model: ModelPrice, c: CostBreakdown, counter: Counter, rate: ExchangeRate | null, iof: number): Report {
  const C = t().rep.c;
  const r = newReport("cost", `${t().rep.titles.detail} — ${model.name}`, { model: model.id, ...fx(rate) });
  r.sections.push({
    heading: t().rep.titles.detail,
    kv: [
      [C.chars, text.length],
      [C.tokens, c.inputTokens],
      [C.counting, counting(counter)],
      [C.outputTokens, c.outputTokens],
      [C.priceIn, c.price.input],
      [C.priceOut, c.price.output],
      [C.inputUsd, r6(c.inputUsd)],
      [C.outputUsd, r6(c.outputUsd)],
      [C.totalUsd, r6(c.totalUsd)],
      [C.totalBrl, brl(c.totalUsd, rate, iof)],
      [C.context, model.contextWindow],
      [C.fits, c.fitsContext],
    ],
  });
  return r;
}

export function compareReport(chars: number, rows: { m: ModelPrice; c: CostBreakdown; counter: Counter }[], outTokens: number, rate: ExchangeRate | null, iof: number): Report {
  const C = t().rep.c;
  const r = newReport("compare", t().rep.titles.compare, { characters: chars, output_tokens: outTokens, ...fx(rate) });
  r.sections.push({
    heading: t().rep.titles.compare,
    table: {
      head: [C.model, C.provider, C.tokens, C.exact, C.priceIn, C.priceOut, C.totalUsd, C.totalBrl, C.context, C.fits],
      rows: rows.map(({ m, c, counter }) => [m.name, m.provider, c.inputTokens, counter.exact, c.price.input, c.price.output, r6(c.totalUsd), brl(c.totalUsd, rate, iof), m.contextWindow, c.fitsContext]),
    },
  });
  return r;
}

export function formatsReport(file: string, variants: FormatVariant[], model: ModelPrice, outTokens: number, counter: Counter, rate: ExchangeRate | null, iof: number): Report {
  const C = t().rep.c;
  const F = t().formats;
  const base = variants.find((v) => v.original) ?? variants[0];
  const r = newReport("formats", `${t().rep.titles.formats} — ${file}`, { model: model.id, counting: counting(counter), ...fx(rate) });
  r.sections.push({
    heading: t().rep.titles.formats,
    table: {
      head: [C.format, C.chars, C.tokens, C.vsOriginal, C.totalUsd, C.totalBrl],
      rows: [...variants]
        .sort((a, b) => a.tokens - b.tokens)
        .map((v) => {
          const cost = computeCost(model, v.tokens, outTokens).totalUsd;
          return [F.names[v.id] ?? v.id, v.chars, v.tokens, base && base.tokens ? r2(((v.tokens - base.tokens) / base.tokens) * 100) : 0, r6(cost), brl(cost, rate, iof)];
        }),
    },
  });
  return r;
}

export function ragReport(file: string, model: ModelPrice, input: RagInput, res: RagResult, counter: Counter, rate: ExchangeRate | null, iof: number): Report {
  const C = t().rep.c;
  const r = newReport("rag", `${t().rep.titles.rag} — ${file}`, { model: model.id, counting: counting(counter), ...fx(rate) });
  r.sections.push({
    heading: C.inputs,
    kv: [
      [C.docTokens, input.docTokens],
      [C.chunkSize, input.chunkSize],
      [C.overlap, input.overlap],
      [C.chunks, res.chunks],
      [C.topK, input.topK],
      [C.queriesMonth, input.queriesPerMonth],
      [C.embedPrice, input.embedPricePer1M],
    ],
  });
  r.sections.push({
    heading: t().rep.titles.rag,
    table: {
      head: [C.item, C.inputTokens, C.perQueryUsd, C.perMonthUsd, C.perMonthBrl, C.fits],
      rows: [
        [C.withRag, res.rag.inputTokens, r6(res.ragPerQueryUsd), r6(res.ragMonthUsd + res.indexUsd), brl(res.ragMonthUsd + res.indexUsd, rate, iof), res.rag.fitsContext],
        [C.wholeDoc, res.full.inputTokens, r6(res.fullPerQueryUsd), r6(res.fullMonthUsd), brl(res.fullMonthUsd, rate, iof), res.full.fitsContext],
      ],
    },
  });
  return r;
}

// ───────────── Modelo local ─────────────

const modelKv = (m: LocalModel, q: Quantization): [string, Cell][] => {
  const C = t().rep.c;
  return [
    [C.model, m.name],
    [C.params, r2(m.paramsB)],
    [C.layers, m.layers],
    [C.kvHeads, m.kvHeads],
    [C.headDim, m.headDim],
    [C.maxContext, m.maxContext],
    [C.quant, q.id],
    [C.bits, r2(q.bits)],
    ...(m.hfRepo ? ([[C.hfRepo, m.hfRepo]] as [string, Cell][]) : []),
  ];
};

const gpuRows = (gpus: Gpu[]): Cell[][] =>
  gpus.map((g) => [g.name, g.vendor, r2(g.vramGib), g.freeGib !== undefined ? r2(g.freeGib) : null, g.integrated, g.powerDrawW ?? null, g.powerLimitW ?? g.tdpW ?? null, g.bandwidthGBs ?? null, g.source]);

const speedKv = (s: SpeedEstimate): [string, Cell][] => {
  const C = t().rep.c;
  const L = t().lt;
  return [
    [C.placement, L.placement[s.placement]],
    [C.layersOnGpu, s.layersOnGpu],
    [C.decodeTps, r2(s.decodeTps)],
    [C.prefillTps, r2(s.prefillTps)],
    [C.verdict, L.verdict[s.verdict]],
  ];
};

export function localReport(
  input: LocalInput,
  est: LocalEstimate,
  text: { tokens: number; counter: Counter } | null,
  speed: SpeedEstimate | null,
  hw: Hardware | null,
  gpu: Gpu | null,
): Report {
  const C = t().rep.c;
  const r = newReport("local", `${t().rep.titles.local} — ${input.model.name}`, {
    quant: input.quant.id,
    kv_cache: input.kv.id,
    context: input.context,
    parallel: input.parallel ?? 1,
    ...(gpu && { gpu: gpu.name, vram_gb: r2(gpu.vramGib) }),
  });
  r.sections.push({ heading: C.model, kv: modelKv(input.model, input.quant) });
  if (text) r.sections.push({ heading: C.text, kv: [[C.tokens, text.tokens], [C.counting, counting(text.counter)]] });
  r.sections.push({
    heading: C.memory,
    kv: [
      [C.weightsGb, r2(est.weightsGib)],
      [C.kvGb, r2(est.kvGib)],
      [C.kvKbToken, r2(est.kvBytesPerToken / 1024)],
      [C.overheadGb, r2(est.overheadGib)],
      [C.totalGb, r2(est.totalGib)],
      ...(est.gpu
        ? ([
            [C.fitsGpu, est.gpu.fits],
            [C.layersOnGpu, est.gpu.layersOnGpu],
            [C.maxCtxGpu, est.gpu.maxContextOnGpu],
          ] as [string, Cell][])
        : []),
    ],
  });
  if (speed) r.sections.push({ heading: C.speed, kv: speedKv(speed) });
  if (hw) r.sections.push({ heading: t().rep.titles.hardware, kv: [[C.cpu, hw.cpu.model], ["RAM (GB)", r2(hw.ramGib)]] });
  return r;
}

export function hardwareReport(hw: Hardware, big: { model: LocalModel; quant: Quantization; speed: SpeedEstimate } | null): Report {
  const C = t().rep.c;
  const r = newReport("hardware", t().rep.titles.hardware, { platform: `${hw.platform} ${hw.arch}` });
  r.sections.push({
    heading: C.system,
    kv: [
      [C.cpu, hw.cpu.model],
      [C.threads, hw.cpu.cores],
      ["RAM (GB)", r2(hw.ramGib)],
      [C.freeRam, r2(hw.freeRamGib)],
      [C.bestGpu, hw.best?.name ?? null],
    ],
  });
  r.sections.push({
    heading: C.gpus,
    table: { head: [C.name, C.vendor, "VRAM (GB)", C.freeGb, C.integrated, C.powerNowW, C.powerLimitW, C.bandwidth, C.source], rows: gpuRows(hw.gpus) },
  });
  if (big) r.sections.push({ heading: C.biggest, kv: [...modelKv(big.model, big.quant), ...speedKv(big.speed)] });
  return r;
}

export function installedReport(scan: InstalledScan, hw: Hardware, rows: { m: InstalledModel; speed: SpeedEstimate }[], context: number): Report {
  const C = t().rep.c;
  const L = t().lt;
  const r = newReport("installed", t().rep.titles.installed, { context, gpu: hw.best?.name ?? null, ram_gb: r2(hw.ramGib) });
  r.sections.push({
    heading: t().rep.titles.installed,
    table: {
      head: [C.name, C.source, C.sizeGb, C.params, C.quant, C.bits, C.maxContext, C.placement, C.decodeTps, C.verdict, C.path],
      rows: rows.map(({ m, speed }) => [
        m.name,
        m.source,
        r2(m.sizeBytes / 1024 ** 3),
        r2(m.model.paramsB),
        m.quant.id,
        r2(m.quant.bits),
        m.model.maxContext,
        L.placement[speed.placement],
        r2(speed.decodeTps),
        L.verdict[speed.verdict],
        m.path,
      ]),
    },
  });
  r.sections.push({ heading: C.searched, table: { head: [C.source, C.path, C.found], rows: scan.searched.map((s) => [s.source, s.dir, s.found]) } });
  return r;
}

export function localVsApiReport(v: {
  model: LocalModel;
  quant: Quantization;
  hw: Hardware;
  speed: SpeedEstimate;
  input: LocalCostInput;
  res: LocalCostResult;
  rate: ExchangeRate | null;
  opts: { iof: number };
}): Report {
  const C = t().rep.c;
  const { res, input, rate } = v;
  const iof = v.opts.iof;
  const r = newReport("local-vs-api", `${t().rep.titles.localVsApi} — ${v.model.name} ${v.quant.id}`, { gpu: v.hw.best?.name ?? null, ...fx(rate) });
  r.sections.push({ heading: C.model, kv: [...modelKv(v.model, v.quant), ...speedKv(v.speed)] });
  r.sections.push({
    heading: C.local,
    kv: [
      [C.inputTokensMonth, input.inputTokens],
      [C.outputTokensMonth, input.outputTokens],
      [C.gpuW, input.gpuW],
      [C.systemW, input.systemW],
      [C.tariffUsd, r6(input.tariffUsdKwh)],
      [C.hoursMonth, r2(res.hoursPerMonth)],
      [C.keepsUp, res.keepsUp],
      ["kWh", r2(res.kWh)],
      [C.energyUsd, r6(res.energyUsd)],
      [C.amortUsd, r6(res.amortUsd)],
      [C.totalUsd, r6(res.totalUsd)],
      [C.totalBrl, brl(res.totalUsd, rate, iof)],
      [C.per1MUsd, r6(res.per1MUsd)],
      [C.kWhPer1M, r2(res.kWhPer1MOut)],
    ],
  });
  r.sections.push({
    heading: C.vsApi,
    table: {
      head: [C.model, C.apiUsd, C.apiBrl, C.savedUsd, C.breakEven],
      rows: res.api.map((a) => [a.model.name, r6(a.usd), brl(a.usd, rate, iof), r6(a.savedUsd), a.breakEvenMonths !== null ? r2(a.breakEvenMonths) : null]),
    },
  });
  return r;
}

export function benchmarkReport(b: BenchmarkResult, hw: Hardware, powerW: number | null, tariff: number, currency: string): Report {
  const C = t().rep.c;
  const r = newReport("benchmark", `${t().rep.titles.benchmark} — ${b.model}`, { gpu: hw.best?.name ?? null, currency });
  const kWh = powerW && b.decodeTps > 0 ? ((1e6 / b.decodeTps / 3600) * powerW) / 1000 : null;
  r.sections.push({
    heading: t().rep.titles.benchmark,
    kv: [
      [C.decodeTps, r2(b.decodeTps)],
      [C.prefillTps, r2(b.prefillTps)],
      [C.promptTokens, b.promptTokens],
      [C.outputTokens, b.outputTokens],
      [C.loadS, r2(b.loadSeconds)],
      [C.totalS, r2(b.totalSeconds)],
      [C.powerMeasuredW, b.avgPowerW !== null ? r2(b.avgPowerW) : null],
      [C.powerSamples, b.powerSamples],
      [C.powerUsedW, powerW],
      [C.kWhPer1M, kWh !== null ? r2(kWh) : null],
      [C.tariff, tariff],
      [C.costPer1M, kWh !== null ? r2(kWh * tariff) : null],
    ],
  });
  return r;
}

// ───────────── Ferramentas ─────────────

export function optimizeReport(res: OptimizeResult, model: ModelPrice, counter: Counter, rate: ExchangeRate | null, iof: number, name: string | null): Report {
  const C = t().rep.c;
  const K = t().tools.kinds;
  const saved = res.originalTokens - res.optimizedTokens;
  const usd = computeCost(model, saved, 0).inputUsd;
  const r = newReport("optimize", `${t().rep.titles.optimize}${name ? ` — ${name}` : ""}`, { model: model.id, counting: counting(counter), ...fx(rate) });
  r.sections.push({
    heading: C.summary,
    kv: [
      [C.originalTokens, res.originalTokens],
      [C.optimizedTokens, res.optimizedTokens],
      [C.savedTokens, saved],
      [C.savedPct, res.originalTokens ? r2((saved / res.originalTokens) * 100) : 0],
      [C.savedPerCallUsd, r6(usd)],
      [C.savedPer1000Brl, brl(usd * 1000, rate, iof)],
    ],
  });
  r.sections.push({
    heading: t().tools.optFound,
    table: {
      head: [C.item, C.occurrences, C.savedTokens, C.applied, C.lines],
      rows: res.issues.map((i) => [K[i.kind], i.occurrences, i.tokensSaved, i.applied, i.examples.map((e) => e.line).join(" ")]),
    },
  });
  return r;
}

export function folderReport(res: FolderResult, model: ModelPrice, counter: Counter, models: ModelPrice[], rate: ExchangeRate | null, iof: number): Report {
  const C = t().rep.c;
  const share = (n: number): number => (res.totalTokens ? r2((n / res.totalTokens) * 100) : 0);
  const r = newReport("folder", `${t().rep.titles.folder} — ${res.root}`, { model: model.id, counting: counting(counter), files: res.files.length, total_tokens: res.totalTokens, ...fx(rate) });
  r.sections.push({ heading: C.files, table: { head: [C.path, C.tokens, "%", C.bytes], rows: res.files.map((f) => [f.path, f.tokens, share(f.tokens), f.bytes]) } });
  r.sections.push({ heading: t().tools.folderExt, table: { head: [C.ext, C.files, C.tokens, "%"], rows: res.byExt.map((e) => [e.ext, e.files, e.tokens, share(e.tokens)]) } });
  r.sections.push({ heading: t().tools.folderDir, table: { head: [C.folder, C.files, C.tokens, "%"], rows: byTopDir(res.files).map((d) => [d.dir, d.files, d.tokens, share(d.tokens)]) } });
  r.sections.push({
    heading: t().tools.folderFit,
    table: {
      head: [C.model, C.context, C.fits, C.inputUsd, C.totalBrl],
      rows: models.map((m) => {
        const c = computeCost(m, res.totalTokens, 0);
        return [m.name, m.contextWindow, c.fitsContext, r6(c.inputUsd), brl(c.inputUsd, rate, iof)];
      }),
    },
  });
  return r;
}

export function chunksReport(plan: ChunkPlan, counter: Counter, name: string | null): Report {
  const C = t().rep.c;
  const r = newReport("chunks", `${t().rep.titles.chunks}${name ? ` — ${name}` : ""}`, {
    tokenizer: counting(counter),
    doc_tokens: plan.docTokens,
    chunk_size: plan.chunkSize,
    overlap: plan.overlap,
    chunks: plan.chunks.length,
    tokens_indexed: plan.indexedTokens,
    chunks_cutting_sentences: plan.cutsSentence,
  });
  const one = (s: string): string => s.replace(/\s+/g, " ").trim();
  r.sections.push({
    heading: C.chunks,
    table: {
      head: ["#", C.start, C.end, C.tokens, C.cutsSentence, C.overlapText, C.preview],
      rows: plan.chunks.map((c) => [c.index, c.start, c.end, c.tokens, c.cutsSentence, one(c.overlapText).slice(-80), one(c.newText).slice(0, 160)]),
    },
  });
  return r;
}

export function recommendReport(rec: Recommendation, chars: number, out: number, signals: string[], rate: ExchangeRate | null, iof: number): Report {
  const C = t().rep.c;
  const T = t().tools;
  const r = newReport("recommend", t().rep.titles.recommend, { characters: chars, output_tokens: out, level: T.quality[rec.quality][0] ?? rec.quality, signals: signals.join(", "), ...fx(rate) });
  const row = (label: string, c: NonNullable<Recommendation["best"]>): Cell[] => [label, c.model.name, c.model.tier, c.cost.inputTokens, c.exact, r6(c.cost.totalUsd), brl(c.cost.totalUsd, rate, iof)];
  const rows: Cell[][] = [];
  if (rec.best) rows.push(row(T.recBest.replace(/^\S+\s/, ""), rec.best));
  for (const a of rec.alternatives) rows.push(row(T.recAlt.replace(/:$/, ""), a));
  for (const [q, c] of Object.entries(rec.perTier)) if (c) rows.push(row(T.quality[q as keyof typeof T.quality][0] ?? q, c));
  r.sections.push({ heading: t().rep.titles.recommend, table: { head: [C.item, C.model, C.tier, C.tokens, C.exact, C.totalUsd, C.totalBrl], rows } });
  return r;
}

export function budgetReport(v: {
  rows: PlanRow[];
  profile: UsageProfile;
  capUsd: number;
  cur: "brl" | "usd";
  rate: ExchangeRate | null;
  iof: number;
  burn?: { spentUsd: number; result: BurnRate };
}): Report {
  const C = t().rep.c;
  const inCur = (usd: number): number => r6(v.cur === "brl" && v.rate ? toBrl(usd, v.rate, v.iof) : usd);
  const u = v.profile;
  const r = newReport("budget", t().rep.titles.budget, { currency: v.cur.toUpperCase(), cap: inCur(v.capUsd), cap_usd: r6(v.capUsd), ...fx(v.rate) });
  r.sections.push({
    heading: C.profile,
    kv: [
      [C.inputTokens, u.inputTokens],
      [C.cachedTokens, u.cachedTokens],
      [C.cacheHit, u.cacheHitPct],
      [C.outputTokens, u.outputTokens],
      [C.batchPct, u.batchPct],
      [C.reqDay, u.requestsPerDay ?? null],
      [C.activeDays, u.activeDays],
    ],
  });
  if (v.burn) {
    const b = v.burn.result;
    r.sections.push({
      heading: t().budget.burnTitle,
      kv: [
        [C.spent, inCur(v.burn.spentUsd)],
        [C.dailyAvg, inCur(b.dailyAvg)],
        [C.projectedMonth, inCur(b.projectedMonth)],
        [C.pctCap, r2(b.capPct)],
        [C.capDay, b.capDay],
        [C.safeDaily, inCur(b.safeDailyLeft)],
      ],
    });
  }
  r.sections.push({
    heading: t().budget.perReqTitle,
    table: {
      head: [C.model, C.provider, "normal", "cache", "batch", "cache+batch", C.yourUsage],
      rows: v.rows.map((x) => [x.model.name, x.model.provider, x.perRequest.normal, x.perRequest.cache, x.perRequest.batch, x.perRequest.cacheBatch, r6(x.optimized)]),
    },
  });
  if (u.requestsPerDay !== undefined)
    r.sections.push({
      heading: t().budget.projTitle,
      table: {
        head: [C.model, C.day, C.month, C.year, C.monthNoOpt, C.pctCap, C.capDay],
        rows: v.rows.map((x) =>
          x.projection
            ? [x.model.name, inCur(x.projection.day), inCur(x.projection.month), inCur(x.projection.year), inCur(x.projection.monthNormal), r2(x.projection.capPct), x.projection.capDay]
            : [x.model.name, null, null, null, null, null, null],
        ),
      },
    });
  r.sections.push({
    heading: t().budget.fitTitle,
    table: {
      head: [C.model, C.maxMonthNormal, C.maxMonthYour, C.maxDay],
      rows: v.rows.map((x) => [x.model.name, x.maxPerMonth.normal, x.maxPerMonth.optimized, x.maxPerDay.optimized]),
    },
  });
  r.sections.push({
    heading: t().budget.batchTitle,
    table: {
      head: [C.provider, C.batchApi, C.discount, C.window],
      rows: [...new Set(v.rows.map((x) => x.model.provider))].map((pv) => [pv, BATCH[pv].api, BATCH[pv].discount, BATCH[pv].window]),
    },
  });
  return r;
}

export function checkReport(v: { name: string; model: ModelPrice; counter: Counter; result: CheckResult; calls: number; maxUsd?: number; maxTokens?: number; rate: ExchangeRate | null; iof: number }): Report {
  const C = t().rep.c;
  const r = newReport("check", `${t().rep.titles.check} — ${v.name}`, { model: v.model.id, ok: v.result.ok, ...fx(v.rate) });
  r.sections.push({
    heading: t().rep.titles.check,
    kv: [
      [C.tokens, v.result.tokens],
      [C.counting, counting(v.counter)],
      [C.calls, v.calls],
      [C.totalUsd, r6(v.result.costUsd)],
      [C.totalBrl, brl(v.result.costUsd, v.rate, v.iof)],
      [C.maxUsd, v.maxUsd ?? null],
      [C.maxTokens, v.maxTokens ?? null],
      [C.overCost, v.result.overCost],
      [C.overTokens, v.result.overTokens],
      [C.overContext, v.result.overContext],
      ["ok", v.result.ok],
    ],
  });
  return r;
}

export function cacheReport(rows: CacheResult[], fixed: number, variable: number, out: number, calls: number, rate: ExchangeRate | null, iof: number): Report {
  const C = t().rep.c;
  const r = newReport("cache", t().rep.titles.cache, { fixed_tokens: fixed, variable_tokens: variable, output_tokens: out, calls, ...fx(rate) });
  r.sections.push({
    heading: t().rep.titles.cache,
    table: {
      head: [C.model, C.supported, C.noCacheUsd, C.withCacheUsd, C.savedUsd, C.savedPct, C.savedBrl],
      rows: rows.map((x) => [x.model.name, x.supported, r6(x.withoutCacheUsd), r6(x.withCacheUsd), r6(x.savedUsd), r2(x.savedPct), brl(x.savedUsd, rate, iof)]),
    },
  });
  return r;
}
