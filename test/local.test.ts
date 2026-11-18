/** Modelo local: detecção de hardware, GGUF, modelos instalados, Hugging Face, velocidade, local vs API, benchmark e relatórios. */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { runOllamaBenchmark } from "../src/core/benchmark.ts";
import { buildTestGguf, readGguf, shapeFromGguf } from "../src/core/gguf.ts";
import { gpuSpecs, parseNvidiaSmi, parseWindowsGpus, type Gpu } from "../src/core/hardware.ts";
import { paramsFromName, shapeFromConfig } from "../src/core/hfconfig.ts";
import { findInstalledModels } from "../src/core/installed.ts";
import { findKv, findLocalModel, findQuant, GIB, type KvPrecision, type Quantization } from "../src/core/local.ts";
import { EFFICIENCY, estimateSpeed, localVsApi } from "../src/core/localcost.ts";
import { formatFromPath, newReport, toCsv, toHtml, toJson, toMarkdown, writeReport } from "../src/report/report.ts";
import type { ModelPrice } from "../src/types/models.ts";

const kv = findKv("F16") as KvPrecision;
const q4 = findQuant("Q4_K_M") as Quantization;
const llama8 = findLocalModel("llama-3.1-8b");
const rtx3060: Gpu = { name: "NVIDIA GeForce RTX 3060", vendor: "nvidia", vramGib: 12, integrated: false, bandwidthGBs: 360, tdpW: 170, source: "manual" };

describe("detecção de GPU", () => {
  test("nvidia-smi: VRAM, energia e tabela de banda/TDP", () => {
    const [g] = parseNvidiaSmi("NVIDIA GeForce RTX 3060, 12288, 10240, 18.53, 170.00\n");
    assert.equal(g?.vramGib, 12);
    assert.equal(g?.freeGib, 10);
    assert.equal(g?.powerDrawW, 18.53);
    assert.equal(g?.powerLimitW, 170);
    assert.equal(g?.bandwidthGBs, 360);
    assert.equal(g?.integrated, false);
  });

  test("nvidia-smi com [N/A] e duas placas", () => {
    const gs = parseNvidiaSmi("NVIDIA GeForce RTX 4090, 24564, 24000, [N/A], [N/A]\nNVIDIA GeForce RTX 3090, 24576, 1000, 300.1, 350\n");
    assert.equal(gs.length, 2);
    assert.equal(gs[0]?.powerDrawW, undefined);
    assert.equal(gs[0]?.bandwidthGBs, 1008);
    assert.equal(gs[1]?.bandwidthGBs, 936);
  });

  test("tabela: o nome mais específico vence (4060 Ti ≠ 4060)", () => {
    assert.equal(gpuSpecs("GeForce RTX 4060 Ti")?.bandwidthGBs, 288);
    assert.equal(gpuSpecs("GeForce RTX 4060")?.bandwidthGBs, 272);
    assert.equal(gpuSpecs("Apple M2 Max")?.bandwidthGBs, 400);
    assert.equal(gpuSpecs("Placa desconhecida"), null);
  });

  test("Windows: registro (64 bits) vence o WMI (trava em 4 GB)", () => {
    const gs = parseWindowsGpus(
      JSON.stringify({
        reg: [{ name: "AMD Radeon RX 7800 XT", bytes: 17179869184 }],
        wmi: [
          { name: "AMD Radeon RX 7800 XT", bytes: 4293918720 },
          { name: "Intel(R) UHD Graphics", bytes: 1073741824 },
        ],
      }),
    );
    const amd = gs.find((g) => g.vendor === "amd");
    assert.equal(amd?.vramGib, 16);
    assert.equal(amd?.integrated, false);
    assert.equal(amd?.bandwidthGBs, 624);
    assert.equal(gs.find((g) => g.vendor === "intel")?.integrated, true);
  });
});

// ───────────── GGUF e modelos instalados ─────────────

