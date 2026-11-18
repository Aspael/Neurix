/**
 * Ferramentas de modelo local: detectar hardware, modelos instalados, importar do Hugging Face,
 * local vs API (energia) e benchmark real com o Ollama.
 */
import * as p from "@clack/prompts";
import pc from "picocolors";
import { ollamaModels, ollamaRunning, runOllamaBenchmark, type BenchmarkResult } from "../core/benchmark.ts";
import { detectHardware, inferencePowerW, type Gpu, type Hardware } from "../core/hardware.ts";
import { HfError, importHfModel, searchHfModels, type HfImport } from "../core/hfconfig.ts";
import { findInstalledModels, type InstalledModel, type InstalledScan } from "../core/installed.ts";
import { findKv, GIB, LOCAL_MODELS, QUANTIZATIONS, type KvPrecision, type LocalModel, type Quantization } from "../core/local.ts";
import { defaultGpuW, estimateSpeed, localVsApi, type LocalCostInput, type LocalCostResult, type RunVerdict, type SpeedEstimate } from "../core/localcost.ts";
import { toBrl, type ExchangeRate } from "../currency/exchange.ts";
import { formatBrl, formatInt, formatNum, formatUsd } from "../currency/format.ts";
import { t } from "../i18n/index.ts";
import { visibleModels } from "../prices/load.ts";
import { benchmarkReport, hardwareReport, installedReport, localVsApiReport } from "../report/builders.ts";
import { setLastReport } from "../report/report.ts";
import type { PriceDataset } from "../types/models.ts";
import { canAnimate } from "./anim.ts";
import { askNumber, Back, localFlow, ok, think, tip, type MenuOptions } from "./menu.ts";
import { rateLine, row, sep, table, termWidth, title, wrap, type OutputOptions } from "./output.ts";

const gb = (gib: number): string => `${formatNum(gib, 1, 1)} GB`;
const size = (bytes: number): string => gb(bytes / GIB);

// ───────────── Hardware (com spinner, uma vez por sessão) ─────────────

export async function hardwareWithSpinner(): Promise<Hardware> {
  const s = canAnimate() ? p.spinner() : null;
  s?.start(t().lt.detecting);
  const hw = await detectHardware();
  s?.stop(pc.green(hwLine(hw)));
  return hw;
}

/** "RTX 3060 · 12 GB · agora 18 W" ou "Sem GPU dedicada · roda na CPU · RAM 16 GB". */
export function hwLine(hw: Hardware): string {
  const L = t().lt;
  const g = hw.best;
  if (!g) return L.noGpuLine(gb(hw.ramGib));
  const power = g.powerDrawW !== undefined ? ` · ${L.nowW(formatInt(g.powerDrawW))}` : "";
  return `${g.name} · ${gb(g.vramGib)}${g.integrated ? ` (${L.unified})` : ""}${power} · RAM ${gb(hw.ramGib)}`;
}

export const VERDICT_COLOR: Record<RunVerdict, (s: string) => string> = {
  great: pc.green,
  good: pc.green,
  slow: pc.yellow,
  tooSlow: pc.red,
  noFit: pc.red,
};

// ───────────── Submenu do modelo local ─────────────

type LocalTool = "memory" | "hardware" | "installed" | "compare" | "benchmark";

export async function localMenu(dataset: PriceDataset, opts: MenuOptions, getRate: () => Promise<ExchangeRate | null>): Promise<boolean> {
  const L = t().lt;
  const tool = ok(
    await p.select<LocalTool | "back">({
      message: L.choose,
      options: [
        ...(["memory", "hardware", "installed", "compare", "benchmark"] as LocalTool[]).map((id) => ({ value: id, label: L.items[id][0] ?? id, hint: L.items[id][1] })),
        { value: "back" as const, label: t().tools.back },
      ],
    }),
  );
  if (tool === "back") return false;
  if (tool === "memory") await localFlow(opts);
  else if (tool === "hardware") await hardwareFlow();
  else if (tool === "installed") await installedFlow(opts);
  else if (tool === "compare") await compareFlow(dataset, opts, await getRate());
  else await benchmarkFlow(opts, await getRate());
  return true;
}

// ───────────── 1. Detectar hardware ─────────────

async function hardwareFlow(): Promise<void> {
  const hw = await hardwareWithSpinner();
  printHardware(hw);
}

