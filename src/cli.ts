#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { computeCost } from "./core/cost.ts";
import { estimateLocal, findKv, findLocalModel, findQuant, KV_PRECISIONS, LOCAL_MODELS, QUANTIZATIONS } from "./core/local.ts";
import { estimateTokens } from "./core/tokens.ts";
import { loadLang, t } from "./i18n/index.ts";
import { findModel, loadPrices, visibleModels } from "./prices/load.ts";
import { localFlow, mainMenu } from "./ui/menu.ts";
import { printDetail, printLocal, printTable, rateLine, safeRate } from "./ui/output.ts";

interface Options {
  model?: string;
  out: number;
  usd?: number;
  iof: number;
  all: boolean;
  prices?: string;
  refreshFx: boolean;
  explicar: boolean;
  lang?: string;
}

const positiveNumber = (v: string): number => {
  const n = Number(v.replace(",", "."));
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError("precisa ser um número positivo");
  return n;
};

const positiveInt = (v: string): number => {
  // "32k" = 32.768, como nos runtimes locais
  const k = /k$/i.test(v);
  const n = positiveNumber(v.replace(/k$/i, "")) * (k ? 1024 : 1);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError("precisa ser um inteiro maior que zero");
  return n;
};

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const output = (opts: Options, explain = opts.explicar) => ({ ...opts, explain });

const program = new Command()
  .name("neurix")
  .version(pkg.version, "-v, --version", "mostra a versão")
  .enablePositionalOptions()
  .description("Estima tokens e custo de LLMs, em dólar e em real. Sem argumentos, abre o menu.")
  .argument("[texto...]", "texto a analisar (ou via stdin)")
  .option("-m, --model <id>", "modelo específico (ex.: claude-sonnet-5-5)")
  .option("-o, --out <tokens>", "tokens de resposta estimados", positiveNumber, 300)
  .option("--usd <cotação>", "cotação manual do dólar em reais (ex.: 5.40)", positiveNumber)
  .option("--iof <pct>", "soma IOF de compra internacional, em % (ex.: 3.5)", positiveNumber, 0)
  .option("-a, --all", "mostra todos os modelos, inclusive os antigos", false)
  .option("--prices <arquivo>", "usa outro arquivo de preços")
  .option("--refresh-fx", "ignora o cache e consulta o câmbio agora", false)
  .option("-e, --explicar", "explica o significado de cada linha do resultado", false)
  .option("-l, --lang <idioma>", "idioma da interface: pt ou en (fica salvo pelo menu)")
  .hook("preAction", async () => {
    await loadLang((program.opts() as Options).lang);
  })
  .action(async (words: string[], opts: Options) => {
    const dataset = await loadPrices(opts.prices);
    let text = words.join(" ");
    if (!text && !process.stdin.isTTY) text = (await readStdin()).trimEnd();
    // No menu interativo as explicações ficam sempre ligadas.
    if (!text) return mainMenu(dataset, output(opts, true));

    const rate = await safeRate(opts);
    if (opts.model) {
      const model = findModel(dataset, opts.model);
      if (!model) {
        console.error(pc.red(t().cli.modelNotFound(opts.model)));
        console.error(pc.dim(t().cli.available(dataset.models.map((m) => m.id).join(", "))));
        process.exit(1);
      }
      return printDetail(text, model, computeCost(model, estimateTokens(text), opts.out), rate, output(opts));
    }
    printTable(text, visibleModels(dataset, opts.all), opts.out, rate, output(opts));
  });

interface LocalOptions {
  model?: string;
  quant: string;
  context?: number;
  kv: string;
  gpu?: number;
  paralelo: number;
  out: number;
  explicar: boolean;
}

program
  .command("local")
  .description("memória para rodar um modelo no seu PC: pesos, KV cache, overhead e VRAM (sem custo por token)")
  .argument("[texto...]", "texto opcional: o contexto vira os tokens dele + a resposta")
  .option("-m, --model <id>", `modelo local (${LOCAL_MODELS.map((m) => m.id).join(", ")})`)
  .option("-q, --quant <tipo>", `quantização (${QUANTIZATIONS.map((q) => q.id).join(", ")})`, "Q4_K_M")
  .option("-c, --context <tokens>", "tokens de contexto a reservar (ex.: 8192 ou 8k)", positiveInt)
  .option("--kv <tipo>", `precisão do KV cache (${KV_PRECISIONS.map((k) => k.id).join(", ")})`, "F16")
  .option("-g, --gpu <GB>", "VRAM da sua placa, para saber se cabe", positiveNumber)
  .option("-p, --paralelo <n>", "conversas simultâneas (multiplica o KV cache)", positiveInt, 1)
  .option("-o, --out <tokens>", "tokens de resposta somados ao texto", positiveNumber, 300)
  .option("-e, --explicar", "explica o significado de cada linha do resultado", false)
  .action(async (words: string[], lo: LocalOptions) => {
    const opts = { ...(program.opts() as Options), out: lo.out, explicar: lo.explicar };
    if (!lo.model) return localFlow(output(opts, true));

    const model = findLocalModel(lo.model);
    const quant = findQuant(lo.quant);
    const kv = findKv(lo.kv);
    const fail = (msg: string, list: string[]): never => {
      console.error(pc.red(msg));
      console.error(pc.dim(t().cli.available(list.join(", "))));
      process.exit(1);
    };
    if (!model) return fail(t().cli.localNotFound(lo.model), LOCAL_MODELS.map((m) => m.id));
    if (!quant) return fail(t().cli.quantUnknown(lo.quant), QUANTIZATIONS.map((q) => q.id));
    if (!kv) return fail(t().cli.kvUnknown(lo.kv), KV_PRECISIONS.map((k) => k.id));

    let text = words.join(" ");
    if (!text && lo.context === undefined && !process.stdin.isTTY) text = (await readStdin()).trimEnd();
    const textTokens = text ? estimateTokens(text) : null;
    const context = lo.context ?? (textTokens !== null ? textTokens + opts.out : Math.min(8192, model.maxContext));

    const input = { model, quant, kv, context, parallel: lo.paralelo, ...(lo.gpu !== undefined && { vramGib: lo.gpu }) };
    printLocal(input, estimateLocal(input), textTokens, output(opts));
  });

program
  .command("cambio")
  .description("mostra a cotação atual do dólar em reais")
  .option("--usd <cotação>", "cotação manual", positiveNumber)
  .action(async (o: { usd?: number }) => {
    const rate = await safeRate({ usd: o.usd, refreshFx: true });
    if (rate) console.log(rateLine(rate, 0));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(pc.red((err as Error).message));
  process.exit(1);
});
