#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import pc from "picocolors";
import pkg from "../package.json" with { type: "json" };
import { computeCost } from "./core/cost.ts";
import { estimateLocal, findKv, findLocalModel, findQuant, KV_PRECISIONS, LOCAL_MODELS, QUANTIZATIONS, type KvPrecision, type LocalModel, type Quantization } from "./core/local.ts";
import { isCached, localCounter } from "./core/hf.ts";
import { readFile, stat, writeFile } from "node:fs/promises";
import { burnRate, checkLimits, planBudget, type UsageProfile } from "./core/plan.ts";
import type { Counter } from "./core/tokens.ts";
import { toBrl } from "./currency/exchange.ts";
import { formatInt } from "./currency/format.ts";
import { printBudget, printCheck, toUsd, type Currency } from "./ui/budget.ts";
import { basename, resolve } from "node:path";
import { chunkDocument } from "./core/chunking.ts";
import { analyzeFolder } from "./core/folder.ts";
import { optimizePrompt } from "./core/optimize.ts";
import { recommendModel, suggestQuality } from "./core/recommend.ts";
import { counterFor, countersFor } from "./core/tokens.ts";
import { printChunks, printFolder, printOptimize, printRecommendation } from "./ui/tools.ts";
import { loadLang, locale, t } from "./i18n/index.ts";
import { ollamaModels, ollamaRunning, runOllamaBenchmark } from "./core/benchmark.ts";
import { detectHardware, type Gpu, type Hardware } from "./core/hardware.ts";
import { importHfModel } from "./core/hfconfig.ts";
import { findInstalledModels } from "./core/installed.ts";
import { defaultGpuW, estimateSpeed, localVsApi, type LocalCostInput } from "./core/localcost.ts";
import { localReport } from "./report/builders.ts";
import { getLastReport, setLastReport, writeReport } from "./report/report.ts";
import { hwLine, printBenchmark, printHardware, printInstalled, printLocalVsApi } from "./ui/localtools.ts";
import { findModel, loadPrices, priceStatus, visibleModels } from "./prices/load.ts";
import { manualCli, setCommandCatalog } from "./ui/manual.ts";
import { localFlow, mainMenu, printSpeed } from "./ui/menu.ts";
import { printDetail, printLocal, printTable, rateLine, safeRate } from "./ui/output.ts";

interface Options {
  model?: string;
  out: number;
  usd?: number;
  iof: number;
  all: boolean;
  prices?: string;
  refreshFx: boolean;
  explain: boolean;
  lang?: string;
  export?: string;
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

const output = (opts: Options, explain = opts.explain) => ({ ...opts, explain });

const program = new Command()
  .name("neurix")
  .version(pkg.version, "-v, --version", "mostra a versão")
  .enablePositionalOptions()
  .description("Estima tokens e custo de LLMs, em dólar e em real. Sem argumentos, abre o menu.")
  .argument("[text...]", "texto a analisar (ou via stdin)")
  .option("-m, --model <id>", "modelo específico (ex.: claude-sonnet-5-5)")
  .option("-o, --out <tokens>", "tokens de resposta estimados", positiveNumber, 300)
  .option("--usd <rate>", "cotação manual do dólar em reais (ex.: 5.40)", positiveNumber)
  .option("--iof <pct>", "soma IOF de compra internacional, em % (ex.: 3.5)", positiveNumber, 0)
  .option("-a, --all", "mostra todos os modelos, inclusive os antigos", false)
  .option("--prices <file>", "usa outro arquivo de preços")
  .option("--refresh-fx", "ignora o cache e consulta o câmbio agora", false)
  .option("-e, --explain", "explica o significado de cada linha do resultado", false)
  .option("-l, --lang <lang>", "idioma da interface: pt ou en (fica salvo pelo menu)")
  .option("-x, --export <file>", "salva o resultado como relatório (.md, .csv, .json ou .html)")
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
      const counter = await counterFor(model);
      return printDetail(text, model, computeCost(model, counter.count(text), opts.out), rate, output(opts), counter);
    }
    await printTable(text, visibleModels(dataset, opts.all), opts.out, rate, output(opts));
  });

