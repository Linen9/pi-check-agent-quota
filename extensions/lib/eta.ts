// lib/eta.ts
// ETA 余量预估：变点截断 + EWMA。纯函数，零 pi 依赖，可脱离 pi 环境单测。
// 算法依据见《pi-check-agent-quota v0.1.2 改造执行文档》4.2 节。

export const ETA_WINDOW = 10;            // 计算窗口（与 CONSUMPTION_CAPACITY 对齐）
export const ETA_MIN_SAMPLES = 4;        // 过滤后最少样本数，不足则不显示
const ETA_CHANGE_POINT = 3;              // 与窗口中位数相差 3 倍以上判定为节奏突变
const ETA_EWMA_ALPHA = 0.35;             // EWMA 权重：越新的样本权重越高
const ETA_MAX_GAP_MS = 15 * 60_000;      // 相邻记录间隔截断：超过 15 分钟只计 15 分钟（排除挂机）

/** 单轮消耗样本：delta 为【已取绝对值】的消耗量（% 或货币单位） */
export interface EtaSample {
  at: number;    // 毫秒时间戳
  delta: number; // 正数，单轮消耗
}

export interface EtaEstimate {
  rounds: number;    // 剩余量 ÷ 典型单轮消耗
  activeMs: number;  // rounds × 平均每轮活跃时长（间隔超 15 分钟按 15 分钟计）
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * 估计余量。
 * @param samples   当前 provider 的消耗样本（时间升序，delta 已取绝对值，已按指标过滤）
 * @param remaining 当前剩余量（配额为剩余 %，余额为剩余货币）
 * @returns 估计结果；样本不足/无消耗/剩余为空时返回 null（调用方隐藏整个 ETA 段）
 */
export function estimateEta(samples: EtaSample[], remaining: number): EtaEstimate | null {
  const recent = samples.slice(-ETA_WINDOW);
  if (recent.length < ETA_MIN_SAMPLES || remaining <= 0) return null;

  // 1. 变点截断：从最新一轮往前扩窗，遇到节奏突变则丢弃更早的样本
  const deltas = recent.map((s) => s.delta);
  const windowDeltas: number[] = [deltas[deltas.length - 1]];
  let windowStart = recent.length - 1;
  for (let i = deltas.length - 2; i >= 0; i--) {
    const med = median(windowDeltas);
    if (deltas[i] > ETA_CHANGE_POINT * med || deltas[i] < med / ETA_CHANGE_POINT) break;
    windowDeltas.unshift(deltas[i]);
    windowStart = i;
  }
  if (windowDeltas.length < 3) return null;

  // 2. 窗口内 EWMA：最新样本权重最高（alpha=0.35）
  let perRound = windowDeltas[0];
  for (let i = 1; i < windowDeltas.length; i++) {
    perRound = ETA_EWMA_ALPHA * windowDeltas[i] + (1 - ETA_EWMA_ALPHA) * perRound;
  }
  if (perRound <= 0) return null;

  const rounds = remaining / perRound;

  // 3. 活跃时长：只用截断后窗口内记录的时间戳；间隔超 15 分钟按 15 分钟计（排除挂机）
  const windowSamples = recent.slice(windowStart);
  let activeMs = 0;
  for (let i = 1; i < windowSamples.length; i++) {
    activeMs += Math.min(windowSamples[i].at - windowSamples[i - 1].at, ETA_MAX_GAP_MS);
  }
  const msPerRound = windowSamples.length > 1 ? activeMs / (windowSamples.length - 1) : 0;

  return { rounds, activeMs: rounds * msPerRound };
}
