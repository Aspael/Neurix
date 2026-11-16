/**
 * Gera as artes animadas do README:
 *   assets/banner-en.svg, assets/banner-pt.svg  — cabeçalho com cérebro, nome e frases digitadas
 *   assets/divider.svg                          — separador de seções com brilho correndo
 *
 * Uso: node scripts/banner.ts
 */
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const MONO = "Cascadia Mono, SF Mono, Menlo, Consolas, DejaVu Sans Mono, monospace";
const SANS = "ui-sans-serif, Segoe UI, Inter, Helvetica, Arial, sans-serif";
const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface BannerText {
  phrases: string[];
  chips: string[];
}

const TEXT: Record<"en" | "pt", BannerText> = {
  en: {
    phrases: ['neurix "how many tokens?"', "tokens · cost · context window", "files · formats · RAG", "VRAM · KV cache · overhead"],
    chips: ["📝 Text", "📄 Files", "🔎 RAG", "🖥️ VRAM", "💵 US$ · R$", "🌐 EN · PT"],
  },
  pt: {
    phrases: ['neurix "quantos tokens?"', "tokens · custo · janela de contexto", "arquivos · formatos · RAG", "VRAM · KV cache · overhead"],
    chips: ["📝 Texto", "📄 Arquivos", "🔎 RAG", "🖥️ VRAM", "💵 US$ · R$", "🌐 PT · EN"],
  },
};

// ───────────── Cérebro (mesmo desenho do logo) ─────────────

const NEURONS: [number, number, number][] = [
  [44, 48, 6], [72, 38, 5], [82, 70, 6.5], [48, 86, 5], [62, 116, 5.5], [84, 108, 6],
  [156, 48, 6], [128, 38, 5], [118, 70, 6.5], [152, 86, 5], [138, 116, 5.5], [116, 108, 6],
];

function brain(): string {
  // Os neurônios acendem conforme a distância do centro, como uma onda.
  const circles = NEURONS.map(([x, y, r]) => {
    const dist = Math.hypot(x - 100, y - 78) / 70;
    return `<circle cx="${x}" cy="${y}" r="${r}"><animate attributeName="opacity" values=".3;1;.3;.3" keyTimes="0;.15;.4;1" dur="2.4s" begin="${(dist * 0.9).toFixed(2)}s" repeatCount="indefinite"/></circle>`;
  }).join("\n      ");
  return `
    <!-- ondas saindo do cérebro -->
    <g fill="none" stroke="url(#g)" stroke-width="2">
      <circle cx="100" cy="80" r="40" opacity="0"><animate attributeName="r" values="40;150" dur="3.6s" repeatCount="indefinite"/><animate attributeName="opacity" values=".55;0" dur="3.6s" repeatCount="indefinite"/></circle>
      <circle cx="100" cy="80" r="40" opacity="0"><animate attributeName="r" values="40;150" dur="3.6s" begin="1.8s" repeatCount="indefinite"/><animate attributeName="opacity" values=".55;0" dur="3.6s" begin="1.8s" repeatCount="indefinite"/></circle>
    </g>
    <g fill="url(#g)" fill-opacity=".1" stroke="url(#g)" stroke-width="7" stroke-linejoin="round">
      <path d="M94 12 C66 -2 32 8 24 34 C4 40 -2 70 12 86 C0 104 10 134 36 138 C44 158 76 164 94 148 Z"/>
      <path d="M106 12 C134 -2 168 8 176 34 C196 40 202 70 188 86 C200 104 190 134 164 138 C156 158 124 164 106 148 Z"/>
    </g>
    <rect x="94" y="150" width="12" height="22" rx="5" fill="url(#g)"/>
    <g fill="none" stroke="#67e8f9" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity=".7">
      <path d="M44 48 L72 38 L82 70 L48 86 L62 116 L84 108"/>
      <path d="M156 48 L128 38 L118 70 L152 86 L138 116 L116 108"/>
      <path d="M82 70 L118 70"/>
      <path d="M84 108 L116 108"/>
    </g>
    <g fill="#fde047" filter="url(#glow)">
      ${circles}
    </g>`;
}