interface LocalOptions {
  model?: string;
  hf?: string;
  quant?: string;
  context?: number;
  kv: string;
  gpu?: number;
  detect?: boolean;
  parallel: number;
  out: number;
  explain: boolean;
}

/**
 * Resolve o modelo local de -m / --hf:
 *  - id da lista (llama-3.1-8b), ou
 *  - nome de um modelo instalado (Ollama/LM Studio: "llama3.1:8b"), com a quantização real do arquivo, ou
 *  - repositório do Hugging Face ("Qwen/Qwen2.5-7B-Instruct" ou "hf:..."), lendo o config.json.
 */
async function resolveLocalModel(id: string | undefined, hf: string | undefined): Promise<{ model: LocalModel; quant?: Quantization }> {
  if (hf || id?.startsWith("hf:") || (id?.includes("/") && !findLocalModel(id))) {
    const repo = (hf ?? id ?? "").replace(/^hf:/, "");
    try {
      console.error(pc.dim(t().lt.hfImporting(repo)));
      return { model: (await importHfModel(repo)).model };
    } catch (err) {
      console.error(pc.red((err as Error).message));
      process.exit(1);
    }
  }
  const builtin = id ? findLocalModel(id) : undefined;
  if (builtin) return { model: builtin };
  const scan = await findInstalledModels();
  const q = (id ?? "").toLowerCase();
  const inst =
    scan.models.find((m) => m.name.toLowerCase() === q) ??
    scan.models.find((m) => m.name.toLowerCase().startsWith(q) || m.path.toLowerCase().endsWith(q));
  if (inst) return { model: inst.model, quant: inst.quant };
  console.error(pc.red(t().cli.localNotFound(id ?? "")));
  console.error(pc.dim(t().cli.available([...LOCAL_MODELS.map((m) => m.id), ...scan.models.map((m) => m.name)].join(", "))));
  process.exit(1);
}

/** GPU para as contas: -g manda; sem -g, a detectada (a não ser com --no-detect). */
async function gpuFor(vram: number | undefined, detect: boolean): Promise<{ hw: Hardware; gpu: Gpu | null }> {
  const hw = await detectHardware();
  const detected = detect && hw.best && !(hw.best.integrated && hw.best.vendor !== "apple") ? hw.best : null;
  if (vram !== undefined) {
    const same = detected && Math.abs(detected.vramGib - vram) < 0.5 ? detected : null;
    return { hw, gpu: same ?? (vram > 0 ? { name: "GPU", vendor: "other", vramGib: vram, integrated: false, source: "manual" } : null) };
  }
  return { hw, gpu: detected };
}