const META = {
  "general.architecture": "llama",
  "general.name": "Teste 8B",
  "general.file_type": 15,
  "llama.block_count": 32,
  "llama.attention.head_count": 32,
  "llama.attention.head_count_kv": 8,
  "llama.embedding_length": 4096,
  "llama.context_length": 131072,
};
const TENSORS = [{ name: "token_embd.weight", dims: [4096, 1000] }, ...Array.from({ length: 32 }, (_, i) => ({ name: `blk.${i}.w`, dims: [1000, 1000] }))];
const PARAMS = 4096 * 1000 + 32 * 1000 * 1000;

describe("GGUF e modelos instalados", () => {
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "neurix-gguf-"));
    const gguf = buildTestGguf(META, TENSORS);
    // pasta solta com .gguf (LM Studio / --dir)
    await mkdir(join(dir, "lms", "autor"), { recursive: true });
    await writeFile(join(dir, "lms", "autor", "teste-8b-Q4_K_M.gguf"), gguf);
    await writeFile(join(dir, "lms", "autor", "mmproj-teste.gguf"), gguf); // projetor de visão: ignorado
    // Ollama: manifesto → blob
    const ollama = join(dir, "ollama");
    await mkdir(join(ollama, "manifests", "registry.ollama.ai", "library", "teste"), { recursive: true });
    await mkdir(join(ollama, "blobs"), { recursive: true });
    await writeFile(join(ollama, "blobs", "sha256-abc123"), gguf);
    await truncate(join(ollama, "blobs", "sha256-abc123"), 2_000_000_000); // "pesa" 2 GB (arquivo esparso)
    await writeFile(
      join(ollama, "manifests", "registry.ollama.ai", "library", "teste", "8b"),
      JSON.stringify({ layers: [{ mediaType: "application/vnd.ollama.image.model", digest: "sha256:abc123" }] }),
    );
  });
  after(() => rm(dir, { recursive: true, force: true }));

  test("lê metadados e soma os tensores (pula o vocabulário)", async () => {
    const info = await readGguf(join(dir, "lms", "autor", "teste-8b-Q4_K_M.gguf"));
    assert.equal(info.parameters, PARAMS);
    const s = shapeFromGguf(info);
    assert.deepEqual([s.arch, s.layers, s.kvHeads, s.headDim, s.maxContext, s.fileType], ["llama", 32, 8, 128, 131072, "Q4_K_M"]);
  });

  test("rejeita arquivo que não é GGUF", async () => {
    const p = join(dir, "falso.gguf");
    await writeFile(p, "não sou gguf");
    await assert.rejects(readGguf(p), /GGUF/);
  });

  test("acha no Ollama (sem servidor) e na pasta extra, com a quantização real", async () => {
    const prev = process.env.OLLAMA_MODELS;
    process.env.OLLAMA_MODELS = join(dir, "ollama");
    try {
      const scan = await findInstalledModels([join(dir, "lms")]);
      const names = scan.models.map((m) => m.name).sort();
      assert.deepEqual(names, ["teste-8b-Q4_K_M", "teste:8b"]);
      const ol = scan.models.find((m) => m.source === "ollama");
      assert.equal(ol?.sizeBytes, 2_000_000_000);
      assert.ok(Math.abs((ol?.quant.bits ?? 0) - (2e9 * 8) / PARAMS) < 1e-9, "bits = tamanho × 8 ÷ parâmetros");
      assert.equal(ol?.model.kvHeads, 8);
    } finally {
      if (prev === undefined) delete process.env.OLLAMA_MODELS;
      else process.env.OLLAMA_MODELS = prev;
    }
  });
});

