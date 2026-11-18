/**
 * 📖 Manual: primeiros passos, glossário por categoria (para quem está começando) e TODOS os comandos.
 *
 * Os comandos e as opções vêm da própria definição da CLI (commander) — nunca ficam desatualizados.
 * Descrições curtas e exemplos de cada comando ficam no dicionário (manual.desc / manual.examples).
 */
import * as p from "@clack/prompts";
import type { Command, Option } from "commander";
import pc from "picocolors";
import { t } from "../i18n/index.ts";
import { newReport, setLastReport, type Report } from "../report/report.ts";
import { ok } from "./menu.ts";
import { termWidth, title, wrap } from "./output.ts";

let catalog: Command | null = null;
/** A CLI registra o programa aqui para o manual listar os comandos. */
export const setCommandCatalog = (program: Command): void => {
  catalog = program;
};

// ───────────── Comandos ─────────────

export interface OptionDoc {
  flags: string;
  description: string;
  defaultValue: string | null;
}

export interface CommandDoc {
  /** Chave no dicionário: "neurix" para o comando principal. */
  key: string;
  name: string;
  aliases: string[];
  usage: string;
  description: string;
  args: { name: string; description: string; required: boolean }[];
  options: OptionDoc[];
  examples: [string, string][];
}

const optDoc = (o: Option): OptionDoc => ({
  flags: o.flags,
  description: o.description,
  defaultValue:
    o.defaultValue === undefined || o.defaultValue === false || (Array.isArray(o.defaultValue) && !o.defaultValue.length) ? null : String(o.defaultValue),
});

function docFor(cmd: Command, root: boolean): CommandDoc {
  const M = t().manual;
  const key = root ? "neurix" : cmd.name();
  return {
    key,
    name: root ? "neurix" : `neurix ${cmd.name()}`,
    aliases: root ? [] : cmd.aliases(),
    usage: root ? `neurix ${cmd.usage()}` : `neurix ${cmd.name()} ${cmd.usage()}`,
    description: M.desc[key] ?? cmd.description(),
    args: cmd.registeredArguments.map((a) => ({ name: a.name() + (a.variadic ? "..." : ""), description: a.description, required: a.required })),
    // no principal, as opções são as globais (mostradas à parte)
    options: root ? [] : cmd.options.filter((o) => !o.hidden).map(optDoc),
    examples: M.examples[key] ?? [],
  };
}

export function commandDocs(): CommandDoc[] {
  if (!catalog) return [];
  return [docFor(catalog, true), ...catalog.commands.map((c) => docFor(c, false))];
}

export const globalOptions = (): OptionDoc[] => (catalog ? catalog.options.filter((o) => !o.hidden).map(optDoc) : []);

// ───────────── Impressão ─────────────

const width = (): number => Math.max(50, termWidth() - 4);

function printOptions(list: OptionDoc[]): void {
  const M = t().manual;
  const w = Math.min(34, Math.max(...list.map((o) => o.flags.length)) + 2);
  for (const o of list) {
    const def = o.defaultValue !== null ? pc.dim(` (${M.defaultVal(o.defaultValue)})`) : "";
    const lines = wrap(`${o.description}${def}`, width() - w - 4);
    lines.forEach((l, i) => console.log(`    ${i === 0 ? pc.cyan(o.flags.padEnd(w)) : " ".repeat(w)}${l}`));
  }
}

export function printCommand(d: CommandDoc): void {
  const M = t().manual;
  console.log();
  console.log(`${pc.bold(pc.magenta(d.name))}${d.aliases.length ? pc.dim(`  ${M.aliases} ${d.aliases.join(", ")}`) : ""}`);
  for (const l of wrap(d.description, width())) console.log(`  ${l}`);
  console.log(`  ${pc.dim(M.usage)} ${d.usage}`);
  if (d.args.length) {
    console.log(`  ${pc.bold(M.args)}`);
    for (const a of d.args) console.log(`    ${pc.cyan(a.name.padEnd(14))}${a.description} ${pc.dim(`(${a.required ? M.required : M.optional})`)}`);
  }
  if (d.options.length) {
    console.log(`  ${pc.bold(M.options)}`);
    printOptions(d.options);
  }
  if (d.examples.length) {
    console.log(`  ${pc.bold(M.examplesTitle)}`);
    for (const [cmd, what] of d.examples) console.log(`    ${pc.green("$")} ${cmd}  ${pc.dim(`# ${what}`)}`);
  }
}

export function printGlobalOptions(): void {
  const M = t().manual;
  console.log();
  console.log(pc.bold(pc.magenta(M.globalTitle)));
  for (const l of wrap(M.globalNote, width())) console.log(pc.dim(`  ${l}`));
  printOptions(globalOptions());
}

export function printAllCommands(): void {
  const M = t().manual;
  const docs = commandDocs();
  title(`${M.commands.trim()}  ${pc.dim(`(${docs.length})`)}`);
  for (const d of docs) printCommand(d);
  printGlobalOptions();
  console.log(pc.dim(`\n${M.tip}`));
  console.log();
}

export function printStart(): void {
  const M = t().manual;
  title(M.start);
  for (const l of M.startText) console.log(l ? wrap(l, width()).join("\n   ") : "");
  console.log();
}

export function printGlossary(cats: { title: string; terms: [string, string][] }[]): void {
  for (const c of cats) {
    title(c.title);
    for (const [term, text] of c.terms) {
      console.log(`  ${pc.bold(pc.cyan(term))}`);
      for (const l of wrap(text, width() - 4)) console.log(`    ${l}`);
      console.log();
    }
  }
}

// ───────────── Busca ─────────────

const norm = (s: string): string => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "");

