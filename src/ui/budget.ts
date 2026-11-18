/** Telas do Neurix Budget (teto mensal, projeção, cache e lote) e do Neurix check (alerta de custo). */
import * as p from "@clack/prompts";
import pc from "picocolors";
import { BATCH, burnRate, planBudget, type BurnRate, type CheckResult, type PlanRow, type UsageProfile } from "../core/plan.ts";
import { countersFor, type Counter } from "../core/tokens.ts";
import { toBrl, type ExchangeRate } from "../currency/exchange.ts";
import { formatBrl, formatContext, formatInt, formatNum, formatUsd } from "../currency/format.ts";
import { t } from "../i18n/index.ts";
import { visibleModels } from "../prices/load.ts";
import type { ModelPrice, PriceDataset, Provider } from "../types/models.ts";
import { askNumber, askOutput, ok, think, tip, type MenuOptions } from "./menu.ts";
import { countNotes, rateLine, row, sep, table, termWidth, title, wrap, type OutputOptions } from "./output.ts";
import { askTokens } from "./tools.ts";
import { budgetReport, checkReport } from "../report/builders.ts";
import { setLastReport } from "../report/report.ts";

export type Currency = "brl" | "usd";

/** Converte dólares para a moeda do teto (reais quando há cotação). */
export const inCurrency = (usd: number, cur: Currency, rate: ExchangeRate | null, iof: number): string =>
  cur === "brl" && rate ? formatBrl(toBrl(usd, rate, iof)) : formatUsd(usd);

/** Valor digitado na moeda do teto → dólares. */
export const toUsd = (amount: number, cur: Currency, rate: ExchangeRate | null, iof: number): number =>
  cur === "brl" && rate ? amount / toBrl(1, rate, iof) : amount;

const pctTxt = (v: number): string => `${formatNum(v, v < 10 ? 1 : 0)}%`;
const capColor = (pct: number): ((s: string) => string) => (pct >= 100 ? pc.red : pct >= 80 ? pc.yellow : pc.green);
const calls = (n: number): string => (Number.isFinite(n) ? formatInt(n) : "∞");

const PROVIDER_NAME: Record<Provider, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  deepseek: "DeepSeek",
  qwen: "Qwen",
  local: "Local",
};

// ───────────── Menu ─────────────

export async function budgetFlow(dataset: PriceDataset, opts: MenuOptions, rate: ExchangeRate | null): Promise<void> {
  const B = t().budget;
  p.note(wrap(B.intro, 64).join("\n"), B.title);

  let cur: Currency = "usd";
  if (rate)
    cur = ok(
      await p.select<Currency>({
        message: B.currency,
        options: [
          { value: "brl", label: "R$ (real)" },
          { value: "usd", label: "US$ (dólar)" },
        ],
      }),
    );
  else p.log.warn(B.noFx);
  const sym = cur === "brl" ? "R$" : "US$";
  const cap = await askNumber(B.cap(sym), cur === "brl" ? 200 : 40, { min: 0.01 });
  const spent = await askNumber(B.spent(sym), 0, { min: 0 });

  tip(B.perDayTip);
  const perDay = await askNumber(B.perDay, 100, { min: 0, integer: true });
  let activeDays = 30;
  if (perDay > 0) {
    const d = ok(
      await p.select<number>({
        message: B.days,
        options: [
          { value: 30, label: B.daysAll },
          { value: 22, label: B.daysWork },
          { value: 0, label: B.daysCustom },
        ],
      }),
    );
    activeDays = d || (await askNumber(B.daysAsk, 20, { min: 1, integer: true }));
  }

  const input = await askTokens(B.input, B.inputHow, 2000);
  tip(B.fixedTip);
  const fixedPct = ok(
    await p.select<number>({
      message: B.fixed,
      initialValue: 50,
      options: [
        { value: 0, label: B.fixedNone },
        ...[25, 50, 75, 90].map((v) => ({ value: v, label: B.fixedPct(v, formatInt(Math.round((input.tokens * v) / 100))) })),
      ],
    }),
  );
  const out = await askOutput(opts);
  tip(B.batchTip);
  const batchPct = ok(
    await p.select<number>({
      message: B.batch,
      options: [0, 25, 50, 100].map((v, i) => ({ value: v, label: B.batchOpts[i]?.[0] ?? `${v}%`, hint: B.batchOpts[i]?.[1] })),
    }),
  );

  const profile: UsageProfile = {
    inputTokens: input.tokens,
    cachedTokens: Math.round((input.tokens * fixedPct) / 100),
    outputTokens: out,
    cacheHitPct: 90,
    batchPct,
    activeDays,
    ...(perDay > 0 && { requestsPerDay: perDay }),
  };
  const models = visibleModels(dataset, opts.all);
  const counters = await countersFor(models);
  await think();
  const capUsd = toUsd(cap, cur, rate, opts.iof);
  const rows = planBudget(
    models,
    (m) => (input.text !== null ? (counters.get(m.id) as Counter).count(input.text) : input.tokens),
    profile,
    capUsd,
  );
  printBudget({
    rows,
    profile,
    capUsd,
    cur,
    rate,
    opts,
    ...(spent > 0 && { burn: { spentUsd: toUsd(spent, cur, rate, opts.iof), result: burnRate(toUsd(spent, cur, rate, opts.iof), capUsd) } }),
    ...(input.text !== null && { counters: [...counters.values()] }),
  });
}

