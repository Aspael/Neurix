/** Menu "🧰 Ferramentas": otimizador de prompt, análise de pasta, chunking visual, recomendador, orçamento e cache. */
import { stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import { promptCacheSavings } from "../core/budget.ts";
import { budgetFlow } from "./budget.ts";
import { readClipboard } from "../core/clipboard.ts";
import { cacheReport, chunksReport, folderReport, optimizeReport, recommendReport } from "../report/builders.ts";
import { setLastReport } from "../report/report.ts";
import { chunkDocument, type ChunkPlan } from "../core/chunking.ts";
import { computeCost } from "../core/cost.ts";
import { analyzeFolder, byTopDir, type FolderResult } from "../core/folder.ts";
import { optimizePrompt, revealWhitespace, type OptimizeResult, type WasteIssue } from "../core/optimize.ts";
import { recommendModel, suggestQuality, type Quality, type Recommendation } from "../core/recommend.ts";
import { counterFor, countersFor, type Counter } from "../core/tokens.ts";
import { toBrl, type ExchangeRate } from "../currency/exchange.ts";
import { formatBrl, formatContext, formatInt, formatNum, formatUsd } from "../currency/format.ts";
import { t } from "../i18n/index.ts";
import { visibleModels } from "../prices/load.ts";
import type { ModelPrice, PriceDataset } from "../types/models.ts";
import { canAnimate } from "./anim.ts";
import { askModel, askNumber, askOutput, Back, ok, readTextFile, think, tip, type MenuOptions } from "./menu.ts";
import { brl, countNotes, LABEL_W, pad, rateLine, row, sep, table, termWidth, title, tokenValue, wrap } from "./output.ts";

type Tool = "optimize" | "folder" | "chunk" | "recommend" | "budget" | "cache";
const TOOLS: Tool[] = ["optimize", "folder", "chunk", "recommend", "budget", "cache"];

const pct = (part: number, whole: number, digits = 1): string =>
  whole > 0 ? `${formatNum((part / whole) * 100, digits, digits)}%` : "0%";

const bar = (part: number, whole: number, width = 20, color = pc.magenta): string => {
  const n = whole > 0 ? Math.round((part / whole) * width) : 0;
  return color("█".repeat(Math.max(part > 0 ? 1 : 0, n))) + pc.dim("░".repeat(Math.max(0, width - Math.max(part > 0 ? 1 : 0, n))));
};

const size = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${formatNum(bytes / 1024 / 1024, 1, 1)} MB` : `${formatNum(bytes / 1024, 1, 1)} KB`;

// ───────────── Entrada de texto ─────────────

export interface Source {
  name: string | null;
  path: string | null;
  content: string;
}

async function askSource(): Promise<Source> {
  const T = t().tools;
  const from = ok(
    await p.select({
      message: T.source,
      options: [
        { value: "clipboard", label: T.sourceClipboard, hint: T.sourceClipboardHint },
        { value: "file", label: T.sourceFile },
        { value: "type", label: T.sourceType, hint: T.sourceTypeHint },
      ],
    }),
  );
  if (from === "file") {
    const f = await readTextFile();
    return { name: f.name, path: f.path, content: f.content };
  }
  if (from === "clipboard") {
    // Copiar e escolher esta opção: funciona com qualquer tamanho e com linhas em branco no meio.
    const text = await readClipboard();
    if (text === null) {
      p.log.error(T.clipboardError);
      throw new Back();
    }
    if (!text.trim()) {
      p.log.warn(T.clipboardEmpty);
      throw new Back();
    }
    const lines = text.split("\n");
    const preview = lines.slice(0, 3).map((l) => (l.length > 70 ? `${l.slice(0, 70)}…` : l));
    p.log.info(`${T.clipboardRead(formatInt(text.length), formatInt(lines.length))}\n${pc.dim(preview.join("\n"))}${lines.length > 3 ? pc.dim("\n…") : ""}`);
    return { name: null, path: null, content: text };
  }
  // Digitar: Enter numa linha vazia envia (padrão do clack). Sem o botão "submit", que só aceitava Tab.
  const content = ok(
    await p.multiline({
      message: T.multiline,
      validate: (v) => (!v || v.trim().length === 0 ? t().ask.textEmpty : undefined),
    }),
  );
  return { name: null, path: null, content: content.replace(/\n+$/, "") };
}

/** Modelo de API para contar/precificar (sem a opção "comparar todos"). */
const pickModel = async (dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null, message?: string): Promise<ModelPrice> => {
  if (message) tip(message);
  return (await askModel(visibleModels(dataset, opts.all), rate, opts, false)) as ModelPrice;
};

// ───────────── Menu das ferramentas ─────────────

export async function toolsFlow(dataset: PriceDataset, opts: MenuOptions, getRate: () => Promise<ExchangeRate | null>): Promise<boolean> {
  const T = t().tools;
  const tool = ok(
    await p.select<Tool | "back">({
      message: T.choose,
      options: [
        ...TOOLS.map((id) => ({ value: id, label: T.items[id][0] ?? id, hint: T.items[id][1] })),
        { value: "back" as const, label: T.back },
      ],
    }),
  );
  if (tool === "back") return false; // volta ao menu sem aviso de "cancelado"
  const rate = await getRate();
  if (tool === "optimize") await optimizeFlow(dataset, opts, rate);
  else if (tool === "folder") await folderFlow(dataset, opts, rate);
  else if (tool === "chunk") await chunkFlow(dataset, opts, rate);
  else if (tool === "recommend") await recommendFlow(dataset, opts, rate);
  else if (tool === "budget") await budgetFlow(dataset, opts, rate);
  else await cacheFlow(dataset, opts, rate);
  return true;
}

// ───────────── 1. Otimizador de prompt ─────────────

async function optimizeFlow(dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const T = t().tools;
  p.note(wrap(T.optIntro, 64).join("\n"), T.optTitle);
  const src = await askSource();
  const model = await pickModel(dataset, opts, rate);
  const counter = await counterFor(model);
  await think();
  const r = optimizePrompt(src.content, counter.count);
  printOptimize(r, model, counter, rate, opts, src.name);
  if (r.optimized === r.original.replace(/\r\n/g, "\n")) return;

  const outName = src.path ? `${basename(src.path, extname(src.path))}.otimizado${extname(src.path) || ".txt"}` : "prompt.otimizado.txt";
  const outPath = src.path ? join(dirname(src.path), outName) : resolve(outName);
  const what = ok(
    await p.select({
      message: T.optWhat,
      options: [
        { value: "show", label: T.optShow },
        { value: "save", label: T.optSave, hint: T.optSaveHint(outPath) },
        { value: "none", label: T.optNone },
      ],
    }),
  );
  if (what === "show") showText(r.optimized, T.optShowTitle);
  if (what === "save") {
    await writeFile(outPath, r.optimized);
    p.log.success(T.optSavedTo(outPath));
  }
}

function showText(text: string, heading: string): void {
  const max = 40;
  const ls = text.split("\n");
  console.log();
  console.log(pc.bold(heading));
  sep();
  for (const l of ls.slice(0, max)) console.log(l);
  if (ls.length > max) console.log(pc.dim(t().tools.optMore(formatInt(ls.length - max))));
  sep();
}

/** Destaca em vermelho o desperdício dentro do exemplo já "revelado" (· e →). */
function highlight(issue: WasteIssue, line: string): string {
  const shown = revealWhitespace(line.length > 90 ? `${line.slice(0, 90)}…` : line);
  const red = (s: string): string => pc.bgRed(pc.white(s));
  switch (issue.kind) {
    case "trailingSpaces":
      return shown.replace(/[·→]+$/, red);
    case "indentation":
      return shown.replace(/^[·→]+/, red);
    case "multiSpaces":
      return shown.replace(/[·→]{2,}/g, red);
    case "invisible":
      return shown.replace(/[¤⍽]/g, red);
    default:
      return shown;
  }
}

export function printOptimize(
  r: OptimizeResult,
  model: ModelPrice,
  counter: Counter,
  rate: ExchangeRate | null,
  opts: MenuOptions,
  name: string | null,
): void {
  const T = t().tools;
  const saved = r.originalTokens - r.optimizedTokens;
  title(`${T.optTitle}  ${pc.dim([name, model.name].filter(Boolean).join(" · "))}`);
  row(
    T.optTokens,
    `${tokenValue(r.originalTokens, counter)}  →  ${pc.bold(pc.green(formatInt(r.optimizedTokens)))}  ${saved > 0 ? pc.green(T.optSaved(formatInt(saved), formatNum((saved / Math.max(1, r.originalTokens)) * 100, 1, 1))) : ""}`,
    undefined,
    false,
  );
  if (saved > 0) {
    const usd = computeCost(model, r.originalTokens, 0).inputUsd - computeCost(model, r.optimizedTokens, 0).inputUsd;
    row(
      T.optPerCall,
      T.optPerCallVal(`${formatUsd(usd)} | ${brl(usd, rate, opts.iof)}`, `${formatUsd(usd * 1000)} | ${brl(usd * 1000, rate, opts.iof)}`),
      undefined,
      false,
    );
  }
  if (!r.issues.length) {
    console.log(pc.green(`\n${T.optNothing}`));
    countNotes([counter]);
    setLastReport(optimizeReport(r, model, counter, rate, opts.iof, name));
    console.log();
    return;
  }

  title(T.optFound);
  const maxSaved = Math.max(...r.issues.map((i) => i.tokensSaved), 1);
  table(
    [...T.optHead, ""],
    r.issues.map((i) => [
      T.kinds[i.kind] + (i.applied ? "" : pc.dim(` ${T.optOnlyPointed}`)),
      formatInt(i.occurrences),
      i.applied ? pc.green(`−${formatInt(i.tokensSaved)}`) : pc.yellow(`~${formatInt(i.tokensSaved)}`),
      bar(i.tokensSaved, maxSaved, 16, i.applied ? pc.green : pc.yellow),
    ]),
  );

  title(T.optExamples);
  for (const i of r.issues) {
    console.log(`${pc.bold(T.kinds[i.kind])} ${pc.dim(`— ${T.kindWhy[i.kind]}`)}`);
    for (const ex of i.examples) {
      const text = i.kind === "blankLines" ? pc.dim(T.optBlank(ex.text)) : highlight(i, ex.text);
      console.log(`  ${pc.dim(pad(T.optLine(ex.line), 10))} ${text}`);
    }
  }
  countNotes([counter]);
  setLastReport(optimizeReport(r, model, counter, rate, opts.iof, name));
  console.log();
}

// ───────────── 2. Análise de pasta ─────────────

async function folderFlow(dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const T = t().tools;
  p.note(wrap(T.folderIntro, 64).join("\n"), T.folderTitle);
  const raw = ok(await p.path({ message: T.folderPath, directory: true, initialValue: process.cwd() }));
  const root = resolve(raw || ".");
  const s = await stat(root).catch(() => null);
  if (!s?.isDirectory()) {
    p.log.error(T.folderNotFound(root));
    throw new Back();
  }
  const model = await pickModel(dataset, opts, rate, T.countingModel);
  const counter = await counterFor(model);
  const spin = canAnimate() ? p.spinner() : null;
  spin?.start(T.scanning);
  const res = await analyzeFolder(root, counter.count);
  spin?.stop(pc.green(T.folderSummary(formatInt(res.files.length), formatInt(res.totalTokens), size(res.totalBytes))));
  printFolder(res, model, counter, visibleModels(dataset, opts.all), rate, opts);
}

export function printFolder(
  res: FolderResult,
  model: ModelPrice,
  counter: Counter,
  models: ModelPrice[],
  rate: ExchangeRate | null,
  opts: MenuOptions,
): void {
  const T = t().tools;
  title(`${T.folderTitle}  ${pc.dim(`${res.root} · ${model.name}`)}`);
  if (!res.files.length) {
    console.log(pc.yellow(T.folderEmpty));
    return;
  }
  row(t().out.tokens, tokenValue(res.totalTokens, counter), undefined, false);
  console.log(pc.dim(T.folderSummary(formatInt(res.files.length), formatInt(res.totalTokens), size(res.totalBytes))));
  const sk = res.skipped;
  console.log(
    pc.dim(
      `${T.folderSkipped(formatInt(sk.ignored), formatInt(sk.binary), formatInt(sk.tooBig), formatInt(sk.lockfile))}${res.usedGitignore ? ` · ${T.folderGitignore}` : ""}`,
    ),
  );
  if (sk.limit) console.log(pc.yellow(T.folderLimit(formatInt(sk.limit))));

  const top = res.files.slice(0, 15);
  title(T.folderTop(top.length));
  const maxPath = Math.max(30, termWidth() - 46);
  table(
    T.folderTopHead,
    top.map((f) => [
      formatInt(f.tokens),
      pct(f.tokens, res.totalTokens),
      bar(f.tokens, res.files[0]?.tokens ?? 1, 14),
      f.path.length > maxPath ? `…${f.path.slice(-maxPath + 1)}` : f.path,
    ]),
    [2, 3],
  );

  title(T.folderExt);
  table(
    T.folderExtHead,
    res.byExt.slice(0, 10).map((e) => [e.ext, formatInt(e.files), formatInt(e.tokens), pct(e.tokens, res.totalTokens)]),
  );

  const dirs = byTopDir(res.files);
  if (dirs.length > 1) {
    title(T.folderDir);
    table(T.folderDirHead, dirs.slice(0, 10).map((d) => [d.dir, formatInt(d.files), formatInt(d.tokens), pct(d.tokens, res.totalTokens)]));
  }

  title(`${T.folderFit}  ${pc.dim(`~${formatInt(res.totalTokens)} tokens · ${model.name}`)}`);
  table(
    T.folderFitHead,
    models.map((m) => {
      const c = computeCost(m, res.totalTokens, 0);
      const fits = c.fitsContext;
      return [
        m.name,
        formatContext(m.contextWindow),
        fits === null ? "—" : fits ? pc.green(`✅ ${T.folderFitPct(pct(res.totalTokens, m.contextWindow ?? 1, 0))}`) : pc.red(`❌ ${pct(res.totalTokens, m.contextWindow ?? 1, 0)}`),
        `${formatUsd(c.inputUsd)}  ${pc.dim(brl(c.inputUsd, rate, opts.iof))}`,
      ];
    }),
  );
  console.log(pc.dim(`\n${T.folderTip}`));
  countNotes([counter]);
  setLastReport(folderReport(res, model, counter, models, rate, opts.iof));
  console.log();
}

// ───────────── 3. Chunking visual ─────────────

async function chunkFlow(dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const T = t().tools;
  const R = t().ragFlow;
  const W = t().why;
  p.note(wrap(T.chunkIntro, 64).join("\n"), T.chunkTitle);
  const src = await askSource();
  const model = await pickModel(dataset, opts, rate, T.countingModel);
  const counter = await counterFor(model);
  tip(W.chunkSize);
  const sizes = [128, 256, 512, 1000, 2000];
  const chunkSize = ok(
    await p.select({
      message: R.chunk,
      initialValue: 512,
      options: sizes.map((v) => ({ value: v, label: `${formatInt(v)} tokens` })),
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
  const show = ok(
    await p.select({
      message: T.chunkShow,
      options: [
        { value: "few", label: T.chunkShowFew },
        { value: "all", label: T.chunkShowAll },
        { value: "none", label: T.chunkShowNone },
      ],
    }),
  );
  await think();
  const plan = chunkDocument(src.content, chunkSize, Math.round((chunkSize * overlapPct) / 100), counter);
  printChunks(plan, counter, src.name, show);
}

const OV = pc.yellow;
const NEW = pc.cyan;

/** Mapa tipo "linha do tempo": cada pedaço é uma barra na sua posição do documento. */
function chunkMap(plan: ChunkPlan): void {
  const T = t().tools;
  const W = Math.max(30, Math.min(60, termWidth() - 20));
  const total = Math.max(1, plan.docTokens);
  const col = (tok: number): number => Math.round((tok / total) * W);
  const rows = plan.chunks.length > 24 ? [...plan.chunks.slice(0, 18), null, ...plan.chunks.slice(-4)] : plan.chunks;
  const hidden = plan.chunks.length - 22;
  for (const c of rows) {
    if (!c) {
      console.log(pc.dim(`  ${"".padStart(5)} ${T.chunkHidden(formatInt(hidden))}`));
      continue;
    }
    const a = col(c.start);
    // Sobreposição pequena some no arredondamento: garante pelo menos 1 coluna.
    const ovEnd = c.index === 1 || plan.overlap === 0 ? a : Math.max(a + 1, col(Math.min(c.end, c.start + plan.overlap)));
    const b = Math.max(col(c.end), ovEnd + 1);
    const line = " ".repeat(a) + OV("▒".repeat(ovEnd - a)) + NEW("█".repeat(Math.max(0, b - ovEnd)));
    console.log(`  ${pc.dim(`#${String(c.index).padEnd(4)}`)} ${line}${" ".repeat(Math.max(0, W - b))} ${c.cutsSentence ? pc.red("✂") : pc.green("✓")}`);
  }
  console.log(pc.dim(`  ${"".padEnd(6)}0${" ".repeat(Math.max(1, W - formatInt(plan.docTokens).length))}${formatInt(plan.docTokens)}`));
  console.log(`  ${"".padEnd(6)}${T.chunkLegend(OV("▒"), NEW("█"), pc.red("✂"))}`);
}

/** Trecho curto: começo e fim do texto, sem quebrar o terminal. */
function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ");
  if (one.length <= max) return one;
  const h = Math.floor(max / 2) - 2;
  return `${one.slice(0, h)} ${pc.dim("…")} ${one.slice(-h)}`;
}

export function printChunks(plan: ChunkPlan, counter: Counter, name: string | null, show: "few" | "all" | "none"): void {
  const T = t().tools;
  title(`${T.chunkTitle}  ${pc.dim(name ?? "")}`);
  const extra = plan.docTokens > 0 ? formatNum(((plan.indexedTokens - plan.docTokens) / plan.docTokens) * 100, 0) : "0";
  console.log(pc.bold(T.chunkSummary(formatInt(plan.docTokens), formatInt(plan.chunks.length), formatInt(plan.indexedTokens), extra)));
  console.log(pc.dim(T.chunkParams(formatInt(plan.chunkSize), formatInt(plan.overlap), formatNum((plan.overlap / plan.chunkSize) * 100, 0))));
  console.log(plan.byTokens ? pc.green(T.chunkExact(counter.source ?? "")) : pc.yellow(T.chunkApprox));

  title(T.chunkMap);
  chunkMap(plan);

  if (show !== "none") {
    title(T.chunkDetail);
    const list = show === "all" || plan.chunks.length <= 4 ? plan.chunks : [...plan.chunks.slice(0, 3), ...plan.chunks.slice(-1)];
    const width = Math.max(40, termWidth() - 8);
    for (const c of list) {
      console.log(pc.bold(`╭─ ${T.chunkHeader(c.index, formatInt(c.start), formatInt(c.end), formatInt(c.tokens))}`));
      // A sobreposição é o fim do pedaço anterior: mostra só o rabo dela.
      const ovMax = Math.floor(width * 0.4);
      const ovOne = c.overlapText.replace(/\s+/g, " ");
      const ovPart = ovOne ? OV(ovOne.length > ovMax ? `…${ovOne.slice(-ovMax)}` : ovOne) : "";
      const body = `${ovPart}${ovPart ? " " : ""}${clip(c.newText, Math.floor(width * 1.6))}`;
      for (const l of wrapAnsi(body, width)) console.log(`${pc.dim("│")}  ${l}`);
      console.log(`${pc.dim("╰─")} ${c.cutsSentence ? pc.red(T.chunkCut) : pc.green(T.chunkClean)}`);
    }
  }

  console.log();
  const n = plan.chunks.length;
  if (plan.cutsSentence > 0) {
    console.log(pc.yellow(T.chunkCutsAll(formatInt(plan.cutsSentence), formatInt(n))));
    console.log(pc.dim(wrap(T.chunkTipCuts, termWidth() - 4).join("\n")));
  } else if (n > 1) console.log(pc.green(T.chunkTipOk));
  if (plan.overlap === 0 && n > 1) console.log(pc.dim(wrap(T.chunkTipNoOverlap, termWidth() - 4).join("\n")));
  countNotes([counter]);
  setLastReport(chunksReport(plan, counter, name));
  console.log();
}

/** Quebra texto com cores ANSI pela largura visível (mantém as cores de cada palavra). */
function wrapAnsi(text: string, width: number): string[] {
  const words = text.split(" ");
  const out: string[] = [];
  let line = "";
  let len = 0;
  for (const w of words) {
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove sequências ANSI
    const wl = w.replace(/\x1b\[[0-9;]*m/g, "").length;
    if (len && len + 1 + wl > width) {
      out.push(line);
      line = w;
      len = wl;
    } else {
      line = line ? `${line} ${w}` : w;
      len += (len ? 1 : 0) + wl;
    }
  }
  if (line) out.push(line);
  return out;
}

// ───────────── 4. Recomendador de modelo ─────────────

async function recommendFlow(dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const T = t().tools;
  p.note(wrap(T.recIntro, 64).join("\n"), T.recTitle);
  const src = await askSource();
  const out = await askOutput(opts);
  const models = visibleModels(dataset, opts.all);
  const counters = await countersFor(models);
  const ref = await counterFor({ tokenizer: "o200k" });
  const sug = suggestQuality(src.content, ref.count(src.content), out);
  const quality = ok(
    await p.select<Quality>({
      message: T.recQuality,
      initialValue: sug.quality,
      options: (["cheap", "mid", "flagship"] as Quality[]).map((q) => ({
        value: q,
        label: `${T.quality[q][0]}${q === sug.quality ? pc.green(` ★ ${T.recSuggested}`) : ""}`,
        hint: T.quality[q][1],
      })),
    }),
  );
  await think();
  const rec = recommendModel(src.content, null, out, models, counters, quality);
  printRecommendation(rec, src.content.length, out, sug.signals, counters, rate, opts);
}

export function printRecommendation(
  rec: Recommendation,
  chars: number,
  out: number,
  signals: string[],
  counters: Map<string, Counter>,
  rate: ExchangeRate | null,
  opts: MenuOptions,
): void {
  const T = t().tools;
  const S = T.signals as Record<string, string>;
  title(T.recTitle);
  row(T.recPrompt, T.recPromptVal(formatInt(chars), formatInt(out)), undefined, false);
  row(T.recSignals, signals.length ? signals.map((s) => S[s] ?? s).join(" · ") : pc.dim(T.recNoSignals), undefined, false);
  row(T.recLevel, `${T.quality[rec.quality][0]} ${pc.dim(`— ${T.quality[rec.quality][1]}`)}`, undefined, false);
  sep();
  /** Comparação com o recomendado: "← recomendado", "3,2× o recomendado" ou "95% mais barato". */
  const vsBest = (id: string, usd: number): string => {
    if (!rec.best) return "";
    if (id === rec.best.model.id) return T.recIsBest;
    const ratio = usd / Math.max(rec.best.cost.totalUsd, 1e-12);
    return ratio < 1 ? T.recCheaper(formatNum((1 - ratio) * 100, 0)) : T.recTimes(formatNum(ratio, 1, 1));
  };
  if (!rec.best) {
    console.log(pc.yellow(T.recNone));
  } else {
    const b = rec.best;
    const counter = counters.get(b.model.id);
    console.log(
      `${pc.bold(T.recBest)} ${pc.bold(pc.green(b.model.name))}  ${pc.dim(`(${b.model.id})`)}\n${" ".repeat(LABEL_W)}${pc.bold(T.recPerCall(formatUsd(b.cost.totalUsd), brl(b.cost.totalUsd, rate, opts.iof)))}`,
    );
    if (counter) row(t().out.tokens, tokenValue(b.cost.inputTokens, counter), undefined, false);
    if (rec.alternatives.length) {
      console.log();
      console.log(pc.dim(T.recAlt));
      for (const a of rec.alternatives)
        console.log(`  ${pad(a.model.name, 22)} ${pad(formatUsd(a.cost.totalUsd), 14, true)}  ${pad(pc.dim(brl(a.cost.totalUsd, rate, opts.iof)), 12)}  ${pc.dim(vsBest(a.model.id, a.cost.totalUsd))}`);
    }
  }
  title(T.recTiers);
  for (const q of ["cheap", "mid", "flagship"] as Quality[]) {
    const c = rec.perTier[q];
    if (!c) continue;
    const vs = vsBest(c.model.id, c.cost.totalUsd);
    console.log(
      `  ${pad(T.quality[q][0] ?? q, 16)} ${pad(c.model.name, 22)} ${pad(formatUsd(c.cost.totalUsd), 14, true)}  ${pad(pc.dim(brl(c.cost.totalUsd, rate, opts.iof)), 12)}  ${vs === T.recIsBest ? pc.green(vs) : pc.dim(vs)}`,
    );
  }
  if (rec.tooSmall.length) console.log(pc.yellow(`\n${T.recTooSmall(rec.tooSmall.map((m) => m.name).join(", "))}`));
  console.log(pc.dim(`\n${T.recToday}`));
  if (rate) console.log(pc.dim(`${t().out.fx} ${rateLine(rate, opts.iof)}`));
  countNotes([...counters.values()]);
  setLastReport(recommendReport(rec, chars, out, signals, rate, opts.iof));
  console.log();
}

// ───────────── Entrada: tokens por texto ou por número ─────────────

export async function askTokens(message: string, how: string, def: number): Promise<{ text: string | null; tokens: number }> {
  const T = t().tools;
  const mode = ok(
    await p.select({
      message: how,
      options: [
        { value: "number", label: T.budgetInputNumber },
        { value: "text", label: T.budgetInputText },
      ],
    }),
  );
  if (mode === "text") {
    const src = await askSource();
    const ref = await counterFor({ tokenizer: "o200k" });
    return { text: src.content, tokens: ref.count(src.content) };
  }
  return { text: null, tokens: await askNumber(message, def, { min: 0, integer: true }) };
}

// ───────────── 6. Cache de prompt ─────────────

async function cacheFlow(dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const T = t().tools;
  p.note(wrap(T.cacheIntro, 64).join("\n"), T.cacheTitle);
  const fixed = await askTokens(T.cacheFixed, T.cacheFixedHow, 5000);
  const variable = await askNumber(T.cacheVariable, 100, { min: 0, integer: true });
  const out = await askOutput(opts);
  const calls = await askNumber(T.cacheCalls, 100, { min: 1, integer: true });
  await think();
  const models = visibleModels(dataset, opts.all);
  const rows = models
    .map((m) => promptCacheSavings(m, { fixedTokens: fixed.tokens, variableTokens: variable, outputTokens: out, calls }))
    .sort((a, b) => a.withCacheUsd - b.withCacheUsd);

  title(`${T.cacheTitle}  ${pc.dim(T.cacheSub(formatInt(fixed.tokens), formatInt(variable), formatInt(out), formatInt(calls)))}`);
  table(
    T.cacheHead,
    rows.map((r) => [
      r.model.name,
      `${formatUsd(r.withoutCacheUsd)}  ${pc.dim(brl(r.withoutCacheUsd, rate, opts.iof))}`,
      r.supported ? `${pc.bold(formatUsd(r.withCacheUsd))}  ${pc.dim(brl(r.withCacheUsd, rate, opts.iof))}` : pc.dim(T.cacheNo),
      r.supported ? pc.green(`−${formatNum(r.savedPct, 0)}%  ${formatUsd(r.savedUsd)}`) : pc.dim("—"),
    ]),
  );
  if (fixed.text !== null) console.log(pc.dim(`(${t().out.tokens} ${formatInt(fixed.tokens)} · o200k_base)`));
  setLastReport(cacheReport(rows, fixed.tokens, variable, out, calls, rate, opts.iof));
  console.log(pc.dim(`\n${wrap(T.cacheNote, termWidth() - 4).join("\n")}`));
  if (rate) console.log(pc.dim(`${t().out.fx} ${rateLine(rate, opts.iof)}`));
  console.log();
}