program
  .command("local")
  .description("memória para rodar um modelo no seu PC: pesos, KV cache, overhead, VRAM e velocidade — detecta a sua GPU sozinho")
  .argument("[text...]", "texto opcional: o contexto vira os tokens dele + a resposta")
  .option("-m, --model <id>", "modelo: id da lista, nome de um modelo instalado (ex.: llama3.1:8b) ou repositório do Hugging Face")
  .option("--hf <repo>", "importa a arquitetura do Hugging Face (ex.: Qwen/Qwen2.5-7B-Instruct)")
  .option("-q, --quant <type>", `quantização (${QUANTIZATIONS.map((q) => q.id).join(", ")}); padrão Q4_K_M ou a real do arquivo instalado`)
  .option("-c, --context <tokens>", "tokens de contexto a reservar (ex.: 8192 ou 8k)", positiveInt)
  .option("--kv <type>", `precisão do KV cache (${KV_PRECISIONS.map((k) => k.id).join(", ")})`, "F16")
  .option("-g, --gpu <GB>", "VRAM para simular outra placa (padrão: a detectada; 0 = sem GPU)", positiveNumber)
  .option("--no-detect", "não detecta a GPU (só usa -g)")
  .option("-p, --parallel <n>", "conversas simultâneas (multiplica o KV cache)", positiveInt, 1)
  .option("-o, --out <tokens>", "tokens de resposta somados ao texto", positiveNumber, 300)
  .option("-e, --explain", "explica o significado de cada linha do resultado", false)
  .action(async (words: string[], lo: LocalOptions) => {
    const opts = { ...(program.opts() as Options), out: lo.out, explain: lo.explain };
    if (!lo.model && !lo.hf) return localFlow(output(opts, true));

    const { model, quant: realQuant } = await resolveLocalModel(lo.model, lo.hf);
    const quant = lo.quant ? findQuant(lo.quant) : (realQuant ?? findQuant("Q4_K_M"));
    const kv = findKv(lo.kv);
    const fail = (msg: string, list: string[]): never => {
      console.error(pc.red(msg));
      console.error(pc.dim(t().cli.available(list.join(", "))));
      process.exit(1);
    };
    if (!quant) return fail(t().cli.quantUnknown(lo.quant ?? ""), QUANTIZATIONS.map((q) => q.id));
    if (!kv) return fail(t().cli.kvUnknown(lo.kv), KV_PRECISIONS.map((k) => k.id));

    let text = words.join(" ");
    if (!text && lo.context === undefined && !process.stdin.isTTY) text = (await readStdin()).trimEnd();
    let counted: { tokens: number; counter: Awaited<ReturnType<typeof localCounter>> } | null = null;
    if (text) {
      if (model.hfRepo && !(await isCached(model.hfRepo))) console.error(pc.dim(t().count.downloading(model.hfRepo)));
      const counter = await localCounter(model);
      counted = { tokens: counter.count(text), counter };
    }
    const context = lo.context ?? (counted ? counted.tokens + opts.out : Math.min(8192, model.maxContext));

    const { hw, gpu } = await gpuFor(lo.gpu, lo.detect !== false);
    if (gpu && lo.gpu === undefined) console.error(pc.dim(`🔍 ${hwLine(hw)}`));
    const input = { model, quant, kv, context, parallel: lo.parallel, ...(gpu && { vramGib: gpu.vramGib }) };
    const est = estimateLocal(input);
    printLocal(input, est, counted, output(opts));
    const speed = estimateSpeed(model, quant, kv, context, { ramGib: hw.ramGib, ramBandwidthGBs: hw.ramBandwidthGBs, gpu });
    printSpeed(speed, gpu);
    setLastReport(localReport(input, est, counted, speed, hw, gpu));
  });

// ───────────── Ferramentas ─────────────

async function textArg(file: string | undefined): Promise<{ name: string | null; path: string | null; content: string }> {
  if (file) {
    const full = resolve(file);
    return { name: basename(full), path: full, content: await readFile(full, "utf8") };
  }
  if (!process.stdin.isTTY) return { name: null, path: null, content: await readStdin() };
  console.error(pc.red(t().cli.needInput));
  process.exit(1);
}

async function apiModelOr(id: string | undefined, fallback: string) {
  const dataset = await loadPrices((program.opts() as Options).prices);
  const model = findModel(dataset, id ?? fallback);
  if (!model) {
    console.error(pc.red(t().cli.modelNotFound(id ?? fallback)));
    console.error(pc.dim(t().cli.available(dataset.models.map((m) => m.id).join(", "))));
    process.exit(1);
  }
  return { dataset, model };
}

program
  .command("optimize")
  .description("aponta tokens desperdiçados num prompt (espaços, JSON indentado, linhas em branco...)")
  .argument("[file]", "arquivo do prompt (ou via stdin)")
  .option("-m, --model <id>", "modelo para contar e precificar", "gpt-6.1-sol")
  .option("-s, --save <file>", "salva a versão otimizada neste arquivo")
  .option("--print", "imprime a versão otimizada no final", false)
  .action(async (file: string | undefined, o: { model: string; save?: string; print: boolean }) => {
    const opts = { ...(program.opts() as Options), out: 300 };
    const { model } = await apiModelOr(o.model, "gpt-6.1-sol");
    const src = await textArg(file);
    const counter = await counterFor(model);
    const r = optimizePrompt(src.content, counter.count);
    printOptimize(r, model, counter, await safeRate(opts), output(opts), src.name);
    if (o.print) console.log(r.optimized);
    if (o.save) {
      await writeFile(o.save, r.optimized);
      console.log(pc.green(t().tools.optSavedTo(resolve(o.save))));
    }
  });

