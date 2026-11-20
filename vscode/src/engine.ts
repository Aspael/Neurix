/**
 * Motor da extensão: o mesmo servidor MCP do Neurix, rodando dentro do extension host e ligado a um
 * cliente por um transporte em memória. Assim cada comando da extensão usa exatamente as mesmas
 * 23 ferramentas do CLI/MCP, sem duplicar lógica.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer } from "../../src/mcp.ts";

export interface ToolResult {
  ok: boolean;
  data: Record<string, unknown>;
  raw: string;
}

export interface EngineEnv {
  lang: "pt" | "en";
  offline: boolean;
}

export class Engine {
  private client: Promise<Client> | null = null;
  private tools: Promise<Tool[]> | null = null;

  constructor(private env: EngineEnv) {}

  /** Troca idioma/offline: o servidor é recriado na próxima chamada. */
  reset(env: EngineEnv): void {
    this.env = env;
    const old = this.client;
    this.client = null;
    this.tools = null;
    void old?.then((c) => c.close()).catch(() => undefined);
  }

  private connect(): Promise<Client> {
    if (!this.client) {
      this.client = (async () => {
        // O núcleo lê idioma e modo offline das variáveis de ambiente (as mesmas do CLI).
        process.env.NEURIX_LANG = this.env.lang;
        if (this.env.offline) process.env.NEURIX_OFFLINE = "1";
        else delete process.env.NEURIX_OFFLINE;
        const server = await createMcpServer();
        const [serverSide, clientSide] = InMemoryTransport.createLinkedPair();
        await server.connect(serverSide);
        const client = new Client({ name: "neurix-vscode", version: "1.0.0" });
        await client.connect(clientSide);
        return client;
      })();
      this.client.catch(() => {
        this.client = null;
      });
    }
    return this.client;
  }

  listTools(): Promise<Tool[]> {
    if (!this.tools) {
      this.tools = this.connect().then(async (c) => (await c.listTools()).tools);
      this.tools.catch(() => {
        this.tools = null;
      });
    }
    return this.tools;
  }

  async tool(name: string): Promise<Tool | undefined> {
    return (await this.listTools()).find((t) => t.name === name);
  }

  async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const client = await this.connect();
    const res = await client.callTool({ name, arguments: args });
    const content = (res.content as { type: string; text?: string }[] | undefined) ?? [];
    const raw = content.map((c) => c.text ?? "").join("\n");
    let data = res.structuredContent as Record<string, unknown> | undefined;
    if (!data) {
      try {
        data = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        data = { result: raw };
      }
    }
    return { ok: !res.isError, data, raw };
  }
}
