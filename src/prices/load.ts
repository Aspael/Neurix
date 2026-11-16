import { readFile } from "node:fs/promises";
import bundled from "../../data/models.json" with { type: "json" };
import type { ModelPrice, PriceDataset } from "../types/models.ts";

/** Carrega o dataset: --prices <arquivo> tem prioridade sobre o embutido no pacote. */
export async function loadPrices(path?: string): Promise<PriceDataset> {
  if (!path) return bundled as PriceDataset;
  return JSON.parse(await readFile(path, "utf8")) as PriceDataset;
}

export function findModel(dataset: PriceDataset, id: string): ModelPrice | undefined {
  const q = id.toLowerCase();
  return (
    dataset.models.find((m) => m.id === q) ??
    // aceita "sonnet-5.5" ou "claude-sonnet-5.5"
    dataset.models.find((m) => m.id.replace(/\./g, "-").endsWith(q.replace(/\./g, "-")))
  );
}

/** Modelos da tabela padrão; `all` inclui os não destacados e os antigos. */
export function visibleModels(dataset: PriceDataset, all = false): ModelPrice[] {
  return dataset.models.filter((m) => all || (m.featured && !m.legacy));
}
