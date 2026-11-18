/** Testa o servidor MCP compilado (dist/mcp.js) com o cliente oficial do SDK, via stdio. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = join(root, "dist", "mcp.js");

const EXPECTED = [
  "neurix_count_tokens",
  "neurix_estimate_cost",
  "neurix_compare_models",
  "neurix_suggest_format",
  "neurix_check_local_fit",
  "neurix_find_local_models",
  "neurix_rag_cost",
  "neurix_count_file",
  "neurix_list_models",
  "neurix_exchange_rate",
  "neurix_explain_term",
  "neurix_optimize_prompt",
  "neurix_analyze_folder",
  "neurix_chunk_document",
  "neurix_recommend_model",
  "neurix_budget",
  "neurix_check_cost",
  "neurix_prompt_cache_savings",
  "neurix_detect_hardware",
  "neurix_installed_models",
  "neurix_import_hf_model",
  "neurix_local_vs_api",
  "neurix_benchmark_ollama",
];

let client: Client;
let home: string;

before(async () => {
  assert.ok(existsSync(server), "dist/mcp.js não existe: rode `pnpm build` antes dos testes");
  home = await mkdtemp(join(tmpdir(), "neurix-mcp-"));
  client = new Client({ name: "neurix-test", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [server],
      env: { ...(process.env as Record<string, string>), NEURIX_HOME: home, NEURIX_LANG: "en", NEURIX_OFFLINE: "1" },
      stderr: "pipe",
    }),
  );
});
after(async () => {
  await client?.close();
  await rm(home, { recursive: true, force: true });
});

/** Chama uma tool e devolve o JSON da resposta. */
async function call(name: string, args: Record<string, unknown>): Promise<{ data: Record<string, any>; isError: boolean }> {
  const r = (await client.callTool({ name, arguments: args })) as { content: { type: string; text: string }[]; isError?: boolean };
  return { data: JSON.parse(r.content[0]?.text ?? "{}"), isError: Boolean(r.isError) };
}

describe("mcp", () => {
  test("lista todas as tools, cada uma com descrição", async () => {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED].sort());
    for (const t of tools) assert.ok((t.description ?? "").length > 80, `${t.name} sem descrição explicativa`);
  });

  test("count_tokens: OpenAI exato, Claude estimativa", async () => {
    const { data } = await call("neurix_count_tokens", { text: "hello world" });
    assert.equal(data.by_family.openai.tokens, 2);
    assert.equal(data.by_family.openai.exact, true);
    assert.equal(data.by_family.claude.exact, false);
  });

  test("estimate_cost com câmbio manual", async () => {
    const { data } = await call("neurix_estimate_cost", { model: "gpt-6.1-sol", input_tokens: 1_000_000, output_tokens: 0, usd_brl: 5 });
    assert.equal(data.per_call.input.brl, data.per_call.input.usd * 5);
  });

  test("optimize_prompt devolve o texto otimizado", async () => {
    const { data } = await call("neurix_optimize_prompt", { text: 'Oi.   \n{\n  "a": 1\n}', usd_brl: 5 });
    assert.equal(data.optimized_text, 'Oi.\n{"a":1}');
    assert.ok(data.tokens_saved > 0);
  });

  test("chunk_document corta por tokens", async () => {
    const { data } = await call("neurix_chunk_document", { text: "Uma frase. ".repeat(200), chunk_size: 100, overlap_pct: 10 });
    assert.match(data.cut_by, /exact tokens/);
    assert.ok(data.chunks > 1);
  });

  test("recommend_model respeita o nível pedido", async () => {
    const { data } = await call("neurix_recommend_model", { prompt: "Resuma isto.", quality: "flagship", usd_brl: 5 });
    assert.equal(data.recommended.tier, "flagship");
  });

  test("check_local_fit e find_local_models", async () => {
    const fit = await call("neurix_check_local_fit", { model: "llama-3.1-8b", vram_gb: 24, context: 8192 });
    assert.equal(fit.data.gpu.fits_entirely, true);
    const find = await call("neurix_find_local_models", { vram_gb: 8 });
    assert.ok(find.data.fits.length > 0);
  });

  test("analyze_folder na pasta src", async () => {
    const { data } = await call("neurix_analyze_folder", { path: join(root, "src"), top: 3, usd_brl: 5 });
    assert.ok(data.files > 10);
    assert.equal(data.largest_files.length, 3);
  });

  test("budget: projeção em reais, ritmo e lote", async () => {
    const { data } = await call("neurix_budget", {
      cap: 200,
      currency: "brl",
      requests_per_day: 150,
      active_days: 22,
      input_tokens: 3000,
      cached_pct: 70,
      batch_pct: 30,
      output_tokens: 500,
      spent_so_far: 120,
      usd_brl: 5,
    });
    assert.equal(data.cap.usd, 40);
    assert.ok(data.spending_pace.projected_month > 0);
    const m = data.models[0];
    assert.ok(m.projection.month > 0);
    assert.ok(Math.abs(m.projection.year - m.projection.month * 12) < 0.01, "ano = 12 meses (cada um arredondado a 4 casas)");
    assert.equal(data.batch_by_provider.anthropic.discount, 0.5);
  });

  test("check_cost: ok e acima do limite", async () => {
    const okR = await call("neurix_check_cost", { text: "hello world", max_usd: 1 });
    assert.equal(okR.data.ok, true);
    const over = await call("neurix_check_cost", { path: join(root, "README.md"), max_tokens: 100 });
    assert.equal(over.data.ok, false);
    assert.ok(over.data.reasons.length > 0);
  });

  test("detect_hardware e installed_models", async () => {
    const hw = await call("neurix_detect_hardware", {});
    assert.ok(hw.data.ram_gb > 0);
    assert.ok(Array.isArray(hw.data.gpus));
    const inst = await call("neurix_installed_models", { extra_dirs: [join(home, "nada")] });
    assert.ok(Array.isArray(inst.data.models));
    assert.ok(inst.data.searched.some((s: { source: string }) => s.source === "gguf"));
  });

  test("local_vs_api com GPU simulada", async () => {
    const { data } = await call("neurix_local_vs_api", { model: "llama-3.1-8b", vram_gb: 12, requests_per_day: 1000, currency: "usd", hardware_price: 500 });
    assert.equal(data.speed.runs_on, "gpu");
    assert.ok(data.local.kwh > 0);
    assert.ok(data.apis.length > 0);
  });

  test("benchmark_ollama sem Ollama vira erro claro (ou lista modelos se houver)", async () => {
    const r = await call("neurix_benchmark_ollama", {});
    if (r.isError) assert.match(r.data.error, /Ollama/);
    else assert.ok(Array.isArray(r.data.ollama_models));
  });

  test("modelo inexistente vira erro de tool (não derruba o servidor)", async () => {
    const r = await call("neurix_estimate_cost", { model: "nao-existe", input_tokens: 10 });
    assert.equal(r.isError, true);
    assert.match(r.data.error, /not found/);
    const ok = await call("neurix_explain_term", { term: "token", lang: "en" });
    assert.equal(ok.isError, false);
  });
});
