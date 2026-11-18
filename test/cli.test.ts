/** Testes de ponta a ponta da CLI já compilada (dist/cli.js). Rode `pnpm build` antes. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import pkg from "../package.json" with { type: "json" };

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "dist", "cli.js");
let home: string;

/** Roda a CLI sem rede (câmbio manual), sem cor e sem animação, em inglês. */
function run(args: string[], input = ""): { code: number | null; out: string; err: string } {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    input,
    encoding: "utf8",
    env: { ...process.env, NEURIX_OFFLINE: "1", NEURIX_HOME: home, NEURIX_LANG: "en", NO_COLOR: "1", NEURIX_NO_ANIM: "1", COLUMNS: "100" },
  });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

before(async () => {
  assert.ok(existsSync(cli), "dist/cli.js não existe: rode `pnpm build` antes dos testes");
  home = await mkdtemp(join(tmpdir(), "neurix-home-"));
});
after(() => rm(home, { recursive: true, force: true }));

describe("cli", () => {
  test("--version bate com o package.json", () => {
    const r = run(["--version"]);
    assert.equal(r.code, 0);
    assert.equal(r.out.trim(), pkg.version);
  });

  test("custo de um texto num modelo OpenAI (contagem exata)", () => {
    const r = run(["--usd", "5", "-m", "gpt-6.1-sol", "hello world"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Tokens:\s+2 ✓ exact · o200k_base/);
    assert.match(r.out, /R\$/);
  });

  test("Claude aparece como estimativa, com o motivo", () => {
    const r = run(["--usd", "5", "-m", "claude-sonnet-5-5", "hello world"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /estimate — exact only via the Anthropic API/);
    assert.match(r.out, /count_tokens/);
  });

  test("comparativo de todos os modelos", () => {
    const r = run(["--usd", "5", "hello world"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Tokens/);
    assert.match(r.out, /✓ = exact count/);
  });

  test("texto pela entrada padrão", () => {
    const r = run(["--usd", "5", "-m", "gpt-6.1-sol"], "hello world");
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /2 ✓/);
  });

  test("modelo inexistente sai com erro", () => {
    const r = run(["--usd", "5", "-m", "nao-existe", "oi"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /not found/);
  });

  test("otimizar salva a versão enxuta", async () => {
    const file = join(home, "prompt.txt");
    const out = join(home, "prompt.min.txt");
    await writeFile(file, 'Hello.   \n{\n  "a": 1\n}\n');
    const r = run(["--usd", "5", "optimize", file, "--save", out]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Indented JSON/);
    assert.equal(await readFile(out, "utf8"), 'Hello.\n{"a":1}');
  });

  test("pasta conta tokens por arquivo", () => {
    const r = run(["--usd", "5", "folder", "src"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Top \d+ files/);
    assert.match(r.out, /cli\.ts/);
  });

  test("chunks desenha o mapa", () => {
    const r = run(["chunks", "README.md", "-s", "1000", "--overlap", "10", "--map-only"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Document map/);
    assert.match(r.out, /#1/);
  });

  test("recomendar escolhe um modelo", () => {
    const r = run(["--usd", "5", "recommend", "Translate to English: bom dia"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Recommended:/);
    assert.match(r.out, /Budget/);
  });

  test("budget: projeção, alertas e lote por provedor", () => {
    const r = run(["--usd", "5", "budget", "--cap", "200", "--requests", "150", "--days", "22", "--input", "3000", "--fixed-pct", "70", "--batch", "30", "--spent", "120"]);
    assert.equal(r.code, 0, r.err);
    for (const s of [/Neurix Budget/, /Your spending pace/, /Projection with your usage/, /How many requests fit/, /Message Batches API/, /no discounted batch API/])
      assert.match(r.out, s);
  });

  test("check: código 0 dentro do limite, 1 acima, 2 sem arquivo", () => {
    assert.equal(run(["check", "package.json", "--max-usd", "10"]).code, 0);
    const over = run(["check", "README.md", "--max-usd", "0.0001"]);
    assert.equal(over.code, 1);
    assert.match(over.out, /ALERT/);
    assert.equal(run(["check", "nao-existe.txt"]).code, 2);
  });

  test("check --json para scripts", () => {
    const r = run(["check", "src", "--max-tokens", "10", "--json"]);
    assert.equal(r.code, 1);
    const j = JSON.parse(r.out);
    assert.equal(j.ok, false);
    assert.equal(j.over_tokens, true);
    assert.ok(j.tokens > 10);
  });

  test("hardware detecta e não quebra (qualquer máquina)", () => {
    const r = run(["hardware"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Your hardware/);
    assert.match(r.out, /RAM:/);
  });

  test("instalados acha um .gguf numa pasta extra", async () => {
    const { buildTestGguf } = await import("../src/core/gguf.ts");
    const dir = join(home, "modelos");
    await import("node:fs/promises").then((fs) => fs.mkdir(dir, { recursive: true }));
    await writeFile(
      join(dir, "mini-1b-Q8_0.gguf"),
      buildTestGguf(
        { "general.architecture": "llama", "general.file_type": 7, "llama.block_count": 16, "llama.attention.head_count": 32, "llama.attention.head_count_kv": 8, "llama.embedding_length": 2048, "llama.context_length": 8192 },
        [{ name: "w", dims: [2048, 1000] }],
      ),
    );
    const r = run(["installed", "--dir", dir]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /mini-1b-Q8_0/);
    assert.match(r.out, /Q8_0/);
  });

  test("compensa (local vs API) e exportação em Markdown/JSON/CSV/HTML", async () => {
    const md = join(home, "compensa.md");
    const r = run(["--usd", "5", "local-vs-api", "-m", "llama-3.1-8b", "-g", "12", "-r", "1000", "--hardware", "2500", "-x", md]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Local vs API/);
    assert.match(r.out, /Same volume on the API/);
    assert.match(await readFile(md, "utf8"), /^# Local vs API/m);
    for (const ext of ["json", "csv", "html"]) {
      const f = join(home, `budget.${ext}`);
      assert.equal(run(["--usd", "5", "budget", "--cap", "100", "--requests", "50", "--export", f]).code, 0);
      assert.ok((await readFile(f, "utf8")).length > 100, ext);
    }
  });

  test("local com GPU simulada mostra a velocidade", () => {
    const r = run(["local", "-m", "llama-3.1-8b", "-g", "12"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Estimated speed: ~\d/);
  });

  test("manual lista TODOS os comandos da CLI", () => {
    const help = run(["--help"]).out.split(/^Commands:$/m)[1] ?? ""; // só a seção de comandos
    const names = [...help.matchAll(/^\s{2}([a-z-]+)(?:\|[a-z-]+)?\s/gm)].map((m) => m[1]).filter((n) => n && n !== "help");
    assert.ok(names.length >= 15, `achou ${names.length} comandos no --help`);
    const man = run(["manual", "--commands"]);
    assert.equal(man.code, 0, man.err);
    for (const n of names) assert.match(man.out, new RegExp(`^neurix ${n}\\b`, "m"), `falta "${n}" no manual`);
    assert.match(man.out, /Global options/);
    assert.match(man.out, /--export/);
  });

  test("manual: comando, termo e busca sem resultado", () => {
    const cmd = run(["manual", "budget"]);
    assert.match(cmd.out, /neurix budget/);
    assert.match(cmd.out, /--cap/);
    assert.match(cmd.out, /Examples/);
    assert.match(run(["manual", "--terms"]).out, /The basics/);
    assert.match(run(["manual", "gguf"]).out, /GGUF/);
    assert.equal(run(["manual", "xyzabc"]).code, 1);
  });

  test("precos mostra de onde vem a tabela (offline)", () => {
    const r = run(["prices"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /bundled with the package/);
    assert.match(r.out, /Offline mode/);
  });

  test("modelo local sem texto (sem baixar tokenizer)", () => {
    const r = run(["local", "-m", "qwen2.5-7b", "-g", "8"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Qwen2\.5 7B/);
    assert.match(r.out, /GB/);
  });
});
