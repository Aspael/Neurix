/** Menu de apresentação do Neurix e os fluxos interativos de cada opção. */
import { readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { computeCost, currentPrice } from "../core/cost.ts";
import { detectKind, formatVariants } from "../core/formats.ts";
import {
  estimateLocal,
  formatLocalContext,
  GIB,
  KV_PRECISIONS,
  LOCAL_MODELS,
  QUANTIZATIONS,
  type KvPrecision,
  type LocalModel,
  type Quantization,
} from "../core/local.ts";
import { simulateRag, type RagInput } from "../core/rag.ts";
import { estimateTokens } from "../core/tokens.ts";
import { toBrl, type ExchangeRate } from "../currency/exchange.ts";
import { formatBrl, formatContext, formatInt, formatNum, formatUsd } from "../currency/format.ts";
import { dictFor, getLang, LANGS, saveLang, t, type Lang } from "../i18n/index.ts";
import { visibleModels } from "../prices/load.ts";
import type { ModelPrice, PriceDataset } from "../types/models.ts";
import { canAnimate, miniHeader, splash, thinking } from "./anim.ts";
import { printDetail, printFormats, printLocal, printRag, printTable, safeRate, wrap, type OutputOptions } from "./output.ts";

export interface MenuOptions extends OutputOptions {
  out: number;
}

/** Ctrl+C dentro de uma opção volta ao menu em vez de fechar o programa. */
class Back extends Error {}

function ok<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new Back();
  return value as Exclude<T, symbol>;
}

const gb = (gib: number): string => `${formatNum(gib, 1)} GB`;
const MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Caixa com vários parágrafos; linhas que começam com espaço mantêm o recuo. */
function noteParas(paras: string[], title: string, width = 66): void {
  const lines = paras.flatMap((para) => {
    if (para === "") return [""];
    const indent = para.match(/^ */)?.[0] ?? "";
    return wrap(para.trim(), width - indent.length).map((l) => indent + l);
  });
  p.note(lines.join("\n"), title);
}

/** Explicação curta acima de uma pergunta. */
const tip = (text: string): void => p.log.message(pc.dim(wrap(text, 70).join("\n")));

/** Animação de "processando" antes de cada resultado. */
const think = (): Promise<void> => thinking(p.spinner, t().menu.thinking, t().menu.ready);

// ───────────── Menu principal ─────────────

export async function mainMenu(dataset: PriceDataset, opts: MenuOptions): Promise<void> {
  await splash(t().tagline);
  p.intro(pc.bgMagenta(pc.white(pc.bold(t().menu.intro))));

  // Busca o câmbio em segundo plano enquanto o usuário escolhe.
  const ratePromise = safeRate(opts);
  let rate: ExchangeRate | null | undefined;
  const getRate = async (): Promise<ExchangeRate | null> => {
    if (rate !== undefined) return rate;
    const s = canAnimate() ? p.spinner() : null;
    s?.start(t().menu.fxLoading);
    rate = await ratePromise;
    s?.stop(rate ? pc.dim(`US$ 1 = R$ ${formatNum(rate.usdBrl, 2, 2)}`) : "—");
    return rate;
  };

  for (;;) {
    const M = t().menu;
    const choice = await p.select({
      message: M.choose,
      options: [
        { value: "texto", label: M.text, hint: M.textHint },
        { value: "arquivo", label: M.file, hint: M.fileHint },
        { value: "local", label: M.local, hint: M.localHint },
        { value: "glossario", label: M.glossary, hint: M.glossaryHint },
        { value: "idioma", label: M.language, hint: M.languageHint(t().langName) },
        { value: "sair", label: M.exit },
      ],
    });
    if (p.isCancel(choice) || choice === "sair") {
      p.outro(pc.magenta(t().menu.bye));
      return;
    }

    try {
      if (choice === "texto") await textFlow(dataset, opts, await getRate());
      else if (choice === "arquivo") await fileFlow(dataset, opts, await getRate());
      else if (choice === "local") await localFlow(opts);
      else if (choice === "glossario") glossary();
      else {
        await languageFlow();
        continue; // trocar idioma já volta direto ao menu
      }
    } catch (err) {
      if (!(err instanceof Back)) throw err;
      p.log.warn(t().menu.cancelled);
      continue;
    }

    const again = await p.confirm({ message: t().menu.again, initialValue: true });
    if (p.isCancel(again) || !again) {
      p.outro(pc.magenta(t().menu.bye));
      return;
    }
  }
}

// ───────────── Idioma ─────────────

const FLAGS: Record<Lang, string> = { pt: "🇧🇷", en: "🇺🇸" };