program
  .command("folder")
  .description("conta os tokens de cada arquivo de uma pasta ou repositório")
  .argument("[dir]", "pasta a analisar", ".")
  .option("-m, --model <id>", "modelo para contar e precificar", "gpt-6.1-sol")
  .option("--ext <list>", "só estas extensões, separadas por vírgula (ex.: ts,md)")
  .option("--hidden", "inclui arquivos e pastas ocultos (.algo)", false)
  .action(async (dir: string, o: { model: string; ext?: string; hidden: boolean }) => {
    const opts = { ...(program.opts() as Options), out: 300 };
    const { dataset, model } = await apiModelOr(o.model, "gpt-6.1-sol");
    const counter = await counterFor(model);
    const res = await analyzeFolder(resolve(dir), counter.count, {
      includeHidden: o.hidden,
      ...(o.ext && { extensions: o.ext.split(",").map((s) => s.trim()) }),
    });
    printFolder(res, model, counter, visibleModels(dataset, opts.all), await safeRate(opts), output(opts));
  });

program
  .command("chunks")
  .description("mostra como um documento é cortado em pedaços para RAG (mapa, sobreposição, cortes)")
  .argument("[file]", "documento (ou via stdin)")
  .option("-m, --model <id>", "modelo cujo tokenizer corta os pedaços", "gpt-6.1-sol")
  .option("-s, --size <tokens>", "tokens por pedaço", positiveInt, 512)
  .option("--overlap <pct>", "sobreposição em % do pedaço", positiveNumber, 10)
  .option("--all", "mostra todos os pedaços em detalhe", false)
  .option("--map-only", "mostra só o mapa", false)
  .action(async (file: string | undefined, o: { model: string; size: number; overlap: number; all: boolean; mapOnly: boolean }) => {
    const { model } = await apiModelOr(o.model, "gpt-6.1-sol");
    const src = await textArg(file);
    const counter = await counterFor(model);
    const plan = chunkDocument(src.content, o.size, Math.round((o.size * Math.min(o.overlap, 50)) / 100), counter);
    printChunks(plan, counter, src.name, o.mapOnly ? "none" : o.all ? "all" : "few");
  });

program
  .command("recommend")
  .description("diz qual é o modelo mais barato que dá conta de um prompt agora")
  .argument("[text...]", "o prompt (ou via stdin)")
  .option("-o, --out <tokens>", "tokens de resposta estimados", positiveNumber, 300)
  .option("--level <level>", "qualidade mínima: cheap, mid ou flagship (padrão: sugerida pelo prompt)")
  .action(async (words: string[], o: { out: number; level?: string }) => {
    const opts = { ...(program.opts() as Options), out: o.out };
    const dataset = await loadPrices(opts.prices);
    let text = words.join(" ");
    if (!text && !process.stdin.isTTY) text = await readStdin();
    if (!text) {
      console.error(pc.red(t().cli.needInput));
      process.exit(1);
    }
    const models = visibleModels(dataset, opts.all);
    const counters = await countersFor(models);
    const ref = await counterFor({ tokenizer: "o200k" });
    const sug = suggestQuality(text, ref.count(text), o.out);
    const level = (["cheap", "mid", "flagship"] as const).find((q) => q === o.level) ?? sug.quality;
    const rec = recommendModel(text, null, o.out, models, counters, level);
    printRecommendation(rec, text.length, o.out, sug.signals, counters, await safeRate(opts), output(opts));
  });

// ───────────── Neurix Budget e Neurix check ─────────────

interface BudgetOptions {
  cap: number;
  currency: string;
  requests?: number;
  days: number;
  input: number;
  textFile?: string;
  fixed?: number;
  fixedPct?: number;
  cacheHit: number;
  output: number;
  batch: number;
  spent?: number;
}

