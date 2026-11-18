/**
 * Converte o mesmo conteúdo para formatos diferentes e mede quantos tokens cada um gasta.
 * O dado é o mesmo; o que muda é quanto "enfeite" (espaços, aspas, chaves, nomes de campo) vai junto.
 */
import { estimateTokens } from "./tokens.ts";

export type SourceKind = "json" | "csv" | "text";

/** Os nomes e explicações de cada id ficam no dicionário de idioma (formats.names / formats.why). */
export type FormatId = "original" | "jsonPretty" | "jsonMin" | "yaml" | "csv" | "md" | "compact";

export interface FormatVariant {
  id: FormatId;
  content: string;
  chars: number;
  tokens: number;
  original?: boolean;
}

type Row = Record<string, unknown>;

// ───────────── Detecção ─────────────

export function detectKind(content: string, filename = ""): SourceKind {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  if (ext === "json") return "json";
  if (ext === "csv") return "csv";
  const t = content.trim();
  if ((t.startsWith("{") || t.startsWith("[")) && tryJson(t) !== undefined) return "json";
  return "text";
}

function tryJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// ───────────── CSV ─────────────

/** Parser CSV simples com suporte a aspas ("a,b" e "" escapado). */
export function parseCsv(content: string): Row[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const sepChar = (content.split("\n")[0] ?? "").includes(";") && !(content.split("\n")[0] ?? "").includes(",") ? ";" : ",";

  for (let i = 0; i < content.length; i++) {
    const c = content[i];
    if (quoted) {
      if (c === '"' && content[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sepChar) {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && content[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);

  const [head, ...body] = rows;
  if (!head) return [];
  return body.map((r) => Object.fromEntries(head.map((h, i) => [h, autoType(r[i] ?? "")])));
}

function autoType(v: string): unknown {
  if (v === "") return "";
  if (v === "true" || v === "false") return v === "true";
  const n = Number(v);
  return Number.isFinite(n) && /^-?\d+(\.\d+)?$/.test(v) ? n : v;
}

const isFlat = (v: unknown): v is Row =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => x === null || typeof x !== "object");

/** Lista de objetos "planos" vira tabela (CSV/Markdown). */
const asTable = (data: unknown): Row[] | null =>
  Array.isArray(data) && data.length > 0 && data.every(isFlat) ? (data as Row[]) : null;

function columns(rows: Row[]): string[] {
  const cols = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r)) cols.add(k);
  return [...cols];
}

const csvCell = (v: unknown): string => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows: Row[]): string {
  const cols = columns(rows);
  return [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
}

export function toMarkdownTable(rows: Row[]): string {
  const cols = columns(rows);
  const cell = (v: unknown): string => (v === null || v === undefined ? "" : String(v).replace(/\|/g, "\\|"));
  return [
    `| ${cols.join(" | ")} |`,
    `| ${cols.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${cols.map((c) => cell(r[c])).join(" | ")} |`),
  ].join("\n");
}

// ───────────── YAML ─────────────

const yamlScalar = (v: unknown): string => {
  if (v === null || v === undefined) return "null";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  const s = String(v);
  const plain = /^[\p{L}\p{N}_][\p{L}\p{N}_ .\-/@]*$/u.test(s) && !/^(true|false|null|yes|no|on|off|~)$/i.test(s) && !/^-?\d/.test(s);
  return plain ? s : JSON.stringify(s);
};

export function toYaml(v: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(v)) {
    if (v.length === 0) return `${pad}[]`;
    return v
      .map((item) => {
        if (item !== null && typeof item === "object") {
          const inner = toYaml(item, indent + 1).trimStart();
          return `${pad}- ${inner}`;
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v);
    if (entries.length === 0) return `${pad}{}`;
    return entries
      .map(([k, val]) => {
        const key = yamlScalar(k);
        if (val !== null && typeof val === "object" && (Array.isArray(val) ? val.length : Object.keys(val).length)) {
          return `${pad}${key}:\n${toYaml(val, indent + 1)}`;
        }
        return `${pad}${key}: ${val !== null && typeof val === "object" ? (Array.isArray(val) ? "[]" : "{}") : yamlScalar(val)}`;
      })
      .join("\n");
  }
  return pad + yamlScalar(v);
}

// ───────────── Texto ─────────────

/** Remove espaços repetidos, espaços no fim da linha e linhas em branco duplicadas. */
export const compactText = (s: string): string =>
  s
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

// ───────────── Variações ─────────────

const variant = (id: FormatId, content: string, count: (text: string) => number): FormatVariant => ({
  id,
  content,
  chars: content.length,
  tokens: count(content),
  ...(id === "original" && { original: true }),
});

/** `count` conta os tokens com o tokenizer do modelo escolhido (padrão: estimativa chars/3,5). */
export function formatVariants(content: string, kind: SourceKind, count: (text: string) => number = estimateTokens): FormatVariant[] {
  const v = (id: FormatId, text: string): FormatVariant => variant(id, text, count);
  const out: FormatVariant[] = [v("original", content)];

  if (kind === "json") {
    const data = tryJson(content);
    if (data === undefined) return [...out, v("compact", compactText(content))];
    out.push(v("jsonPretty", JSON.stringify(data, null, 2)));
    out.push(v("jsonMin", JSON.stringify(data)));
    out.push(v("yaml", toYaml(data)));
    const table = asTable(data);
    if (table) {
      out.push(v("csv", toCsv(table)));
      out.push(v("md", toMarkdownTable(table)));
    }
    return out;
  }

  if (kind === "csv") {
    const rows = parseCsv(content);
    if (rows.length === 0) return out;
    out.push(v("jsonPretty", JSON.stringify(rows, null, 2)));
    out.push(v("jsonMin", JSON.stringify(rows)));
    out.push(v("yaml", toYaml(rows)));
    out.push(v("md", toMarkdownTable(rows)));
    return out;
  }

  out.push(v("compact", compactText(content)));
  return out;
}
