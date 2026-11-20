/** Painel (webview) onde cada ferramenta do Neurix vira um formulário e o resultado vira tabelas. */
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { CATEGORIES, FIELD_LABELS, TOOLS, toolInfo, type Lang } from "./catalog.ts";
import type { Engine } from "./engine.ts";
import { ui } from "./i18n.ts";
import { toMarkdown } from "./markdown.ts";

export interface ToolContext {
  /** Valores para pré-preencher o formulário. */
  values: Record<string, unknown>;
  autorun: boolean;
}

export class NeurixPanel {
  private static instance: NeurixPanel | undefined;

  private ready: Promise<void>;
  private markReady!: () => void;
  private currentTool = "";

  static show(ext: vscode.ExtensionContext, engine: Engine, lang: Lang, tool: string, ctx: ToolContext, helpers: PanelHelpers): void {
    if (!NeurixPanel.instance) NeurixPanel.instance = new NeurixPanel(ext, engine, lang, helpers);
    else NeurixPanel.instance.panel.reveal(vscode.ViewColumn.Beside, false);
    void NeurixPanel.instance.open(tool, ctx);
  }

  /** Idioma mudou: fecha o painel (é reaberto no idioma novo). */
  static dispose(): void {
    NeurixPanel.instance?.panel.dispose();
  }

  private constructor(
    private ext: vscode.ExtensionContext,
    private engine: Engine,
    private lang: Lang,
    private helpers: PanelHelpers,
    private panel = vscode.window.createWebviewPanel("neurix.panel", "Neurix", vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(ext.extensionUri, "media")],
    }),
  ) {
    this.ready = new Promise((r) => (this.markReady = r));
    panel.iconPath = vscode.Uri.joinPath(ext.extensionUri, "media", "icon.png");
    panel.webview.html = this.html();
    panel.onDidDispose(() => (NeurixPanel.instance = undefined));
    panel.webview.onDidReceiveMessage((m: Msg) => void this.onMessage(m).catch((err: unknown) => this.post({ type: "error", text: String((err as Error).message ?? err) })));
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private async open(name: string, ctx: ToolContext): Promise<void> {
    await this.ready;
    const tool = await this.engine.tool(name);
    const info = toolInfo(name);
    if (!tool || !info) return;
    this.currentTool = name;
    this.panel.title = `Neurix · ${info.title[this.lang]}`;
    const schema = tool.inputSchema as { required?: string[] };
    const required = schema.required ?? [];
    const labels = Object.fromEntries(Object.keys((tool.inputSchema as { properties?: object }).properties ?? {}).map((k) => [k, FIELD_LABELS[k]?.[this.lang] ?? k]));
    const autorun = ctx.autorun && !!info.autorun && required.every((k) => ctx.values[k] !== undefined && ctx.values[k] !== "");
    this.post({
      type: "tool",
      name,
      title: info.title[this.lang],
      desc: this.lang === "en" ? (tool.description ?? info.desc.en) : info.desc.pt,
      schema: tool.inputSchema,
      values: ctx.values,
      labels,
      autorun,
    });
  }

  private async onMessage(m: Msg): Promise<void> {
    switch (m.type) {
      case "ready": {
        const t = ui(this.lang);
        const models = await this.helpers.modelIds().catch(() => [] as string[]);
        this.post({
          type: "init",
          lang: this.lang,
          models,
          strings: { ...t, took: t.took(Number.NaN).replace("NaN", "{ms}"), invalidJson: t.invalidJson("{f}") },
          categories: CATEGORIES.map((c) => ({ id: c.id, label: c.label[this.lang] })),
          tools: TOOLS.map((x) => ({ name: x.name, category: x.category, title: x.title[this.lang] })),
        });
        this.markReady();
        break;
      }
      case "run": {
        const start = Date.now();
        const res = await this.engine.call(m.name, m.args);
        this.post({ type: "result", ok: res.ok, data: res.data, ms: Date.now() - start });
        break;
      }
      case "switch":
        await this.open(m.name, { values: await this.helpers.prefill(m.name), autorun: false });
        break;
      case "browse": {
        const picked = await vscode.window.showOpenDialog({ canSelectFiles: !m.folder, canSelectFolders: m.folder, canSelectMany: false });
        if (picked?.[0]) this.post({ type: "setField", field: m.field, value: picked[0].fsPath });
        break;
      }
      case "useSelection": {
        const text = this.helpers.editorText();
        if (text === undefined) void vscode.window.showWarningMessage(ui(this.lang).noEditor);
        else this.post({ type: "setField", field: m.field, value: text });
        break;
      }
      case "copy":
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage(ui(this.lang).copied, 2000);
        break;
      case "openJson": {
        const doc = await vscode.workspace.openTextDocument({ language: "json", content: JSON.stringify(m.data, null, 2) });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
        break;
      }
      case "exportMd": {
        const doc = await vscode.workspace.openTextDocument({ language: "markdown", content: toMarkdown(`Neurix · ${m.title}`, m.data) });
        await vscode.window.showTextDocument(doc, vscode.ViewColumn.Active);
        break;
      }
    }
  }

  private html(): string {
    const w = this.panel.webview;
    const media = (f: string) => w.asWebviewUri(vscode.Uri.joinPath(this.ext.extensionUri, "media", f)).toString();
    const nonce = randomBytes(16).toString("base64");
    return /* html */ `<!doctype html>
<html lang="${this.lang}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${w.cspSource}; style-src ${w.cspSource}; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="${media("panel.css")}">
<title>Neurix</title>
</head>
<body>
<header>
  <img src="${media("icon.png")}" alt="">
  <span class="brand">Neurix</span>
  <select id="picker" aria-label="${ui(this.lang).tool}"></select>
</header>
<h1 id="title"></h1>
<p class="desc" id="desc"></p>
<form id="form" autocomplete="off"></form>
<datalist id="models"></datalist>
<section class="result" id="result"></section>
<script nonce="${nonce}" src="${media("panel.js")}"></script>
</body>
</html>`;
  }

  get tool(): string {
    return this.currentTool;
  }
}

export interface PanelHelpers {
  modelIds(): Promise<string[]>;
  prefill(tool: string): Promise<Record<string, unknown>>;
  editorText(): string | undefined;
}

type Msg =
  | { type: "ready" }
  | { type: "run"; name: string; args: Record<string, unknown> }
  | { type: "switch"; name: string }
  | { type: "browse"; field: string; folder: boolean }
  | { type: "useSelection"; field: string }
  | { type: "copy"; text: string }
  | { type: "openJson"; data: unknown }
  | { type: "exportMd"; data: Record<string, unknown>; title: string };
