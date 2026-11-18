/**
 * Confere se `npx aspael-neurix` vai achar o executável, usando a MESMA função do npm
 * (libnpmexec/get-bin-from-manifest). Com vários executáveis, um precisa ter o nome do pacote —
 * senão o npx falha com "could not determine executable to run" (bug da 0.2.0).
 *
 * Uso: node scripts/check-npx.mjs   (sai com código 1 se o npx não for achar o executável)
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const rel = join("npm", "node_modules", "libnpmexec", "lib", "get-bin-from-manifest.js");

// O npm fica em lugares diferentes: ao lado do node (Windows), em ../lib/node_modules (Linux/macOS) ou no prefixo global.
const roots = [join(dirname(process.execPath), "node_modules"), join(dirname(process.execPath), "..", "lib", "node_modules")];
try {
  roots.push(execSync("npm root -g", { encoding: "utf8" }).trim());
} catch {
  // sem npm no PATH
}
const file = roots.map((r) => join(r, rel)).find((f) => existsSync(f));

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
if (!file) {
  // sem o npm por perto: aplica a mesma regra à mão
  const bins = pkg.bin ?? {};
  const ok = new Set(Object.values(bins)).size === 1 || bins[pkg.name.replace(/^@[^/]+\//, "")];
  console.log(ok ? `npx ${pkg.name} -> ok (regra do npm aplicada à mão)` : "npx não vai achar o executável");
  process.exit(ok ? 0 : 1);
}
try {
  const bin = require(file)(pkg);
  console.log(`npx ${pkg.name} -> ${bin} (${pkg.bin[bin]})`);
} catch (err) {
  console.error(`npx ${pkg.name} vai falhar: ${err.message}`);
  process.exit(1);
}
