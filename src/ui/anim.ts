/**
 * Efeitos visuais do menu: cérebro com neurônios disparando, logo em degradê,
 * texto digitado e transições. Tudo é desligado automaticamente quando não há
 * terminal interativo, em CI, com NO_COLOR ou com NEURIX_NO_ANIM=1.
 */
import pc from "picocolors";

const ESC = "\x1b[";
const fg = (n: number): string => `${ESC}38;5;${n}m`;
const RESET = `${ESC}0m`;
const BOLD = `${ESC}1m`;

export const canAnimate = (): boolean =>
  Boolean(process.stdout.isTTY) && !process.env.CI && !process.env.NEURIX_NO_ANIM && pc.isColorSupported;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const write = (s: string): void => {
  process.stdout.write(s);
};

let cursorHidden = false;
function hideCursor(): void {
  if (cursorHidden) return;
  cursorHidden = true;
  write(`${ESC}?25l`);
  process.once("exit", () => write(`${ESC}?25h`));
}
function showCursor(): void {
  if (!cursorHidden) return;
  cursorHidden = false;
  write(`${ESC}?25h`);
}

// ───────────── Cérebro ─────────────

/** ● = neurônio · ─╲╱│ = sinapse · · = detalhe · resto = contorno. */
const BRAIN_ART = [
  "          ▄▄▄██████▄▄▄  ▄▄▄██████▄▄▄",
  "       ▄██▀▀  ·   ●   ▀██▀   ●   ·  ▀▀██▄",
  "     ▄█▀   ●────●   ·   ██   ·   ●────●   ▀█▄",
  "    ██  ·      ╲    ●───██───●    ╱      ·  ██",
  "   ██    ●──────●       ██       ●──────●    ██",
  "   ██  ·   ╱       ●────██────●       ╲   ·  ██",
  "    ██   ●────●     ·   ██   ·     ●────●   ██",
  "     ▀█▄    ·   ●───────██───────●   ·    ▄█▀",
  "       ▀██▄▄   ·    ●  ▄█▀▀█▄  ●    ·   ▄▄██▀",
  "          ▀▀▀██████▀▀▀  ▐██▌  ▀▀▀██████▀▀▀",
  "                         ▀▀",
];

/** Remove a indentação comum para poder centralizar o cérebro sobre o logo. */
const MIN_INDENT = Math.min(...BRAIN_ART.map((l) => l.length - l.trimStart().length));
const BRAIN = BRAIN_ART.map((l) => l.slice(MIN_INDENT));
const BRAIN_W = Math.max(...BRAIN.map((l) => [...l].length));
const LOGO_W = 46;
const BRAIN_PAD = " ".repeat(2 + Math.max(0, Math.floor((LOGO_W - BRAIN_W) / 2)));
const CENTER_COL = BRAIN_W / 2;
const CENTER_ROW = BRAIN.length / 2;
/** Degradê rosa → roxo → azul → ciano, por linha. */
const OUTLINE = [213, 207, 171, 135, 99, 63, 69, 75, 81, 87, 51];

/**
 * Pinta um quadro. `wave` é o raio da onda de ativação que sai do centro;
 * neurônios e sinapses perto da frente da onda acendem.
 */
function paintBrain(wave: number | null): string[] {
  return BRAIN.map((line, row) => {
    let out = "";
    [...line].forEach((ch, col) => {
      const dist = Math.hypot((col - CENTER_COL) / 2.2, row - CENTER_ROW);
      const near = wave === null ? false : Math.abs(dist - wave) < 1.6;
      const settled = wave === null;
      if (ch === "●") out += near ? `${BOLD}${fg(226)}●${RESET}` : settled ? `${fg(159)}●${RESET}` : `${fg(60)}●${RESET}`;
      else if ("─╲╱│".includes(ch)) out += near ? `${fg(51)}${ch}${RESET}` : settled ? `${fg(31)}${ch}${RESET}` : `${fg(238)}${ch}${RESET}`;
      else if (ch === "·") out += near ? `${fg(229)}·${RESET}` : `${fg(240)}·${RESET}`;
      else if (ch === " ") out += " ";
      else out += `${fg(OUTLINE[row] ?? 51)}${ch}${RESET}`;
    });
    return `${BRAIN_PAD}${out}`;
  });
}

