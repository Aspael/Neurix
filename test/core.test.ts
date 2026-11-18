/** Testes do núcleo: contagem, custo, otimizador, chunking, pasta, recomendador, orçamento/cache, local, formatos e i18n. */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { callsForBudget, promptCacheSavings } from "../src/core/budget.ts";
import { chunkDocument } from "../src/core/chunking.ts";
import { computeCost } from "../src/core/cost.ts";
import { analyzeFolder } from "../src/core/folder.ts";
import { formatVariants } from "../src/core/formats.ts";
import { estimateLocal, findKv, findLocalModel, findQuant, GIB } from "../src/core/local.ts";
import { minifyJsonBlocks, optimizePrompt } from "../src/core/optimize.ts";
import { burnRate, checkLimits, hasBatch, planBudget, requestCost, type UsageProfile } from "../src/core/plan.ts";
import { countChunks, simulateRag } from "../src/core/rag.ts";
import { recommendModel, suggestQuality, TIER_RANK } from "../src/core/recommend.ts";
import { counterFor, countersFor, estimateTokens, type Counter } from "../src/core/tokens.ts";
import { en } from "../src/i18n/en.ts";
import { pt } from "../src/i18n/pt.ts";
import { findModel, loadPrices, visibleModels } from "../src/prices/load.ts";
import type { ModelPrice, PriceDataset } from "../src/types/models.ts";

// usa a tabela do repositório (sem baixar a publicada)
process.env.NEURIX_OFFLINE = "1";

let dataset: PriceDataset;
let openai: Counter;
before(async () => {
  dataset = await loadPrices();
  openai = await counterFor({ tokenizer: "o200k" });
});

const fakeModel = (over: Partial<ModelPrice> = {}): ModelPrice => ({
  id: "fake",
  name: "Fake",
  provider: "openai",
  tier: "mid",
  featured: true,
  legacy: false,
  tokenizer: "o200k",
  contextWindow: 100_000,
  maxOutput: 8000,
  input: 2,
  output: 10,
  source: "manual",
  ...over,
});

describe("tokens", () => {
  test("estimativa chars/3.5", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("abc"), 1);
    assert.equal(estimateTokens("abcdefg"), 2);
  });

  test("OpenAI conta exato com o200k_base", () => {
    assert.equal(openai.exact, true);
    assert.equal(openai.method, "tiktoken");
    assert.equal(openai.count("hello world"), 2);
    const ids = openai.encode?.("Olá, mundo!") ?? [];
    assert.equal(openai.decode?.(ids), "Olá, mundo!");
  });

  test("Claude e Gemini são estimativa", async () => {
    for (const tokenizer of ["claude", "gemini"] as const) {
      const c = await counterFor({ tokenizer });
      assert.equal(c.exact, false);
      assert.equal(c.method, tokenizer);
      assert.equal(c.count("abcdefg"), 2);
    }
  });

  test("countersFor reaproveita o tokenizer entre modelos", async () => {
    const models = visibleModels(dataset, true);
    const map = await countersFor(models);
    assert.equal(map.size, models.length);
    const gpts = models.filter((m) => m.tokenizer === "o200k");
    if (gpts.length > 1) assert.equal(map.get(gpts[0]?.id ?? ""), map.get(gpts[1]?.id ?? ""));
  });
});

describe("custo", () => {
  test("1M de tokens de entrada custa o preço de entrada", () => {
    const c = computeCost(fakeModel(), 1_000_000, 0);
    assert.equal(c.inputUsd, 2);
    assert.equal(c.outputUsd, 0);
    assert.equal(c.fitsContext, false);
  });

  test("faixa de contexto longo é aplicada acima do limite", () => {
    const m = fakeModel({ contextWindow: 1_000_000, tiers: [{ above: 200_000, input: 4, output: 20 }] });
    assert.equal(computeCost(m, 100_000, 0).price.input, 2);
    const long = computeCost(m, 300_000, 0);
    assert.equal(long.price.input, 4);
    assert.equal(long.tierAbove, 200_000);
  });

  test("todos os modelos do catálogo têm preço e id únicos", () => {
    const ids = new Set<string>();
    for (const m of dataset.models) {
      assert.ok(m.input >= 0 && m.output >= 0, m.id);
      assert.ok(!ids.has(m.id), `id repetido: ${m.id}`);
      ids.add(m.id);
    }
    assert.ok(findModel(dataset, dataset.models[0]?.id ?? ""));
  });
});