program
  .command("budget")
  .description("teto mensal: quantas requisições cabem, projeção por dia/mês/ano, cache de prompt e lote por provedor")
  .requiredOption("-c, --cap <amount>", "teto mensal (na moeda de --currency)", positiveNumber)
  .option("--currency <brl|usd>", "moeda do teto e do gasto", "brl")
  .option("-r, --requests <n>", "requisições por dia (sem isso, mostra só quantas cabem)", positiveNumber)
  .option("-d, --days <n>", "dias de uso no mês (30 = todo dia, 22 = dias úteis)", positiveInt, 30)
  .option("-i, --input <tokens>", "tokens de entrada por requisição", positiveNumber, 2000)
  .option("--text-file <file>", "conta a entrada a partir de um arquivo (cada modelo com seu tokenizer)")
  .option("-f, --fixed <tokens>", "tokens fixos por requisição que podem ir para o cache")
  .option("--fixed-pct <pct>", "parte fixa em % da entrada (alternativa a --fixed)", positiveNumber)
  .option("--cache-hit <pct>", "% das requisições que acertam o cache", positiveNumber, 90)
  .option("-o, --output <tokens>", "tokens de resposta por requisição", positiveNumber, 300)
  .option("-b, --batch <pct>", "% do uso que pode ir em lote (batch, até 24 h)", positiveNumber, 0)
  .option("-s, --spent <amount>", "quanto já gastou este mês (mostra o ritmo e quando o teto acaba)", positiveNumber)
  .action(async (o: BudgetOptions) => {
    const opts = { ...(program.opts() as Options), out: o.output };
    const dataset = await loadPrices(opts.prices);
    const rate = await safeRate(opts);
    let cur: Currency = o.currency.toLowerCase().startsWith("u") ? "usd" : "brl";
    if (cur === "brl" && !rate) {
      console.error(pc.yellow(t().budget.noFx));
      cur = "usd";
    }
    const text = o.textFile ? await readFile(resolve(o.textFile), "utf8") : null;
    const models = visibleModels(dataset, opts.all);
    const counters = await countersFor(models);
    const ref = await counterFor({ tokenizer: "o200k" });
    const inputTokens = text !== null ? ref.count(text) : o.input;
    const fixed = Math.round(o.fixed !== undefined ? Number(o.fixed) : o.fixedPct !== undefined ? (inputTokens * Math.min(100, o.fixedPct)) / 100 : 0);
    const profile: UsageProfile = {
      inputTokens,
      cachedTokens: Math.min(fixed, inputTokens),
      outputTokens: o.output,
      cacheHitPct: Math.min(100, o.cacheHit),
      batchPct: Math.min(100, o.batch),
      activeDays: Math.min(31, o.days),
      ...(o.requests !== undefined && { requestsPerDay: o.requests }),
    };
    const capUsd = toUsd(o.cap, cur, rate, opts.iof);
    const rows = planBudget(models, (m) => (text !== null ? (counters.get(m.id) as Counter).count(text) : inputTokens), profile, capUsd);
    const spentUsd = o.spent !== undefined ? toUsd(o.spent, cur, rate, opts.iof) : undefined;
    printBudget({
      rows,
      profile,
      capUsd,
      cur,
      rate,
      opts: output(opts),
      ...(spentUsd !== undefined && { burn: { spentUsd, result: burnRate(spentUsd, capUsd) } }),
      ...(text !== null && { counters: [...counters.values()] }),
    });
  });

interface CheckOptions {
  model: string;
  maxUsd?: number;
  maxBrl?: number;
  maxTokens?: number;
  calls: number;
  out: number;
  json: boolean;
}