/** Maior modelo da lista que roda inteiro na GPU (ou na RAM) com 8k de contexto, e a quantização. */
export function biggestThatRuns(hw: Hardware): { model: LocalModel; quant: Quantization; speed: SpeedEstimate } | null {
  const kv = findKv("F16") as KvPrecision;
  const candidates = [...LOCAL_MODELS].sort((a, b) => b.paramsB - a.paramsB);
  for (const m of candidates)
    for (const q of QUANTIZATIONS.filter((x) => x.bits >= 4.9)) {
      const s = estimateSpeed(m, q, kv, Math.min(8192, m.maxContext), { ramGib: hw.ramGib, ramBandwidthGBs: hw.ramBandwidthGBs, gpu: hw.best });
      if (s.verdict === "great" || s.verdict === "good") return { model: m, quant: q, speed: s };
    }
  return null;
}

export function printHardware(hw: Hardware): void {
  const L = t().lt;
  title(L.hwTitle);
  row(L.cpu, `${hw.cpu.model} · ${hw.cpu.cores} ${L.threads}`, undefined, false);
  row("RAM:", `${gb(hw.ramGib)} ${pc.dim(L.free(gb(hw.freeRamGib)))}`, undefined, false);
  row(L.system, `${hw.platform} ${hw.arch}`, undefined, false);

  if (hw.gpus.length) {
    title(L.gpusTitle);
    table(
      L.gpuHead,
      hw.gpus.map((g) => [
        g.name + (g === hw.best ? pc.green(" ★") : ""),
        `${gb(g.vramGib)}${g.integrated ? pc.dim(` ${L.shared}`) : ""}`,
        g.freeGib !== undefined ? gb(g.freeGib) : pc.dim("—"),
        g.powerDrawW !== undefined ? `${formatInt(g.powerDrawW)} W` : pc.dim("—"),
        g.powerLimitW !== undefined ? `${formatInt(g.powerLimitW)} W` : g.tdpW ? pc.dim(`~${formatInt(g.tdpW)} W`) : pc.dim("—"),
        g.bandwidthGBs ? `${formatInt(g.bandwidthGBs)} GB/s` : pc.dim("—"),
        pc.dim(g.source),
      ]),
    );
  } else console.log(pc.yellow(`\n${L.noGpuFound}`));

  title(L.verdictTitle);
  if (!hw.best) console.log(pc.yellow(wrap(L.cpuOnly(gb(hw.ramGib)), termWidth() - 4).join("\n")));
  else if (hw.best.integrated && hw.best.vendor !== "apple") console.log(pc.yellow(L.integratedOnly));
  const big = biggestThatRuns(hw);
  if (big)
    console.log(
      pc.green(L.biggest(pc.bold(big.model.name), big.quant.id, formatNum(big.speed.decodeTps, 0), big.speed.placement === "gpu" ? L.onGpu : L.onCpu)),
    );
  else console.log(pc.red(L.nothingRuns));
  const w = inferencePowerW(hw.best);
  if (w) console.log(pc.dim(L.powerNote(formatInt(w))));
  console.log(pc.dim(`\n${wrap(L.hwNote, termWidth() - 4).join("\n")}`));
  console.log();
  setLastReport(hardwareReport(hw, big));
}

// ───────────── 2. Modelos instalados ─────────────

async function installedFlow(opts: MenuOptions): Promise<void> {
  const L = t().lt;
  const hw = await hardwareWithSpinner();
  const s = canAnimate() ? p.spinner() : null;
  s?.start(L.scanning);
  const scan = await findInstalledModels();
  s?.stop(L.foundModels(scan.models.length));
  const context = Math.min(8192, ...scan.models.map((m) => m.model.maxContext), 8192);
  printInstalled(scan, hw, context);
  if (!scan.models.length) return;

  const pick = ok(
    await p.select<string>({
      message: L.detailAsk,
      options: [{ value: "", label: L.detailNone }, ...scan.models.map((m) => ({ value: m.path, label: m.name, hint: `${m.quant.id} · ${size(m.sizeBytes)}` }))],
    }),
  );
  const chosen = scan.models.find((m) => m.path === pick);
  if (chosen) await localFlow(opts, { model: chosen.model, quant: chosen.quant, hw });
}

