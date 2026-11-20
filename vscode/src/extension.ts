/**
 * Neurix para VS Code.
 *
 * Tudo o que o Neurix oferece, dentro do editor:
 *  - as 23 ferramentas (tokens, custo, comparação, formatos, RAG, budget, alertas, modelos locais…) num painel,
 *    pela barra lateral, pela paleta de comandos e pelos menus de contexto do editor e do Explorer;
 *  - contador de tokens e custo da seleção/arquivo na barra de status;
 *  - o servidor MCP do Neurix oferecido ao Copilot (modo agente) e a outros clientes MCP do VS Code;
 *  - o menu interativo do CLI num terminal integrado.
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import * as vscode from "vscode";
import { CATEGORIES, TEXT_FIELDS, TOOLS, toolInfo, type CategoryId, type Lang, type ToolInfo } from "./catalog.ts";
import { Engine } from "./engine.ts";
import { ui } from "./i18n.ts";
import { NeurixPanel, type PanelHelpers } from "./panel.ts";

const MAX_READ_BYTES = 5 * 1024 * 1024;

// ───────────── Configuração ─────────────

const cfg = () => vscode.workspace.getConfiguration("neurix");

function currentLang(): Lang {
  const v = cfg().get<string>("language", "auto");
  if (v === "pt" || v === "en") return v;
  return vscode.env.language.toLowerCase().startsWith("pt") ? "pt" : "en";
}

const engineEnv = () => ({ lang: currentLang(), offline: cfg().get<boolean>("offline", false) });

// ───────────── Contexto do editor ─────────────

/** Seleção (todas as seleções não vazias) ou, sem seleção, o arquivo inteiro. */
function editorText(): string | undefined {
  const ed = vscode.window.activeTextEditor;
  if (!ed) return undefined;
  const sel = ed.selections.filter((s) => !s.isEmpty).map((s) => ed.document.getText(s));
  return sel.length ? sel.join("\n") : ed.document.getText();
}

/** Uri veio do Explorer (e não é só o documento do editor ativo, que o menu do editor também passa)? */
function explorerUri(uri: unknown): vscode.Uri | undefined {
  if (!(uri instanceof vscode.Uri)) return undefined;
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.toString() === uri.toString()) return undefined;
  return uri;
}