async function languageFlow(): Promise<void> {
  const lang = ok(
    await p.select<Lang>({
      message: t().menu.chooseLang,
      initialValue: getLang(),
      options: LANGS.map((l) => ({ value: l, label: `${FLAGS[l]}  ${dictFor(l).langName}` })),
    }),
  );
  await saveLang(lang);
  miniHeader(t().tagline);
  p.log.success(t().menu.langChanged);
}

// ───────────── Perguntas reutilizadas ─────────────

function modelHint(m: ModelPrice, rate: ExchangeRate | null, iof: number): string {
  const price = currentPrice(m, new Date().toISOString().slice(0, 10));
  const usd = `${formatUsd(price.input)} / ${formatUsd(price.output)}`;
  const real = rate ? ` · ${formatBrl(toBrl(price.input, rate, iof))} / ${formatBrl(toBrl(price.output, rate, iof))}` : "";
  return t().ask.modelHint(`${usd}${real}`, formatContext(m.contextWindow));
}

async function askModel(
  models: ModelPrice[],
  rate: ExchangeRate | null,
  opts: MenuOptions,
  allowCompare: boolean,
): Promise<ModelPrice | "__all__"> {
  const A = t().ask;
  const fx = rate ? pc.dim(` (US$ 1 = R$ ${formatNum(rate.usdBrl, 2, 2)})`) : "";
  const choice = ok(
    await p.select({
      message: `${A.model}${fx}`,
      options: [
        ...(allowCompare ? [{ value: "__all__", label: `⚖️  ${A.compareAll}`, hint: A.compareAllHint }] : []),
        ...models.map((m) => ({ value: m.id, label: m.name, hint: modelHint(m, rate, opts.iof) })),
      ],
    }),
  );
  return choice === "__all__" ? "__all__" : (models.find((m) => m.id === choice) as ModelPrice);
}

async function askOutput(opts: MenuOptions): Promise<number> {
  const A = t().ask;
  tip(t().why.outputCost);
  const values = [100, 300, 1000, 4000];
  return ok(
    await p.select({
      message: A.outSize,
      initialValue: opts.out,
      options: [
        ...values.map((value, i) => ({ value, label: A.outSizes[i]?.[0] ?? "", hint: A.outSizes[i]?.[1] })),
        ...(!values.includes(opts.out) ? [{ value: opts.out, label: A.outCustom, hint: A.outCustomHint(formatInt(opts.out)) }] : []),
      ],
    }),
  );
}

async function askNumber(
  message: string,
  def: number,
  opts: { min?: number; hint?: string; integer?: boolean } = {},
): Promise<number> {
  const A = t().ask;
  if (opts.hint) tip(opts.hint);
  const v = ok(
    await p.text({
      message,
      placeholder: String(def),
      defaultValue: String(def),
      validate: (s) => {
        if (!s) return undefined;
        const n = Number(s.replace(",", "."));
        if (!Number.isFinite(n)) return A.typeNumber;
        if (opts.integer && !Number.isInteger(n)) return A.typeInteger;
        if (n < (opts.min ?? 0)) return A.atLeast(String(opts.min ?? 0));
        return undefined;
      },
    }),
  );
  return v ? Number(v.replace(",", ".")) : def;
}

async function askText(): Promise<string> {
  const A = t().ask;
  return ok(
    await p.text({
      message: A.text,
      placeholder: A.textPlaceholder,
      validate: (v) => (!v || v.trim().length === 0 ? A.textEmpty : undefined),
    }),
  );
}

// ───────────── 1. Texto ─────────────

async function textFlow(dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const T = t().textFlow;
  p.note(wrap(T.intro, 64).join("\n"), T.title);
  const text = await askText();
  const out = await askOutput(opts);
  await showTextResult(text, dataset, { ...opts, out }, rate);
}

async function showTextResult(text: string, dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null) {
  const models = visibleModels(dataset, opts.all);
  const model = await askModel(models, rate, opts, true);
  await think();
  if (model === "__all__") return printTable(text, models, opts.out, rate, opts);
  printDetail(text, model, computeCost(model, estimateTokens(text), opts.out), rate, opts);
}

// ───────────── 2. Arquivo ─────────────

async function readTextFile(): Promise<{ name: string; content: string }> {
  const F = t().fileFlow;
  const path = ok(await p.path({ message: F.path, validate: (v) => (!v ? F.pathEmpty : undefined) }));
  const full = resolve(path);
  const s = await stat(full).catch(() => null);
  if (!s?.isFile()) {
    p.log.error(F.notFound(full));
    throw new Back();
  }
  if (s.size > MAX_FILE_BYTES) {
    p.log.error(F.tooBig(formatInt(s.size / 1024 / 1024)));
    throw new Back();
  }
  const spin = canAnimate() ? p.spinner() : null;
  spin?.start(F.reading);
  const buf = await readFile(full);
  if (buf.subarray(0, 8000).includes(0)) {
    spin?.stop();
    p.log.error(F.binary);
    throw new Back();
  }
  const content = buf.toString("utf8");
  spin?.stop(pc.green(F.info(basename(full), formatInt(content.length), formatInt(estimateTokens(content)))));
  if (!spin) p.log.info(F.info(basename(full), formatInt(content.length), formatInt(estimateTokens(content))));
  return { name: basename(full), content };
}

