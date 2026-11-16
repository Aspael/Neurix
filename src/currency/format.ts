import { locale } from "../i18n/index.ts";

/**
 * Valores de LLM costumam ser minúsculos (US$ 0,0000207). Acima de 1 centavo
 * mostramos 2–4 casas; abaixo, 3 dígitos significativos.
 */
function money(value: number, currency: "USD" | "BRL"): string {
  const abs = Math.abs(value);
  const opts: Intl.NumberFormatOptions =
    abs === 0
      ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
      : abs >= 1
        ? { minimumFractionDigits: 2, maximumFractionDigits: 2 }
        : abs >= 0.01
          ? { minimumFractionDigits: 2, maximumFractionDigits: 4 }
          : { maximumSignificantDigits: 3 };
  return new Intl.NumberFormat(locale(), { style: "currency", currency, ...opts }).format(value);
}

export const formatUsd = (v: number): string => money(v, "USD");
export const formatBrl = (v: number): string => money(v, "BRL");
export const formatInt = (v: number): string => new Intl.NumberFormat(locale()).format(Math.round(v));

/** Número com até `max` casas decimais, no formato do idioma (8,03 / 8.03). */
export const formatNum = (v: number, max = 2, min = 0): string =>
  new Intl.NumberFormat(locale(), { minimumFractionDigits: min, maximumFractionDigits: max }).format(v);

/** 1000000 → "1M", 128000 → "128k". */
export function formatContext(tokens: number | null): string {
  if (tokens === null) return "?";
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(2)}M`;
  return `${Math.round(tokens / 1000)}k`;
}