program
  .command("check")
  .description("alerta de custo: sai com erro (código 1) se o arquivo/pasta passar do limite — útil em CI e pre-commit")
  .argument("<target>", "arquivo ou pasta")
  .option("-m, --model <id>", "modelo para contar e precificar", "gpt-6.1-sol")
  .option("--max-usd <amount>", "custo máximo em dólar", positiveNumber)
  .option("--max-brl <amount>", "custo máximo em real", positiveNumber)
  .option("--max-tokens <n>", "máximo de tokens de entrada", positiveNumber)
  .option("-c, --calls <n>", "multiplica o custo por este número de chamadas", positiveInt, 1)
  .option("-o, --out <tokens>", "tokens de resposta por chamada", positiveNumber, 0)
  .option("--json", "saída em JSON (para scripts)", false)
  .action(async (target: string, o: CheckOptions) => {
    const opts = program.opts() as Options;
    const { model } = await apiModelOr(o.model, "gpt-6.1-sol");
    const full = resolve(target);
    const st = await stat(full).catch(() => null);
    if (!st) {
      console.error(pc.red(t().fileFlow.notFound(full)));
      process.exit(2);
    }
    const counter = await counterFor(model);
    let tokens: number;
    let name = basename(full);
    if (st.isDirectory()) {
      const res = await analyzeFolder(full, counter.count);
      tokens = res.totalTokens;
      name = `${name}/ (${t().check.folder(formatInt(res.files.length))})`;
    } else tokens = counter.count(await readFile(full, "utf8"));

    const rate = o.maxBrl !== undefined || !o.json ? await safeRate(opts) : null;
    if (o.maxBrl !== undefined && !rate) {
      console.error(pc.red(t().check.noFx));
      process.exit(2);
    }
    const brlLimitUsd = o.maxBrl !== undefined && rate ? toUsd(o.maxBrl, "brl", rate, opts.iof) : undefined;
    const maxUsd = [o.maxUsd, brlLimitUsd].filter((x): x is number => x !== undefined).reduce<number | undefined>((a, b) => (a === undefined ? b : Math.min(a, b)), undefined);
    const result = checkLimits(model, tokens, o.out, o.calls, {
      ...(maxUsd !== undefined && { maxUsd }),
      ...(o.maxTokens !== undefined && { maxTokens: o.maxTokens }),
    });

    if (o.json) {
      console.log(
        JSON.stringify(
          {
            target: full,
            model: model.id,
            tokens,
            tokens_exact: counter.exact,
            calls: o.calls,
            cost_usd: result.costUsd,
            ...(rate && { cost_brl: toBrl(result.costUsd, rate, opts.iof) }),
            limits: { max_usd: maxUsd ?? null, max_tokens: o.maxTokens ?? null },
            over_cost: result.overCost,
            over_tokens: result.overTokens,
            over_context: result.overContext,
            ok: result.ok,
          },
          null,
          2,
        ),
      );
    } else {
      printCheck({
        name,
        model,
        counter,
        result,
        calls: o.calls,
        ...(maxUsd !== undefined && { maxUsd }),
        ...(o.maxTokens !== undefined && { maxTokens: o.maxTokens }),
        cur: "usd",
        rate,
        iof: opts.iof,
      });
      console.log();
    }
    process.exitCode = result.ok ? 0 : 1;
  });

// ───────────── Hardware, modelos instalados, local vs API, benchmark ─────────────

program
  .command("hardware")
  .alias("gpu")
  .description("detecta GPU, VRAM, energia, RAM e CPU — e o maior modelo que roda bem")
  .action(async () => {
    printHardware(await detectHardware());
  });

program
  .command("installed")
  .description("modelos instalados (Ollama, LM Studio, pastas com .gguf) e quais rodam bem no seu PC")
  .option("--dir <dir...>", "outras pastas com arquivos .gguf")
  .option("-c, --context <tokens>", "contexto para a estimativa de velocidade", positiveInt, 8192)
  .action(async (o: { dir?: string[]; context: number }) => {
    const [hw, scan] = await Promise.all([detectHardware(), findInstalledModels(o.dir ?? [])]);
    printInstalled(scan, hw, o.context);
  });

interface CompareOptions {
  model?: string;
  hf?: string;
  quant?: string;
  requests: number;
  days: number;
  input: number;
  output: number;
  tariff?: number;
  gpuW?: number;
  systemW: number;
  hardware: number;
  months: number;
  gpu?: number;
}

