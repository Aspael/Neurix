/**
 * Corta um documento em pedaços (chunks) para RAG, por tokens de verdade quando o tokenizer permite
 * (OpenAI e modelos locais) e por caracteres (~3,5 por token) nos demais.
 *
 * Cada pedaço começa com a sobreposição (o final do pedaço anterior) e depois o conteúdo novo.
 */
import { CHARS_PER_TOKEN, type Counter } from "./tokens.ts";

export interface Chunk {
  index: number;
  /** Posição em tokens no documento (início inclusivo, fim exclusivo). */
  start: number;
  end: number;
  tokens: number;
  /** Trecho repetido do pedaço anterior. */
  overlapText: string;
  /** Conteúdo novo deste pedaço. */
  newText: string;
  /** Termina no meio de uma frase (pode cortar uma ideia ao meio). */
  cutsSentence: boolean;
}

export interface ChunkPlan {
  docTokens: number;
  chunkSize: number;
  overlap: number;
  byTokens: boolean;
  chunks: Chunk[];
  /** Tokens enviados ao embedding (conta a sobreposição repetida). */
  indexedTokens: number;
  cutsSentence: number;
}

/** Termina num fim de frase ou numa quebra de linha. */
const endsSentence = (s: string): boolean => /\n\s*$/.test(s) || /[.!?…:;)\]}"'”»]$/.test(s.trimEnd());

export function chunkDocument(text: string, chunkSize: number, overlap: number, counter: Counter): ChunkPlan {
  const size = Math.max(1, Math.floor(chunkSize));
  const ov = Math.max(0, Math.min(Math.floor(overlap), size - 1));
  const step = size - ov;

  // Unidades: ids de token (exato) ou caracteres (aproximado).
  const byTokens = Boolean(counter.encode && counter.decode);
  const ids = byTokens ? (counter.encode as (s: string) => number[])(text) : [];
  const unitsPerToken = byTokens ? 1 : CHARS_PER_TOKEN;
  const total = byTokens ? ids.length : text.length;
  const slice = (a: number, b: number): string =>
    byTokens ? (counter.decode as (x: number[]) => string)(ids.slice(a, b)) : text.slice(a, b);

  const uSize = Math.round(size * unitsPerToken);
  const uStep = Math.max(1, Math.round(step * unitsPerToken));
  const uOv = uSize - uStep;

  const chunks: Chunk[] = [];
  if (total > 0) {
    for (let a = 0, i = 0; ; a += uStep, i++) {
      const b = Math.min(total, a + uSize);
      const ovEnd = i === 0 ? a : Math.min(b, a + uOv);
      const overlapText = slice(a, ovEnd);
      const newText = slice(ovEnd, b);
      chunks.push({
        index: i + 1,
        start: Math.round(a / unitsPerToken),
        end: Math.round(b / unitsPerToken),
        tokens: byTokens ? b - a : counter.count(overlapText + newText),
        overlapText,
        newText,
        cutsSentence: b < total && !endsSentence(overlapText + newText),
      });
      if (b >= total) break;
    }
  }
  const docTokens = byTokens ? total : counter.count(text);
  return {
    docTokens,
    chunkSize: size,
    overlap: ov,
    byTokens,
    chunks,
    indexedTokens: chunks.reduce((s, c) => s + c.tokens, 0),
    cutsSentence: chunks.filter((c) => c.cutsSentence).length,
  };
}
