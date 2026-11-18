/**
 * Relatórios exportáveis: todo resultado do Neurix vira um Report (título, metadados e seções com
 * pares chave-valor, tabelas e textos) e sai em Markdown, CSV, JSON ou HTML.
 *
 * As telas registram o último relatório com setLastReport(); a CLI (--export) e o menu ("📤 Exportar")
 * só pegam esse relatório e salvam no formato pedido.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };

export type Cell = string | number | boolean | null;

export interface Section {
  heading: string;
  kv?: [string, Cell][];
  table?: { head: string[]; rows: Cell[][] };
  text?: string[];
}

export interface Report {
  /** Tipo do resultado (ex.: "budget", "local", "folder"). */
  kind: string;
  title: string;
  generatedAt: string;
  meta: Record<string, Cell>;
  sections: Section[];
}

export type ReportFormat = "md" | "csv" | "json" | "html";
export const FORMATS: ReportFormat[] = ["md", "csv", "json", "html"];

export function newReport(kind: string, title: string, meta: Record<string, Cell> = {}): Report {
  return { kind, title, generatedAt: new Date().toISOString(), meta: { neurix: pkg.version, ...meta }, sections: [] };
}

// ───────────── Último relatório ─────────────

let last: Report | null = null;
export const setLastReport = (r: Report): void => {
  last = r;
};
export const getLastReport = (): Report | null => last;
export const clearLastReport = (): void => {
  last = null;
};

// ───────────── Formatação ─────────────

/** Remove cores ANSI (o texto das telas às vezes chega colorido). */
// biome-ignore lint/suspicious/noControlCharactersInRegex: remove sequências ANSI
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, "");

const human = (c: Cell, locale: string): string => {
  if (c === null) return "—";
  if (typeof c === "number") {
    if (!Number.isFinite(c)) return "∞";
    const abs = Math.abs(c);
    const digits = abs !== 0 && abs < 0.01 ? 6 : abs < 100 ? 4 : 2;
    return c.toLocaleString(locale, { maximumFractionDigits: digits });
  }
  if (typeof c === "boolean") return c ? "✓" : "✗";
  return plain(c);
};

const mdEscape = (s: string): string => s.replace(/\|/g, "\\|").replace(/\n/g, "<br>");

export function toMarkdown(r: Report, locale = "pt-BR"): string {
  const out: string[] = [`# ${r.title}`, ""];
  out.push(`_${new Date(r.generatedAt).toLocaleString(locale)} · Neurix ${r.meta.neurix ?? ""}_`, "");
  const meta = Object.entries(r.meta).filter(([k]) => k !== "neurix");
  if (meta.length) {
    for (const [k, v] of meta) out.push(`- **${k}:** ${mdEscape(human(v, locale))}`);
    out.push("");
  }
  for (const s of r.sections) {
    out.push(`## ${plain(s.heading)}`, "");
    if (s.kv?.length) {
      out.push("| | |", "|---|---|");
      for (const [k, v] of s.kv) out.push(`| ${mdEscape(plain(k))} | ${mdEscape(human(v, locale))} |`);
      out.push("");
    }
    if (s.table) {
      out.push(`| ${s.table.head.map((h) => mdEscape(plain(h))).join(" | ")} |`);
      out.push(`|${s.table.head.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`);
      for (const row of s.table.rows) out.push(`| ${row.map((c) => mdEscape(human(c, locale))).join(" | ")} |`);
      out.push("");
    }
    for (const p of s.text ?? []) out.push(plain(p), "");
  }
  return `${out.join("\n").trimEnd()}\n`;
}

