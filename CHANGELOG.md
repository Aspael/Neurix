# Changelog

All notable changes to Neurix. 🇧🇷 Em português: [README → Novidades](README.md#-novidades-changelog).

## 0.2.1 — unreleased

**🐛 Fixes**

- **`npx aspael-neurix` didn't run** ("could not determine executable to run"): the package had two executables (`neurix` and `neurix-mcp`) and none named after the package, so npx couldn't tell which to open. The package now also ships an `aspael-neurix` executable.
- The README said to install `neurix` (`npm install -g neurix`, `npx neurix`), which isn't the package name. It's now `aspael-neurix`, and the badges point to the right package.
- CI now tests `npx` against the packed package, so this can't come back.

## 0.2.0 — 2026-11-17

**✨ New**

- **Exact token counts** — OpenAI with the official tokenizer (`js-tiktoken`, `o200k_base`); local models with each model's own tokenizer, downloaded from Hugging Face and cached. Claude and Gemini show as an **estimate**, with the reason on screen (their tokenizers aren't public).
- **🔌 MCP server** (`neurix mcp` / `neurix-mcp`) with **23 tools** to use Neurix inside Claude Code, Cursor, VS Code, Windsurf, Gemini CLI and others.
- **🧰 Tools** — prompt optimizer (`optimize`), folder/repository analysis (`folder`), visual RAG chunking (`chunks`), model recommender (`recommend`) and prompt caching.
- **💰 Neurix Budget** (`budget`) — monthly cap, requests that fit, projection per day/month/year, the day the cap runs out, spending pace (`--spent`) and caching/batch savings per provider.
- **🚦 Neurix check** (`check`) — cost alert for CI and pre-commit: exit code 1 when over `--max-usd`, `--max-brl` or `--max-tokens`; `--json` for scripts.
- **🖥️ Local models, for real**
  - `hardware` — detects GPU, VRAM, live power draw (NVIDIA), RAM and CPU, with nothing to type.
  - `installed` — reads Ollama (even when closed) and LM Studio models straight from their GGUF files and tells which run well.
  - `local --hf <repo>` — imports layers, KV heads and context from Hugging Face's `config.json` (replaces the 5 questions; they're still there as a fallback).
  - `local-vs-api` — electricity + GPU amortization versus the API bill, with the month the card pays for itself.
  - `benchmark` — real tokens/s and GPU power measured with Ollama.
  - `local` now uses the detected GPU and shows the estimated speed.
- **📤 Reports** in Markdown, CSV, JSON and HTML for every result (`--export file` or "📤 Export" in the menu).
- **📖 Manual** — getting started, a glossary by category (39 beginner-friendly terms) and every command with options and examples (`manual`).
- **🏷️ Always-current prices** — a daily GitHub Actions workflow regenerates `data/models.json`; the CLI downloads the new table by itself (24 h cache). `prices` shows where it came from; `prices --refresh` forces a download.
- **📋 Paste from the clipboard** in the tools that ask for text (long prompts, with blank lines).
- **⭐ Credits** in the menu.

**🔄 Changes** (may break scripts)

- Commands and options standardized in **English**. From the published version: `cambio` → `fx`, `-e/--explicar` → `--explain` and `local --paralelo` → `--parallel`.
- "What does each term mean" became **📖 Manual**; "🖥️ Local model" became a submenu.
- `neurix local` uses the detected GPU when `-g` isn't given (`--no-detect` turns it off).
- The model comparison gained a **Tokens** column: each model counts with its own tokenizer.

**🐛 Fixes**

- **Multi-line text input** (prompt caching and the other tools): Enter didn't submit — the submit button only reacted to Tab. Now Enter on an empty line submits, and text with blank lines goes through "📋 Paste" or a file.
- GPU detection on Windows when PowerShell or `nvidia-smi` aren't on the PATH (e.g. Git Bash).
- Optimizer: line numbers now point to the original text, and fixes that save no tokens no longer show as "−0".
- Chunking: a small overlap no longer disappears from the map.
- Recommender: cheaper models show as "95% cheaper" instead of "0.0× the recommended".
- Going back from a submenu no longer shows "Cancelled".

**🏗️ Internal**

- GitHub Actions CI (Linux, Windows and macOS; Node 22 and 24) testing the installed npm package; automatic release on tag with npm provenance; Dependabot.
- 91 tests (`node:test`) covering the core, the CLI and the MCP server.
- New dependencies: `js-tiktoken`, `@huggingface/tokenizers`, `@modelcontextprotocol/sdk`, `zod`.

## 0.1.1 — 2026-11-15

First public release: animated interactive menu in Portuguese and English; cost of a text in dollars and reais with a live exchange rate (and IOF); model comparison; files as input, format comparison and RAG simulation; memory to run a local model (weights, KV cache, overhead, VRAM) with a custom mode.

