/** Tudo que imprime resultado na tela. Com `explain`, cada linha ganha um "↳" dizendo o que significa. */
import pc from "picocolors";
import { computeCost, type CostBreakdown } from "../core/cost.ts";
import type { FormatVariant } from "../core/formats.ts";
import { formatLocalContext, KV_PRECISIONS, QUANTIZATIONS, type LocalEstimate, type LocalInput } from "../core/local.ts";
import type { RagInput, RagResult } from "../core/rag.ts";
import { estimateTokens } from "../core/tokens.ts";
import { getUsdBrl, toBrl, type ExchangeRate } from "../currency/exchange.ts";
import { formatBrl, formatContext, formatInt, formatNum, formatUsd } from "../currency/format.ts";
import { locale, t } from "../i18n/index.ts";
import type { ModelPrice } from "../types/models.ts";

export interface OutputOptions {
  usd?: number;
  iof: number;
  all: boolean;
  refreshFx: boolean;
  explain: boolean;
}

// ───────────── Câmbio ─────────────

/** Nunca derruba a CLI: sem cotação, mostra só em dólar. */
export async function safeRate(opts: Pick<OutputOptions, "usd" | "refreshFx">): Promise<ExchangeRate | null> {
  try {
    return await getUsdBrl({ manual: opts.usd, refresh: opts.refreshFx });
  } catch (err) {
    console.error(pc.yellow(t().fx.onlyUsd((err as Error).message)));
    return null;
  }
}

export function rateLine(rate: ExchangeRate, iof: number): string {
  const L = t().fx;
  const when = new Date(rate.quotedAt).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" });
  let line = `US$ 1 = R$ ${formatNum(rate.usdBrl, 4, 2)} · ${L.sources[rate.source] ?? rate.source}`;
  if (rate.source !== "manual") line += ` · ${when}`;
  if (rate.stale) line += pc.yellow(L.stale);
  if (iof > 0) line += L.iof(formatNum(iof));
  return line;
}

export const brl = (usd: number, rate: ExchangeRate | null, iof: number): string =>
  rate ? formatBrl(toBrl(usd, rate, iof)) : "—";

const money = (usd: number, rate: ExchangeRate | null, iof: number): string =>
  `${formatUsd(usd)}  ${pc.dim("|")}  ${brl(usd, rate, iof)}`;

// ───────────── Blocos básicos ─────────────

const LABEL_W = 18;
export const sep = (): void => console.log(pc.dim("─".repeat(56)));
export const title = (s: string): void => {
  console.log();
  console.log(pc.bold(s));
  sep();
};

const termWidth = (): number => Math.min(100, process.stdout.columns || 80);

export function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

/** Uma linha "Rótulo: valor" e, no modo explicado, o significado logo abaixo. */
export function row(label: string, value: string, why: string | undefined, explain: boolean): void {
  console.log(`${pc.dim(label.padEnd(LABEL_W))}${value}`);
  if (explain && why) {
    const indent = " ".repeat(LABEL_W);
    wrap(why, termWidth() - LABEL_W - 3).forEach((l, i) =>
      console.log(`${indent}${pc.dim(pc.italic(`${i === 0 ? "↳" : " "} ${l}`))}`),
    );
  }
}

/** Parágrafo explicativo solto (só no modo explicado). */
export function explainBlock(text: string, explain: boolean): void {
  if (!explain) return;
  for (const l of wrap(text, termWidth() - 4)) console.log(pc.cyan(`  ${l}`));
}

const gb = (gib: number): string => `${formatNum(gib, 1, 1)} GB`;