describe("otimizador de prompt", () => {
  const prompt = [
    "Você é um assistente.   Responda    em português.   ",
    "",
    "",
    "",
    "    Dados:",
    "{",
    '    "nome": "Ana",',
    '    "itens": [1, 2]',
    "}",
    "- item",
    "  - subitem",
    "Esta linha é repetida no prompt várias vezes.",
    "Esta linha é repetida no prompt várias vezes.",
    "```python",
    "def f():",
    "    return 1",
    "```",
  ].join("\n");

  test("acha e corrige o desperdício", () => {
    const r = optimizePrompt(prompt, openai.count);
    const kinds = r.issues.map((i) => i.kind);
    for (const k of ["prettyJson", "trailingSpaces", "indentation", "multiSpaces", "duplicateLines"]) assert.ok(kinds.includes(k as never), k);
    assert.ok(r.optimizedTokens < r.originalTokens);
    assert.equal(r.originalTokens - r.optimizedTokens, r.issues.filter((i) => i.applied).reduce((s, i) => s + i.tokensSaved, 0));
    assert.ok(r.optimized.includes('{"nome":"Ana","itens":[1,2]}'));
    assert.ok(!/[ \t]+$/m.test(r.optimized));
    assert.ok(r.optimized.includes("    return 1"), "recuo dentro de bloco de código é mantido");
    assert.ok(r.optimized.includes("  - subitem"), "lista aninhada mantém o recuo");
  });

  test("linhas repetidas só são apontadas, com a linha do original", () => {
    const r = optimizePrompt(prompt, openai.count);
    const dup = r.issues.find((i) => i.kind === "duplicateLines");
    assert.equal(dup?.applied, false);
    assert.equal(dup?.examples[0]?.line, 13);
    assert.equal(r.optimized.split("Esta linha é repetida").length - 1, 2);
  });

  test("texto já enxuto não tem problemas", () => {
    const r = optimizePrompt("Responda em português.", openai.count);
    assert.equal(r.issues.length, 0);
    assert.equal(r.optimized, "Responda em português.");
  });

  test("minifica JSON inteiro e blocos ```json", () => {
    assert.equal(minifyJsonBlocks('{\n  "a": 1\n}').text, '{"a":1}');
    const fenced = minifyJsonBlocks('Dados:\n```json\n{\n  "a": [1,\n 2]\n}\n```\nfim');
    assert.equal(fenced.text, 'Dados:\n```json\n{"a":[1,2]}\n```\nfim');
    assert.equal(fenced.blocks[0]?.line, 3);
  });
});

describe("chunking", () => {
  const doc = "Primeira frase do documento. ".repeat(60);

  test("corta por tokens com sobreposição e reconstrói o documento", () => {
    const plan = chunkDocument(doc, 100, 20, openai);
    assert.equal(plan.byTokens, true);
    assert.equal(plan.docTokens, openai.count(doc));
    assert.equal(plan.chunks.length, countChunks(plan.docTokens, 100, 20));
    for (const c of plan.chunks.slice(0, -1)) assert.equal(c.tokens, 100);
    assert.equal(plan.chunks[1]?.start, 80);
    const rebuilt = plan.chunks.map((c, i) => (i === 0 ? c.overlapText + c.newText : c.newText)).join("");
    assert.equal(rebuilt, doc);
    for (let i = 1; i < plan.chunks.length; i++) {
      const prev = plan.chunks[i - 1];
      const cur = plan.chunks[i];
      assert.ok(prev && cur && (prev.overlapText + prev.newText).endsWith(cur.overlapText), `sobreposição do #${i + 1}`);
    }
  });

  test("sem tokenizer público corta por caracteres", async () => {
    const plan = chunkDocument(doc, 100, 0, await counterFor({ tokenizer: "claude" }));
    assert.equal(plan.byTokens, false);
    assert.equal(plan.chunks.map((c) => c.newText).join(""), doc);
  });

  test("simulação de RAG usa a mesma contagem de pedaços", () => {
    const r = simulateRag(fakeModel(), {
      docTokens: 10_000,
      chunkSize: 512,
      overlap: 51,
      topK: 5,
      questionTokens: 50,
      systemTokens: 200,
      outputTokens: 300,
      queriesPerMonth: 1000,
      embedPricePer1M: 0.02,
    });
    assert.equal(r.chunks, countChunks(10_000, 512, 51));
    assert.ok(r.ragPerQueryUsd < r.fullPerQueryUsd);
  });
});

