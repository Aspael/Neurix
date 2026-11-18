/**
 * Otimizador de prompt: acha tokens desperdiçados (espaços, indentação, JSON indentado, linhas em branco,
 * caracteres invisíveis, linhas repetidas) e mede quantos tokens cada correção economiza.
 *
 * Cada correção é aplicada em sequência e medida com o tokenizer do modelo escolhido, então a soma das
 * economias bate com a diferença entre o original e o otimizado.
 */

export type WasteKind =
  | "invisible" // caracteres invisíveis / espaço não separável
  | "prettyJson" // JSON indentado que pode ser minificado
  | "trailingSpaces" // espaços no fim da linha
  | "indentation" // recuo no começo das linhas (fora de blocos de código)
  | "multiSpaces" // espaços repetidos no meio da linha
  | "blankLines" // linhas em branco em excesso
  | "duplicateLines"; // linhas repetidas (só aponta; não remove)

export interface WasteExample {
  /** Linha no texto original (começa em 1). */
  line: number;
  /** Última linha do trecho, quando ocupa várias (ex.: bloco JSON). */
  end?: number;
  text: string;
}

export interface WasteIssue {
  kind: WasteKind;
  occurrences: number;
  tokensSaved: number;
  /** Se a correção entrou na versão otimizada (linhas repetidas só são apontadas). */
  applied: boolean;
  examples: WasteExample[];
}

export interface OptimizeResult {
  original: string;
  optimized: string;
  originalTokens: number;
  optimizedTokens: number;
  issues: WasteIssue[];
}

const MAX_EXAMPLES = 3;
const INVISIBLE = /[​-‍⁠﻿­]/g;
const NBSP = /[  ]/g;

const lines = (s: string): string[] => s.split("\n");

