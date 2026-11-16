/**
 * Simula o custo de usar um arquivo como base de conhecimento em RAG
 * (Retrieval-Augmented Generation) versus mandar o arquivo inteiro em cada pergunta.
 */
import type { ModelPrice } from "../types/models.ts";
import { computeCost, type CostBreakdown } from "./cost.ts";

export interface RagInput {
  docTokens: number;
  chunkSize: number;
  overlap: number;
  topK: number;
  questionTokens: number;
  systemTokens: number;
  outputTokens: number;
  queriesPerMonth: number;
  /** US$ por 1M de tokens do modelo de embedding. */
  embedPricePer1M: number;
}

export interface RagResult {
  chunks: number;
  /** Tokens enviados ao embedding na indexação (conta a sobreposição repetida). */
  indexedTokens: number;
  indexUsd: number;
  /** Pedaços realmente enviados ao modelo por pergunta. */
  retrieved: number;
  contextTokens: number;
  rag: CostBreakdown;
  queryEmbedUsd: number;
  ragPerQueryUsd: number;
  ragMonthUsd: number;
  full: CostBreakdown;
  fullPerQueryUsd: number;
  fullMonthUsd: number;
}

export function countChunks(docTokens: number, chunkSize: number, overlap: number): number {
  if (docTokens <= 0) return 0;
  if (docTokens <= chunkSize) return 1;
  const step = Math.max(1, chunkSize - overlap);
  return Math.ceil((docTokens - overlap) / step);
}

export function simulateRag(model: ModelPrice, i: RagInput): RagResult {
  const chunks = countChunks(i.docTokens, i.chunkSize, i.overlap);
  const indexedTokens = i.docTokens + Math.max(0, chunks - 1) * i.overlap;
  const indexUsd = (indexedTokens / 1e6) * i.embedPricePer1M;

  const retrieved = Math.min(i.topK, chunks);
  const contextTokens = Math.min(retrieved * i.chunkSize, indexedTokens);
  const rag = computeCost(model, i.systemTokens + i.questionTokens + contextTokens, i.outputTokens);
  const queryEmbedUsd = (i.questionTokens / 1e6) * i.embedPricePer1M;
  const ragPerQueryUsd = rag.totalUsd + queryEmbedUsd;

  const full = computeCost(model, i.systemTokens + i.questionTokens + i.docTokens, i.outputTokens);

  return {
    chunks,
    indexedTokens,
    indexUsd,
    retrieved,
    contextTokens,
    rag,
    queryEmbedUsd,
    ragPerQueryUsd,
    ragMonthUsd: ragPerQueryUsd * i.queriesPerMonth,
    full,
    fullPerQueryUsd: full.totalUsd,
    fullMonthUsd: full.totalUsd * i.queriesPerMonth,
  };
}