async function fileFlow(dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const F = t().fileFlow;
  p.note(wrap(t().why.file, 64).join("\n"), F.title);
  const file = await readTextFile();

  const mode = ok(
    await p.select({
      message: F.mode,
      options: [
        { value: "entrada", label: `📥 ${F.asInput}`, hint: F.asInputHint },
        { value: "formato", label: `🧾 ${F.asFormat}`, hint: F.asFormatHint },
        { value: "rag", label: `🔎 ${F.asRag}`, hint: F.asRagHint },
      ],
    }),
  );

  if (mode === "entrada") {
    const out = await askOutput(opts);
    return showTextResult(file.content, dataset, { ...opts, out }, rate);
  }

  const models = visibleModels(dataset, opts.all);
  if (mode === "formato") {
    tip(t().why.formats);
    const model = (await askModel(models, rate, opts, false)) as ModelPrice;
    const variants = formatVariants(file.content, detectKind(file.content, file.name));
    if (variants.length < 2) p.log.warn(F.noVariants);
    await think();
    return printFormats(file.name, variants, model, opts.out, rate, opts);
  }

  // RAG
  const R = t().ragFlow;
  const W = t().why;
  p.note(wrap(W.rag, 64).join("\n"), R.title);
  const model = (await askModel(models, rate, opts, false)) as ModelPrice;
  tip(W.chunkSize);
  const sizes = [256, 512, 1000, 2000];
  const chunkSize = ok(
    await p.select({
      message: R.chunk,
      initialValue: 512,
      options: sizes.map((v, i) => ({ value: v, label: `${formatInt(v)} tokens`, hint: R.chunkHints[i] })),
    }),
  );
  tip(W.overlap);
  const overlapPct = ok(
    await p.select({
      message: R.overlap,
      initialValue: 10,
      options: [
        { value: 0, label: "0%", hint: R.overlapNone },
        { value: 10, label: "10%", hint: R.overlapCommon(Math.round(chunkSize * 0.1)) },
        { value: 20, label: "20%", hint: R.overlapSafe(Math.round(chunkSize * 0.2)) },
      ],
    }),
  );
  tip(W.topK);
  const topK = ok(
    await p.select({
      message: R.topK,
      initialValue: 5,
      options: [3, 5, 10].map((v, i) => ({ value: v, label: String(v), hint: R.topKHints[i] })),
    }),
  );
  const queriesPerMonth = await askNumber(R.queries, 1000, { min: 1 });
  const embedPricePer1M = await askNumber(R.embedPrice, 0.02, { hint: W.embedPrice });

  const input: RagInput = {
    docTokens: estimateTokens(file.content),
    chunkSize,
    overlap: Math.round((chunkSize * overlapPct) / 100),
    topK,
    questionTokens: 50,
    systemTokens: 200,
    outputTokens: opts.out,
    queriesPerMonth,
    embedPricePer1M,
  };
  await think();
  printRag(file.name, model, input, simulateRag(model, input), rate, opts);
}

// ───────────── 3. Modelo local ─────────────

async function askCustomModel(): Promise<LocalModel> {
  const L = t().localFlow;
  noteParas(L.customGuide, L.customTitle);

  const paramsB = await askNumber(L.customParams, 8, { min: 0.01, hint: L.customParamsTip });
  const layers = await askNumber(L.customLayers, 32, { min: 1, integer: true, hint: L.customLayersTip });
  const kvHeads = await askNumber(L.customKvHeads, 8, { min: 1, integer: true, hint: L.customKvHeadsTip });
  let headDim = await askNumber(L.customHeadDim, 128, { min: 0, integer: true, hint: L.customHeadDimTip });
  if (headDim === 0) {
    const hidden = await askNumber(L.customHidden, 4096, { min: 1, integer: true });
    const heads = await askNumber(L.customAttnHeads, 32, { min: 1, integer: true });
    headDim = Math.round(hidden / heads);
    p.log.info(L.customHeadDimCalc(formatInt(hidden), formatInt(heads), formatInt(headDim)));
  }
  const maxContext = await askNumber(L.customMaxCtx, 131072, { min: 1, integer: true, hint: L.customMaxCtxTip });

  const kvBytes = 2 * layers * kvHeads * headDim * 2;
  noteParas(
    L.customSummary(
      formatNum(paramsB),
      formatInt(layers),
      formatInt(kvHeads),
      formatInt(headDim),
      formatInt(maxContext),
      formatNum(kvBytes / 1024, 1),
      `2 × ${layers} × ${kvHeads} × ${headDim} × 2 bytes`,
    ),
    L.customSummaryTitle,
  );
  return { id: "custom", name: L.customName(formatNum(paramsB)), paramsB, layers, kvHeads, headDim, maxContext };
}

