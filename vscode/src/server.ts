// Servidor MCP stdio do Neurix, empacotado com a extensão.
// O VS Code o executa com o próprio runtime (ELECTRON_RUN_AS_NODE=1), então não precisa de Node instalado.
import { startMcpServer } from "../../src/mcp.ts";

startMcpServer().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