describe("Hugging Face (config.json)", () => {
  test("lê os campos e estima parâmetros", () => {
    const s = shapeFromConfig({
      num_hidden_layers: 28,
      num_attention_heads: 28,
      num_key_value_heads: 4,
      hidden_size: 3584,
      intermediate_size: 18944,
      vocab_size: 152064,
      max_position_embeddings: 32768,
    });
    assert.deepEqual([s.layers, s.kvHeads, s.headDim, s.maxContext], [28, 4, 128, 32768]);
    assert.ok(s.est > 7e9 && s.est < 8e9, `Qwen2.5-7B ≈ 7,6B (deu ${s.est})`);
  });

  test("multimodal: usa text_config; sem num_key_value_heads usa as cabeças", () => {
    const s = shapeFromConfig({ text_config: { num_hidden_layers: 10, num_attention_heads: 8, hidden_size: 1024, head_dim: 256 } });
    assert.deepEqual([s.layers, s.kvHeads, s.headDim], [10, 8, 256]);
  });

  test("parâmetros pelo nome", () => {
    assert.equal(paramsFromName("meta-llama/Llama-3.1-8B-Instruct"), 8);
    assert.equal(paramsFromName("Qwen/Qwen2.5-0.5B"), 0.5);
    assert.equal(paramsFromName("mistralai/Mixtral-8x7B-v0.1"), 56);
    assert.equal(paramsFromName("gpt2"), null);
  });
});

describe("velocidade e local vs API", () => {
  test("cabe na GPU: tok/s = banda × eficiência ÷ tamanho dos pesos", () => {
    assert.ok(llama8);
    const s = estimateSpeed(llama8, q4, kv, 8192, { ramGib: 32, ramBandwidthGBs: 40, gpu: rtx3060 });
    const weightsGB = (8.03e9 * q4.bits) / 8 / 1e9;
    assert.equal(s.placement, "gpu");
    assert.ok(Math.abs(s.decodeTps - (360 * EFFICIENCY) / weightsGB) < 1e-9);
    assert.equal(s.verdict, "great");
  });

  test("sem GPU roda na CPU; grande demais não cabe", () => {
    assert.ok(llama8);
    const cpu = estimateSpeed(llama8, q4, kv, 8192, { ramGib: 32, ramBandwidthGBs: 40, gpu: null });
    assert.equal(cpu.placement, "cpu");
    assert.ok(cpu.decodeTps < 8);
    const big = findLocalModel("llama-3.1-70b");
    assert.ok(big);
    assert.equal(estimateSpeed(big, q4, kv, 8192, { ramGib: 16, ramBandwidthGBs: 40, gpu: rtx3060 }).placement, "noFit");
    assert.equal(estimateSpeed(big, q4, kv, 8192, { ramGib: 64, ramBandwidthGBs: 40, gpu: rtx3060 }).placement, "partial");
  });

  test("custo local: horas, kWh, energia, amortização e ponto de equilíbrio", () => {
    const speed = { placement: "gpu" as const, layersOnGpu: 32, decodeTps: 40, prefillTps: 600, totalGib: 6, verdict: "great" as const, gpuBandwidthGBs: 360, ramBandwidthGBs: 40 };
    const api: ModelPrice = { id: "x", name: "X", provider: "openai", tier: "mid", featured: true, legacy: false, tokenizer: "o200k", contextWindow: 1e6, maxOutput: 1e5, input: 2, output: 10, source: "manual" };
    const r = localVsApi(speed, { inputTokens: 90e6, outputTokens: 24e6, tariffUsdKwh: 0.15, gpuW: 150, systemW: 50, hardwareUsd: 480, amortMonths: 24 }, [api]);
    const hours = (24e6 / 40 + 90e6 / 600) / 3600;
    assert.ok(Math.abs(r.hoursPerMonth - hours) < 1e-9);
    assert.ok(Math.abs(r.kWh - (hours * 200) / 1000) < 1e-9);
    assert.ok(Math.abs(r.energyUsd - r.kWh * 0.15) < 1e-9);
    assert.equal(r.amortUsd, 20);
    const apiUsd = 90 * 2 + 24 * 10; // US$ 420
    assert.ok(Math.abs((r.api[0]?.usd ?? 0) - apiUsd) < 1e-9);
    assert.ok(Math.abs((r.api[0]?.breakEvenMonths ?? 0) - 480 / (apiUsd - r.energyUsd)) < 1e-9);
    assert.equal(r.keepsUp, true);
  });
});

