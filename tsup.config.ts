import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts", "src/mcp.ts"],
  format: ["esm"],
  target: "node22",
  platform: "node",
  clean: true,
  // data/models.json é embutido no bundle (import JSON em src/prices/load.ts)
});
