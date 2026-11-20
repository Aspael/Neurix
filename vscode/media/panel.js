// Painel do Neurix: formulário gerado do JSON Schema de cada ferramenta MCP e resultado em tabelas.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (sel, el = document) => el.querySelector(sel);
  const h = (tag, attrs = {}, ...kids) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) if (kid !== undefined && kid !== null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
    return el;
  };

  let S = {}; // textos da interface
  let lang = "pt";
  let models = [];
  let current = null; // { name, schema, ... }
  let lastData = null;

  const fmtLocale = () => (lang === "en" ? "en-US" : "pt-BR");
  const TEXT_FIELDS = ["text", "content", "prompt", "fixed_text"];
  const MAIN_FIELDS = ["text", "content", "prompt", "fixed_text", "path", "model", "query", "term", "cap", "vram_gb", "hf_repo"];

  // ───────── Formulário ─────────

  function fieldType(p) {
    if (!p) return "string";
    if (p.anyOf) {
      const t = p.anyOf.map((x) => x.type).filter((x) => x && x !== "null");
      return t[0] || "string";
    }
    return Array.isArray(p.type) ? p.type.find((x) => x !== "null") : p.type || "string";
  }

  function renderForm(msg) {
    current = msg;
    const schema = msg.schema || {};
    const props = schema.properties || {};
    const required = new Set(schema.required || []);
    const values = msg.values || {};

    $("#title").textContent = msg.title;
    $("#desc").textContent = msg.desc;
    $("#picker").value = msg.name;

    const form = $("#form");
    form.replaceChildren();
    const main = [];
    const adv = [];

    for (const [key, p] of Object.entries(props)) {
      const el = renderField(key, p, required.has(key), values[key]);
      const isMain = required.has(key) || MAIN_FIELDS.includes(key) || (values[key] !== undefined && !["output_tokens", "iof_pct", "usd_brl"].includes(key));
      (isMain ? main : adv).push(el);
    }
    form.append(...main);
    if (adv.length) form.append(h("details", {}, h("summary", { text: S.optional }), h("div", { class: "grid" }, adv)));
    form.append(h("div", { class: "actions" }, h("button", { type: "submit", class: "primary", id: "run" }, S.run)));

    $("#result").replaceChildren(h("p", { class: "empty", text: S.empty }));
    lastData = null;
    if (msg.autorun) submit();
  }

  function renderField(key, p, isReq, value) {
    const id = "f_" + key;
    const label = (current.labels && current.labels[key]) || key;
    const type = fieldType(p);
    const hint = p.description ? h("div", { class: "hint", text: p.description }) : null;
    const lab = h("label", { for: id }, label, isReq ? h("span", { class: "req", text: S.required }) : null);
    const wrap = (...kids) => h("div", { class: "field", "data-key": key, "data-type": type }, ...kids);

    if (type === "boolean") {
      const def = value !== undefined ? value : p.default === true;
      return wrap(h("label", { class: "check" }, h("input", { type: "checkbox", id, checked: !!def }), label), hint);
    }

    if (type === "array") {
      const items = p.items || {};
      if (items.enum) {
        const sel = new Set(value || []);
        return wrap(lab, h("div", { class: "chips" }, items.enum.map((v) => h("label", {}, h("input", { type: "checkbox", value: v, checked: sel.has(v) }), v))), hint);
      }
      return wrap(lab, h("input", { id, type: "text", value: Array.isArray(value) ? value.join(", ") : "", placeholder: "a, b, c" }), hint);
    }

    if (type === "object") {
      return wrap(lab, h("textarea", { id, rows: 6, placeholder: '{ "params_b": 8, "layers": 32, ... }' }, value ? JSON.stringify(value, null, 2) : ""), hint);
    }

    if (p.enum) {
      const opts = [];
      if (!isReq && p.default === undefined) opts.push(h("option", { value: "" }, "—"));
      for (const v of p.enum) opts.push(h("option", { value: v, selected: (value ?? p.default) === v }, v));
      return wrap(lab, h("select", { id }, opts), hint);
    }

    if (type === "number" || type === "integer") {
      const ph = p.default !== undefined ? String(p.default) : "";
      return wrap(lab, h("input", { id, type: "number", step: type === "integer" ? "1" : "any", min: p.minimum, max: p.maximum, value: value ?? "", placeholder: ph }), hint);
    }

    // string
    if (TEXT_FIELDS.includes(key)) {
      return wrap(
        h("div", { class: "row" }, lab, h("span", { class: "spacer" }), h("button", { type: "button", onclick: () => vscode.postMessage({ type: "useSelection", field: key }) }, S.useSelection)),
        h("textarea", { id, rows: 8 }, value ?? ""),
        hint,
      );
    }
    if (key === "path" || key === "extra_dirs") {
      const folder = current.name === "neurix_analyze_folder";
      return wrap(lab, h("div", { class: "row" }, h("input", { id, type: "text", value: value ?? "" }), h("button", { type: "button", onclick: () => vscode.postMessage({ type: "browse", field: key, folder }) }, S.browse)), hint);
    }
    const attrs = { id, type: "text", value: value ?? "", placeholder: p.default !== undefined ? String(p.default) : "" };
    if (key === "model") attrs.list = "models";
    return wrap(lab, h("input", attrs), hint);
  }

  function collect() {
    const args = {};
    for (const f of document.querySelectorAll("#form .field")) {
      const key = f.dataset.key;
      const type = f.dataset.type;
      const input = f.querySelector("#f_" + key);
      if (type === "boolean") {
        args[key] = !!input.checked;
      } else if (type === "array") {
        const boxes = f.querySelectorAll(".chips input");
        if (boxes.length) {
          const v = [...boxes].filter((b) => b.checked).map((b) => b.value);
          if (v.length) args[key] = v;
        } else if (input.value.trim()) {
          args[key] = input.value.split(",").map((s) => s.trim()).filter(Boolean);
        }
      } else if (type === "object") {
        if (input.value.trim()) {
          try {
            args[key] = JSON.parse(input.value);
          } catch {
            throw new Error(S.invalidJson.replace("{f}", key));
          }
        }
      } else if (type === "number" || type === "integer") {
        if (input.value.trim() !== "") args[key] = Number(input.value);
      } else if (input.value !== "") {
        args[key] = input.value;
      }
    }
    return args;
  }

  function submit() {
    let args;
    try {
      args = collect();
    } catch (e) {
      showError(e.message);
      return;
    }
    const btn = $("#run");
    if (btn) {
      btn.disabled = true;
      btn.textContent = S.running;
    }
    $("#result").replaceChildren(h("p", {}, h("span", { class: "spin" }), " ", S.running));
    vscode.postMessage({ type: "run", name: current.name, args });
  }

  // ───────── Resultado ─────────

  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  const isMoney = (v) => isObj(v) && "usd" in v && "brl" in v && Object.keys(v).length === 2;
  const pretty = (k) => k.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

  function fmtNum(n) {
    if (!Number.isFinite(n)) return String(n);
    const abs = Math.abs(n);
    const opts = Number.isInteger(n) ? { maximumFractionDigits: 0 } : abs >= 100 ? { maximumFractionDigits: 2 } : abs >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 };
    return n.toLocaleString(fmtLocale(), opts);
  }

  function money(v) {
    const usd = typeof v.usd === "number" ? "US$ " + fmtNum(v.usd) : "—";
    const brl = typeof v.brl === "number" ? "R$ " + fmtNum(v.brl) : null;
    return h("span", { class: "money" }, usd, brl ? h("span", { class: "brl" }, " · " + brl) : null);
  }

  function scalar(v) {
    if (v === null || v === undefined) return "—";
    if (typeof v === "boolean") return h("span", { class: v ? "yes" : "no", text: v ? "✓" : "✗" });
    if (typeof v === "number") return fmtNum(v);
    if (isMoney(v)) return money(v);
    if (Array.isArray(v) && v.every((x) => !isObj(x) && !Array.isArray(x))) return v.join(", ");
    if (isObj(v) || Array.isArray(v)) return compact(v);
    return String(v);
  }

  function compact(v) {
    if (isMoney(v)) return money(v);
    if (isObj(v)) {
      const parts = Object.entries(v).map(([k, x]) => `${k}: ${isObj(x) || Array.isArray(x) ? JSON.stringify(x) : typeof x === "number" ? fmtNum(x) : x}`);
      return parts.join(" · ");
    }
    return JSON.stringify(v);
  }

  /** Achata 1 nível de objetos aninhados em colunas "a.b" (dinheiro fica junto). */
  function flatRow(o) {
    const r = {};
    for (const [k, v] of Object.entries(o)) {
      if (isObj(v) && !isMoney(v) && Object.values(v).every((x) => !isObj(x) || isMoney(x))) for (const [k2, v2] of Object.entries(v)) r[k + "." + k2] = v2;
      else r[k] = v;
    }
    return r;
  }

  function table(arr) {
    const rows = arr.map(flatRow);
    const cols = [];
    for (const r of rows) for (const k of Object.keys(r)) if (!cols.includes(k)) cols.push(k);
    const body = rows.map((r, i) =>
      h(
        "tr",
        { class: i === 0 && (r.rank === 1 || "total" in r) ? "first" : null },
        cols.map((c) => {
          const v = r[c];
          const long = typeof v === "string" && v.length > 80;
          return h("td", { class: typeof v === "number" ? "num" : long ? "long" : null }, scalar(v));
        }),
      ),
    );
    return h("div", { class: "tablewrap" }, h("table", {}, h("thead", {}, h("tr", {}, cols.map((c) => h("th", { text: pretty(c) })))), h("tbody", {}, body)));
  }

  function renderValue(key, v, depth) {
    if (Array.isArray(v) && v.length && v.every(isObj)) return h("div", { class: "group" }, h("div", { class: "gt", text: pretty(key) + ` (${v.length})` }), table(v));
    if (isObj(v) && !isMoney(v)) return h("div", { class: "group" }, h("div", { class: "gt", text: pretty(key) }), renderObject(v, depth + 1));
    return null;
  }

  function renderObject(obj, depth = 0) {
    const frag = document.createDocumentFragment();
    const kv = h("div", { class: "kv" });
    const nested = [];
    for (const [k, v] of Object.entries(obj)) {
      const block = depth < 4 ? renderValue(k, v, depth) : null;
      if (block) nested.push(block);
      else kv.append(h("div", { class: "k", text: pretty(k) }), h("div", { class: "v" }, scalar(v)));
    }
    if (kv.childElementCount) frag.append(kv);
    frag.append(...nested);
    return frag;
  }

  function showResult(msg) {
    const btn = $("#run");
    if (btn) {
      btn.disabled = false;
      btn.textContent = S.run;
    }
    lastData = msg.data;
    const bar = h(
      "div",
      { class: "bar" },
      h("h2", { text: msg.ok ? S.result : S.error }),
      h("span", { class: "badge" + (msg.ok ? "" : " err"), text: S.took.replace("{ms}", msg.ms) }),
      h("span", { class: "spacer" }),
      h("button", { type: "button", onclick: () => vscode.postMessage({ type: "copy", text: JSON.stringify(lastData, null, 2) }) }, S.copyJson),
      h("button", { type: "button", onclick: () => vscode.postMessage({ type: "openJson", data: lastData }) }, S.openJson),
      h("button", { type: "button", onclick: () => vscode.postMessage({ type: "exportMd", data: lastData, title: current.title }) }, S.exportMd),
    );
    const body = msg.ok ? renderObject(msg.data) : h("div", { class: "kv error" }, renderObject(msg.data));
    $("#result").replaceChildren(bar, body);
  }

  function showError(text) {
    const btn = $("#run");
    if (btn) {
      btn.disabled = false;
      btn.textContent = S.run;
    }
    $("#result").replaceChildren(h("div", { class: "kv error" }, h("div", { class: "k", text: S.error }), h("div", { class: "v", text })));
  }

  // ───────── Mensagens ─────────

  window.addEventListener("message", (e) => {
    const msg = e.data;
    switch (msg.type) {
      case "init": {
        S = msg.strings;
        lang = msg.lang;
        models = msg.models || [];
        document.documentElement.lang = lang;
        $("#models").replaceChildren(...models.map((m) => h("option", { value: m })));
        const picker = $("#picker");
        picker.replaceChildren(
          ...msg.categories.map((c) =>
            h("optgroup", { label: c.label }, msg.tools.filter((t) => t.category === c.id).map((t) => h("option", { value: t.name, text: t.title }))),
          ),
        );
        break;
      }
      case "tool":
        renderForm(msg);
        break;
      case "result":
        showResult(msg);
        break;
      case "error":
        showError(msg.text);
        break;
      case "setField": {
        const el = $("#f_" + msg.field);
        if (el) el.value = msg.value;
        break;
      }
    }
  });

  $("#form").addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
  $("#picker").addEventListener("change", (e) => vscode.postMessage({ type: "switch", name: e.target.value }));
  document.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") submit();
  });

  vscode.postMessage({ type: "ready" });
})();