export interface InstalledRow {
  m: InstalledModel;
  speed: SpeedEstimate;
}

export function installedRows(scan: InstalledScan, hw: Hardware, context: number): InstalledRow[] {
  const kv = findKv("F16") as KvPrecision;
  return scan.models.map((m) => ({
    m,
    speed: estimateSpeed(m.model, m.quant, kv, Math.min(context, m.model.maxContext), { ramGib: hw.ramGib, ramBandwidthGBs: hw.ramBandwidthGBs, gpu: hw.best }),
  }));
}

export function printInstalled(scan: InstalledScan, hw: Hardware, context: number): void {
  const L = t().lt;
  title(`${L.installedTitle}  ${pc.dim(hwLine(hw))}`);
  if (!scan.models.length) {
    console.log(pc.yellow(L.noneInstalled));
    for (const s of scan.searched) console.log(pc.dim(`  ${s.found ? "✓" : "✗"} ${s.source}: ${s.dir}`));
    console.log(pc.dim(`\n${wrap(L.howInstall, termWidth() - 4).join("\n")}`));
    console.log();
    setLastReport(installedReport(scan, hw, [], context));
    return;
  }
  const rows = installedRows(scan, hw, context);
  table(
    L.installedHead,
    rows.map(({ m, speed }) => [
      m.name,
      m.source,
      size(m.sizeBytes),
      `${formatNum(m.model.paramsB, 1)}B`,
      m.quant.id,
      formatInt(m.model.maxContext),
      L.placement[speed.placement],
      speed.decodeTps > 0 ? `~${formatNum(speed.decodeTps, 0)}` : pc.dim("—"),
      VERDICT_COLOR[speed.verdict](L.verdict[speed.verdict]),
    ]),
  );
  console.log(pc.dim(`\n${L.installedNote(formatInt(context))}`));
  for (const e of scan.errors.slice(0, 3)) console.log(pc.yellow(`  ⚠ ${e.path}: ${e.error}`));
  console.log();
  setLastReport(installedReport(scan, hw, rows, context));
}

// ───────────── Hugging Face (substitui as 5 perguntas) ─────────────

/** Busca no Hugging Face, baixa o config.json e devolve o modelo. Sem rede ou sem config, devolve null. */
export async function askHfModel(): Promise<LocalModel | null> {
  const L = t().lt;
  const query = ok(
    await p.text({
      message: L.hfAsk,
      placeholder: L.hfPlaceholder,
      validate: (v) => (!v?.trim() ? L.hfEmpty : undefined),
    }),
  ).trim();

  let repo = query;
  if (!query.includes("/")) {
    const s = canAnimate() ? p.spinner() : null;
    s?.start(L.hfSearching(query));
    let hits: Awaited<ReturnType<typeof searchHfModels>> = [];
    try {
      hits = await searchHfModels(query);
      s?.stop(L.hfFound(hits.length));
    } catch (err) {
      s?.stop(pc.red(L.hfOffline((err as Error).message)));
      return null;
    }
    if (!hits.length) {
      p.log.warn(L.hfNoHits(query));
      return null;
    }
    repo = ok(
      await p.select({
        message: L.hfPick,
        options: hits.map((h) => ({ value: h.id, label: h.id, hint: L.hfHit(formatInt(h.downloads), formatInt(h.likes)) })),
      }),
    );
  }
  return importWithFallback(repo);
}

async function importWithFallback(repo: string): Promise<LocalModel | null> {
  const L = t().lt;
  const s = canAnimate() ? p.spinner() : null;
  s?.start(L.hfImporting(repo));
  try {
    const imp = await importHfModel(repo);
    s?.stop(pc.green(L.hfImported(imp.repo)));
    showImport(imp);
    return imp.model;
  } catch (err) {
    const e = err as HfError;
    s?.stop(pc.yellow(e.message));
    if (e.kind === "gated") {
      // procura cópias abertas do mesmo modelo (ex.: unsloth/…)
      const name = repo.split("/").pop() ?? repo;
      const owner = repo.split("/")[0];
      const copies = (await searchHfModels(name, 10).catch(() => [])).filter((h) => h.id.split("/")[0] !== owner && !/gguf|awq|gptq|exl2|mlx/i.test(h.id));
      if (copies.length) {
        const alt = ok(
          await p.select({
            message: L.hfGatedPick,
            options: [...copies.slice(0, 6).map((h) => ({ value: h.id, label: h.id, hint: L.hfHit(formatInt(h.downloads), formatInt(h.likes)) })), { value: "", label: L.hfManual }],
          }),
        );
        if (alt) return importWithFallback(alt);
      }
    }
    return null;
  }
}

