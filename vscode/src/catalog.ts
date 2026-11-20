/** Catálogo das 23 ferramentas do Neurix como aparecem na extensão: categoria, ícone, textos PT/EN e como preencher. */
export type Lang = "pt" | "en";
type L = Record<Lang, string>;

export type CategoryId = "cost" | "prompt" | "budget" | "local" | "learn";

export const CATEGORIES: { id: CategoryId; icon: string; label: L }[] = [
  { id: "cost", icon: "symbol-number", label: { pt: "Tokens e custo", en: "Tokens & cost" } },
  { id: "prompt", icon: "sparkle", label: { pt: "Prompt, dados e RAG", en: "Prompt, data & RAG" } },
  { id: "budget", icon: "graph-line", label: { pt: "Orçamento e alertas", en: "Budget & alerts" } },
  { id: "local", icon: "server-environment", label: { pt: "Modelos locais", en: "Local models" } },
  { id: "learn", icon: "book", label: { pt: "Aprender", en: "Learn" } },
];

/**
 * Como preencher a partir do contexto:
 *  - text:    campos de texto recebem a seleção (ou o arquivo aberto)
 *  - file:    `path` recebe o arquivo (do editor ou do Explorer)
 *  - folder:  `path` recebe a pasta (do Explorer ou a raiz do workspace)
 *  - textOrFile: arquivo se veio do Explorer, senão texto
 */
export type Prefill = "text" | "file" | "folder" | "textOrFile" | "none";

export interface ToolInfo {
  name: string;
  command: string;
  category: CategoryId;
  icon: string;
  title: L;
  desc: L;
  prefill: Prefill;
  /** Preenche `model` com o modelo padrão (API). */
  apiModel?: boolean;
  /** Roda sozinho ao abrir quando os campos obrigatórios já estão preenchidos. */
  autorun?: boolean;
}