async function isFolder(uri: vscode.Uri): Promise<boolean> {
  try {
    return (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
  try {
    if (uri.scheme === "file") {
      if ((await stat(uri.fsPath)).size > MAX_READ_BYTES) return undefined;
      return await readFile(uri.fsPath, "utf8");
    }
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
  } catch {
    return undefined;
  }
}

// ───────────── Ativação ─────────────

export function activate(ctx: vscode.ExtensionContext): void {
  const engine = new Engine(engineEnv());
  let lang = currentLang();
  let modelCache: Promise<{ api: ApiModel[]; local: string[] }> | null = null;

  const models = () => {
    if (!modelCache) {
      modelCache = engine.call("neurix_list_models", { kind: "all", include_all: true }).then((r) => ({
        api: ((r.data.api_models as ApiModel[] | undefined) ?? []),
        local: ((r.data.local_models as { id: string }[] | undefined) ?? []).map((m) => m.id),
      }));
      modelCache.catch(() => (modelCache = null));
    }
    return modelCache;
  };

  /** Valores iniciais do formulário de uma ferramenta, a partir do editor/Explorer e das configurações. */
  async function prefill(name: string, from?: vscode.Uri): Promise<Record<string, unknown>> {
    const info = toolInfo(name);
    const tool = await engine.tool(name);
    if (!info || !tool) return {};
    const props = Object.keys((tool.inputSchema as { properties?: object }).properties ?? {});
    const has = (k: string) => props.includes(k);
    const v: Record<string, unknown> = {};
    const doc = vscode.window.activeTextEditor?.document;
    const fromFolder = from ? await isFolder(from) : false;
    const textField = props.find((p) => TEXT_FIELDS.has(p));

    const fileUri = from && !fromFolder ? from : doc && doc.uri.scheme === "file" && !doc.isUntitled ? doc.uri : undefined;
    const folderUri = from && fromFolder ? from : vscode.workspace.workspaceFolders?.[0]?.uri;

    switch (info.prefill) {
      case "file":
        if (fileUri && has("path")) v.path = fileUri.fsPath;
        break;
      case "folder":
        if (folderUri && has("path")) v.path = folderUri.fsPath;
        break;
      case "textOrFile":
        if (from && !fromFolder && has("path")) v.path = from.fsPath;
        else if (textField) v[textField] = editorText();
        break;
      case "text":
        if (textField) v[textField] = from && !fromFolder ? await readText(from) : editorText();
        break;
      case "none":
        break;
    }
    if (has("filename") && fileUri) v.filename = basename(fileUri.fsPath);
    if (info.apiModel && has("model")) v.model = cfg().get<string>("defaultModel");
    if (has("output_tokens")) v.output_tokens = cfg().get<number>("outputTokens", 300);
    const iof = cfg().get<number>("iofPct", 0);
    if (has("iof_pct") && iof > 0) v.iof_pct = iof;
    const fx = cfg().get<number | null>("usdBrl", null);
    if (has("usd_brl") && fx) v.usd_brl = fx;
    for (const k of Object.keys(v)) if (v[k] === undefined || v[k] === "") delete v[k];
    return v;
  }

  const helpers: PanelHelpers = {
    modelIds: async () => {
      const m = await models();
      return [...m.api.map((x) => x.id), ...m.local];
    },
    prefill: (name) => prefill(name),
    editorText,
  };

  async function openTool(name: string, from?: unknown, autorun = true): Promise<void> {
    try {
      const values = await prefill(name, explorerUri(from));
      NeurixPanel.show(ctx, engine, lang, name, { values, autorun }, helpers);
    } catch (err) {
      void vscode.window.showErrorMessage(`Neurix: ${(err as Error).message}`);
    }
  }

  // ── Comandos: uma entrada por ferramenta
  for (const t of TOOLS) ctx.subscriptions.push(vscode.commands.registerCommand(t.command, (uri?: unknown) => openTool(t.name, uri)));

  // Da barra lateral: abre o formulário; só roda sozinho o que não depende do editor.
  ctx.subscriptions.push(
    vscode.commands.registerCommand("neurix.openTool", (name: string) => openTool(name, undefined, toolInfo(name)?.prefill === "none")),
    vscode.commands.registerCommand("neurix.openPanel", () => openTool("neurix_count_tokens", undefined, false)),
  );

  // ── Barra lateral
  const tree = new ToolsTree(() => lang);
  ctx.subscriptions.push(vscode.window.createTreeView("neurix.tools", { treeDataProvider: tree, showCollapseAll: true }));
  ctx.subscriptions.push(vscode.commands.registerCommand("neurix.refreshTools", () => tree.refresh()));

  // ── Barra de status
  const status = new TokenStatus(engine, () => lang);
  ctx.subscriptions.push(status);

  // ── Modelo padrão
  ctx.subscriptions.push(
    vscode.commands.registerCommand("neurix.selectModel", async () => {
      const t = ui(lang);
      const m = await models();
      const current = cfg().get<string>("defaultModel");
      const items = m.api.map((x) => ({
        label: x.id,
        description: `${x.name} · ${x.provider}${x.id === current ? " ✓" : ""}`,
        detail: `US$ ${x.price_per_1m_usd.input} / ${x.price_per_1m_usd.output} per 1M · ctx ${x.context_window?.toLocaleString() ?? "?"} · ${x.token_count}`,
      }));
      const pick = await vscode.window.showQuickPick(items, { title: t.pickModel, matchOnDescription: true, placeHolder: current });
      if (pick) await cfg().update("defaultModel", pick.label, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("neurix.setLanguage", async () => {
      const t = ui(lang);
      const pick = await vscode.window.showQuickPick(
        [
          { label: "🇧🇷 Português", value: "pt" },
          { label: "🇺🇸 English", value: "en" },
          { label: t.auto, value: "auto" },
        ],
        { title: t.pickLang },
      );
      if (pick) await cfg().update("language", pick.value, vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand("neurix.toggleStatusBar", async () => {
      const on = !cfg().get<boolean>("statusBar.enabled", true);
      await cfg().update("statusBar.enabled", on, vscode.ConfigurationTarget.Global);
      void vscode.window.setStatusBarMessage(on ? ui(lang).statusOn : ui(lang).statusOff, 3000);
    }),
  );

  // ── CLI interativo no terminal integrado (roda com o runtime do próprio VS Code)
  ctx.subscriptions.push(
    vscode.commands.registerCommand("neurix.openCli", () => {
      const term = vscode.window.createTerminal({
        name: ui(lang).terminal,
        shellPath: process.execPath,
        shellArgs: [vscode.Uri.joinPath(ctx.extensionUri, "dist", "cli.js").fsPath],
        env: { ELECTRON_RUN_AS_NODE: "1", NEURIX_LANG: lang, FORCE_COLOR: "1", ...(cfg().get<boolean>("offline") && { NEURIX_OFFLINE: "1" }) },
        iconPath: vscode.Uri.joinPath(ctx.extensionUri, "media", "activity.svg"),
      });
      term.show();
    }),
  );

  // ── Servidor MCP para Copilot (modo agente) e outros clientes MCP do VS Code
  const mcpChanged = new vscode.EventEmitter<void>();
  ctx.subscriptions.push(mcpChanged);
  const lm = vscode.lm as typeof vscode.lm | undefined;
  if (lm && typeof lm.registerMcpServerDefinitionProvider === "function" && typeof vscode.McpStdioServerDefinition === "function") {
    const version = (ctx.extension.packageJSON as { version: string }).version;
    ctx.subscriptions.push(
      lm.registerMcpServerDefinitionProvider("neurix.mcp", {
        onDidChangeMcpServerDefinitions: mcpChanged.event,
        provideMcpServerDefinitions: () => {
          if (!cfg().get<boolean>("mcp.enabled", true)) return [];
          const env: Record<string, string> = { ELECTRON_RUN_AS_NODE: "1", NEURIX_LANG: lang };
          if (cfg().get<boolean>("offline")) env.NEURIX_OFFLINE = "1";
          return [new vscode.McpStdioServerDefinition("Neurix", process.execPath, [vscode.Uri.joinPath(ctx.extensionUri, "dist", "server.js").fsPath], env, version)];
        },
      }),
    );
  }

  // ── Mudanças de configuração
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("neurix")) return;
      const langChanged = currentLang() !== lang;
      if (langChanged || e.affectsConfiguration("neurix.offline")) {
        lang = currentLang();
        engine.reset(engineEnv());
        modelCache = null;
        tree.refresh();
        NeurixPanel.dispose();
      }
      if (langChanged || e.affectsConfiguration("neurix.offline") || e.affectsConfiguration("neurix.mcp")) mcpChanged.fire();
      status.schedule(0);
    }),
  );

  status.schedule(800);
}

export function deactivate(): void {}

// ───────────── Barra lateral ─────────────

type Node = { kind: "cat"; id: CategoryId } | { kind: "tool"; info: ToolInfo };

class ToolsTree implements vscode.TreeDataProvider<Node> {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.changed.event;

  constructor(private lang: () => Lang) {}

  refresh(): void {
    this.changed.fire();
  }

  getChildren(node?: Node): Node[] {
    if (!node) return CATEGORIES.map((c) => ({ kind: "cat", id: c.id }));
    if (node.kind === "cat") return TOOLS.filter((t) => t.category === node.id).map((info) => ({ kind: "tool", info }));
    return [];
  }

  getTreeItem(node: Node): vscode.TreeItem {
    const lang = this.lang();
    if (node.kind === "cat") {
      const c = CATEGORIES.find((x) => x.id === node.id)!;
      const item = new vscode.TreeItem(c.label[lang], vscode.TreeItemCollapsibleState.Expanded);
      item.iconPath = new vscode.ThemeIcon(c.icon);
      item.id = `cat:${c.id}:${lang}`;
      return item;
    }
    const t = node.info;
    const item = new vscode.TreeItem(t.title[lang], vscode.TreeItemCollapsibleState.None);
    item.iconPath = new vscode.ThemeIcon(t.icon);
    item.tooltip = t.desc[lang];
    item.id = `tool:${t.name}:${lang}`;
    item.command = { command: "neurix.openTool", title: t.title[lang], arguments: [t.name] };
    return item;
  }
}

// ───────────── Barra de status ─────────────

interface ApiModel {
  id: string;
  name: string;
  provider: string;
  price_per_1m_usd: { input: number; output: number };
  context_window: number | null;
  token_count: string;
}

class TokenStatus implements vscode.Disposable {
  private item = vscode.window.createStatusBarItem("neurix.tokens", vscode.StatusBarAlignment.Right, 100);
  private timer: NodeJS.Timeout | undefined;
  private seq = 0;
  private subs: vscode.Disposable[] = [];

  constructor(
    private engine: Engine,
    private lang: () => Lang,
  ) {
    this.item.name = "Neurix";
    this.item.command = "neurix.compareModels";
    this.subs.push(
      vscode.window.onDidChangeActiveTextEditor(() => this.schedule(150)),
      vscode.window.onDidChangeTextEditorSelection(() => this.schedule(300)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document === vscode.window.activeTextEditor?.document) this.schedule(600);
      }),
    );
  }

  schedule(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), ms);
  }

  private async update(): Promise<void> {
    const seq = ++this.seq;
    const t = ui(this.lang());
    const ed = vscode.window.activeTextEditor;
    if (!cfg().get<boolean>("statusBar.enabled", true) || !ed || ed.document.uri.scheme === "output") {
      this.item.hide();
      return;
    }
    const hasSel = ed.selections.some((s) => !s.isEmpty);
    const maxKb = cfg().get<number>("statusBar.maxFileSizeKB", 2048);
    if (!hasSel && ed.document.getText().length > maxKb * 1024) {
      this.item.text = "$(pulse) —";
      this.item.tooltip = t.sbTooBig;
      this.item.show();
      return;
    }
    const text = editorText() ?? "";
    const model = cfg().get<string>("defaultModel", "claude-sonnet-5-5");
    const args: Record<string, unknown> = { model, text, output_tokens: cfg().get<number>("outputTokens", 300) };
    const iof = cfg().get<number>("iofPct", 0);
    if (iof > 0) args.iof_pct = iof;
    const fx = cfg().get<number | null>("usdBrl", null);
    if (fx) args.usd_brl = fx;

    let res;
    try {
      res = await this.engine.call("neurix_estimate_cost", args);
    } catch {
      return;
    }
    if (seq !== this.seq) return;
    const loc = this.lang() === "en" ? "en-US" : "pt-BR";
    const n = (x: number, d = 0) => x.toLocaleString(loc, { maximumFractionDigits: d });
    const sig = (x: number) => x.toLocaleString(loc, x >= 1 ? { maximumFractionDigits: 2 } : { maximumSignificantDigits: 3 });

    if (!res.ok) {
      this.item.text = "$(pulse) Neurix $(warning)";
      this.item.tooltip = String(res.data.error ?? res.raw);
      this.item.command = "neurix.selectModel";
      this.item.show();
      return;
    }
    const d = res.data as {
      input_tokens: number;
      counting: { exact: boolean };
      per_call: { total: { usd: number; brl: number | null }; input: { usd: number; brl: number | null } };
      context: { used_pct: number | null; fits: boolean | null; window: number | null };
      model: { name: string };
    };
    const tokens = n(d.input_tokens);
    const approx = d.counting.exact ? "" : "~";
    const inputCost = d.per_call.input;
    const cost = cfg().get<boolean>("statusBar.showCost", true) ? ` · ${inputCost.brl !== null && this.lang() === "pt" ? `R$ ${sig(inputCost.brl)}` : `$${sig(inputCost.usd)}`}` : "";
    this.item.text = `$(pulse) ${approx}${tokens} tok${cost}`;
    this.item.command = "neurix.compareModels";

    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ["neurix.selectModel", "neurix.compareModels", "neurix.openPanel"] };
    md.appendMarkdown(`**${t.sbTooltip}** — ${hasSel ? t.sbSelection : t.sbFile}\n\n`);
    md.appendMarkdown(`| | |\n|---|---|\n`);
    md.appendMarkdown(`| $(symbol-number) Tokens | ${approx}${tokens} (${d.counting.exact ? t.sbExact : t.sbEstimate}) |\n`);
    md.appendMarkdown(`| $(hubot) ${d.model.name} | input US$ ${sig(inputCost.usd)}${inputCost.brl !== null ? ` · R$ ${sig(inputCost.brl)}` : ""} |\n`);
    md.appendMarkdown(`| $(credit-card) + ${n(cfg().get<number>("outputTokens", 300))} out | US$ ${sig(d.per_call.total.usd)}${d.per_call.total.brl !== null ? ` · R$ ${sig(d.per_call.total.brl)}` : ""} |\n`);
    if (d.context.used_pct !== null) md.appendMarkdown(`| $(layers) ${n(d.context.used_pct, 2)}% | ${t.sbContext} (${n(d.context.window ?? 0)}) ${d.context.fits === false ? "$(error)" : ""} |\n`);
    md.appendMarkdown(`\n[$(list-ordered) ${t.sbCompare}](command:neurix.compareModels) · [$(gear) ${t.sbChangeModel}](command:neurix.selectModel)`);
    this.item.tooltip = md;
    this.item.show();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.item.dispose();
    for (const s of this.subs) s.dispose();
  }
}