export function findCommand(q: string): CommandDoc | undefined {
  const n = norm(q).replace(/^neurix\s*/, "");
  return commandDocs().find((d) => d.key === n || d.aliases.includes(n) || (n === "" && d.key === "neurix"));
}

export function findTerms(q: string): { title: string; terms: [string, string][] }[] {
  const n = norm(q);
  return t()
    .glossaryCats.map((c) => ({ title: c.title, terms: c.terms.filter(([term, text]) => norm(term).includes(n) || norm(text).includes(n)) }))
    .filter((c) => c.terms.length);
}

/** Todos os termos do glossário (para o MCP e para buscas). */
export const flatGlossary = (cats = t().glossaryCats): [string, string][] => cats.flatMap((c) => c.terms);

// ───────────── Relatório ─────────────

export function manualReport(part: "all" | "terms" | "commands" = "all"): Report {
  const M = t().manual;
  const r = newReport("manual", M.title.replace(/^\S+\s/, ""));
  if (part !== "commands") {
    r.sections.push({ heading: M.start.replace(/^\S+\s/, ""), text: M.startText.filter(Boolean) });
    for (const c of t().glossaryCats) r.sections.push({ heading: c.title, kv: c.terms.map(([term, text]) => [term, text]) });
  }
  if (part !== "terms") {
    for (const d of commandDocs())
      r.sections.push({
        heading: d.name,
        text: [d.description, `${M.usage} ${d.usage}`, ...(d.aliases.length ? [`${M.aliases} ${d.aliases.join(", ")}`] : []), ...d.examples.map(([c, w]) => `$ ${c}  # ${w}`)],
        ...(d.options.length && { table: { head: [M.options, "", ""], rows: d.options.map((o) => [o.flags, o.description, o.defaultValue]) } }),
      });
    r.sections.push({ heading: M.globalTitle, text: [M.globalNote], table: { head: [M.options, "", ""], rows: globalOptions().map((o) => [o.flags, o.description, o.defaultValue]) } });
  }
  return r;
}

// ───────────── Menu ─────────────

export async function manualFlow(): Promise<void> {
  const M = t().manual;
  const cats = t().glossaryCats;
  const total = flatGlossary().length;
  const docs = commandDocs();
  const choice = ok(
    await p.select<string>({
      message: M.choose,
      maxItems: 12,
      options: [
        { value: "start", label: M.start, hint: M.startHint },
        ...cats.map((c, i) => ({ value: `cat:${i}`, label: c.title, hint: M.terms(c.terms.length) })),
        { value: "glossary", label: M.glossaryAll, hint: M.glossaryAllHint(String(total)) },
        { value: "commands", label: M.commands, hint: M.commandsHint(docs.length) },
      ],
    }),
  );
  if (choice === "start") {
    printStart();
    setLastReport(manualReport("terms"));
  } else if (choice.startsWith("cat:")) {
    const c = cats[Number(choice.slice(4))];
    if (c) printGlossary([c]);
    setLastReport(manualReport("terms"));
  } else if (choice === "glossary") {
    printGlossary(cats);
    setLastReport(manualReport("terms"));
  } else {
    const which = ok(
      await p.select<string>({
        message: M.oneCommand,
        maxItems: 14,
        options: [{ value: "*", label: M.allCommands }, ...docs.map((d) => ({ value: d.key, label: d.name, hint: d.description.slice(0, 70) }))],
      }),
    );
    if (which === "*") printAllCommands();
    else {
      const d = docs.find((x) => x.key === which);
      if (d) printCommand(d);
      if (which === "neurix") printGlobalOptions();
      console.log();
    }
    setLastReport(manualReport("commands"));
  }
  console.log(pc.dim(wrap(M.tip, width()).join("\n")));
  console.log();
}

/** `neurix manual [busca]` no terminal. */
export function manualCli(query: string | undefined, part: "all" | "terms" | "commands"): boolean {
  const M = t().manual;
  if (query) {
    const cmd = findCommand(query);
    const terms = findTerms(query);
    if (!cmd && !terms.length) {
      console.error(pc.yellow(M.noMatch(query)));
      return false;
    }
    if (cmd) {
      printCommand(cmd);
      if (cmd.key === "neurix") printGlobalOptions();
      console.log();
    }
    if (terms.length) printGlossary(terms);
    setLastReport(manualReport(cmd ? "commands" : "terms"));
    return true;
  }
  if (part !== "commands") {
    printStart();
    printGlossary(t().glossaryCats);
  }
  if (part !== "terms") printAllCommands();
  setLastReport(manualReport(part));
  return true;
}