// Largura visível ignorando códigos de cor ANSI.
// biome-ignore lint/suspicious/noControlCharactersInRegex: remove sequências ANSI
const visible = (s: string): number => s.replace(/\x1b\[[0-9;]*m/g, "").length;
const pad = (s: string, w: number, right = false): string => {
  const fill = " ".repeat(Math.max(0, w - visible(s)));
  return right ? fill + s : s + fill;
};

function table(head: string[], body: string[][]): void {
  const widths = head.map((h, i) => Math.max(visible(h), ...body.map((r) => visible(r[i] ?? ""))));
  console.log(head.map((h, i) => pc.dim(pad(h, widths[i] ?? 0, i > 0))).join("  "));
  for (const r of body) console.log(r.map((cell, i) => pad(cell, widths[i] ?? 0, i > 0)).join("  "));
}

function contextLine(model: ModelPrice, c: CostBreakdown): string {
  const L = t().out;
  const used = `${formatInt(c.inputTokens + c.outputTokens)} / ${formatInt(model.contextWindow ?? 0)}`;
  if (c.fitsContext === null) return pc.dim(L.ctxUnknown);
  const pct = ((c.inputTokens + c.outputTokens) / (model.contextWindow ?? 1)) * 100;
  const pctTxt = pct < 0.1 ? `<${formatNum(0.1, 1)}%` : `${formatNum(pct, 1, 1)}%`;
  return c.fitsContext ? pc.green(L.fits(used, pctTxt)) : pc.red(L.notFits(used));
}

// ───────────── Texto: um modelo ─────────────

export function printDetail(
  text: string,
  model: ModelPrice,
  c: CostBreakdown,
  rate: ExchangeRate | null,
  opts: OutputOptions,
): void {
  const L = t().out;
  const W = t().why;
  const e = opts.explain;
  title(L.estimate);
  row(L.text, L.chars(formatInt(text.length)), W.chars, e);
  row(L.tokens, `~${formatInt(c.inputTokens)} ${pc.dim(L.estimateNote)}`, W.tokens, e);
  row(L.model, `${model.name} ${pc.dim(`(${model.id})`)}`, W.model, e);
  row(L.pricePer1M, L.priceLine(formatUsd(c.price.input), formatUsd(c.price.output)), undefined, e);
  sep();
  row(L.inCost, money(c.inputUsd, rate, opts.iof), W.inputCost, e);
  row(L.outCost, `~${money(c.outputUsd, rate, opts.iof)}  ${pc.dim(L.outNote(formatInt(c.outputTokens)))}`, W.outputCost, e);
  row(
    L.total,
    `${pc.bold(`~${formatUsd(c.totalUsd)}`)}  ${pc.dim("|")}  ${pc.bold(pc.green(`~${brl(c.totalUsd, rate, opts.iof)}`))}`,
    W.total,
    e,
  );
  if (c.tierAbove) row("", pc.yellow(L.longCtx(formatContext(c.tierAbove))), W.tier, e);
  row(L.context, contextLine(model, c), W.context, e);
  if (rate) row(L.fx, pc.dim(rateLine(rate, opts.iof)), W.fx, e);
  if (model.source !== "litellm") row("", pc.yellow(L.unofficial(model.source)), W.unofficial, e);
  console.log();
}

// ───────────── Texto: todos os modelos ─────────────

export function printTable(
  text: string,
  models: ModelPrice[],
  outTokens: number,
  rate: ExchangeRate | null,
  opts: OutputOptions,
): void {
  const L = t().out;
  const W = t().why;
  const inputTokens = estimateTokens(text);
  const rows = models
    .map((m) => ({ m, c: computeCost(m, inputTokens, outTokens) }))
    .sort((a, b) => a.c.totalUsd - b.c.totalUsd);

  console.log();
  console.log(`${pc.bold(L.compare)}  ${pc.dim(L.compareSub(formatInt(text.length), formatInt(inputTokens), formatInt(outTokens)))}`);
  table(
    L.compareHead,
    rows.map(({ m, c }) => [
      m.name + (m.source !== "litellm" ? pc.yellow(" *") : ""),
      formatUsd(c.price.input),
      formatUsd(c.price.output),
      formatUsd(c.totalUsd),
      pc.green(brl(c.totalUsd, rate, opts.iof)),
      c.fitsContext === false ? pc.red(`❌ ${formatContext(m.contextWindow)}`) : formatContext(m.contextWindow),
    ]),
  );
  if (rate) console.log(pc.dim(`\n${L.fx} ${rateLine(rate, opts.iof)}`));
  if (rows.some(({ m }) => m.source !== "litellm")) console.log(pc.dim(`${pc.yellow("*")} ${L.orNote}`));
  if (opts.explain) {
    console.log();
    explainBlock(`${L.explainPrices} ${W.inputCost}`, true);
    explainBlock(`${W.total} ${L.explainTotal}`, true);
    explainBlock(L.explainCtx, true);
  }
  if (!opts.all) console.log(pc.dim(L.useAll));
  console.log();
}

// ───────────── Arquivo: formatos ─────────────

export function printFormats(
  file: string,
  variants: FormatVariant[],
  model: ModelPrice,
  outTokens: number,
  rate: ExchangeRate | null,
  opts: OutputOptions,
): void {
  const L = t().out;
  const F = t().formats;
  const base = variants.find((v) => v.original) ?? variants[0];
  if (!base) return;
  const baseCost = computeCost(model, base.tokens, outTokens).totalUsd;
  const sorted = [...variants].sort((a, b) => a.tokens - b.tokens);
  const name = (v: FormatVariant): string => F.names[v.id] ?? v.id;

  title(`${L.formatsTitle}  ${pc.dim(`${file} · ${model.name}`)}`);
  table(
    L.formatsHead,
    sorted.map((v, i) => {
      const cost = computeCost(model, v.tokens, outTokens).totalUsd;
      const diff = base.tokens === 0 ? 0 : ((v.tokens - base.tokens) / base.tokens) * 100;
      const diffTxt = v.original ? pc.dim("—") : diff <= 0 ? pc.green(`${diff.toFixed(0)}%`) : pc.red(`+${diff.toFixed(0)}%`);
      return [
        (i === 0 ? pc.green("★ ") : "  ") + name(v),
        formatInt(v.chars),
        `~${formatInt(v.tokens)}`,
        formatUsd(cost),
        brl(cost, rate, opts.iof),
        diffTxt,
      ];
    }),
  );
  const best = sorted[0];
  if (best && !best.original) {
    const saved = baseCost - computeCost(model, best.tokens, outTokens).totalUsd;
    console.log();
    console.log(
      `${pc.green("★")} ${L.best(pc.bold(name(best)), formatInt(base.tokens - best.tokens), formatUsd(saved), brl(saved, rate, opts.iof))}`,
    );
    console.log(pc.dim(`  ${L.in1000(formatUsd(saved * 1000), brl(saved * 1000, rate, opts.iof))}`));
  }
  if (opts.explain) {
    console.log();
    explainBlock(t().why.formats, true);
    console.log();
    for (const v of sorted) explainBlock(`• ${name(v)}: ${F.why[v.id] ?? ""}.`, true);
    console.log();
    explainBlock(L.vsOriginal(formatInt(outTokens)), true);
    explainBlock(L.formatWarning, true);
  }
  console.log();
}

// ───────────── Arquivo: RAG ─────────────

export function printRag(
  file: string,
  model: ModelPrice,
  input: RagInput,
  r: RagResult,
  rate: ExchangeRate | null,
  opts: OutputOptions,
): void {
  const L = t().out;
  const W = t().why;
  const e = opts.explain;
  // Arredonda para baixo: 99,6% de economia não pode aparecer como "100%".
  const pct = (a: number, b: number): string => (b === 0 ? "0%" : `${Math.floor((1 - a / b) * 100)}%`);

  title(`${L.ragTitle}  ${pc.dim(`${file} · ${model.name}`)}`);
  explainBlock(W.rag, e);
  if (e) console.log();
  row(L.doc, `~${formatInt(input.docTokens)} tokens`, W.tokens, e);
  row(L.chunk, `${formatInt(input.chunkSize)} tokens`, W.chunkSize, e);
  row(L.overlap, `${formatInt(input.overlap)} tokens`, W.overlap, e);
  row(L.pieces, L.piecesVal(formatInt(r.chunks)), W.chunks, e);
  row(L.topK, L.topKVal(formatInt(r.retrieved), formatInt(r.contextTokens)), W.topK, e);
  row(
    L.perCall,
    L.perCallVal(formatInt(input.systemTokens), formatInt(input.questionTokens), formatInt(input.outputTokens)),
    W.systemPrompt,
    e,
  );

  title(L.indexing);
  row(L.embedding, L.embedVal(formatUsd(input.embedPricePer1M)), W.embedPrice, e);
  row(L.indexAll, `${money(r.indexUsd, rate, opts.iof)}  ${pc.dim(`(~${formatInt(r.indexedTokens)} tokens)`)}`, W.indexCost, e);

  title(L.each);
  row(
    L.withRag,
    `${pc.bold(pc.green(formatUsd(r.ragPerQueryUsd)))}  ${pc.dim("|")}  ${brl(r.ragPerQueryUsd, rate, opts.iof)}  ${pc.dim(L.inputNote(formatInt(r.rag.inputTokens)))}`,
    W.ragQuery,
    e,
  );
  row(L.ragCtx, contextLine(model, r.rag), W.context, e);
  row(
    L.whole,
    `${formatUsd(r.fullPerQueryUsd)}  ${pc.dim("|")}  ${brl(r.fullPerQueryUsd, rate, opts.iof)}  ${pc.dim(L.inputNote(formatInt(r.full.inputTokens)))}`,
    W.fullQuery,
    e,
  );
  row(L.wholeCtx, contextLine(model, r.full), W.context, e);

  title(L.month(formatInt(input.queriesPerMonth)));
  const ragTotal = r.ragMonthUsd + r.indexUsd;
  row(L.withRag, pc.green(money(ragTotal, rate, opts.iof)), `${W.month} ${L.monthIncl}`, e);
  row(L.whole, money(r.fullMonthUsd, rate, opts.iof), W.month, e);
  sep();
  if (ragTotal < r.fullMonthUsd) console.log(pc.green(L.cheaper(pct(ragTotal, r.fullMonthUsd))));
  else console.log(pc.yellow(L.notWorth));
  if (r.full.fitsContext === false) console.log(pc.yellow(L.mustRag));
  explainBlock(L.tradeoff, e);
  if (rate) row(L.fx, pc.dim(rateLine(rate, opts.iof)), W.fx, e);
  console.log();
}

// ───────────── Modelo local ─────────────

export function printLocal(input: LocalInput, est: LocalEstimate, textTokens: number | null, opts: OutputOptions): void {
  const D = t();
  const L = D.out;
  const W = D.why;
  const e = opts.explain;
  const { model, quant, kv, context } = input;
  const parallel = input.parallel ?? 1;

  title(`${L.localTitle}  ${pc.dim(model.name)}`);
  if (textTokens !== null) row(L.yourText, `~${formatInt(textTokens)} tokens`, W.tokens, e);
  row(L.cost, pc.green(L.costVal), W.localCost, e);
  row(L.params, L.paramsVal(formatNum(model.paramsB)), W.params, e);
  row(L.quant, `${quant.id} ${pc.dim(L.quantVal(formatNum(quant.bits, 1), D.quantHints[quant.id] ?? ""))}`, W.quant, e);
  row(
    L.ctx,
    `${L.ctxVal(formatInt(context), parallel)} ${pc.dim(L.ctxMax(formatLocalContext(model.maxContext)))}`,
    parallel > 1 ? `${W.localContext} ${W.parallel}` : W.localContext,
    e,
  );
  if (context > model.maxContext) console.log(pc.yellow(`${" ".repeat(LABEL_W)}${L.overMax}`));

  title(L.memory);
  row(L.weights, gb(est.weightsGib), W.weights, e);
  row(
    L.kv,
    `${gb(est.kvGib)} ${pc.dim(L.kvVal(formatInt(est.kvBytesPerToken / 1024), kv.id))}`,
    `${W.kv} ${W.kvFormula} ${L.kvHere(model.layers, model.kvHeads, model.headDim, formatNum(kv.bytes, 4), formatInt(context * parallel))}`,
    e,
  );
  row(L.overhead, gb(est.overheadGib), W.overhead, e);
  sep();
  row(L.vramTotal, pc.bold(gb(est.totalGib)), W.vram, e);
  barChart(est, L.legend);

  if (est.gpu) {
    const g = est.gpu;
    title(L.gpu(gb(g.vramGib)));
    if (g.fits) row(L.result, pc.green(L.gpuFits(gb(g.vramGib - est.totalGib))), W.gpuFit, e);
    else if (g.layersOnGpu > 0) row(L.result, pc.yellow(L.gpuPartial(g.layersOnGpu, model.layers)), W.offload, e);
    else row(L.result, pc.red(L.gpuNo), W.offload, e);
    row(
      L.maxCtx,
      g.maxContextOnGpu > 0 ? L.maxCtxVal(formatInt(Math.min(g.maxContextOnGpu, model.maxContext))) : pc.red(L.weightsDontFit),
      W.maxCtx,
      e,
    );
    if (!g.fits) {
      const smaller = QUANTIZATIONS.filter((q) => q.bits < quant.bits && q.bits >= 4).slice(0, 2);
      const cheaperKv = KV_PRECISIONS.find((k) => k.bytes < kv.bytes);
      console.log();
      console.log(pc.dim(L.tryTitle));
      if (smaller.length) console.log(pc.dim(`  ${L.trySmallerQuant(smaller.map((q) => q.id).join(` ${L.or} `))}`));
      console.log(pc.dim(`  ${L.tryLessCtx}`));
      if (cheaperKv) console.log(pc.dim(`  ${L.tryKv(cheaperKv.id)}`));
      console.log(pc.dim(`  ${L.trySmallerModel}`));
    }
  }
  const note = D.modelNotes[model.id];
  if (note) console.log(pc.dim(`\n${L.note(note)}`));
  console.log(pc.dim(`\n${L.approx}`));
  console.log();
}

/** Barra proporcional mostrando quem ocupa a memória. */
function barChart(est: LocalEstimate, names: string[]): void {
  const width = 40;
  const parts = [
    { v: est.weightsGib, c: pc.blue, name: names[0] ?? "" },
    { v: est.kvGib, c: pc.magenta, name: names[1] ?? "" },
    { v: est.overheadGib, c: pc.gray, name: names[2] ?? "" },
  ];
  let bar = "";
  for (const p of parts) bar += p.c("█".repeat(Math.max(p.v > 0 ? 1 : 0, Math.round((p.v / est.totalGib) * width))));
  const legend = parts.map((p) => `${p.c("■")} ${p.name} ${((p.v / est.totalGib) * 100).toFixed(0)}%`).join(pc.dim("  ·  "));
  console.log(`${" ".repeat(LABEL_W)}${bar}`);
  console.log(`${" ".repeat(LABEL_W)}${legend}`);
}
