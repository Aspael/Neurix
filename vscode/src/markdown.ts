/** Converte o JSON de uma ferramenta num relatório Markdown (títulos, listas e tabelas). */
type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const pretty = (k: string): string => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());
const esc = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function cell(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (isObj(v) && "usd" in v && "brl" in v) return `US$ ${v.usd as number}${typeof v.brl === "number" ? ` · R$ ${v.brl}` : ""}`;
  if (Array.isArray(v) && v.every((x) => !isObj(x))) return v.join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function flat(o: Obj): Obj {
  const r: Obj = {};
  for (const [k, v] of Object.entries(o)) {
    if (isObj(v) && !("usd" in v && "brl" in v) && Object.values(v).every((x) => !isObj(x))) for (const [k2, v2] of Object.entries(v)) r[`${k}.${k2}`] = v2;
    else r[k] = v;
  }
  return r;
}

function table(arr: Obj[]): string {
  const rows = arr.map(flat);
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [
    `| ${cols.map(pretty).join(" | ")} |`,
    `| ${cols.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${cols.map((c) => esc(cell(r[c]))).join(" | ")} |`),
  ].join("\n");
}

function section(obj: Obj, level: number): string {
  const lines: string[] = [];
  const nested: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v) && v.length && v.every(isObj)) nested.push(`${"#".repeat(level)} ${pretty(k)}\n\n${table(v)}`);
    else if (isObj(v) && !("usd" in v && "brl" in v) && level < 6) nested.push(`${"#".repeat(level)} ${pretty(k)}\n\n${section(v, level + 1)}`);
    else lines.push(`- **${pretty(k)}:** ${cell(v)}`);
  }
  return [lines.join("\n"), ...nested].filter(Boolean).join("\n\n");
}

export function toMarkdown(title: string, data: Obj): string {
  return `# ${title}\n\n_${new Date().toLocaleString()}_\n\n${section(data, 2)}\n`;
}
