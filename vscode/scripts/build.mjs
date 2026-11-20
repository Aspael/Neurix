// Empacota a extensão (e o núcleo do Neurix em ../src) com esbuild.
//   dist/extension.js → a extensão (roda no extension host)
//   dist/server.js    → servidor MCP stdio (oferecido ao Copilot / clientes MCP)
//   dist/cli.js       → o CLI interativo, aberto no terminal integrado
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const watch = process.argv.includes("--watch");
const production = process.argv.includes("--production");

// O ícone da extensão vem de /assets do projeto (fonte única).
await mkdir(join(root, "media"), { recursive: true });
await copyFile(join(root, "..", "assets", "extension-icon.png"), join(root, "media", "icon.png"));

/** @type {esbuild.BuildOptions} */
const options = {
  absWorkingDir: root,
  entryPoints: {
    extension: "src/extension.ts",
    server: "src/server.ts",
    cli: "../src/cli.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  legalComments: "none",
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
} else {
  await esbuild.build(options);
}
