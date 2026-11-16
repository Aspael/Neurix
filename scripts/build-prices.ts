/**
 * Gera data/models.json juntando o catálogo curado (data/overlay.json)
 * com os preços do LiteLLM (oficial) e da OpenRouter.
 *
 * Uso: node scripts/build-prices.ts [--strict]
 *   --strict  sai com código 1 se houver conflito de preço ou modelo ausente (útil em CI)
 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverNewModels, mergePrices, type MergeIssue } from "../src/prices/merge.ts";
import {
  fetchLiteLLM,
  fetchOpenRouter,
  LITELLM_URL,
  OPENROUTER_URL,
  type LiteLLMData,
  type OpenRouterModel,
} from "../src/prices/sources.ts";
import type { OverlayEntry, PriceDataset } from "../src/types/models.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const overlayPath = resolve(root, "data/overlay.json");
const outPath = resolve(root, "data/models.json");
const strict = process.argv.includes("--strict");

async function tryFetch<T>(name: string, fn: () => Promise<T>): Promise<T | null> {
  try {
    const t0 = Date.now();
    const data = await fn();
    console.log(`✓ ${name} baixado em ${Date.now() - t0}ms`);
    return data;
  } catch (err) {
    console.warn(`✗ ${name} falhou: ${(err as Error).message}`);
    return null;
  }
}

const ICON: Record<MergeIssue["kind"], string> = {
  conflict: "⚠️ ",
  missing: "❌",
  "openrouter-only": "ℹ️ ",
  manual: "✍️ ",
  "scheduled-due": "📅",
};

async function main(): Promise<void> {
  const overlay = (JSON.parse(await readFile(overlayPath, "utf8")) as { models: OverlayEntry[] }).models;

  const [litellm, openrouter] = await Promise.all([
    tryFetch<LiteLLMData>("LiteLLM", fetchLiteLLM),
    tryFetch<OpenRouterModel[]>("OpenRouter", fetchOpenRouter),
  ]);
  if (!litellm && !openrouter) {
    console.error("Nenhuma fonte disponível; data/models.json não foi alterado.");
    process.exit(1);
  }

  const now = new Date().toISOString();
  const { models, issues } = mergePrices(overlay, litellm, openrouter);

  const dataset: PriceDataset = {
    version: 1,
    generatedAt: now,
    currency: "USD",
    unit: "per_1m_tokens",
    sources: {
      litellm: litellm ? { url: LITELLM_URL, fetchedAt: now } : null,
      openrouter: openrouter ? { url: OPENROUTER_URL, fetchedAt: now } : null,
    },
    models,
  };
  await writeFile(outPath, `${JSON.stringify(dataset, null, 2)}\n`, "utf8");

  // ── Relatório ──
  const bySource = models.reduce<Record<string, number>>((acc, m) => {
    acc[m.source] = (acc[m.source] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n📦 ${models.length}/${overlay.length} modelos gravados em data/models.json`);
  console.log(`   fontes: ${Object.entries(bySource).map(([k, v]) => `${k}=${v}`).join(", ")}`);

  if (issues.length) {
    console.log("\nPontos para revisar:");
    for (const i of issues) console.log(`  ${ICON[i.kind]} ${i.id.padEnd(20)} ${i.message}`);
  }

  if (openrouter) {
    const fresh = discoverNewModels(overlay, openrouter);
    if (fresh.length) {
      console.log(`\n🆕 Modelos recentes (60 dias) fora do catálogo — avalie incluir no overlay:`);
      for (const m of fresh.slice(0, 15)) {
        const date = new Date(m.created * 1000).toISOString().slice(0, 10);
        const inP = Number(m.pricing.prompt) * 1e6;
        const outP = Number(m.pricing.completion) * 1e6;
        console.log(`  ${date}  ${m.id.padEnd(40)} $${+inP.toFixed(3)}/$${+outP.toFixed(3)}`);
      }
      if (fresh.length > 15) console.log(`  … e mais ${fresh.length - 15}`);
    }
  }

  if (strict && issues.some((i) => i.kind === "conflict" || i.kind === "missing")) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
