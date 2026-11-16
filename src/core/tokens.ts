/** PT-BR gera ~20–30% mais tokens que inglês; chars/3.5 é a estimativa padrão do Neurix. */
export const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}
