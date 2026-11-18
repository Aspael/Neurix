/**
 * Leitor do cabeçalho de arquivos GGUF (llama.cpp, Ollama, LM Studio).
 *
 * Lê só os metadados e a lista de tensores — não carrega os pesos. Com isso sabemos a arquitetura,
 * camadas, cabeças KV, dimensão da cabeça, contexto nativo, tipo de quantização e o número exato de
 * parâmetros (somando os tensores).
 *
 * Formato: "GGUF" | versão u32 | nº tensores u64 | nº chaves u64 | chaves… | tensores…
 */
import { open, type FileHandle } from "node:fs/promises";

const T = { U8: 0, I8: 1, U16: 2, I16: 3, U32: 4, I32: 5, F32: 6, BOOL: 7, STRING: 8, ARRAY: 9, U64: 10, I64: 11, F64: 12 } as const;
const SIZE: Record<number, number> = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };

export type GgufValue = number | bigint | boolean | string | GgufValue[] | { arrayOf: number; length: number };

export interface GgufInfo {
  version: number;
  metadata: Record<string, GgufValue>;
  tensorCount: number;
  /** Soma dos elementos de todos os tensores = parâmetros do modelo. */
  parameters: number;
}

/** Leitor sequencial com buffer: lê o arquivo aos pedaços conforme precisa. */
class Reader {
  private buf = Buffer.alloc(0);
  private pos = 0; // posição dentro de buf
  private fileOffset = 0; // posição no arquivo do início de buf
  private fh: FileHandle;
  private limit: number;
  constructor(fh: FileHandle, limit: number) {
    this.fh = fh;
    this.limit = limit;
  }

  private async need(n: number): Promise<void> {
    if (this.pos + n <= this.buf.length) return;
    const keep = this.buf.subarray(this.pos);
    const want = Math.max(n - keep.length, 1 << 20);
    const chunk = Buffer.alloc(want);
    const start = this.fileOffset + this.pos + keep.length;
    if (start >= this.limit) throw new Error("GGUF: cabeçalho maior que o limite de leitura");
    const { bytesRead } = await this.fh.read(chunk, 0, want, start);
    if (bytesRead + keep.length < n) throw new Error("GGUF: arquivo terminou no meio do cabeçalho");
    this.fileOffset += this.pos;
    this.buf = Buffer.concat([keep, chunk.subarray(0, bytesRead)]);
    this.pos = 0;
  }
  async u32(): Promise<number> {
    await this.need(4);
    const v = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return v;
  }
  async u64(): Promise<bigint> {
    await this.need(8);
    const v = this.buf.readBigUInt64LE(this.pos);
    this.pos += 8;
    return v;
  }
  async bytes(n: number): Promise<Buffer> {
    await this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  async skip(n: number): Promise<void> {
    // pula sem guardar (arrays enormes do tokenizer)
    while (n > 0) {
      const step = Math.min(n, 1 << 20);
      await this.need(step);
      this.pos += step;
      n -= step;
    }
  }
  async string(): Promise<string> {
    const len = Number(await this.u64());
    return (await this.bytes(len)).toString("utf8");
  }
  async scalar(type: number): Promise<GgufValue> {
    const n = SIZE[type];
    if (n === undefined) throw new Error(`GGUF: tipo ${type} desconhecido`);
    const b = await this.bytes(n);
    switch (type) {
      case T.U8: return b.readUInt8(0);
      case T.I8: return b.readInt8(0);
      case T.U16: return b.readUInt16LE(0);
      case T.I16: return b.readInt16LE(0);
      case T.U32: return b.readUInt32LE(0);
      case T.I32: return b.readInt32LE(0);
      case T.F32: return b.readFloatLE(0);
      case T.BOOL: return b.readUInt8(0) !== 0;
      case T.U64: return b.readBigUInt64LE(0);
      case T.I64: return b.readBigInt64LE(0);
      default: return b.readDoubleLE(0);
    }
  }
}

/** Arrays pequenos (ex.: cabeças KV por camada) são lidos; os grandes (vocabulário) são pulados. */
const MAX_ARRAY_KEPT = 4096;

async function readValue(r: Reader, type: number): Promise<GgufValue> {
  if (type === T.STRING) return r.string();
  if (type !== T.ARRAY) return r.scalar(type);
  const itemType = await r.u32();
  const length = Number(await r.u64());
  if (length <= MAX_ARRAY_KEPT && itemType !== T.ARRAY) {
    const items: GgufValue[] = [];
    for (let i = 0; i < length; i++) items.push(await readValue(r, itemType));
    return items;
  }
  if (itemType === T.STRING) for (let i = 0; i < length; i++) await r.skip(Number(await r.u64()));
  else if (SIZE[itemType] !== undefined) await r.skip(length * (SIZE[itemType] as number));
  else for (let i = 0; i < length; i++) await readValue(r, itemType);
  return { arrayOf: itemType, length };
}

export async function readGguf(path: string, maxHeaderBytes = 256 * 1024 * 1024): Promise<GgufInfo> {
  const fh = await open(path, "r");
  try {
    const r = new Reader(fh, maxHeaderBytes);
    if ((await r.bytes(4)).toString("latin1") !== "GGUF") throw new Error("não é um arquivo GGUF");
    const version = await r.u32();
    if (version < 2) throw new Error(`GGUF versão ${version} não suportada`);
    const tensorCount = Number(await r.u64());
    const kvCount = Number(await r.u64());
    const metadata: Record<string, GgufValue> = {};
    for (let i = 0; i < kvCount; i++) {
      const key = await r.string();
      metadata[key] = await readValue(r, await r.u32());
    }
    let parameters = 0;
    for (let i = 0; i < tensorCount; i++) {
      await r.string(); // nome
      const dims = await r.u32();
      let n = 1;
      for (let d = 0; d < dims; d++) n *= Number(await r.u64());
      await r.u32(); // tipo
      await r.u64(); // offset
      parameters += n;
    }
    return { version, metadata, tensorCount, parameters };
  } finally {
    await fh.close();
  }
}

/** Nomes de general.file_type (llama.cpp). */
export const FILE_TYPES: Record<number, string> = {
  0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 7: "Q8_0", 8: "Q5_0", 9: "Q5_1", 10: "Q2_K", 11: "Q3_K_S", 12: "Q3_K_M",
  13: "Q3_K_L", 14: "Q4_K_S", 15: "Q4_K_M", 16: "Q5_K_S", 17: "Q5_K_M", 18: "Q6_K", 19: "IQ2_XXS", 20: "IQ2_XS",
  21: "Q2_K_S", 22: "IQ3_XS", 23: "IQ3_XXS", 24: "IQ1_S", 25: "IQ4_NL", 26: "IQ3_S", 27: "IQ3_M", 28: "IQ2_S",
  29: "IQ2_M", 30: "IQ4_XS", 31: "IQ1_M", 32: "BF16",
};

const num = (v: GgufValue | undefined): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  // por camada (alguns modelos variam as cabeças KV): usa o maior
  if (Array.isArray(v) && v.length) return Math.max(...v.map((x) => num(x) ?? 0));
  return undefined;
};

