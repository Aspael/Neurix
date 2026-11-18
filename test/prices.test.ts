/** Atualização automática da tabela de preços (servidor falso no lugar do GitHub). */
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import bundled from "../data/models.json" with { type: "json" };

let server: Server;
let home: string;
let reply: unknown;
let hits = 0;
let load: typeof import("../src/prices/load.ts");

before(async () => {
  server = createServer((_req, res) => {
    hits++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const addr = server.address();
  home = await mkdtemp(join(tmpdir(), "neurix-prices-"));
  process.env.NEURIX_PRICES_URL = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/models.json`;
  process.env.NEURIX_HOME = home;
  delete process.env.NEURIX_OFFLINE;
  // importa depois de configurar o ambiente (a URL é lida ao carregar o módulo)
  load = await import("../src/prices/load.ts");
});
after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(home, { recursive: true, force: true });
});

const newerTable = () => {
  const d = structuredClone(bundled) as typeof bundled;
  d.generatedAt = new Date(Date.parse(bundled.generatedAt) + 86_400_000).toISOString();
  (d.models[0] as { input: number }).input = 123.45;
  return d;
};

describe("preços automáticos", () => {
  test("baixa a tabela mais nova do GitHub e guarda no cache", async () => {
    reply = newerTable();
    const d = await load.loadPrices(undefined, { refresh: true });
    assert.equal(d.models[0]?.input, 123.45);
    assert.equal(load.priceStatus()?.source, "remote");
    const cache = JSON.parse(await readFile(join(home, "models.json"), "utf8"));
    assert.equal(cache.dataset.models[0].input, 123.45);
  });

  test("dentro de 24 h usa o cache sem baixar de novo", async () => {
    const before = hits;
    const d = await load.loadPrices();
    assert.equal(hits, before);
    assert.equal(d.models[0]?.input, 123.45);
    assert.equal(load.priceStatus()?.source, "cache");
  });

  test("tabela inválida ou de outra versão é ignorada", async () => {
    reply = { version: 99, generatedAt: new Date().toISOString(), models: [] };
    const d = await load.loadPrices(undefined, { refresh: true });
    assert.equal(load.priceStatus()?.source, "cache"); // continua com a última boa
    assert.equal(d.models[0]?.input, 123.45);
    assert.match(load.priceStatus()?.error ?? "", /inválido|formato/);
  });

  test("tabela do GitHub mais velha que a do pacote: fica a do pacote", async () => {
    const old = structuredClone(bundled) as typeof bundled;
    old.generatedAt = "2020-01-01T00:00:00.000Z";
    reply = old;
    await rm(join(home, "models.json"), { force: true });
    await load.loadPrices(undefined, { refresh: true });
    assert.equal(load.priceStatus()?.source, "bundled");
  });

  test("offline: não acessa a rede", async () => {
    process.env.NEURIX_OFFLINE = "1";
    const before = hits;
    await load.loadPrices(undefined, { refresh: true });
    assert.equal(hits, before);
    assert.equal(load.priceStatus()?.error, "offline");
    delete process.env.NEURIX_OFFLINE;
  });

  test("validação do formato", () => {
    assert.equal(load.isValidDataset(bundled), true);
    assert.equal(load.isValidDataset({ ...bundled, models: [{ id: "x" }] }), false);
    assert.equal(load.isValidDataset(null), false);
  });
});