function showImport(imp: HfImport): void {
  const L = t().lt;
  const f = imp.fields;
  const lines = [
    `${pc.bold(imp.repo)}${imp.architecture ? pc.dim(` · ${imp.architecture}`) : ""}`,
    "",
    `${L.fParams}: ${formatNum(imp.model.paramsB, 2)} B ${pc.dim(`(${L.paramsSource[imp.paramsSource]})`)}`,
    `${L.fLayers}: ${f.num_hidden_layers}`,
    `${L.fKvHeads}: ${f.num_key_value_heads} ${pc.dim(`/ ${f.num_attention_heads}`)}`,
    `${L.fHeadDim}: ${f.head_dim}`,
    `${L.fCtx}: ${formatInt(Number(f.max_position_embeddings))}`,
    ...(f.experts ? [`${L.fExperts}: ${f.experts}`] : []),
    "",
    pc.dim(L.fTokenizer),
  ];
  p.note(lines.join("\n"), L.hfImportTitle);
}

// ───────────── Escolha de modelo (instalado, da lista, Hugging Face ou manual) ─────────────

export interface ModelChoice {
  model: LocalModel;
  /** Quantização real do arquivo instalado (pula a pergunta de quantização). */
  quant?: Quantization;
}

/** Usado por "Local vs API": modelos instalados primeiro, depois a lista e o Hugging Face. */
async function pickLocalModel(scan: InstalledScan | null): Promise<ModelChoice> {
  const L = t().lt;
  const v = ok(
    await p.select<string>({
      message: L.pickModel,
      maxItems: 14,
      options: [
        ...(scan?.models ?? []).map((m) => ({ value: `inst:${m.path}`, label: `📦 ${m.name}`, hint: `${m.quant.id} · ${size(m.sizeBytes)}` })),
        ...LOCAL_MODELS.map((m) => ({ value: m.id, label: m.name, hint: `${formatNum(m.paramsB)}B` })),
        { value: "hf", label: `🤗 ${L.hfOption}`, hint: L.hfOptionHint },
      ],
    }),
  );
  if (v.startsWith("inst:")) {
    const m = scan?.models.find((x) => `inst:${x.path}` === v) as InstalledModel;
    return { model: m.model, quant: m.quant };
  }
  if (v === "hf") {
    const m = await askHfModel();
    if (!m) throw new Back();
    return { model: m };
  }
  return { model: LOCAL_MODELS.find((m) => m.id === v) as LocalModel };
}

// ───────────── 3. Local vs API ─────────────