program
  .command("local-vs-api")
  .description("local vs API: energia elétrica (+ a placa) contra pagar a API pelos mesmos tokens")
  .option("-m, --model <id>", "modelo local (id, instalado ou repositório do Hugging Face)", "llama-3.1-8b")
  .option("--hf <repo>", "importa a arquitetura do Hugging Face")
  .option("-q, --quant <type>", "quantização (padrão Q4_K_M ou a real do arquivo instalado)")
  .option("-r, --requests <n>", "requisições por dia", positiveNumber, 500)
  .option("-d, --days <n>", "dias de uso no mês", positiveInt, 30)
  .option("-i, --input <tokens>", "tokens de entrada por requisição", positiveNumber, 1500)
  .option("-o, --output <tokens>", "tokens de saída por requisição", positiveNumber, 400)
  .option("-t, --tariff <amount>", "tarifa de energia por kWh (R$ com cotação; senão US$)", positiveNumber)
  .option("--gpu-w <W>", "potência da GPU gerando (padrão: 75% do limite/TDP detectado)", positiveNumber)
  .option("--system-w <W>", "resto do PC enquanto roda", positiveNumber, 60)
  .option("--hardware <amount>", "preço do hardware para amortizar (0 = já tenho)", positiveNumber, 0)
  .option("--months <n>", "amortizar em quantos meses", positiveInt, 24)
  .option("-g, --gpu <GB>", "simular outra placa com esta VRAM", positiveNumber)
  .action(async (o: CompareOptions) => {
    const opts = { ...(program.opts() as Options), out: o.output };
    const dataset = await loadPrices(opts.prices);
    const rate = await safeRate(opts);
    const { model, quant: realQuant } = await resolveLocalModel(o.model, o.hf);
    const quant = o.quant ? findQuant(o.quant) : (realQuant ?? findQuant("Q4_K_M"));
    if (!quant) {
      console.error(pc.red(t().cli.quantUnknown(o.quant ?? "")));
      process.exit(1);
    }
    const { hw, gpu } = await gpuFor(o.gpu, true);
    const toUsd = (v: number): number => (rate ? v / toBrl(1, rate, opts.iof) : v);
    const kv = findKv("F16") as KvPrecision;
    const speed = estimateSpeed(model, quant, kv, Math.min(4096, model.maxContext), { ramGib: hw.ramGib, ramBandwidthGBs: hw.ramBandwidthGBs, gpu });
    const input: LocalCostInput = {
      inputTokens: o.requests * o.days * o.input,
      outputTokens: o.requests * o.days * o.output,
      tariffUsdKwh: toUsd(o.tariff ?? (rate ? 0.85 : 0.16)),
      gpuW: gpu ? (o.gpuW ?? defaultGpuW(gpu)) : 0,
      systemW: o.systemW,
      hardwareUsd: toUsd(o.hardware),
      amortMonths: o.months,
    };
    const res = localVsApi(speed, input, visibleModels(dataset, opts.all));
    printLocalVsApi({ model, quant, hw: gpu === hw.best ? hw : { ...hw, best: gpu }, speed, input, res, rate, opts: output(opts) });
  });

program
  .command("benchmark")
  .alias("bench")
  .description("benchmark real com o Ollama: tokens/s medidos e, com NVIDIA, o consumo da GPU durante a geração")
  .argument("[model]", "modelo do Ollama (ex.: llama3.2:3b); sem ele, lista os disponíveis")
  .option("-n, --tokens <n>", "tokens a gerar", positiveInt, 256)
  .option("-t, --tariff <amount>", "tarifa de energia por kWh", positiveNumber)
  .action(async (model: string | undefined, o: { tokens: number; tariff?: number }) => {
    const opts = program.opts() as Options;
    if (!(await ollamaRunning())) {
      console.error(pc.red(t().lt.ollamaOff));
      process.exit(2);
    }
    const names = await ollamaModels();
    if (!model) {
      if (!names.length) console.error(pc.yellow(t().lt.ollamaEmpty));
      for (const n of names) console.log(n);
      return;
    }
    console.error(pc.dim(t().lt.benchRunning(model)));
    const [hw, r] = await Promise.all([detectHardware(), runOllamaBenchmark(model, { maxTokens: o.tokens })]);
    const rate = await safeRate(opts);
    printBenchmark(r, hw, rate, output({ ...opts, out: 0 }), o.tariff ?? (rate ? 0.85 : 0.16));
  });

