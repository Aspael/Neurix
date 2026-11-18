/**
 * Detecção automática de hardware: GPU(s), VRAM, energia, RAM e CPU — sem o usuário digitar nada.
 *
 * Fontes, em ordem:
 *   NVIDIA (qualquer sistema): nvidia-smi → nome, VRAM total/livre, consumo agora e limite de energia.
 *   Windows (AMD/Intel):        registro (HardwareInformation.qwMemorySize) e Win32_VideoController.
 *   Linux (AMD):                /sys/class/drm/card*\/device/mem_info_vram_total.
 *   macOS Apple Silicon:        memória unificada (a GPU usa ~70% da RAM).
 *
 * Largura de banda e TDP vêm de uma tabela aproximada por nome de GPU (usada para estimar tokens/s e watts).
 */
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { cpus, totalmem, freemem, platform, arch } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GIB = 1024 ** 3;

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "other";

export interface Gpu {
  name: string;
  vendor: GpuVendor;
  /** VRAM dedicada (GiB). Em GPU integrada/Apple é a fatia da RAM que a GPU pode usar. */
  vramGib: number;
  freeGib?: number;
  /** Usa a RAM do sistema (Intel/AMD integrada, Apple Silicon). */
  integrated: boolean;
  /** Consumo medido agora (W) — só NVIDIA. */
  powerDrawW?: number;
  /** Limite de energia configurado (W) — só NVIDIA. */
  powerLimitW?: number;
  /** Largura de banda da memória (GB/s), da tabela. */
  bandwidthGBs?: number;
  /** TDP típico (W), da tabela. */
  tdpW?: number;
  source: "nvidia-smi" | "windows" | "linux-sysfs" | "apple" | "manual";
}

export interface Hardware {
  platform: string;
  arch: string;
  cpu: { model: string; cores: number };
  ramGib: number;
  freeRamGib: number;
  gpus: Gpu[];
  /** A melhor GPU para rodar LLM (maior VRAM dedicada; senão Apple; senão nenhuma). */
  best: Gpu | null;
  /** Banda estimada da RAM (GB/s) para a parte que roda na CPU. */
  ramBandwidthGBs: number;
}

// ───────────── Tabela de GPUs (aproximada) ─────────────

/** [padrão no nome, banda GB/s, TDP W]. Mais específicos primeiro ("4060 Ti" antes de "4060"). */
const SPECS: [RegExp, number, number][] = [
  [/5090/, 1792, 575], [/5080/, 960, 360], [/5070 Ti/i, 896, 300], [/5070/, 672, 250], [/5060 Ti/i, 448, 180], [/5060/, 448, 145],
  [/4090/, 1008, 450], [/4080 Super/i, 736, 320], [/4080/, 717, 320], [/4070 Ti Super/i, 672, 285], [/4070 Ti/i, 504, 285],
  [/4070 Super/i, 504, 220], [/4070/, 504, 200], [/4060 Ti/i, 288, 160], [/4060/, 272, 115], [/4050/, 192, 115],
  [/3090 Ti/i, 1008, 450], [/3090/, 936, 350], [/3080 Ti/i, 912, 350], [/3080/, 760, 320], [/3070 Ti/i, 608, 290], [/3070/, 448, 220],
  [/3060 Ti/i, 448, 200], [/3060/, 360, 170], [/3050/, 224, 130],
  [/2080 Ti/i, 616, 250], [/2080/, 448, 215], [/2070/, 448, 175], [/2060/, 336, 160],
  [/1660/, 192, 120], [/1650/, 128, 75], [/1080 Ti/i, 484, 250], [/1080/, 320, 180], [/1070/, 256, 150],
  [/H200/, 4800, 700], [/H100/, 3350, 700], [/A100/, 2039, 400], [/L40S/i, 864, 350], [/A6000/i, 768, 300], [/A40\b/, 696, 300],
  [/L4\b/, 300, 72], [/T4\b/, 320, 70], [/A10\b/, 600, 150], [/V100/, 900, 300],
  [/7900 XTX/i, 960, 355], [/7900 XT/i, 800, 315], [/7800 XT/i, 624, 263], [/7700 XT/i, 432, 245], [/7600/, 288, 165],
  [/6950 XT/i, 576, 335], [/6900 XT/i, 512, 300], [/6800 XT/i, 512, 300], [/6800/, 512, 250], [/6700 XT/i, 384, 230], [/6600/, 224, 132],
  [/M4 Max/i, 546, 90], [/M4 Pro/i, 273, 60], [/M4/, 120, 25],
  [/M3 Ultra/i, 819, 150], [/M3 Max/i, 400, 90], [/M3 Pro/i, 150, 50], [/M3/, 100, 22],
  [/M2 Ultra/i, 800, 150], [/M2 Max/i, 400, 80], [/M2 Pro/i, 200, 45], [/M2/, 100, 22],
  [/M1 Ultra/i, 800, 120], [/M1 Max/i, 400, 70], [/M1 Pro/i, 200, 40], [/M1/, 68, 20],
];