async function compareFlow(dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const L = t().lt;
  p.note(wrap(L.cmpIntro, 64).join("\n"), L.cmpTitle);
  const hw = await hardwareWithSpinner();
  const scan = await findInstalledModels().catch(() => null);
  const choice = await pickLocalModel(scan);
  let quant = choice.quant;
  if (!quant) {
    const qid = ok(
      await p.select({
        message: t().localFlow.quant,
        initialValue: "Q4_K_M",
        options: QUANTIZATIONS.map((q) => ({ value: q.id, label: q.id, hint: gb((choice.model.paramsB * 1e9 * q.bits) / 8 / GIB) })),
      }),
    );
    quant = QUANTIZATIONS.find((q) => q.id === qid) as Quantization;
  }

  tip(L.volTip);
  const perDay = await askNumber(L.reqDay, 500, { min: 1, integer: true });
  const days = await askNumber(L.daysMonth, 30, { min: 1, integer: true });
  const inTok = await askNumber(L.inPerReq, 1500, { min: 0, integer: true });
  const outTok = await askNumber(L.outPerReq, 400, { min: 1, integer: true });
  const cur = rate ? "R$" : "US$";
  tip(L.tariffTip);
  const tariff = await askNumber(L.tariff(cur), rate ? 0.85 : 0.16, { min: 0 });
  const gpuDefault = defaultGpuW(hw.best);
  tip(L.gpuWTip(hw.best?.powerLimitW ? "nvidia-smi" : hw.best?.tdpW ? "TDP" : "—"));
  const gpuW = await askNumber(L.gpuW, gpuDefault, { min: 0 });
  const systemW = await askNumber(L.systemW, 60, { min: 0 });
  const hardware = await askNumber(L.hardwarePrice(cur), 0, { min: 0, hint: L.hardwareTip });
  const months = hardware > 0 ? await askNumber(L.amortMonths, 24, { min: 1, integer: true }) : 24;
  await think();

  const toUsd = (v: number): number => (rate ? v / toBrl(1, rate, opts.iof) : v);
  const kv = findKv("F16") as KvPrecision;
  const speed = estimateSpeed(choice.model, quant, kv, Math.min(4096, choice.model.maxContext), { ramGib: hw.ramGib, ramBandwidthGBs: hw.ramBandwidthGBs, gpu: hw.best });
  const input: LocalCostInput = {
    inputTokens: perDay * days * inTok,
    outputTokens: perDay * days * outTok,
    tariffUsdKwh: toUsd(tariff),
    gpuW: hw.best ? gpuW : 0,
    systemW,
    hardwareUsd: toUsd(hardware),
    amortMonths: months,
  };
  const res = localVsApi(speed, input, visibleModels(dataset, opts.all));
  printLocalVsApi({ model: choice.model, quant, hw, speed, input, res, rate, opts, perDay, days });
}

export interface CompareView {
  model: LocalModel;
  quant: Quantization;
  hw: Hardware;
  speed: SpeedEstimate;
  input: LocalCostInput;
  res: LocalCostResult;
  rate: ExchangeRate | null;
  opts: OutputOptions;
  perDay?: number;
  days?: number;
}

export function printLocalVsApi(v: CompareView): void {
  const L = t().lt;
  const { res, speed, input, rate, opts } = v;
  const money = (usd: number): string => (rate ? formatBrl(toBrl(usd, rate, opts.iof)) : formatUsd(usd));

  title(`${L.cmpTitle}  ${pc.dim(`${v.model.name} ${v.quant.id} · ${hwLine(v.hw)}`)}`);
  row(L.volume, L.volumeVal(formatInt(input.inputTokens), formatInt(input.outputTokens)), undefined, false);
  row(L.speed, `${speed.decodeTps > 0 ? `~${formatNum(speed.decodeTps, 1)} tok/s` : "—"} ${pc.dim(`(${L.placement[speed.placement]})`)}`, undefined, false);
  if (speed.placement === "noFit") {
    console.log(pc.red(`\n${L.cmpNoFit(gb(speed.totalGib), gb(v.hw.ramGib))}`));
    console.log();
    setLastReport(localVsApiReport(v));
    return;
  }
  row(L.hours, `${formatNum(res.hoursPerMonth, 1)} h/${L.month}${res.keepsUp ? "" : pc.red(`  ⚠ ${L.cantKeepUp}`)}`, undefined, false);
  row(L.energy, `${formatNum(res.kWh, 1)} kWh ${pc.dim(`(${formatInt(input.gpuW + input.systemW)} W)`)} → ${money(res.energyUsd)}`, undefined, false);
  if (res.amortUsd > 0) row(L.amort, money(res.amortUsd), undefined, false);
  sep();
  row(L.localTotal, pc.bold(`${money(res.totalUsd)}/${L.month}`), undefined, false);
  row(L.per1M, `${money(res.per1MUsd)} ${pc.dim(L.per1MNote(formatNum(res.kWhPer1MOut, 2)))}`, undefined, false);

  title(L.vsApiTitle);
  table(
    L.vsApiHead,
    res.api.map((a) => [
      a.model.name,
      money(a.usd),
      a.savedUsd >= 0 ? pc.green(`+${money(a.savedUsd)}`) : pc.red(`−${money(-a.savedUsd)}`),
      a.breakEvenMonths !== null ? `${formatNum(a.breakEvenMonths, 1)} ${L.months}` : pc.dim(input.hardwareUsd > 0 ? L.never : "—"),
    ]),
  );
  const winners = res.api.filter((a) => a.savedUsd > 0);
  console.log();
  if (!res.keepsUp) console.log(pc.yellow(L.cmpSlow));
  else if (winners.length === res.api.length) console.log(pc.green(pc.bold(L.cmpAllWin)));
  else if (winners.length) console.log(pc.green(L.cmpSomeWin(winners.map((a) => a.model.name).join(", "))));
  else console.log(pc.yellow(pc.bold(L.cmpNoWin(res.api[0]?.model.name ?? ""))));
  console.log(pc.dim(`\n${wrap(L.cmpNote, termWidth() - 4).join("\n")}`));
  if (rate) console.log(pc.dim(`${t().out.fx} ${rateLine(rate, opts.iof)}`));
  console.log();
  setLastReport(localVsApiReport(v));
}

