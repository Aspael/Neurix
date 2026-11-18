/**
 * Gera as imagens do README em assets/screenshots/{en,pt}/*.svg a partir da saída REAL da CLI.
 * Cada comando roda com cores forçadas; os códigos ANSI viram uma janela de terminal em SVG.
 *
 * Uso: node scripts/screenshots.ts
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "src/cli.ts");
const self = fileURLToPath(import.meta.url);

type Lang = "pt" | "en";

// ───────────── Modo "render": imprime telas que não têm comando direto ─────────────

if (process.argv[2] === "--render") {
  const [, , , what, lang] = process.argv as [string, string, string, string, Lang];
  const { setLang, t } = await import("../src/i18n/index.ts");
  setLang(lang);
  const opts = { iof: 0, all: false, refreshFx: false, explain: false };
  const rate = { usdBrl: 5.4, source: "manual" as const, quotedAt: new Date().toISOString() };

  if (what === "splash") {
    const { splashFrame } = await import("../src/ui/anim.ts");
    console.log();
    for (const l of splashFrame(t().tagline)) console.log(l);
  } else {
    const { findModel, loadPrices } = await import("../src/prices/load.ts");
    const model = findModel(await loadPrices(), "claude-haiku-5-5");
    if (!model) throw new Error("modelo de exemplo não encontrado");

    if (what === "formats") {
      const { formatVariants } = await import("../src/core/formats.ts");
      const { printFormats } = await import("../src/ui/output.ts");
      const { counterFor } = await import("../src/core/tokens.ts");
      const counter = await counterFor(model);
      const cities = ["São Paulo", "Rio de Janeiro", "Manaus", "Recife", "Curitiba"];
      const data = Array.from({ length: 40 }, (_, i) => ({
        id: i + 1,
        name: `Customer ${i + 1}`,
        city: cities[i % cities.length],
        active: i % 3 !== 0,
        balance: Math.round(i * 137.5) / 10,
      }));
      printFormats("customers.json", formatVariants(JSON.stringify(data, null, 4), "json", counter.count), model, 300, rate, opts, counter);
    } else if (what === "rag") {
      const { simulateRag } = await import("../src/core/rag.ts");
      const { printRag } = await import("../src/ui/output.ts");
      const { counterFor } = await import("../src/core/tokens.ts");
      const input = {
        docTokens: 180_000,
        chunkSize: 512,
        overlap: 51,
        topK: 5,
        questionTokens: 50,
        systemTokens: 200,
        outputTokens: 300,
        queriesPerMonth: 1000,
        embedPricePer1M: 0.02,
      };
      printRag("manual.pdf.txt", model, input, simulateRag(model, input), rate, opts, await counterFor(model));
    }
  }
  process.exit(0);
}

// ───────────── Execução dos comandos ─────────────

const COLS = 100;

function run(args: string[], lang: Lang, home: string): string {
  const res = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    input: "",
    env: {
      ...process.env,
      FORCE_COLOR: "1",
      NO_COLOR: "",
      NEURIX_USD: "5.40",
      NEURIX_HOME: home,
      NEURIX_LANG: lang,
      NEURIX_NO_ANIM: "1",
      COLUMNS: String(COLS),
    },
  });
  if (res.status !== 0 && !res.stdout) throw new Error(`falhou: ${args.join(" ")}\n${res.stderr}`);
  return res.stdout;
}

// ───────────── ANSI → SVG ─────────────

const BASE: Record<number, string> = {
  30: "#3f3f46", 31: "#f87171", 32: "#4ade80", 33: "#facc15", 34: "#60a5fa", 35: "#e879f9", 36: "#22d3ee", 37: "#f4f4f5",
  90: "#71717a", 91: "#fca5a5", 92: "#86efac", 93: "#fde047", 94: "#93c5fd", 95: "#f0abfc", 96: "#67e8f9", 97: "#ffffff",
};
const FG = "#d4d4d8";
const BG = "#16161e";

function xterm256(n: number): string {
  if (n < 16) return BASE[n < 8 ? 30 + n : 82 + n] ?? FG;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v},${v},${v})`;
  }
  const i = n - 16;
  const lv = [0, 95, 135, 175, 215, 255];
  return `rgb(${lv[Math.floor(i / 36)]},${lv[Math.floor(i / 6) % 6]},${lv[i % 6]})`;
}

interface Style {
  fg?: string;
  bg?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
}
interface Run {
  col: number;
  text: string;
  style: Style;
}

/** Largura do caractere em colunas de terminal (emojis ocupam 2). */
function charWidth(cp: number): number {
  if (cp === 0xfe0f || cp === 0x200d) return 0;
  if (cp >= 0x1f000 || (cp >= 0x2600 && cp <= 0x27bf && cp !== 0x2713)) return 2;
  return 1;
}

