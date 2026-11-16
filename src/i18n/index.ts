/** Idioma da interface (pt/en). A escolha fica salva em ~/.neurix/config.json. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { en } from "./en.ts";
import { pt, type Dict } from "./pt.ts";

export type Lang = "pt" | "en";
export const LANGS: Lang[] = ["pt", "en"];

const DICTS: Record<Lang, Dict> = { pt, en };
let current: Lang = "pt";

/** Dicionário do idioma atual. */
export const t = (): Dict => DICTS[current];
export const getLang = (): Lang => current;
export const setLang = (lang: Lang): void => {
  current = lang;
};
export const dictFor = (lang: Lang): Dict => DICTS[lang];
/** Locale para formatar números e datas. */
export const locale = (): string => (current === "en" ? "en-US" : "pt-BR");

export function parseLang(v: string | undefined): Lang | undefined {
  const s = v?.trim().toLowerCase();
  if (!s) return undefined;
  if (s.startsWith("en")) return "en";
  if (s.startsWith("pt")) return "pt";
  return undefined;
}

const configPath = (): string =>
  process.env.NEURIX_HOME ? join(process.env.NEURIX_HOME, "config.json") : join(homedir(), ".neurix", "config.json");

async function readConfig(): Promise<Record<string, unknown>> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Ordem: --lang → NEURIX_LANG → idioma salvo → português. */
export async function loadLang(flag?: string): Promise<Lang> {
  const lang = parseLang(flag) ?? parseLang(process.env.NEURIX_LANG) ?? parseLang((await readConfig()).lang as string) ?? "pt";
  setLang(lang);
  return lang;
}

export async function saveLang(lang: Lang): Promise<void> {
  setLang(lang);
  try {
    const cfg = await readConfig();
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ ...cfg, lang }, null, 2));
  } catch {
    // salvar é conveniência; o idioma já vale nesta sessão
  }
}