describe("análise de pasta", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "neurix-test-"));
    await mkdir(join(dir, "src"));
    await mkdir(join(dir, "node_modules", "lib"), { recursive: true });
    await mkdir(join(dir, "gerado"));
    await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n".repeat(50));
    await writeFile(join(dir, "README.md"), "# Projeto\n\nTexto.");
    await writeFile(join(dir, "node_modules", "lib", "x.js"), "ignorado");
    await writeFile(join(dir, "gerado", "y.txt"), "ignorado pelo gitignore");
    await writeFile(join(dir, "debug.log"), "ignorado pelo gitignore");
    await writeFile(join(dir, ".gitignore"), "gerado/\n*.log\n");
    await writeFile(join(dir, "package-lock.json"), "{}");
    await writeFile(join(dir, "img.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]));
    await writeFile(join(dir, "dados.bin2"), Buffer.from([1, 2, 0, 3]));
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test("conta só os arquivos de texto relevantes", async () => {
    const r = await analyzeFolder(dir, openai.count);
    const paths = r.files.map((f) => f.path).sort();
    assert.deepEqual(paths, [".gitignore", "README.md", "src/a.ts"]);
    assert.equal(r.files[0]?.path, "src/a.ts", "ordenado do maior para o menor");
    assert.equal(r.usedGitignore, true);
    assert.equal(r.skipped.lockfile, 1);
    assert.equal(r.skipped.binary, 2);
    assert.equal(r.totalTokens, r.files.reduce((s, f) => s + f.tokens, 0));
  });

  test("filtro por extensão", async () => {
    const r = await analyzeFolder(dir, openai.count, { extensions: ["md"] });
    assert.deepEqual(r.files.map((f) => f.path), ["README.md"]);
  });
});

describe("recomendador", () => {
  test("sugere o nível pela tarefa", () => {
    assert.equal(suggestQuality("Traduza para inglês: bom dia", 10, 100).quality, "cheap");
    const hard = suggestQuality("Analise passo a passo a arquitetura: ```ts\nconst a = 1\n```", 9000, 4000);
    assert.equal(hard.quality, "flagship");
    assert.ok(hard.signals.includes("code") && hard.signals.includes("reasoning"));
  });

  test("escolhe o mais barato que atende o nível e cabe", async () => {
    const models = visibleModels(dataset, true);
    const counters = await countersFor(models);
    for (const q of ["cheap", "mid", "flagship"] as const) {
      const rec = recommendModel("Resuma este texto.", null, 300, models, counters, q);
      assert.ok(rec.best, q);
      assert.ok(TIER_RANK[rec.best.model.tier] >= TIER_RANK[q]);
      for (const a of rec.alternatives) assert.ok(a.cost.totalUsd >= rec.best.cost.totalUsd);
    }
  });

  test("nada cabe: sem recomendação", async () => {
    const small = [fakeModel({ contextWindow: 10 })];
    const rec = recommendModel(null, 1000, 0, small, await countersFor(small), "cheap");
    assert.equal(rec.best, null);
    assert.equal(rec.tooSmall.length, 1);
  });
});

describe("orçamento e cache", () => {
  test("chamadas que cabem no orçamento", () => {
    const [row] = callsForBudget([fakeModel()], () => 1000, 100, 10);
    // 1000 × 2/1M + 100 × 10/1M = 0,003 por chamada
    assert.equal(row?.calls, Math.floor(10 / 0.003));
  });

  test("economia do cache de prompt confere com a conta à mão", () => {
    const m = fakeModel({ cachedInput: 0.1, cacheWrite: 2.5 });
    const r = promptCacheSavings(m, { fixedTokens: 20_000, variableTokens: 200, outputTokens: 300, calls: 500 });
    assert.ok(Math.abs(r.withoutCacheUsd - 21.7) < 1e-9);
    assert.ok(Math.abs(r.withCacheUsd - 2.748) < 1e-9);
    assert.equal(promptCacheSavings(fakeModel(), { fixedTokens: 1, variableTokens: 1, outputTokens: 1, calls: 2 }).supported, false);
  });
});