/** Marca de linhas que estão dentro de blocos ``` (código: o recuo importa, não mexemos). */
function fenceMask(ls: string[]): boolean[] {
  let inside = false;
  return ls.map((l) => {
    if (/^\s*```/.test(l)) {
      inside = !inside;
      return true;
    }
    return inside;
  });
}


// ───────────── JSON indentado ─────────────

const firstLine = (s: string): string => (s.trim().split("\n")[0] ?? "").slice(0, 80);

const tryMin = (s: string): string | null => {
  try {
    return JSON.stringify(JSON.parse(s));
  } catch {
    return null;
  }
};

/**
 * Minifica JSON indentado: o texto inteiro, blocos ```json e trechos de várias linhas que começam com
 * { ou [ e fecham numa linha só com } ou ]. Passo único, sem mexer no resto do texto.
 */
export function minifyJsonBlocks(text: string): { text: string; blocks: WasteExample[] } {
  const whole = text.trim();
  if (/^[[{]/.test(whole) && whole.includes("\n")) {
    const min = tryMin(whole);
    if (min !== null) return { text: min, blocks: [{ line: 1, end: lines(text).length, text: firstLine(whole) }] };
  }

  const ls = lines(text);
  const out: string[] = [];
  const blocks: WasteExample[] = [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i] ?? "";
    const t = l.trim();

    // ```json … ```
    if (/^```\s*json\s*$/i.test(t)) {
      const end = ls.findIndex((x, j) => j > i && /^\s*```\s*$/.test(x));
      if (end > i + 2) {
        const body = ls.slice(i + 1, end).join("\n");
        const min = tryMin(body);
        if (min !== null) {
          blocks.push({ line: i + 2, end, text: firstLine(body) });
          out.push(l, min, ls[end] ?? "```");
          i = end;
          continue;
        }
      }
    }

    // trecho solto: { ou [ no começo da linha, fechando numa linha "}" / "]" (com vírgula opcional)
    if (/^[[{]/.test(t) && !/^[[{].*[\]}],?$/.test(t)) {
      let done = false;
      for (let end = i + 1; end < Math.min(ls.length, i + 5000); end++) {
        const e = (ls[end] ?? "").trim();
        if (!/^[\]}],?$/.test(e)) continue;
        const min = tryMin(ls.slice(i, end + 1).join("\n").trim().replace(/,$/, ""));
        if (min === null) continue; // ainda não fechou o bloco de fora
        blocks.push({ line: i + 1, end: end + 1, text: firstLine(l) });
        out.push((l.match(/^\s*/)?.[0] ?? "") + min + (e.endsWith(",") ? "," : ""));
        i = end;
        done = true;
        break;
      }
      if (done) continue;
    }
    out.push(l);
  }
  return { text: blocks.length ? out.join("\n") : text, blocks };
}

// ───────────── Análise ─────────────

export function optimizePrompt(text: string, count: (s: string) => number): OptimizeResult {
  const orig = text.replace(/\r\n/g, "\n");
  const originalTokens = count(text);
  const issues: WasteIssue[] = [];
  let cur = orig;

  // Onde está cada coisa é procurado no ORIGINAL (números de linha batem com o arquivo do usuário);
  // a economia é medida aplicando as correções em sequência.
  const ols = lines(orig);
  const fence = fenceMask(ols);
  const json = minifyJsonBlocks(orig).blocks;
  const inJson = (i: number): boolean => json.some((b) => i + 1 >= b.line && i + 1 <= (b.end ?? b.line));
  const plain = (i: number): boolean => !fence[i] && !inJson(i);

  const find = (test: (l: string, i: number) => boolean): { count: number; examples: WasteExample[] } => {
    const examples: WasteExample[] = [];
    let n = 0;
    ols.forEach((l, i) => {
      if (!test(l, i)) return;
      n++;
      if (examples.length < MAX_EXAMPLES) examples.push({ line: i + 1, text: l });
    });
    return { count: n, examples };
  };

  const step = (kind: WasteKind, next: string, found: { count: number; examples: WasteExample[] }): void => {
    if (found.count === 0 || next === cur) return;
    const saved = count(cur) - count(next);
    cur = next;
    // Mudou caracteres mas não tokens (ex.: várias quebras de linha já são 1 token): não vale apontar.
    if (saved > 0) issues.push({ kind, occurrences: found.count, tokensSaved: saved, applied: true, examples: found.examples });
  };

  // 1. Invisíveis e espaço não separável
  const hasInvisible = new RegExp(`${INVISIBLE.source}|${NBSP.source}`); // sem /g: .test() sem estado
  step("invisible", cur.replace(INVISIBLE, "").replace(NBSP, " "), find((l) => hasInvisible.test(l)));

  // 2. JSON indentado
  step("prettyJson", minifyJsonBlocks(cur).text, { count: json.length, examples: json.slice(0, MAX_EXAMPLES) });

  // 3. Espaços no fim da linha
  step("trailingSpaces", cur.replace(/[ \t]+$/gm, ""), find((l, i) => plain(i) && /\S[ \t]+$/.test(l)));

  // 4. Recuo fora de código; itens de lista aninhados mantêm o recuo (ele dá a hierarquia)
  {
    const isList = (l: string): boolean => /^\s*([-*+]|\d+[.)])\s/.test(l);
    const ls = lines(cur);
    const mask = fenceMask(ls);
    const next = ls.map((l, i) => (mask[i] || isList(l) ? l : l.replace(/^[ \t]+(?=\S)/, ""))).join("\n");
    step("indentation", next, find((l, i) => plain(i) && !isList(l) && /^[ \t]{2,}\S/.test(l)));
  }

  // 5. Espaços repetidos no meio da linha
  {
    const ls = lines(cur);
    const mask = fenceMask(ls);
    const next = ls.map((l, i) => (mask[i] ? l : l.replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 "))).join("\n");
    step("multiSpaces", next, find((l, i) => plain(i) && /\S[ \t]{2,}\S/.test(l)));
  }

  // 6. Linhas em branco em excesso (3+ quebras viram 2) e sobras no começo/fim
  {
    const examples: WasteExample[] = [];
    let n = 0;
    for (const m of orig.matchAll(/\n{3,}/g)) {
      n++;
      // text = quantas linhas em branco seguidas
      if (examples.length < MAX_EXAMPLES) examples.push({ line: orig.slice(0, m.index).split("\n").length + 1, text: String(m[0].length - 1) });
    }
    if (/^\s*\n|\n\s*$/.test(orig)) n++;
    step("blankLines", cur.replace(/\n{3,}/g, "\n\n").trim(), { count: n, examples });
  }

  // 7. Linhas repetidas: só aponta (apagar muda o sentido; o usuário decide)
  {
    const seen = new Set<string>();
    const examples: WasteExample[] = [];
    let dupTokens = 0;
    let n = 0;
    ols.forEach((l, i) => {
      const key = l.trim();
      if (!plain(i) || key.length < 25) return;
      if (!seen.has(key)) {
        seen.add(key);
        return;
      }
      n++;
      dupTokens += count(`${key}\n`);
      if (examples.length < MAX_EXAMPLES) examples.push({ line: i + 1, text: l });
    });
    if (n > 0) issues.push({ kind: "duplicateLines", occurrences: n, tokensSaved: dupTokens, applied: false, examples });
  }

  return { original: text, optimized: cur, originalTokens, optimizedTokens: count(cur), issues };
}

/** Mostra o que é invisível: espaço vira ·, tab vira →. */
export const revealWhitespace = (s: string): string =>
  s.replace(/\t/g, "→").replace(/[  ]/g, "⍽").replace(/[​-‍⁠﻿­]/g, "¤").replace(/ /g, "·");