describe("benchmark com Ollama (servidor falso)", () => {
  let server: Server;
  let url: string;
  before(async () => {
    server = createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/generate")
        res.end(JSON.stringify({ eval_count: 200, eval_duration: 4e9, prompt_eval_count: 50, prompt_eval_duration: 1e8, load_duration: 2e9, total_duration: 6.1e9 }));
      else res.end(JSON.stringify({ version: "0.0.0", models: [{ name: "teste:1b" }] }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const addr = server.address();
    url = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  test("tokens/s vêm dos tempos do Ollama", async () => {
    const r = await runOllamaBenchmark("teste:1b", { url, maxTokens: 64 });
    assert.equal(r.decodeTps, 50); // 200 tokens em 4 s
    assert.equal(r.prefillTps, 500); // 50 em 0,1 s
    assert.equal(r.loadSeconds, 2);
    assert.equal(r.outputTokens, 200);
  });
});

describe("relatórios", () => {
  const rep = newReport("teste", "Relatório | teste", { modelo: "x" });
  rep.sections.push({ heading: "Resumo", kv: [["Tokens", 1234.5], ["Cabe", true], ["Vazio", null]] });
  rep.sections.push({ heading: "Tabela", table: { head: ["Nome", "Valor"], rows: [["a,b", 1], ['com "aspas"', 0.000123]] } });

  test("Markdown com tabelas e escape de |", () => {
    const md = toMarkdown(rep, "en-US");
    assert.match(md, /^# Relatório \| teste$/m); // no título o | não precisa de escape
    assert.match(md, /\| com "aspas" \| 0\.000123 \|/);
    assert.match(md, /\| Tokens \| 1,234\.5 \|/);
    assert.match(md, /\| Nome \| Valor \|\n\|---\|---:\|/);
  });

  test("CSV com aspas e números crus", () => {
    const csv = toCsv(rep);
    assert.match(csv, /^"a,b",1$/m);
    assert.match(csv, /^"com ""aspas""",0\.000123$/m);
    assert.match(csv, /^Tokens,1234\.5$/m);
  });

  test("JSON e HTML", () => {
    assert.equal(JSON.parse(toJson(rep)).sections[1].table.rows[0][0], "a,b");
    const html = toHtml(rep);
    assert.match(html, /<!doctype html>/);
    assert.match(html, /prefers-color-scheme: dark/);
    assert.match(html, /com &quot;aspas&quot;/);
  });

  test("formato pela extensão e gravação", async () => {
    assert.equal(formatFromPath("a/b.markdown"), "md");
    assert.equal(formatFromPath("x.HTML"), "html");
    assert.equal(formatFromPath("x.txt"), null);
    const d = await mkdtemp(join(tmpdir(), "neurix-rep-"));
    const p = await writeReport(rep, join(d, "sub", "r.csv"));
    assert.match(await readFile(p, "utf8"), /## Tabela/);
    const noExt = await writeReport(rep, join(d, "sem-extensao"), "json");
    assert.ok(noExt.endsWith(".json"));
    await rm(d, { recursive: true, force: true });
  });
});

describe("área de transferência", () => {
  test("lê sem quebrar (texto ou null, nunca exceção)", async () => {
    const { readClipboard } = await import("../src/core/clipboard.ts");
    const v = await readClipboard(); // no CI pode não haver área de transferência: aí volta null
    assert.ok(v === null || typeof v === "string");
    if (typeof v === "string") assert.ok(!v.includes("\r\n"), "quebras de linha normalizadas");
  });
});

// conferência rápida do GIB usado nas contas de tamanho
test("GIB", () => assert.equal(GIB, 1024 ** 3));