export function gpuSpecs(name: string): { bandwidthGBs: number; tdpW: number } | null {
  const hit = SPECS.find(([re]) => re.test(name));
  return hit ? { bandwidthGBs: hit[1], tdpW: hit[2] } : null;
}

const vendorOf = (name: string): GpuVendor =>
  /nvidia|geforce|rtx|gtx|quadro|tesla|\b[AHLTV]\d{1,3}\b/i.test(name)
    ? "nvidia"
    : /amd|radeon|\brx\b/i.test(name)
      ? "amd"
      : /intel|uhd|iris|arc/i.test(name)
        ? "intel"
        : /apple|\bM[1-9]\b/i.test(name)
          ? "apple"
          : "other";

const withSpecs = (g: Gpu): Gpu => {
  const s = gpuSpecs(g.name);
  return s ? { ...g, bandwidthGBs: s.bandwidthGBs, tdpW: s.tdpW } : g;
};

// ───────────── NVIDIA ─────────────

export const NVIDIA_QUERY = "name,memory.total,memory.free,power.draw,power.limit";

/** Lê a saída de `nvidia-smi --query-gpu=name,memory.total,memory.free,power.draw,power.limit --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(out: string): Gpu[] {
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [name = "NVIDIA GPU", total, free, draw, limit] = l.split(",").map((s) => s.trim());
      const num = (s?: string): number | undefined => {
        const n = Number(s);
        return s && Number.isFinite(n) ? n : undefined; // "[N/A]" vira undefined
      };
      const mib = num(total) ?? 0;
      const freeMib = num(free);
      const powerDrawW = num(draw);
      const powerLimitW = num(limit);
      return withSpecs({
        name,
        vendor: "nvidia",
        vramGib: mib / 1024,
        ...(freeMib !== undefined && { freeGib: freeMib / 1024 }),
        integrated: false,
        ...(powerDrawW !== undefined && { powerDrawW }),
        ...(powerLimitW !== undefined && { powerLimitW }),
        source: "nvidia-smi",
      });
    });
}

/** Onde o nvidia-smi pode estar (no Windows ele fica no System32, que nem sempre está no PATH). */
let smiPath: string | null | undefined;
async function nvidiaSmi(args: string[], timeout: number): Promise<string | null> {
  const candidates =
    smiPath !== undefined
      ? smiPath
        ? [smiPath]
        : []
      : [
          "nvidia-smi",
          ...(platform() === "win32"
            ? [
                join(process.env.SystemRoot ?? "C:\\Windows", "System32", "nvidia-smi.exe"),
                join(process.env.ProgramFiles ?? "C:\\Program Files", "NVIDIA Corporation", "NVSMI", "nvidia-smi.exe"),
              ]
            : []),
        ];
  for (const exe of candidates) {
    try {
      const { stdout } = await run(exe, args, { timeout, windowsHide: true });
      smiPath = exe;
      return stdout;
    } catch {
      // tenta o próximo
    }
  }
  smiPath = null; // não tem NVIDIA: não tenta de novo
  return null;
}

async function nvidia(): Promise<Gpu[]> {
  const out = await nvidiaSmi([`--query-gpu=${NVIDIA_QUERY}`, "--format=csv,noheader,nounits"], 5000);
  return out ? parseNvidiaSmi(out) : [];
}

/** Consumo atual (W) da GPU NVIDIA — usado pelo benchmark para medir energia de verdade. */
export async function nvidiaPowerDraw(): Promise<number | null> {
  const out = await nvidiaSmi(["--query-gpu=power.draw", "--format=csv,noheader,nounits"], 3000);
  const n = Number(out?.split(/\r?\n/)[0]?.trim());
  return out && Number.isFinite(n) ? n : null;
}

// ───────────── Windows ─────────────

const WIN_SCRIPT = [
  "$ErrorActionPreference='SilentlyContinue';",
  "$reg = Get-ItemProperty 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}\\0*' |",
  "  Where-Object { $_.DriverDesc } | ForEach-Object { [pscustomobject]@{ name = $_.DriverDesc; bytes = $_.'HardwareInformation.qwMemorySize' } };",
  "$wmi = Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ name = $_.Name; bytes = $_.AdapterRAM } };",
  "[pscustomobject]@{ reg = @($reg); wmi = @($wmi) } | ConvertTo-Json -Compress -Depth 4",
].join(" ");