// ───────────── Partículas ("tokens" subindo) ─────────────

function particles(w: number, h: number): string {
  const out: string[] = [];
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };
  const colors = ["#22d3ee", "#8b5cf6", "#f472b6", "#facc15"];
  for (let i = 0; i < 22; i++) {
    const x = 20 + rnd() * (w - 40);
    const size = 4 + rnd() * 6;
    const dur = 6 + rnd() * 6;
    const begin = -rnd() * dur;
    const color = colors[i % colors.length];
    out.push(
      `<rect x="${x.toFixed(0)}" y="${h}" width="${(size * 1.8).toFixed(1)}" height="${size.toFixed(1)}" rx="${(size / 2).toFixed(1)}" fill="${color}" opacity="0">` +
        `<animateTransform attributeName="transform" type="translate" values="0 0;0 -${h + 20}" dur="${dur.toFixed(1)}s" begin="${begin.toFixed(1)}s" repeatCount="indefinite"/>` +
        `<animate attributeName="opacity" values="0;.55;.55;0" keyTimes="0;.15;.7;1" dur="${dur.toFixed(1)}s" begin="${begin.toFixed(1)}s" repeatCount="indefinite"/></rect>`,
    );
  }
  return out.join("\n    ");
}

// ───────────── Frases digitadas ─────────────

function typing(phrases: string[], x: number, y: number): string {
  const per = 3.2; // segundos por frase
  const total = per * phrases.length;
  const charW = 22 * 0.6; // fonte mono 22px
  const kt = (n: number): string => (Math.min(1, Math.max(0, n)) / 1).toFixed(4);

  const defs: string[] = [];
  const groups: string[] = [];
  phrases.forEach((p, i) => {
    const full = (p.length + 2) * charW; // + "$ "
    const a = (i * per) / total;
    const typed = (i * per + Math.min(1.6, p.length * 0.06)) / total;
    const erase = ((i + 1) * per - 0.35) / total;
    const b = ((i + 1) * per) / total;
    // Largura do recorte: 0 → frase inteira (digitando) → mantém → 0 (apaga).
    defs.push(`<clipPath id="clip${i}"><rect x="${x}" y="${y - 26}" height="36" width="0">
        <animate attributeName="width" values="0;0;${full.toFixed(0)};${full.toFixed(0)};0;0" keyTimes="0;${kt(a)};${kt(typed)};${kt(erase)};${kt(b)};1" dur="${total}s" repeatCount="indefinite"/>
      </rect></clipPath>`);
    groups.push(`<g clip-path="url(#clip${i})">
      <text x="${x}" y="${y}"><tspan fill="#4ade80">$ </tspan><tspan fill="#e4e4e7">${esc(p)}</tspan></text>
      <rect x="${x}" y="${y - 19}" width="11" height="24" rx="2" fill="#f472b6">
        <animate attributeName="x" values="${x};${x};${(x + full).toFixed(0)};${(x + full).toFixed(0)};${x};${x}" keyTimes="0;${kt(a)};${kt(typed)};${kt(erase)};${kt(b)};1" dur="${total}s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
      </rect>
    </g>`);
  });
  return `<defs>${defs.join("")}</defs>
    <g font-family="${MONO}" font-size="22">
    ${groups.join("\n    ")}
    </g>`;
}

// ───────────── Chips ─────────────