function parseLine(line: string, style: Style): { runs: Run[]; style: Style; cols: number } {
  const runs: Run[] = [];
  let col = 0;
  let cur: Run | null = null;
  const re = /\x1b\[([0-9;?]*)([A-Za-z])/g;
  let last = 0;
  const pushText = (txt: string) => {
    for (const ch of txt) {
      const w = charWidth(ch.codePointAt(0) ?? 0);
      if (!cur) cur = { col, text: "", style: { ...style } };
      cur.text += ch;
      col += w;
    }
  };
  const flush = () => {
    if (cur?.text) runs.push(cur);
    cur = null;
  };
  for (let m = re.exec(line); m; m = re.exec(line)) {
    pushText(line.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== "m") continue;
    flush();
    const codes = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i] ?? 0;
      if (c === 0) style = {};
      else if (c === 1) style.bold = true;
      else if (c === 2) style.dim = true;
      else if (c === 22) style = { ...style, bold: false, dim: false };
      else if (c === 3) style.italic = true;
      else if (c === 23) style.italic = false;
      else if (c === 39) style.fg = undefined;
      else if (c === 49) style.bg = undefined;
      else if (c === 38 && codes[i + 1] === 5) {
        style.fg = xterm256(codes[i + 2] ?? 7);
        i += 2;
      } else if (BASE[c]) style.fg = BASE[c];
      else if (c >= 40 && c <= 47) style.bg = BASE[c - 10];
    }
  }
  pushText(line.slice(last));
  flush();
  return { runs, style, cols: col };
}

/**
 * Caracteres de bloco e de moldura viram formas vetoriais: como texto, cada fonte
 * os desenha com tamanho diferente e o cérebro/logo ficam "furados".
 */