// ───────────── Resultado ─────────────

export interface BudgetView {
  rows: PlanRow[];
  profile: UsageProfile;
  capUsd: number;
  cur: Currency;
  rate: ExchangeRate | null;
  opts: OutputOptions;
  burn?: { spentUsd: number; result: BurnRate };
  counters?: Counter[];
}

export function printBudget(v: BudgetView): void {
  const B = t().budget;
  const { rows, profile: u, capUsd, cur, rate, opts } = v;
  const money = (usd: number): string => inCurrency(usd, cur, rate, opts.iof);
  const usdNote = cur === "brl" && rate ? pc.dim(` (US$ ${formatNum(capUsd, 2, 2)})`) : "";

  title(`${B.title}  ${pc.dim(B.head(money(capUsd), ""))}${usdNote}`);
  row(
    B.profile,
    B.profileVal(formatInt(u.inputTokens), formatInt(u.cachedTokens), formatInt(u.cacheHitPct), formatInt(u.outputTokens), formatInt(u.batchPct)),
    undefined,
    false,
  );
  row(B.usage, u.requestsPerDay !== undefined ? B.usageVal(formatInt(u.requestsPerDay), formatInt(u.activeDays)) : pc.dim(B.usageNone), undefined, false);

  // Ritmo de gasto
  if (v.burn) {
    const b = v.burn.result;
    const day = new Date().getDate();
    title(B.burnTitle);
    console.log(B.burnSpent(money(v.burn.spentUsd), day));
    console.log(B.burnAvg(money(b.dailyAvg)));
    console.log(capColor(b.capPct)(B.burnProj(money(b.projectedMonth), pctTxt(b.capPct))));
    if (b.remaining <= 0) console.log(pc.red(pc.bold(B.burnGone)));
    else if (b.capDay !== null) {
      console.log(pc.red(pc.bold(B.burnOver(b.capDay))));
      console.log(pc.yellow(B.burnSafe(money(b.safeDailyLeft))));
    } else console.log(pc.green(B.burnOk(money(b.safeDailyLeft))));
  }

  // Custo por requisição em cada estratégia
  title(B.perReqTitle);
  const cell = (n: number | null): string => (n === null ? pc.dim(B.never) : formatUsd(n));
  table(
    B.perReqHead,
    rows.map((r) => [
      r.model.name + (r.fitsContext === false ? pc.red(" ❌") : ""),
      cell(r.perRequest.normal),
      cell(r.perRequest.cache),
      cell(r.perRequest.batch),
      cell(r.perRequest.cacheBatch),
      pc.bold(formatUsd(r.optimized)),
    ]),
  );

  // Projeção
  if (u.requestsPerDay !== undefined) {
    title(B.projTitle);
    table(
      B.projHead,
      rows.map((r) => {
        const pr = r.projection;
        if (!pr) return [r.model.name, "", "", "", "", ""];
        const color = capColor(pr.capPct);
        return [
          r.model.name,
          money(pr.day),
          pc.bold(money(pr.month)),
          money(pr.year),
          color(`${pr.capPct >= 100 ? "⚠ " : ""}${pctTxt(pr.capPct)}`),
          pr.capDay !== null ? pc.red(String(pr.capDay)) : pc.dim(B.never),
        ];
      }),
    );
  }

  // Quantas cabem
  title(B.fitTitle);
  table(
    B.fitHead,
    rows.map((r) => [r.model.name, calls(r.maxPerMonth.normal), pc.bold(pc.green(calls(r.maxPerMonth.optimized))), calls(r.maxPerDay.optimized)]),
  );

  // Alertas
  if (u.requestsPerDay !== undefined) {
    title(B.alertsTitle);
    const over = rows.filter((r) => r.projection && r.projection.capPct >= 100);
    const near = rows.filter((r) => r.projection && r.projection.capPct >= 80 && r.projection.capPct < 100);
    for (const r of over) {
      const pr = r.projection;
      if (pr) console.log(pc.red(`⚠ ${B.alertOver(r.model.name, money(pr.month), pctTxt(pr.capPct), pr.capDay ?? 1)}`));
    }
    if (near.length) console.log(pc.yellow(`⚠ ${B.alert80(near.map((r) => r.model.name).join(", "))}`));
    if (!over.length && !near.length) console.log(pc.green(B.alertNone));
  }

  // Dicas
  title(B.tipsTitle);
  const tips: string[] = [];
  if (u.requestsPerDay !== undefined) {
    // maior economia em dinheiro com cache + lote
    const best = [...rows]
      .filter((r) => r.projection && r.projection.monthNormal > r.projection.month)
      .sort((a, b) => (b.projection?.monthNormal ?? 0) - (b.projection?.month ?? 0) - ((a.projection?.monthNormal ?? 0) - (a.projection?.month ?? 0)))[0];
    if (best?.projection) {
      const saved = best.projection.monthNormal - best.projection.month;
      tips.push(pc.green(B.tipSave(best.model.name, money(saved), pctTxt((saved / best.projection.monthNormal) * 100))));
    }
    const rank = { cheap: 0, mid: 1, flagship: 2 };
    const fits = rows.filter((r) => r.projection && r.projection.capPct <= 100 && r.fitsContext !== false);
    const strongest = [...fits].sort((a, b) => rank[b.model.tier] - rank[a.model.tier] || b.optimized - a.optimized)[0];
    if (strongest?.projection) tips.push(B.tipBest(pc.bold(strongest.model.name), pctTxt(strongest.projection.capPct)));
    else tips.push(pc.yellow(B.tipNoneFits));
  }
  if (u.cachedTokens === 0) tips.push(pc.dim(B.tipCacheOff));
  if (u.batchPct === 0) tips.push(pc.dim(B.tipBatchOff));
  for (const tp of tips) console.log(`• ${tp}`);

  // Lote por provedor
  title(B.batchTitle);
  const providers = [...new Set(rows.map((r) => r.model.provider))];
  for (const pv of providers) {
    const b = BATCH[pv];
    const name = PROVIDER_NAME[pv] ?? pv;
    console.log(
      b.discount !== null && b.api && b.window
        ? `  ${pc.green("✓")} ${B.batchHas(name, b.api, `${formatNum(b.discount * 100, 0)}%`, b.window)}`
        : pc.dim(`  ✗ ${B.batchNo(name)}`),
    );
  }
  console.log(pc.dim(`\n${wrap(B.note, termWidth() - 4).join("\n")}`));
  if (rate) console.log(pc.dim(`${t().out.fx} ${rateLine(rate, opts.iof)}`));
  if (v.counters) countNotes(v.counters);
  setLastReport(budgetReport({ rows, profile: u, capUsd, cur, rate, iof: opts.iof, ...(v.burn && { burn: v.burn }) }));
  console.log();
}