function chips(list: string[], x: number, y: number): string {
  let cx = x;
  return list
    .map((c, i) => {
      const w = 28 + [...c].length * 9.2;
      const out = `<g opacity="0">
      <animate attributeName="opacity" values="0;1" dur=".6s" begin="${(0.3 + i * 0.15).toFixed(2)}s" fill="freeze"/>
      <rect x="${cx.toFixed(0)}" y="${y}" width="${w.toFixed(0)}" height="32" rx="16" fill="#ffffff" fill-opacity=".05" stroke="url(#g)" stroke-opacity=".7"/>
      <text x="${(cx + w / 2).toFixed(0)}" y="${y + 21}" text-anchor="middle" fill="#d4d4d8" font-family="${SANS}" font-size="15">${esc(c)}</text>
    </g>`;
      cx += w + 10;
      return out;
    })
    .join("\n    ");
}

function banner(t: BannerText): string {
  const W = 960;
  const H = 320;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <title>Neurix — LLM token calculator</title>
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#8b5cf6"/><stop offset="1" stop-color="#f472b6"/>
    </linearGradient>
    <linearGradient id="word" gradientUnits="userSpaceOnUse" x1="300" y1="0" x2="760" y2="0" spreadMethod="reflect">
      <stop offset="0" stop-color="#22d3ee"/><stop offset=".5" stop-color="#8b5cf6"/><stop offset="1" stop-color="#f472b6"/>
      <animateTransform attributeName="gradientTransform" type="translate" values="0 0;460 0;0 0" dur="6s" repeatCount="indefinite"/>
    </linearGradient>
    <radialGradient id="bg" cx=".25" cy=".35" r=".9">
      <stop offset="0" stop-color="#2a1f4d"/><stop offset=".6" stop-color="#141226"/><stop offset="1" stop-color="#0b0b14"/>
    </radialGradient>
    <pattern id="dots" width="24" height="24" patternUnits="userSpaceOnUse"><circle cx="2" cy="2" r="1.2" fill="#ffffff" opacity=".07"/></pattern>
    <filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="2.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <clipPath id="frame"><rect width="${W}" height="${H}" rx="24"/></clipPath>
  </defs>

  <g clip-path="url(#frame)">
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <rect width="${W}" height="${H}" fill="url(#dots)"/>
    ${particles(W, H)}
  </g>
  <rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="23" fill="none" stroke="url(#g)" stroke-opacity=".35"/>

  <g transform="translate(48 58) scale(1.05)">${brain()}
  </g>

  <text x="300" y="138" fill="url(#word)" font-family="${SANS}" font-size="96" font-weight="800" letter-spacing="6">NEURIX</text>
  ${typing(t.phrases, 304, 196)}
  ${chips(t.chips, 300, 238)}
</svg>
`;
}

function divider(): string {
  const W = 900;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="12" viewBox="0 0 ${W} 12">
  <defs>
    <linearGradient id="line" x1="0" x2="1">
      <stop offset="0" stop-color="#22d3ee" stop-opacity="0"/><stop offset=".2" stop-color="#22d3ee"/>
      <stop offset=".5" stop-color="#8b5cf6"/><stop offset=".8" stop-color="#f472b6"/><stop offset="1" stop-color="#f472b6" stop-opacity="0"/>
    </linearGradient>
    <radialGradient id="spark"><stop offset="0" stop-color="#ffffff"/><stop offset=".4" stop-color="#fde047"/><stop offset="1" stop-color="#fde047" stop-opacity="0"/></radialGradient>
  </defs>
  <rect x="0" y="5" width="${W}" height="2" rx="1" fill="url(#line)" opacity=".8"/>
  <circle cx="0" cy="6" r="6" fill="url(#spark)">
    <animate attributeName="cx" values="-10;${W + 10}" dur="4s" repeatCount="indefinite"/>
  </circle>
</svg>
`;
}

await writeFile(join(root, "assets/banner-en.svg"), banner(TEXT.en));
await writeFile(join(root, "assets/banner-pt.svg"), banner(TEXT.pt));
await writeFile(join(root, "assets/divider.svg"), divider());
console.log("✓ assets/banner-en.svg\n✓ assets/banner-pt.svg\n✓ assets/divider.svg");