export const TOOLS: ToolInfo[] = [
  // ── Tokens e custo
  {
    name: "neurix_count_tokens", command: "neurix.countTokens", category: "cost", icon: "symbol-number", prefill: "text", autorun: true,
    title: { pt: "Contar tokens", en: "Count tokens" },
    desc: { pt: "Tokens do texto por família (OpenAI exato; Claude/Gemini estimado) ou num modelo específico.", en: "Tokens per family (OpenAI exact; Claude/Gemini estimated) or for a specific model." },
  },
  {
    name: "neurix_count_file", command: "neurix.countFile", category: "cost", icon: "file", prefill: "file", apiModel: true, autorun: true,
    title: { pt: "Tokens e custo do arquivo", en: "Tokens & cost of a file" },
    desc: { pt: "Conta os tokens de um arquivo de texto e o custo de enviá-lo como entrada.", en: "Counts a text file's tokens and the cost of sending it as input." },
  },
  {
    name: "neurix_estimate_cost", command: "neurix.estimateCost", category: "cost", icon: "credit-card", prefill: "text", apiModel: true, autorun: true,
    title: { pt: "Custo de uma chamada", en: "Cost of one call" },
    desc: { pt: "Entrada + saída em US$ e R$, preço aplicado e uso da janela de contexto.", en: "Input + output in US$ and R$, applied price and context-window usage." },
  },
  {
    name: "neurix_compare_models", command: "neurix.compareModels", category: "cost", icon: "list-ordered", prefill: "text", autorun: true,
    title: { pt: "Comparar modelos", en: "Compare models" },
    desc: { pt: "Ranking de todos os modelos pelo custo da mesma chamada, do mais barato ao mais caro.", en: "Ranks every model by the cost of the same call, cheapest first." },
  },
  {
    name: "neurix_recommend_model", command: "neurix.recommendModel", category: "cost", icon: "lightbulb", prefill: "text", autorun: true,
    title: { pt: "Recomendar modelo", en: "Recommend a model" },
    desc: { pt: "O modelo mais barato com a qualidade que o prompt pede.", en: "The cheapest model with the quality the prompt needs." },
  },
  {
    name: "neurix_list_models", command: "neurix.listModels", category: "cost", icon: "list-unordered", prefill: "none", autorun: true,
    title: { pt: "Modelos e preços", en: "Models & prices" },
    desc: { pt: "Todos os modelos (API e locais), preço por 1M tokens e janela de contexto.", en: "Every model (API and local), price per 1M tokens and context window." },
  },
  {
    name: "neurix_exchange_rate", command: "neurix.exchangeRate", category: "cost", icon: "arrow-swap", prefill: "none", autorun: true,
    title: { pt: "Cotação do dólar", en: "USD → BRL rate" },
    desc: { pt: "Cotação atual USD → BRL (cache de 1 h), com IOF opcional.", en: "Live USD → BRL rate (1 h cache), with optional IOF." },
  },
  // ── Prompt, dados e RAG
  {
    name: "neurix_optimize_prompt", command: "neurix.optimizePrompt", category: "prompt", icon: "wand", prefill: "textOrFile", apiModel: true, autorun: true,
    title: { pt: "Otimizar prompt", en: "Optimize prompt" },
    desc: { pt: "Acha tokens desperdiçados (espaços, repetições, decoração) e mostra a economia.", en: "Finds wasted tokens (whitespace, repetition, decoration) and the savings." },
  },
  {
    name: "neurix_suggest_format", command: "neurix.suggestFormat", category: "prompt", icon: "json", prefill: "text", apiModel: true, autorun: true,
    title: { pt: "Formato mais barato", en: "Cheapest data format" },
    desc: { pt: "Os mesmos dados em JSON, YAML, CSV, Markdown… e quanto cada um custa.", en: "The same data as JSON, YAML, CSV, Markdown… and what each costs." },
  },
  {
    name: "neurix_chunk_document", command: "neurix.chunkDocument", category: "prompt", icon: "split-horizontal", prefill: "textOrFile", apiModel: true, autorun: true,
    title: { pt: "Dividir em chunks (RAG)", en: "Chunk document (RAG)" },
    desc: { pt: "Divide o documento em chunks com sobreposição, como um pipeline de RAG.", en: "Splits the document into overlapping chunks, like a RAG pipeline." },
  },
  {
    name: "neurix_rag_cost", command: "neurix.ragCost", category: "prompt", icon: "search", prefill: "text", apiModel: true, autorun: true,
    title: { pt: "RAG × documento inteiro", en: "RAG vs whole document" },
    desc: { pt: "Custo por pergunta e por mês: mandar tudo ou só os chunks relevantes.", en: "Cost per question and per month: send everything or only the relevant chunks." },
  },
  {
    name: "neurix_analyze_folder", command: "neurix.analyzeFolder", category: "prompt", icon: "folder", prefill: "folder", apiModel: true, autorun: true,
    title: { pt: "Tokens por arquivo da pasta", en: "Tokens per file in folder" },
    desc: { pt: "Conta os tokens de cada arquivo de uma pasta/repositório e o custo total.", en: "Counts every file in a folder/repository and the total cost." },
  },
  {
    name: "neurix_prompt_cache_savings", command: "neurix.promptCache", category: "prompt", icon: "database", prefill: "text", apiModel: true,
    title: { pt: "Economia com prompt caching", en: "Prompt caching savings" },
    desc: { pt: "Quanto o cache de prompt economiza quando a parte fixa se repete.", en: "How much prompt caching saves when the fixed part repeats." },
  },
  // ── Orçamento e alertas
  {
    name: "neurix_budget", command: "neurix.budget", category: "budget", icon: "graph-line", prefill: "text",
    title: { pt: "Neurix Budget", en: "Neurix Budget" },
    desc: { pt: "Teto mensal: quantas requisições cabem, projeção, dia em que acaba, cache e batch.", en: "Monthly cap: requests that fit, projection, the day it runs out, caching and batch." },
  },
  {
    name: "neurix_check_cost", command: "neurix.checkCost", category: "budget", icon: "warning", prefill: "textOrFile", apiModel: true,
    title: { pt: "Alerta de custo", en: "Cost alert" },
    desc: { pt: "Passou do limite? Defina máximo em US$, R$ ou tokens.", en: "Over the limit? Set a maximum in US$, R$ or tokens." },
  },
  // ── Modelos locais
  {
    name: "neurix_detect_hardware", command: "neurix.detectHardware", category: "local", icon: "chip", prefill: "none", autorun: true,
    title: { pt: "Detectar hardware", en: "Detect hardware" },
    desc: { pt: "GPU, VRAM, consumo, RAM e CPU — sem digitar nada.", en: "GPU, VRAM, power, RAM and CPU — nothing to type." },
  },
  {
    name: "neurix_installed_models", command: "neurix.installedModels", category: "local", icon: "package", prefill: "none", autorun: true,
    title: { pt: "Modelos instalados", en: "Installed models" },
    desc: { pt: "Modelos do Ollama e LM Studio e quais rodam bem na sua máquina.", en: "Ollama and LM Studio models and which run well on your machine." },
  },
  {
    name: "neurix_check_local_fit", command: "neurix.checkLocalFit", category: "local", icon: "server", prefill: "none",
    title: { pt: "Cabe na minha GPU?", en: "Does it fit my GPU?" },
    desc: { pt: "Pesos + KV cache + overhead = VRAM; camadas na GPU e maior contexto que cabe.", en: "Weights + KV cache + overhead = VRAM; GPU layers and the largest context that fits." },
  },
  {
    name: "neurix_find_local_models", command: "neurix.findLocalModels", category: "local", icon: "filter", prefill: "none",
    title: { pt: "Modelos que cabem na GPU", en: "Models that fit my GPU" },
    desc: { pt: "Quais modelos locais cabem numa VRAM, com qual quantização.", en: "Which local models fit a given VRAM, and at which quantization." },
  },
  {
    name: "neurix_import_hf_model", command: "neurix.importHfModel", category: "local", icon: "cloud-download", prefill: "none",
    title: { pt: "Importar do Hugging Face", en: "Import from Hugging Face" },
    desc: { pt: "Busca um modelo no Hugging Face e lê camadas, KV heads e contexto.", en: "Finds a Hugging Face model and reads layers, KV heads and context." },
  },
  {
    name: "neurix_local_vs_api", command: "neurix.localVsApi", category: "local", icon: "law", prefill: "none",
    title: { pt: "Local × API", en: "Local vs API" },
    desc: { pt: "Energia + amortização da GPU contra a conta da API, e quando a placa se paga.", en: "Electricity + GPU amortization vs the API bill, and when the card pays off." },
  },
  {
    name: "neurix_benchmark_ollama", command: "neurix.benchmarkOllama", category: "local", icon: "dashboard", prefill: "none",
    title: { pt: "Benchmark com Ollama", en: "Ollama benchmark" },
    desc: { pt: "Mede tokens/s reais e consumo da GPU. Sem modelo, lista os do Ollama.", en: "Measures real tokens/s and GPU power. Without a model, lists Ollama's." },
  },
  // ── Aprender
  {
    name: "neurix_explain_term", command: "neurix.explainTerm", category: "learn", icon: "book", prefill: "none", autorun: true,
    title: { pt: "Glossário", en: "Glossary" },
    desc: { pt: "Token, chunk, embedding, quantização, KV cache… em linguagem simples.", en: "Token, chunk, embedding, quantization, KV cache… in plain language." },
  },
];