export interface GgufModelShape {
  arch: string;
  name: string | null;
  layers: number;
  kvHeads: number;
  headDim: number;
  maxContext: number;
  paramsB: number;
  fileType: string | null;
}

/** Converte os metadados no formato que o Neurix usa para calcular memória. */
export function shapeFromGguf(info: GgufInfo): GgufModelShape {
  const m = info.metadata;
  const a = String(m["general.architecture"] ?? "llama");
  const k = (key: string): number | undefined => num(m[`${a}.${key}`]);
  const layers = k("block_count") ?? 0;
  const heads = k("attention.head_count") ?? 0;
  const kvHeads = k("attention.head_count_kv") ?? heads;
  const embed = k("embedding_length") ?? 0;
  const headDim = k("attention.key_length") ?? (heads ? Math.round(embed / heads) : 0);
  const ft = num(m["general.file_type"]);
  const params = info.parameters || num(m["general.parameter_count"]) || 0;
  return {
    arch: a,
    name: typeof m["general.name"] === "string" ? (m["general.name"] as string) : null,
    layers,
    kvHeads,
    headDim,
    maxContext: k("context_length") ?? 2048,
    paramsB: params / 1e9,
    fileType: ft !== undefined ? (FILE_TYPES[ft] ?? `tipo ${ft}`) : null,
  };
}

// ───────────── Escrita (usada nos testes para gerar um GGUF de exemplo) ─────────────

/** Gera um GGUF mínimo com metadados e tensores falsos (sem pesos). Só para testes. */
export function buildTestGguf(meta: Record<string, string | number>, tensors: { name: string; dims: number[] }[]): Buffer {
  const parts: Buffer[] = [];
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    parts.push(b);
  };
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(BigInt(n));
    parts.push(b);
  };
  const str = (s: string) => {
    const b = Buffer.from(s, "utf8");
    u64(b.length);
    parts.push(b);
  };
  parts.push(Buffer.from("GGUF", "latin1"));
  u32(3);
  u64(tensors.length);
  u64(Object.keys(meta).length + 1);
  for (const [key, v] of Object.entries(meta)) {
    str(key);
    if (typeof v === "string") {
      u32(T.STRING);
      str(v);
    } else {
      u32(T.U32);
      u32(v);
    }
  }
  // um array grande de strings (como o vocabulário) para testar o "pular"
  str("tokenizer.ggml.tokens");
  u32(T.ARRAY);
  u32(T.STRING);
  u64(5000);
  for (let i = 0; i < 5000; i++) str(`tok${i}`);
  for (const t of tensors) {
    str(t.name);
    u32(t.dims.length);
    for (const d of t.dims) u64(d);
    u32(0);
    u64(0);
  }
  return Buffer.concat(parts);
}
