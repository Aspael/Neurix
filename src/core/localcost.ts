/**
 * Velocidade, energia e custo de rodar um modelo no próprio PC — e a comparação com APIs.
 *
 * Velocidade (gerar texto é limitado pela memória): cada token lê todos os pesos uma vez.
 *   tokens/s ≈ 1 ÷ (bytes na GPU ÷ banda da GPU + bytes na RAM ÷ banda da RAM) × eficiência (~60%)
 * Leitura do prompt (prefill) é limitada por cálculo e é bem mais rápida: ~15× na GPU, ~3× na CPU.
 *
 * Energia: horas rodando × (potência da GPU gerando + resto do PC) → kWh × tarifa.
 * Custo local = energia + (opcional) amortização do hardware. Comparado ao custo das APIs para os
 * mesmos tokens, com o ponto de equilíbrio (em quantos meses a placa se paga).
 */
import type { ModelPrice } from "../types/models.ts";
import { computeCost } from "./cost.ts";
import type { Gpu, Hardware } from "./hardware.ts";
import { inferencePowerW } from "./hardware.ts";
import { estimateLocal, GIB, type KvPrecision, type LocalModel, type Quantization } from "./local.ts";

export const EFFICIENCY = 0.6;

export type RunVerdict = "great" | "good" | "slow" | "tooSlow" | "noFit";

export interface SpeedEstimate {
  /** Onde roda: tudo na GPU, dividido GPU+CPU, só CPU, ou não cabe nem na RAM. */
  placement: "gpu" | "partial" | "cpu" | "noFit";
  layersOnGpu: number;
  /** Tokens/s gerando a resposta. */
  decodeTps: number;
  /** Tokens/s lendo o prompt. */
  prefillTps: number;
  totalGib: number;
  verdict: RunVerdict;
  /** Banda usada nas contas (para mostrar). */
  gpuBandwidthGBs: number | null;
  ramBandwidthGBs: number;
}

export function verdictFor(placement: SpeedEstimate["placement"], tps: number): RunVerdict {
  if (placement === "noFit") return "noFit";
  if (tps >= 20) return "great";
  if (tps >= 8) return "good";
  if (tps >= 3) return "slow";
  return "tooSlow";
}

/** Estima onde e quão rápido o modelo roda no hardware. */
export function estimateSpeed(
  model: LocalModel,
  quant: Quantization,
  kv: KvPrecision,
  context: number,
  hw: Pick<Hardware, "ramGib" | "ramBandwidthGBs"> & { gpu: Gpu | null },
): SpeedEstimate {
  const gpu = hw.gpu && !(hw.gpu.integrated && hw.gpu.vendor !== "apple") ? hw.gpu : null;
  const est = estimateLocal({ model, quant, kv, context, ...(gpu && { vramGib: gpu.vramGib }) });
  const weightsGB = (est.weightsGib * GIB) / 1e9;
  const ramBw = hw.ramBandwidthGBs;
  const gpuBw = gpu?.bandwidthGBs ?? (gpu ? 300 : null);

  let placement: SpeedEstimate["placement"];
  let layersOnGpu = 0;
  let secPerToken: number;
  if (gpu && est.gpu?.fits) {
    placement = "gpu";
    layersOnGpu = model.layers;
    secPerToken = weightsGB / ((gpuBw as number) * EFFICIENCY);
  } else {
    // o que não cabe na GPU vai para a RAM; precisa caber (deixa ~2 GB para o sistema)
    layersOnGpu = gpu ? (est.gpu?.layersOnGpu ?? 0) : 0;
    const gpuShare = model.layers ? layersOnGpu / model.layers : 0;
    const ramNeedGib = est.totalGib * (1 - gpuShare);
    if (ramNeedGib > hw.ramGib - 2) {
      placement = "noFit";
      secPerToken = Number.POSITIVE_INFINITY;
    } else {
      placement = layersOnGpu > 0 ? "partial" : "cpu";
      const onGpu = weightsGB * gpuShare;
      const onRam = weightsGB - onGpu;
      secPerToken = (gpuBw ? onGpu / (gpuBw * EFFICIENCY) : 0) + onRam / (ramBw * EFFICIENCY);
    }
  }
  const decodeTps = Number.isFinite(secPerToken) && secPerToken > 0 ? 1 / secPerToken : 0;
  const prefillTps = decodeTps * (placement === "gpu" ? 15 : placement === "partial" ? 6 : 3);
  return {
    placement,
    layersOnGpu,
    decodeTps,
    prefillTps,
    totalGib: est.totalGib,
    verdict: verdictFor(placement, decodeTps),
    gpuBandwidthGBs: gpuBw,
    ramBandwidthGBs: ramBw,
  };
}