export const toolInfo = (name: string): ToolInfo | undefined => TOOLS.find((t) => t.name === name);

/** Rótulos amigáveis dos parâmetros (a descrição completa vem do schema MCP). */
export const FIELD_LABELS: Record<string, L> = {
  text: { pt: "Texto", en: "Text" },
  content: { pt: "Conteúdo (JSON, CSV ou texto)", en: "Content (JSON, CSV or text)" },
  prompt: { pt: "Prompt", en: "Prompt" },
  fixed_text: { pt: "Parte fixa do prompt", en: "Fixed part of the prompt" },
  path: { pt: "Caminho", en: "Path" },
  filename: { pt: "Nome do arquivo", en: "File name" },
  model: { pt: "Modelo", en: "Model" },
  include_local: { pt: "Incluir modelos locais", en: "Include local models" },
  input_tokens: { pt: "Tokens de entrada", en: "Input tokens" },
  output_tokens: { pt: "Tokens de saída (resposta)", en: "Output tokens (answer)" },
  calls: { pt: "Chamadas", en: "Calls" },
  usd_brl: { pt: "Cotação USD→BRL manual", en: "Manual USD→BRL rate" },
  iof_pct: { pt: "IOF (%)", en: "IOF (%)" },
  include_all: { pt: "Incluir todos (legados também)", en: "Include all (legacy too)" },
  providers: { pt: "Provedores", en: "Providers" },
  provider: { pt: "Provedor", en: "Provider" },
  include_converted: { pt: "Mostrar o texto convertido", en: "Show converted text" },
  custom: { pt: "Modelo personalizado (JSON)", en: "Custom model (JSON)" },
  quant: { pt: "Quantização", en: "Quantization" },
  context: { pt: "Contexto (tokens)", en: "Context (tokens)" },
  kv: { pt: "Precisão do KV cache", en: "KV cache precision" },
  vram_gb: { pt: "VRAM (GB)", en: "VRAM (GB)" },
  detect_gpu: { pt: "Detectar minha GPU", en: "Detect my GPU" },
  hf_repo: { pt: "Repositório Hugging Face", en: "Hugging Face repo" },
  parallel: { pt: "Requisições paralelas", en: "Parallel requests" },
  min_quality: { pt: "Qualidade mínima", en: "Minimum quality" },
  doc_tokens: { pt: "Tokens do documento", en: "Document tokens" },
  chunk_size: { pt: "Tamanho do chunk", en: "Chunk size" },
  overlap_pct: { pt: "Sobreposição (%)", en: "Overlap (%)" },
  top_k: { pt: "Top-K chunks", en: "Top-K chunks" },
  queries_per_month: { pt: "Perguntas por mês", en: "Questions per month" },
  embed_price_per_1m: { pt: "Preço do embedding por 1M", en: "Embedding price per 1M" },
  system_tokens: { pt: "Tokens do system prompt", en: "System prompt tokens" },
  question_tokens: { pt: "Tokens da pergunta", en: "Question tokens" },
  kind: { pt: "Tipo", en: "Kind" },
  amount_usd: { pt: "Valor em US$", en: "Amount in US$" },
  refresh: { pt: "Forçar atualização", en: "Force refresh" },
  term: { pt: "Termo", en: "Term" },
  lang: { pt: "Idioma", en: "Language" },
  include_optimized: { pt: "Mostrar versão otimizada", en: "Show optimized version" },
  top: { pt: "Maiores arquivos", en: "Top files" },
  extensions: { pt: "Extensões (ex.: ts, md)", en: "Extensions (e.g. ts, md)" },
  include_hidden: { pt: "Incluir ocultos", en: "Include hidden" },
  include_text: { pt: "Mostrar texto dos chunks", en: "Show chunk text" },
  max_chunks: { pt: "Máximo de chunks", en: "Max chunks" },
  quality: { pt: "Qualidade", en: "Quality" },
  cap: { pt: "Teto mensal", en: "Monthly cap" },
  currency: { pt: "Moeda", en: "Currency" },
  requests_per_day: { pt: "Requisições por dia", en: "Requests per day" },
  active_days: { pt: "Dias ativos no mês", en: "Active days per month" },
  cached_tokens: { pt: "Tokens em cache", en: "Cached tokens" },
  cached_pct: { pt: "% do prompt em cache", en: "% of prompt cached" },
  cache_hit_pct: { pt: "Acerto do cache (%)", en: "Cache hit (%)" },
  batch_pct: { pt: "% via batch", en: "% via batch" },
  spent_so_far: { pt: "Gasto até agora", en: "Spent so far" },
  max_usd: { pt: "Máximo em US$", en: "Max US$" },
  max_brl: { pt: "Máximo em R$", en: "Max R$" },
  max_tokens: { pt: "Máximo de tokens", en: "Max tokens" },
  fixed_tokens: { pt: "Tokens fixos", en: "Fixed tokens" },
  variable_tokens: { pt: "Tokens variáveis", en: "Variable tokens" },
  extra_dirs: { pt: "Pastas extras", en: "Extra folders" },
  query: { pt: "Busca", en: "Search" },
  pick: { pt: "Escolher resultado nº", en: "Pick result #" },
  days_per_month: { pt: "Dias por mês", en: "Days per month" },
  tariff_per_kwh: { pt: "Tarifa por kWh", en: "Tariff per kWh" },
  gpu_w: { pt: "Consumo da GPU (W)", en: "GPU power (W)" },
  system_w: { pt: "Consumo do sistema (W)", en: "System power (W)" },
  hardware_price: { pt: "Preço do hardware", en: "Hardware price" },
  amortize_months: { pt: "Amortizar em (meses)", en: "Amortize over (months)" },
};

/** Campos de texto longo (viram textarea e recebem a seleção). */
export const TEXT_FIELDS = new Set(["text", "content", "prompt", "fixed_text"]);