// ───────────── 4. Benchmark real (Ollama) ─────────────

async function benchmarkFlow(opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const L = t().lt;
  p.note(wrap(L.benchIntro, 64).join("\n"), L.benchTitle);
  if (!(await ollamaRunning())) {
    p.log.error(L.ollamaOff);
    throw new Back();
  }
  const names = await ollamaModels();
  if (!names.length) {
    p.log.warn(L.ollamaEmpty);
    throw new Back();
  }
  const model = ok(await p.select({ message: L.benchPick, options: names.map((n) => ({ value: n, label: n })) }));
  const maxTokens = ok(
    await p.select({
      message: L.benchTokens,
      initialValue: 256,
      options: [128, 256, 512].map((v) => ({ value: v, label: `${v} tokens` })),
    }),
  );
  const hw = await detectHardware();
  const s = canAnimate() ? p.spinner() : null;
  s?.start(L.benchRunning(model));
  let r: BenchmarkResult;
  try {
    r = await runOllamaBenchmark(model, { maxTokens });
  } catch (err) {
    s?.stop(pc.red((err as Error).message));
    throw new Back();
  }
  s?.stop(pc.green(L.benchDone));
  printBenchmark(r, hw, rate, opts, rate ? 0.85 : 0.16);
}

export function printBenchmark(r: BenchmarkResult, hw: Hardware, rate: ExchangeRate | null, opts: OutputOptions, tariff: number): void {
  const L = t().lt;
  title(`${L.benchTitle}  ${pc.dim(`${r.model} · ${hwLine(hw)}`)}`);
  row(L.benchGen, pc.bold(`${formatNum(r.decodeTps, 1)} tok/s`), undefined, false);
  row(L.benchPrompt, `${formatNum(r.prefillTps, 0)} tok/s ${pc.dim(`(${formatInt(r.promptTokens)} tokens)`)}`, undefined, false);
  row(L.benchLoad, `${formatNum(r.loadSeconds, 1)} s ${pc.dim(L.benchLoadNote)}`, undefined, false);
  row(L.benchOut, `${formatInt(r.outputTokens)} tokens · ${formatNum(r.totalSeconds, 1)} s`, undefined, false);
  sep();
  const estW = r.avgPowerW ?? inferencePowerW(hw.best);
  if (r.avgPowerW !== null) row(L.benchPower, pc.bold(`${formatNum(r.avgPowerW, 0)} W`) + pc.dim(` ${L.benchMeasured(r.powerSamples)}`), undefined, false);
  else row(L.benchPower, estW ? `~${formatInt(estW)} W ${pc.dim(L.benchEstimated)}` : pc.dim(L.benchNoPower), undefined, false);
  if (estW && r.decodeTps > 0) {
    const kWh = ((1e6 / r.decodeTps / 3600) * estW) / 1000;
    const cur = rate ? "R$" : "US$";
    const cost = kWh * tariff;
    row(L.benchPer1M, `${formatNum(kWh, 2)} kWh → ${cur} ${formatNum(cost, 2, 2)} ${pc.dim(L.benchTariff(`${cur} ${formatNum(tariff, 2, 2)}`))}`, undefined, false);
  }
  const verdictTps = r.decodeTps >= 20 ? "great" : r.decodeTps >= 8 ? "good" : r.decodeTps >= 3 ? "slow" : "tooSlow";
  console.log(`\n${VERDICT_COLOR[verdictTps](L.verdict[verdictTps])} ${pc.dim(L.benchVerdictNote)}`);
  console.log();
  setLastReport(benchmarkReport(r, hw, estW ?? null, tariff, rate ? "BRL" : "USD"));
}