async function animateBrain(): Promise<void> {
  const maxR = Math.hypot(CENTER_COL / 2.2, CENTER_ROW) + 2;
  const frames = 22;
  hideCursor();
  write(`${paintBrain(0).join("\n")}\n`);
  for (let f = 1; f <= frames; f++) {
    await sleep(45);
    // Duas ondas: a segunda começa quando a primeira está na metade.
    const r = (f / frames) * maxR * 1.6;
    const wave = r > maxR ? r - maxR * 0.8 : r;
    write(`${ESC}${BRAIN.length}A`);
    write(`${paintBrain(wave).join("\n")}\n`);
  }
  await sleep(40);
  write(`${ESC}${BRAIN.length}A`);
  write(`${paintBrain(null).join("\n")}\n`);
}

// ───────────── Logo ─────────────

const LOGO = [
  "███╗   ██╗███████╗██╗   ██╗██████╗ ██╗██╗  ██╗",
  "████╗  ██║██╔════╝██║   ██║██╔══██╗██║╚██╗██╔╝",
  "██╔██╗ ██║█████╗  ██║   ██║██████╔╝██║ ╚███╔╝ ",
  "██║╚██╗██║██╔══╝  ██║   ██║██╔══██╗██║ ██╔██╗ ",
  "██║ ╚████║███████╗╚██████╔╝██║  ██║██║██╔╝ ██╗",
  "╚═╝  ╚═══╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝",
];
/** Degradê horizontal ciano → azul → roxo → rosa. */
const LOGO_GRADIENT = [51, 45, 39, 33, 63, 99, 135, 171, 207, 213];

function paintLogoLine(line: string, shift = 0): string {
  const chars = [...line];
  return chars
    .map((ch, i) => {
      if (ch === " ") return " ";
      const idx = Math.floor(((i + shift) / chars.length) * LOGO_GRADIENT.length) % LOGO_GRADIENT.length;
      return `${fg(LOGO_GRADIENT[idx] ?? 51)}${ch}`;
    })
    .join("")
    .concat(RESET);
}

async function typewriter(text: string, ms = 7): Promise<void> {
  write("  ");
  for (const ch of text) {
    write(pc.dim(ch));
    await sleep(ms);
  }
  write("\n");
}

// ───────────── API ─────────────

const wide = (): boolean => (process.stdout.columns || 80) >= 52;

/** Abertura completa: cérebro → logo → slogan. Versão estática quando não dá para animar. */
export async function splash(tagline: string): Promise<void> {
  console.log();
  if (!canAnimate()) {
    if (wide()) for (const l of LOGO) console.log(`  ${pc.cyan(l)}`);
    else console.log(pc.bold(pc.cyan("  🧠 NEURIX")));
    console.log(pc.dim(`  ${tagline}`));
    console.log();
    return;
  }
  if (wide()) {
    await animateBrain();
    console.log();
    for (const l of LOGO) {
      console.log(`  ${paintLogoLine(l)}`);
      await sleep(35);
    }
  } else console.log(`  🧠 ${BOLD}${fg(51)}NEURIX${RESET}`);
  await typewriter(tagline);
  showCursor();
  console.log();
}

/** Cabeçalho curto (ao trocar de idioma, por exemplo). */
export function miniHeader(tagline: string): void {
  console.log();
  console.log(`  🧠 ${canAnimate() ? `${BOLD}${paintLogoLine("N E U R I X")}` : pc.bold(pc.cyan("N E U R I X"))}  ${pc.dim(tagline)}`);
  console.log();
}

/** Quadros do spinner: um neurônio pulsando. */
export const PULSE_FRAMES = ["◌", "○", "◎", "◉", "●", "◉", "◎", "○"];

/** Pequena pausa com spinner antes de mostrar um resultado, para dar a sensação de processamento. */
export async function thinking(
  spinnerFactory: (o: { frames: string[]; delay: number }) => { start(m?: string): void; stop(m?: string): void; message(m?: string): void },
  messages: string[],
  done: string,
): Promise<void> {
  if (!canAnimate()) return;
  const s = spinnerFactory({ frames: PULSE_FRAMES.map((f) => pc.magenta(f)), delay: 70 });
  s.start(messages[0]);
  for (const m of messages.slice(1)) {
    await sleep(220);
    s.message(m);
  }
  await sleep(220);
  s.stop(pc.green(done));
}

/** Quadro final da abertura (cérebro + logo + slogan), com cores. Usado para gerar as imagens do README. */
export function splashFrame(tagline: string): string[] {
  return [...paintBrain(null), "", ...LOGO.map((l) => `  ${paintLogoLine(l)}`), `  ${pc.dim(tagline)}`];
}