/** Lê o JSON do script do Windows. O registro tem a VRAM em 64 bits; o WMI trava em 4 GB. */
export function parseWindowsGpus(json: string): Gpu[] {
  const data = JSON.parse(json) as { reg?: { name: string; bytes: number | null }[]; wmi?: { name: string; bytes: number | null }[] };
  const byName = new Map<string, number>();
  for (const r of data.wmi ?? []) if (r.name) byName.set(r.name, Number(r.bytes) || 0);
  for (const r of data.reg ?? []) if (r.name && Number(r.bytes) > 0) byName.set(r.name, Number(r.bytes)); // registro vence
  return [...byName.entries()].map(([name, bytes]) => {
    const vendor = vendorOf(name);
    const integrated = vendor === "intel" && !/\barc\b/i.test(name);
    return withSpecs({ name, vendor, vramGib: bytes / GIB, integrated, source: "windows" });
  });
}

/** O PowerShell nem sempre está no PATH (ex.: Git Bash): tenta o caminho completo do Windows primeiro. */
const POWERSHELLS = (): string[] => [
  join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
  "powershell.exe",
  "pwsh",
];

export async function windowsGpus(): Promise<Gpu[]> {
  for (const exe of POWERSHELLS()) {
    try {
      const { stdout } = await run(exe, ["-NoProfile", "-NonInteractive", "-Command", WIN_SCRIPT], { timeout: 10_000, windowsHide: true });
      return parseWindowsGpus(stdout);
    } catch {
      // tenta o próximo
    }
  }
  return [];
}

// ───────────── Linux (AMD) ─────────────

async function linuxSysfs(): Promise<Gpu[]> {
  const out: Gpu[] = [];
  try {
    const cards = (await readdir("/sys/class/drm")).filter((c) => /^card\d+$/.test(c));
    for (const c of cards) {
      const dev = join("/sys/class/drm", c, "device");
      const vendor = (await readFile(join(dev, "vendor"), "utf8").catch(() => "")).trim();
      const total = Number((await readFile(join(dev, "mem_info_vram_total"), "utf8").catch(() => "")).trim());
      if (vendor !== "0x1002" || !total) continue; // AMD com VRAM informada
      const name = (await readFile(join(dev, "product_name"), "utf8").catch(() => "")).trim() || "AMD Radeon";
      out.push(withSpecs({ name, vendor: "amd", vramGib: total / GIB, integrated: total < 2 * GIB, source: "linux-sysfs" }));
    }
  } catch {
    // sem /sys/class/drm
  }
  return out;
}

// ───────────── Apple Silicon ─────────────

async function apple(ramGib: number): Promise<Gpu[]> {
  let chip = "";
  try {
    chip = (await run("sysctl", ["-n", "machdep.cpu.brand_string"], { timeout: 3000 })).stdout.trim();
  } catch {
    chip = cpus()[0]?.model ?? "Apple Silicon";
  }
  // O macOS deixa a GPU usar ~2/3 da memória em máquinas pequenas e ~3/4 nas grandes.
  const share = ramGib >= 36 ? 0.75 : 0.67;
  return [withSpecs({ name: chip || "Apple Silicon", vendor: "apple", vramGib: ramGib * share, integrated: true, source: "apple" })];
}

// ───────────── Tudo junto ─────────────

let cached: Promise<Hardware> | null = null;

export function detectHardware(refresh = false): Promise<Hardware> {
  if (!cached || refresh) cached = detect();
  return cached;
}

async function detect(): Promise<Hardware> {
  const ramGib = totalmem() / GIB;
  const plat = platform();
  const isApple = plat === "darwin" && arch() === "arm64";

  let gpus = await nvidia();
  if (isApple) gpus = [...gpus, ...(await apple(ramGib))];
  else if (plat === "win32") {
    const win = await windowsGpus();
    // NVIDIA já veio do nvidia-smi (com energia); do Windows só o que não é NVIDIA
    gpus = [...gpus, ...win.filter((g) => !(gpus.length && g.vendor === "nvidia"))];
  } else if (plat === "linux") gpus = [...gpus, ...(await linuxSysfs())];

  const dedicated = gpus.filter((g) => !g.integrated).sort((a, b) => b.vramGib - a.vramGib);
  const best = dedicated[0] ?? gpus.find((g) => g.vendor === "apple") ?? null;
  return {
    platform: plat,
    arch: arch(),
    cpu: { model: (cpus()[0]?.model ?? "CPU").trim(), cores: cpus().length },
    ramGib,
    freeRamGib: freemem() / GIB,
    gpus,
    best,
    // DDR4 dual-channel ~40 GB/s, DDR5 ~70 GB/s; Apple: a própria memória unificada
    ramBandwidthGBs: isApple ? (best?.bandwidthGBs ?? 100) : 40,
  };
}

/** Potência que a GPU deve puxar gerando texto (W): limite/TDP × 75% (gerar texto é limitado pela memória). */
export function inferencePowerW(g: Gpu | null): number | null {
  const ref = g?.powerLimitW ?? g?.tdpW;
  return ref ? Math.round(ref * 0.75) : null;
}