// ───────────── Neurix check ─────────────

export interface CheckView {
  name: string;
  model: ModelPrice;
  counter: Counter;
  result: CheckResult;
  calls: number;
  maxUsd?: number;
  maxTokens?: number;
  cur: Currency;
  rate: ExchangeRate | null;
  iof: number;
}

export function printCheck(v: CheckView): void {
  const C = t().check;
  const { result: r } = v;
  setLastReport(checkReport({ ...v, ...(v.maxUsd !== undefined && { maxUsd: v.maxUsd }) }));
  const money = (usd: number): string =>
    `${formatUsd(usd)}${v.rate ? pc.dim(`  ${formatBrl(toBrl(usd, v.rate, v.iof))}`) : ""}`;
  title(`${C.title}  ${pc.dim(C.target(v.name, v.model.name))}`);
  row(C.tokens, `${v.counter.exact ? "" : "~"}${formatInt(r.tokens)}${v.maxTokens !== undefined ? pc.dim(` / ${formatInt(v.maxTokens)}`) : ""}`, undefined, false);
  row(C.cost, v.calls > 1 ? C.costVal(money(r.costUsd), formatInt(v.calls)) : money(r.costUsd), undefined, false);
  if (v.maxUsd !== undefined) row(C.limit, money(v.maxUsd), undefined, false);
  sep();
  if (v.maxUsd === undefined && v.maxTokens === undefined && !r.overContext) {
    console.log(pc.dim(C.noLimit));
    return;
  }
  if (r.ok) {
    console.log(pc.green(pc.bold(C.ok)));
    return;
  }
  console.log(pc.red(pc.bold(C.over)));
  if (r.overCost && v.maxUsd !== undefined)
    console.log(pc.red(`  • ${C.overCost(formatUsd(r.costUsd), formatUsd(v.maxUsd), pctTxt(((r.costUsd - v.maxUsd) / v.maxUsd) * 100))}`));
  if (r.overTokens && v.maxTokens !== undefined) console.log(pc.red(`  • ${C.overTokens(formatInt(r.tokens), formatInt(v.maxTokens))}`));
  if (r.overContext) console.log(pc.red(`  • ${C.overContext(formatInt(r.tokens), formatContext(v.model.contextWindow))}`));
}