describe("Neurix Budget", () => {
  // Preços tipo Opus: entrada 4, saída 20, cache leitura 0,2, gravação 5 (US$/1M)
  const opus = fakeModel({ provider: "anthropic", input: 4, output: 20, cachedInput: 0.2, cacheWrite: 5, contextWindow: 1_000_000 });
  const u: UsageProfile = { inputTokens: 3000, cachedTokens: 2100, outputTokens: 500, cacheHitPct: 90, batchPct: 30, activeDays: 22, requestsPerDay: 150 };
  const near = (a: number | null | undefined, b: number): void => assert.ok(a !== null && a !== undefined && Math.abs(a - b) < 1e-9, `${a} ≠ ${b}`);

  test("custo por requisição nas 4 estratégias (conta à mão)", () => {
    near(requestCost(opus, u, "normal"), 0.022); // 3000×4 + 500×20, por milhão
    near(requestCost(opus, u, "cache"), 0.022 - 0.0084 + 2100e-6 * (0.9 * 0.2 + 0.1 * 5));
    near(requestCost(opus, u, "batch"), 0.011);
    near(requestCost(opus, u, "cacheBatch"), (0.022 - 0.0084 + 2100e-6 * 0.68) / 2);
  });

  test("provedor sem lote ou sem cache devolve null", () => {
    const ds = fakeModel({ provider: "deepseek", cachedInput: undefined });
    assert.equal(requestCost(ds, u, "batch"), null);
    assert.equal(requestCost(ds, u, "cache"), null);
    assert.equal(hasBatch(ds), false);
  });

  test("projeção, % do teto e dia em que acaba", () => {
    const [r] = planBudget([opus], () => 3000, u, 37.037);
    const mixed = 0.7 * 0.015028 + 0.3 * 0.007514;
    near(r?.optimized, mixed);
    near(r?.projection?.month, mixed * 150 * 22);
    near(r?.projection?.year, mixed * 150 * 22 * 12);
    assert.equal(r?.projection?.capDay, 28);
    assert.ok((r?.projection?.thresholds[50] ?? 99) < (r?.projection?.thresholds[80] ?? 0));
    assert.equal(r?.maxPerMonth.normal, Math.floor(37.037 / 0.022));
  });

  test("sem volume: só quantas cabem", () => {
    const { requestsPerDay: _, ...noVolume } = u;
    const [r] = planBudget([opus], () => 3000, noVolume, 100);
    assert.equal(r?.projection, undefined);
    assert.ok((r?.maxPerMonth.optimized ?? 0) > (r?.maxPerMonth.normal ?? 0));
  });

  test("ritmo de gasto projeta o mês", () => {
    const b = burnRate(120, 200, new Date(2026, 10, 17)); // 17/nov, mês de 30 dias
    near(b.dailyAvg, 120 / 17);
    near(b.projectedMonth, (120 / 17) * 30);
    assert.equal(b.capDay, 29);
    near(b.safeDailyLeft, 80 / 13);
    assert.equal(burnRate(50, 200, new Date(2026, 10, 17)).capDay, null);
  });

  test("checagem de limite", () => {
    const m = fakeModel();
    assert.equal(checkLimits(m, 1000, 0, 1, { maxUsd: 0.01 }).ok, true);
    const over = checkLimits(m, 1000, 0, 10, { maxUsd: 0.01, maxTokens: 500 });
    assert.equal(over.ok, false);
    assert.equal(over.overCost, true);
    assert.equal(over.overTokens, true);
    assert.equal(checkLimits(m, 200_000, 0, 1, {}).overContext, true);
  });
});

describe("modelo local", () => {
  test("pesos = parâmetros × bits ÷ 8", () => {
    const model = findLocalModel("llama-3.1-8b");
    const quant = findQuant("Q4_K_M");
    const kv = findKv("F16");
    assert.ok(model && quant && kv);
    const est = estimateLocal({ model, quant, kv, context: 8192, vramGib: 24 });
    assert.ok(Math.abs(est.weightsGib - (8.03e9 * 4.9) / 8 / GIB) < 1e-9);
    assert.equal(est.kvBytesPerToken, 2 * 32 * 8 * 128 * 2);
    assert.equal(est.gpu?.fits, true);
  });
});

describe("formatos", () => {
  test("CSV gasta menos tokens que JSON indentado", () => {
    const rows = Array.from({ length: 20 }, (_, i) => ({ id: i, nome: `Cliente ${i}`, ativo: i % 2 === 0 }));
    const v = formatVariants(JSON.stringify(rows, null, 2), "json", openai.count);
    const tok = (id: string) => v.find((x) => x.id === id)?.tokens ?? 0;
    assert.ok(tok("csv") < tok("jsonPretty"));
    assert.ok(tok("jsonMin") < tok("jsonPretty"));
  });
});

describe("i18n", () => {
  /** Mesmas chaves e mesmos tipos nos dois idiomas (o TypeScript não pega chave sobrando). */
  function shape(v: unknown): unknown {
    if (Array.isArray(v)) return v.length && typeof v[0] !== "string" ? v.map(shape) : "array";
    if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape((v as Record<string, unknown>)[k])]));
    return typeof v;
  }
  test("pt e en têm a mesma estrutura", () => {
    assert.deepEqual(shape(en), shape(pt));
  });
});