export async function localFlow(opts: MenuOptions): Promise<void> {
  const D = t();
  const L = D.localFlow;
  const W = D.why;
  p.note(wrap(L.intro, 64).join("\n"), L.title);

  tip(W.params);
  const modelId = ok(
    await p.select({
      message: L.model,
      initialValue: "llama-3.1-8b",
      maxItems: 12,
      options: [
        ...LOCAL_MODELS.map((m) => ({
          value: m.id,
          label: m.name,
          hint: L.modelHint(formatNum(m.paramsB), formatLocalContext(m.maxContext)),
        })),
        { value: "custom", label: `✏️  ${L.custom}`, hint: L.customHint },
      ],
    }),
  );
  const model = modelId === "custom" ? await askCustomModel() : (LOCAL_MODELS.find((m) => m.id === modelId) as LocalModel);

  tip(W.quant);
  const quantId = ok(
    await p.select({
      message: L.quant,
      initialValue: "Q4_K_M",
      options: QUANTIZATIONS.map((q) => ({
        value: q.id,
        label: q.id,
        hint: L.quantHint(formatNum(q.bits, 1), gb((model.paramsB * 1e9 * q.bits) / 8 / GIB), D.quantHints[q.id] ?? ""),
      })),
    }),
  );
  const quant = QUANTIZATIONS.find((q) => q.id === quantId) as Quantization;

  tip(`${W.localContext} ${W.kv}`);
  const ctxChoices = [2048, 4096, 8192, 16_384, 32_768, 65_536, 131_072].filter((c) => c <= model.maxContext);
  const ctxChoice = ok(
    await p.select<number | "texto">({
      message: L.ctx,
      initialValue: Math.min(8192, model.maxContext),
      options: [
        ...ctxChoices.map((c) => ({
          value: c,
          label: `${formatLocalContext(c)} tokens`,
          hint: L.ctxHint(formatInt(c / 500), c === model.maxContext),
        })),
        { value: "texto" as const, label: `📝 ${L.ctxText}`, hint: L.ctxTextHint },
      ],
    }),
  );
  let context: number;
  let textTokens: number | null = null;
  if (ctxChoice === "texto") {
    textTokens = estimateTokens(await askText());
    context = textTokens + opts.out;
    p.log.info(L.ctxInfo(formatInt(textTokens), formatInt(opts.out), formatInt(context)));
  } else context = ctxChoice;

  tip(W.kvPrecision);
  const kvId = ok(
    await p.select({
      message: L.kv,
      initialValue: "F16",
      options: KV_PRECISIONS.map((k) => ({ value: k.id, label: k.id, hint: L.kvHint(formatNum(k.bytes, 4), D.kvHints[k.id] ?? "") })),
    }),
  );
  const kv = KV_PRECISIONS.find((k) => k.id === kvId) as KvPrecision;

  tip(W.vram);
  const gpus: [number, string][] = [
    [4, "GTX 1650"],
    [6, "RTX 2060, RTX 3050 6GB"],
    [8, "RTX 3060 Ti, RTX 4060"],
    [12, "RTX 3060, RTX 4070"],
    [16, "RTX 4060 Ti 16GB, RTX 4080"],
    [24, "RTX 3090, RTX 4090"],
    [32, "RTX 5090"],
    [48, "RTX A6000, 2× 24 GB"],
    [80, "A100 / H100"],
  ];
  const vram = ok(
    await p.select<number>({
      message: L.vram,
      initialValue: 8,
      options: [
        { value: 0, label: L.vramSkip, hint: L.vramSkipHint },
        ...gpus.map(([v, ex]) => ({ value: v, label: `${v} GB`, hint: `${L.eg} ${ex}` })),
      ],
    }),
  );

  const input = { model, quant, kv, context, ...(vram > 0 && { vramGib: vram }) };
  await think();
  printLocal(input, estimateLocal(input), textTokens, opts);
}

// ───────────── Glossário ─────────────

function glossary(): void {
  const D = t();
  console.log();
  console.log(pc.bold(D.glossaryTitle));
  const width = Math.min(90, (process.stdout.columns || 80) - 6);
  for (const [term, text] of D.glossary) {
    console.log();
    console.log(`  ${pc.bold(pc.cyan(term))}`);
    for (const l of wrap(text, width)) console.log(`    ${l}`);
  }
  console.log();
}