// ───────────── Preços e manual ─────────────

program
  .command("prices")
  .description("de onde vem a tabela de preços, quando foi gerada e quantos modelos tem; --refresh baixa a mais nova")
  .option("-u, --refresh", "ignora o cache de 24 h e baixa a tabela do GitHub agora", false)
  .action(async (o: { refresh: boolean }) => {
    const opts = program.opts() as Options;
    await loadPrices(opts.prices, { refresh: o.refresh });
    const st = priceStatus();
    const P = t().prices;
    if (!st) return;
    const when = (iso: string): string => new Date(iso).toLocaleString(locale(), { dateStyle: "short", timeStyle: "short" });
    console.log();
    console.log(pc.bold(P.title));
    console.log(pc.dim("─".repeat(56)));
    console.log(`${pc.dim(P.source.padEnd(18))}${st.source === "remote" || st.source === "cache" ? pc.green(P.sources[st.source]) : P.sources[st.source]}${st.source === "bundled" && st.fetchedAt && !st.error ? pc.dim(` (${P.sameAsRemote})`) : ""}`);
    console.log(`${pc.dim(P.generated.padEnd(18))}${when(st.generatedAt)}`);
    if (st.fetchedAt) console.log(`${pc.dim(P.fetched.padEnd(18))}${when(st.fetchedAt)}`);
    console.log(`${pc.dim(P.models.padEnd(18))}${st.models}`);
    console.log(`${pc.dim(P.url.padEnd(18))}${pc.dim(st.url)}`);
    if (st.error === "offline") console.log(pc.yellow(`\n${P.offline}`));
    else if (st.error) console.log(pc.yellow(`\n${P.error(st.error)}`));
    console.log(pc.dim(`\n${P.howItWorks}`));
    console.log();
  });

program
  .command("manual")
  .description("manual para iniciantes: glossário por categoria e todos os comandos com opções e exemplos")
  .argument("[query]", "um comando (ex.: budget) ou um termo (ex.: kv cache)")
  .option("--terms", "só o glossário", false)
  .option("--commands", "só os comandos", false)
  .action((query: string | undefined, o: { terms: boolean; commands: boolean }) => {
    const part = o.terms && !o.commands ? "terms" : o.commands && !o.terms ? "commands" : "all";
    if (!manualCli(query, part)) process.exitCode = 1;
  });

program
  .command("mcp")
  .description("inicia o servidor MCP (stdio) para usar o Neurix no Claude Code, Cursor, VS Code etc.")
  .action(async () => {
    const { startMcpServer } = await import("./mcp.ts");
    await startMcpServer();
  });

program
  .command("fx")
  .description("mostra a cotação atual do dólar em reais")
  .option("--usd <rate>", "cotação manual", positiveNumber)
  .action(async (o: { usd?: number }) => {
    const rate = await safeRate({ usd: o.usd, refreshFx: true });
    if (rate) console.log(rateLine(rate, 0));
  });

// ───────────── Exportar relatório (--export arquivo.md|.csv|.json|.html) ─────────────

for (const c of program.commands)
  if (c.name() !== "mcp" && c.name() !== "fx") c.option("-x, --export <file>", "salva o resultado como relatório (.md, .csv, .json ou .html)");

setCommandCatalog(program);

program.hook("postAction", async (_root, action) => {
  const file = (action.opts() as { export?: string }).export ?? (program.opts() as Options).export;
  if (!file) return;
  const report = getLastReport();
  if (!report) {
    console.error(pc.yellow(t().rep.noReport));
    return;
  }
  const full = await writeReport(report, file, undefined, locale());
  console.error(pc.green(t().rep.saved(full)));
});

program.parseAsync().catch((err: unknown) => {
  console.error(pc.red((err as Error).message));
  process.exit(1);
});