// ───────────── Local vs API ─────────────

export interface LocalCostInput {
  /** Tokens por mês. */
  inputTokens: number;
  outputTokens: number;
  /** Tarifa de energia em US$/kWh (já convertida). */
  tariffUsdKwh: number;
  /** Potência da GPU gerando texto (W). Sem GPU: só o resto do PC. */
  gpuW: number;
  /** Resto do PC (CPU, placa-mãe, monitor desligado) enquanto roda (W). */
  systemW: number;
  /** Custo do hardware (US$) e em quantos meses quer pagar. 0 = já tem / não conta. */
  hardwareUsd: number;
  amortMonths: number;
}

export interface LocalCostResult {
  hoursPerMonth: number;
  /** Cabe no mês? (mais de 720 h = o PC não dá conta sozinho) */
  keepsUp: boolean;
  kWh: number;
  energyUsd: number;
  amortUsd: number;
  totalUsd: number;
  per1MUsd: number;
  /** Energia por 1M de tokens gerados (kWh). */
  kWhPer1MOut: number;
  api: { model: ModelPrice; usd: number; savedUsd: number; breakEvenMonths: number | null }[];
}

export function localVsApi(speed: SpeedEstimate, i: LocalCostInput, apiModels: ModelPrice[]): LocalCostResult {
  const ok = speed.decodeTps > 0;
  const hours = ok ? (i.outputTokens / speed.decodeTps + i.inputTokens / speed.prefillTps) / 3600 : Number.POSITIVE_INFINITY;
  const watts = i.gpuW + i.systemW;
  const kWh = (hours * watts) / 1000;
  const energyUsd = kWh * i.tariffUsdKwh;
  const amortUsd = i.amortMonths > 0 ? i.hardwareUsd / i.amortMonths : 0;
  const totalUsd = energyUsd + amortUsd;
  const tokens = i.inputTokens + i.outputTokens;
  const outHours = ok ? i.outputTokens / speed.decodeTps / 3600 : Number.POSITIVE_INFINITY;
  return {
    hoursPerMonth: hours,
    keepsUp: hours <= 720,
    kWh,
    energyUsd,
    amortUsd,
    totalUsd,
    per1MUsd: tokens > 0 ? (totalUsd / tokens) * 1e6 : 0,
    kWhPer1MOut: i.outputTokens > 0 ? ((outHours * watts) / 1000 / i.outputTokens) * 1e6 : 0,
    api: apiModels
      .map((m) => {
        // tokens por mês divididos em chamadas de ~2.000 de entrada não mudam o preço por token; usa o total
        const c = computeCost(m, 0, 0);
        const usd = (i.inputTokens / 1e6) * c.price.input + (i.outputTokens / 1e6) * c.price.output;
        const monthlyGain = usd - energyUsd;
        return {
          model: m,
          usd,
          savedUsd: usd - totalUsd,
          breakEvenMonths: i.hardwareUsd > 0 && monthlyGain > 0 ? i.hardwareUsd / monthlyGain : null,
        };
      })
      .sort((a, b) => a.usd - b.usd),
  };
}

/** Potência para a conta: medida/limite da NVIDIA ou TDP da tabela (× 75%); sem GPU, 0. */
export const defaultGpuW = (g: Gpu | null): number => (g && !(g.integrated && g.vendor !== "apple") ? (inferencePowerW(g) ?? 150) : 0);