const csvCell = (c: Cell): string => {
  if (c === null) return "";
  const s = typeof c === "number" ? (Number.isFinite(c) ? String(c) : "") : typeof c === "boolean" ? (c ? "true" : "false") : plain(c);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * CSV: cada seção vira um bloco (linha com o título, cabeçalho e linhas), separados por uma linha em branco.
 * Números ficam crus (ponto decimal) para planilhas e scripts.
 */
export function toCsv(r: Report): string {
  const lines: string[] = [csvCell(r.title), `generated_at,${r.generatedAt}`];
  for (const [k, v] of Object.entries(r.meta)) lines.push(`${csvCell(k)},${csvCell(v)}`);
  for (const s of r.sections) {
    lines.push("", csvCell(`## ${plain(s.heading)}`));
    if (s.kv?.length) for (const [k, v] of s.kv) lines.push(`${csvCell(k)},${csvCell(v)}`);
    if (s.table) {
      lines.push(s.table.head.map(csvCell).join(","));
      for (const row of s.table.rows) lines.push(row.map(csvCell).join(","));
    }
    for (const p of s.text ?? []) lines.push(csvCell(p));
  }
  return `${lines.join("\n")}\n`;
}

export const toJson = (r: Report): string =>
  `${JSON.stringify(r, (_k, v) => (typeof v === "string" ? plain(v) : typeof v === "number" && !Number.isFinite(v) ? null : v), 2)}\n`;

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** HTML de uma página, sem dependências, com tema claro e escuro. */
export function toHtml(r: Report, locale = "pt-BR"): string {
  const cell = (c: Cell): string => esc(human(c, locale));
  const body: string[] = [];
  const meta = Object.entries(r.meta).filter(([k]) => k !== "neurix");
  if (meta.length) body.push(`<dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${cell(v)}</dd>`).join("")}</dl>`);
  for (const s of r.sections) {
    body.push(`<section><h2>${esc(plain(s.heading))}</h2>`);
    if (s.kv?.length) body.push(`<table class="kv">${s.kv.map(([k, v]) => `<tr><th>${esc(plain(k))}</th><td>${cell(v)}</td></tr>`).join("")}</table>`);
    if (s.table)
      body.push(
        `<div class="scroll"><table><thead><tr>${s.table.head.map((h) => `<th>${esc(plain(h))}</th>`).join("")}</tr></thead><tbody>${s.table.rows
          .map((row) => `<tr>${row.map((c, i) => `<td${i > 0 && typeof c === "number" ? ' class="n"' : ""}>${cell(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`,
      );
    for (const p of s.text ?? []) body.push(`<p>${esc(plain(p))}</p>`);
    body.push("</section>");
  }
  return `<!doctype html>
<html lang="${locale.startsWith("pt") ? "pt-BR" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(r.title)}</title>
<style>
:root { --bg:#fbfaff; --fg:#1e1b2e; --muted:#6b6880; --line:#e4e1f0; --accent:#8b5cf6; --head:#f3f0fd; }
@media (prefers-color-scheme: dark) { :root { --bg:#16141f; --fg:#ece9f7; --muted:#a29fb8; --line:#2e2a40; --accent:#a78bfa; --head:#201d2e; } }
* { box-sizing:border-box; }
body { margin:0; padding:32px 16px; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
main { max-width:980px; margin:0 auto; }
h1 { margin:0 0 4px; font-size:26px; } h1 span { color:var(--accent); }
.when { color:var(--muted); margin:0 0 20px; font-size:13px; }
h2 { font-size:17px; margin:28px 0 10px; padding-bottom:6px; border-bottom:2px solid var(--line); }
.meta { display:grid; grid-template-columns:max-content 1fr; gap:4px 16px; margin:0; }
.meta dt { color:var(--muted); } .meta dd { margin:0; font-weight:600; }
.scroll { overflow-x:auto; }
table { border-collapse:collapse; width:100%; font-size:14px; }
th, td { padding:6px 10px; border-bottom:1px solid var(--line); text-align:left; white-space:nowrap; }
thead th { background:var(--head); font-weight:600; }
td.n { text-align:right; font-variant-numeric:tabular-nums; }
table.kv th { width:40%; color:var(--muted); font-weight:500; white-space:normal; }
table.kv td { white-space:normal; }
p { color:var(--muted); }
footer { margin-top:36px; color:var(--muted); font-size:12px; }
</style>
</head>
<body><main>
<h1><span>🧠</span> ${esc(r.title)}</h1>
<p class="when">${esc(new Date(r.generatedAt).toLocaleString(locale))}</p>
${body.join("\n")}
<footer>Neurix ${esc(String(r.meta.neurix ?? ""))} · github.com/Aspael/Neurix</footer>
</main></body>
</html>
`;
}

export function formatFromPath(path: string): ReportFormat | null {
  const ext = extname(path).toLowerCase().replace(".", "");
  if (ext === "markdown") return "md";
  return (FORMATS as string[]).includes(ext) ? (ext as ReportFormat) : null;
}

export function renderReport(r: Report, format: ReportFormat, locale?: string): string {
  if (format === "md") return toMarkdown(r, locale);
  if (format === "csv") return toCsv(r);
  if (format === "json") return toJson(r);
  return toHtml(r, locale);
}

/** Salva o relatório; o formato vem da extensão (ou do parâmetro). Devolve o caminho absoluto. */
export async function writeReport(r: Report, path: string, format?: ReportFormat, locale?: string): Promise<string> {
  const fmt = format ?? formatFromPath(path) ?? "md";
  const full = resolve(formatFromPath(path) ? path : `${path}.${fmt}`);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, renderReport(r, fmt, locale));
  return full;
}

/** Nome sugerido: neurix-<tipo>-AAAA-MM-DD-HHMM.<ext> */
export const defaultReportName = (r: Report, format: ReportFormat): string =>
  `neurix-${r.kind}-${r.generatedAt.slice(0, 16).replace(/[:T]/g, "-")}.${format}`;