function glyph(ch: string, x: number, top: number, cw: number, lh: number, color: string, op: string): string | null {
  const cx = x + cw / 2;
  const cy = top + lh / 2;
  const r = x + cw;
  const b = top + lh;
  const rect = (rx: number, ry: number, rw: number, rh: number) =>
    `<rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${(rw + 0.4).toFixed(1)}" height="${(rh + 0.4).toFixed(1)}" fill="${color}"${op}/>`;
  const path = (d: string, sw = 1.3) =>
    `<path d="${d}" fill="none" stroke="${color}" stroke-width="${sw}"${op}/>`;
  const d = 1.7;
  switch (ch) {
    case "█": return rect(x, top, cw, lh);
    case "▀": return rect(x, top, cw, lh / 2);
    case "▄": return rect(x, cy, cw, lh / 2);
    case "▌": return rect(x, top, cw / 2, lh);
    case "▐": return rect(cx, top, cw / 2, lh);
    case "─": return path(`M${x} ${cy}H${r}`);
    case "│": return path(`M${cx} ${top}V${b}`);
    case "┌": case "╭": return path(`M${r} ${cy}H${cx}V${b}`);
    case "┐": case "╮": return path(`M${x} ${cy}H${cx}V${b}`);
    case "└": case "╰": return path(`M${cx} ${top}V${cy}H${r}`);
    case "┘": case "╯": return path(`M${cx} ${top}V${cy}H${x}`);
    case "├": return path(`M${cx} ${top}V${b}M${cx} ${cy}H${r}`);
    case "┤": return path(`M${cx} ${top}V${b}M${cx} ${cy}H${x}`);
    case "═": return path(`M${x} ${cy - d}H${r}M${x} ${cy + d}H${r}`, 1.1);
    case "║": return path(`M${cx - d} ${top}V${b}M${cx + d} ${top}V${b}`, 1.1);
    case "╔": return path(`M${r} ${cy - d}H${cx - d}V${b}M${r} ${cy + d}H${cx + d}V${b}`, 1.1);
    case "╗": return path(`M${x} ${cy - d}H${cx + d}V${b}M${x} ${cy + d}H${cx - d}V${b}`, 1.1);
    case "╚": return path(`M${cx - d} ${top}V${cy + d}H${r}M${cx + d} ${top}V${cy - d}H${r}`, 1.1);
    case "╝": return path(`M${cx + d} ${top}V${cy + d}H${x}M${cx - d} ${top}V${cy - d}H${x}`, 1.1);
    default: return null;
  }
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const CW = 8.4;
const LH = 19;
const PAD = 20;
const BAR = 38;
const MONO = "Cascadia Mono, SF Mono, Menlo, Consolas, DejaVu Sans Mono, monospace";
const SANS = "ui-sans-serif, Segoe UI, Helvetica, Arial, sans-serif";

/** Cores do cérebro "em repouso" (neurônio e sinapse): são elas que piscam na animação. */
const NEURON = new Set([xterm256(159), xterm256(31)]);

interface Rendered {
  body: string;
  cols: number;
  rows: number;
}

/**
 * Converte ANSI em elementos SVG.
 * Com `pulse`, neurônios e sinapses do cérebro acendem em ondas que saem do centro.
 */
function renderLines(ansi: string, pulse?: { dur: number }): Rendered {
  const raw = ansi.replace(/\r/g, "").replace(/\n+$/, "").split("\n");
  let style: Style = {};
  const lines = raw.map((l) => {
    const r = parseLine(l, style);
    style = r.style;
    return r;
  });

  // Centro do cérebro = média das posições dos neurônios.
  const pts: [number, number][] = [];
  lines.forEach((l, row) => {
    for (const r of l.runs) {
      if (!NEURON.has(r.style.fg ?? "")) continue;
      let col = r.col;
      for (const ch of r.text) {
        if (ch.trim()) pts.push([col, row]);
        col += charWidth(ch.codePointAt(0) ?? 0);
      }
    }
  });
  const cCol = pts.reduce((a, p) => a + p[0], 0) / (pts.length || 1);
  const cRow = pts.reduce((a, p) => a + p[1], 0) / (pts.length || 1);
  const maxDist = Math.max(1, ...pts.map(([c, r]) => Math.hypot((c - cCol) / 2.2, r - cRow)));
  const pulseAnim = (col: number, row: number): string => {
    if (!pulse) return "";
    const dist = Math.hypot((col - cCol) / 2.2, row - cRow) / maxDist;
    const begin = (dist * pulse.dur * 0.45).toFixed(2);
    return `<animate attributeName="opacity" values="0.3;1;0.3;0.3" keyTimes="0;0.12;0.3;1" dur="${pulse.dur}s" begin="${begin}s" repeatCount="indefinite"/>`;
  };

  const body = lines
    .map((l, i) => {
      const y = BAR + PAD + i * LH;
      const bgs = l.runs
        .filter((r) => r.style.bg)
        .map(
          (r) =>
            `<rect x="${(PAD + r.col * CW).toFixed(1)}" y="${y - 14}" width="${([...r.text].length * CW).toFixed(1)}" height="${LH}" fill="${r.style.bg}"/>`,
        )
        .join("");
      const shapes: string[] = [];
      const spans: string[] = [];
      const animated: string[] = [];
      for (const r of l.runs) {
        const s = r.style;
        const color = s.fg ?? FG;
        const isNeuron = Boolean(pulse) && NEURON.has(color);
        const op = s.dim ? ' opacity="0.6"' : "";
        let col = r.col;
        let buf = "";
        let bufCol = col;
        const flush = () => {
          // Navegadores juntam espaços repetidos em SVG; por isso cada trecho separado por
          // 2+ espaços (colunas de tabela, alinhamentos) ganha a sua própria posição x.
          let c = bufCol;
          for (const part of buf.split(/( {2,})/)) {
            const lead = part.length - part.trimStart().length;
            if (part.trim()) {
              const attrs = [
                `x="${(PAD + (c + lead) * CW).toFixed(1)}"`,
                `fill="${color}"`,
                s.bold ? 'font-weight="700"' : "",
                s.italic ? 'font-style="italic"' : "",
                s.dim ? 'opacity="0.6"' : "",
              ].filter(Boolean);
              spans.push(`<tspan ${attrs.join(" ")}>${esc(part.trimStart())}</tspan>`);
            }
            for (const ch of part) c += charWidth(ch.codePointAt(0) ?? 0);
          }
          buf = "";
        };
        for (const ch of r.text) {
          const x = PAD + col * CW;
          if (isNeuron && ch.trim()) {
            flush();
            // Cada neurônio/sinapse vira um elemento próprio, com atraso proporcional à distância do centro.
            const shape = glyph(ch, x, y - 14, CW, LH, color, "");
            const anim = pulseAnim(col, i);
            animated.push(
              shape
                ? shape.replace("/>", `>${anim}</${shape.startsWith("<rect") ? "rect" : "path"}>`)
                : `<text x="${x.toFixed(1)}" y="${y}" fill="${color}" font-weight="700">${esc(ch)}${anim}</text>`,
            );
          } else {
            const shape = glyph(ch, x, y - 14, CW, LH, color, op);
            if (shape) {
              flush();
              shapes.push(shape);
            } else {
              if (!buf) bufCol = col;
              buf += ch;
            }
          }
          col += charWidth(ch.codePointAt(0) ?? 0);
        }
        flush();
      }
      return `${bgs}${shapes.join("")}<text y="${y}">${spans.join("")}</text>${animated.join("")}`;
    })
    .join("\n    ");

  return { body, cols: Math.max(60, ...lines.map((l) => l.cols)), rows: lines.length };
}

const size = (cols: number, rows: number): { w: number; h: number } => ({
  w: Math.ceil(cols * CW + PAD * 2),
  h: Math.ceil(BAR + PAD + rows * LH + PAD / 2),
});

const titleText = (w: number, title: string): string =>
  `<text x="${w / 2}" y="24" text-anchor="middle" fill="#a1a1aa" font-family="${SANS}" font-size="13">${esc(title)}</text>`;

/** Janela de terminal (moldura e barra com as bolinhas) em volta do conteúdo. */
function windowSvg(w: number, h: number, inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xml:space="preserve">
  <defs>
    <linearGradient id="bar" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee" stop-opacity=".18"/><stop offset="1" stop-color="#e879f9" stop-opacity=".18"/></linearGradient>
    <linearGradient id="prog" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#8b5cf6"/><stop offset="1" stop-color="#f472b6"/></linearGradient>
  </defs>
  <rect width="${w}" height="${h}" rx="12" fill="${BG}"/>
  <rect width="${w}" height="${BAR}" rx="12" fill="url(#bar)"/>
  <rect y="${BAR - 12}" width="${w}" height="12" fill="${BG}"/>
  <circle cx="22" cy="19" r="6" fill="#ff5f57"/><circle cx="42" cy="19" r="6" fill="#febc2e"/><circle cx="62" cy="19" r="6" fill="#28c840"/>
  <g font-family="${MONO}" font-size="14">
    ${inner}
  </g>
</svg>
`;
}

function toSvg(ansi: string, title: string, pulse = false): string {
  const r = renderLines(ansi, pulse ? { dur: 2.4 } : undefined);
  const { w, h } = size(r.cols, r.rows);
  return windowSvg(w, h, `${titleText(w, title)}\n    ${r.body}`);
}

interface Scene {
  ansi: string;
  title: string;
  seconds: number;
  pulse?: boolean;
}

/**
 * Demo animada: as telas aparecem uma depois da outra, com transição suave
 * e uma barra de progresso embaixo. Fica em loop.
 */
function toDemoSvg(scenes: Scene[]): string {
  const rendered = scenes.map((s) => ({ ...s, r: renderLines(s.ansi, s.pulse ? { dur: 2.4 } : undefined) }));
  const cols = Math.max(...rendered.map((s) => s.r.cols));
  const rows = Math.max(...rendered.map((s) => s.r.rows));
  const { w, h } = size(cols, rows);
  const total = rendered.reduce((a, s) => a + s.seconds, 0);
  const fade = 0.5 / total;
  const kt = (n: number): string => Math.min(1, Math.max(0, n)).toFixed(4);

  let t = 0;
  const groups = rendered.map((s, i) => {
    const a = t / total;
    const b = (t + s.seconds) / total;
    t += s.seconds;
    // A 1ª cena começa visível, para quem vê a imagem sem animação.
    const values = i === 0 ? "1;1;0;0;1" : "0;0;1;1;0;0";
    const keyTimes =
      i === 0 ? `0;${kt(b - fade)};${kt(b)};${kt(1 - fade)};1` : `0;${kt(a)};${kt(a + fade)};${kt(b - fade)};${kt(b)};1`;
    return `<g opacity="${i === 0 ? 1 : 0}">
    <animate attributeName="opacity" values="${values}" keyTimes="${keyTimes}" dur="${total}s" repeatCount="indefinite"/>
    ${titleText(w, s.title)}
    ${s.r.body}
  </g>`;
  });

  const progress = `<rect x="0" y="${h - 3}" width="0" height="3" fill="url(#prog)">
    <animate attributeName="width" values="0;${w}" dur="${total}s" repeatCount="indefinite"/>
  </rect>`;
  return windowSvg(w, h, `${groups.join("\n  ")}\n  ${progress}`);
}

// ───────────── Telas ─────────────

interface Shot {
  file: string;
  title: (lang: Lang) => string;
  ansi: (lang: Lang, home: string) => string;
}

const SAMPLE: Record<Lang, string> = {
  pt: "Explique em poucas linhas o que é um token em modelos de linguagem e por que o português gasta mais tokens que o inglês.",
  en: "Explain in a few lines what a token is in language models and why some languages use more tokens than English.",
};

const SHOTS: Shot[] = [
  {
    file: "menu",
    title: () => "neurix",
    ansi: (lang, home) => {
      const splash = run([self, "--render", "splash", lang], lang, home);
      const menu = run([cli], lang, home);
      // Mantém só a parte do menu (depois do slogan) e troca a abertura estática pela do cérebro.
      const lines = menu.split("\n");
      const start = lines.findIndex((l) => l.includes("┌"));
      return `${splash}\n${lines.slice(start).join("\n")}`;
    },
  },
  {
    file: "estimate",
    title: () => "neurix \"…\" -m claude-sonnet-5-5 --explain",
    ansi: (lang, home) => run([cli, SAMPLE[lang], "-m", "claude-sonnet-5-5", "-e"], lang, home),
  },
  {
    file: "compare",
    title: () => 'neurix "…"',
    ansi: (lang, home) => run([cli, SAMPLE[lang]], lang, home),
  },
  {
    file: "local",
    title: () => "neurix local -m llama-3.1-8b -c 32k -g 8",
    ansi: (lang, home) => run([cli, "local", "-m", "llama-3.1-8b", "-c", "32k", "-g", "8"], lang, home),
  },
  {
    file: "formats",
    title: (lang) => (lang === "pt" ? "neurix → Simular arquivo → Como formato" : "neurix → Simulate file → As format"),
    ansi: (lang, home) => run([self, "--render", "formats", lang], lang, home),
  },
  {
    file: "rag",
    title: (lang) => (lang === "pt" ? "neurix → Simular arquivo → Cenário RAG" : "neurix → Simulate file → RAG scenario"),
    ansi: (lang, home) => run([self, "--render", "rag", lang], lang, home),
  },
];

const home = await mkdtemp(join(tmpdir(), "neurix-shots-"));
for (const lang of ["en", "pt"] as Lang[]) {
  const dir = join(root, "assets/screenshots", lang);
  await mkdir(dir, { recursive: true });
  const ansi: Record<string, string> = {};
  for (const shot of SHOTS) {
    ansi[shot.file] = shot.ansi(lang, home);
    const svg = toSvg(ansi[shot.file] ?? "", shot.title(lang), shot.file === "menu");
    await writeFile(join(dir, `${shot.file}.svg`), svg);
    console.log(`✓ assets/screenshots/${lang}/${shot.file}.svg`);
  }

  // Demo animada: as telas mais curtas em sequência (a estimativa explicada é alta demais).
  const order: [string, number][] = [
    ["menu", 6],
    ["compare", 4.5],
    ["formats", 4.5],
    ["rag", 5],
    ["local", 5],
  ];
  const demo = toDemoSvg(
    order.map(([file, seconds]) => ({
      ansi: ansi[file] ?? "",
      title: SHOTS.find((s) => s.file === file)?.title(lang) ?? "",
      seconds,
      pulse: file === "menu",
    })),
  );
  await writeFile(join(dir, "demo.svg"), demo);
  console.log(`✓ assets/screenshots/${lang}/demo.svg`);
}
