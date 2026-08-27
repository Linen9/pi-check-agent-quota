// lib/eta.ts
// ETA 余量预估：分层混合模型 v2.0（频率加权）。纯函数，零 pi 依赖，可脱离 pi 环境单测。
// 算法：
// - 大额判定：x > 3×全窗口中位数（alpha=3.0）
// - 日常速率：median(日常样本)
// - 大额速率：mean(大额样本) × 出现频率（n_l/n）
// - 综合速率：eta = (n_d/n)·median(日常) + (n_l/n)·mean(大额)；无大额时退化为纯中位数

export const ETA_WINDOW = 10;            // 计算窗口（与 CONSUMPTION_CAPACITY 对齐）
export const ETA_MIN_SAMPLES = 5;        // 过滤后最少样本数，不足则不显示
export const ETA_LARGE_FACTOR = 3;       // 单轮消耗 > 3×窗口内中位数 视为偶发大额
export const ETA_MIN_DAILY = 3;          // 日常样本至少 3 个，否则中位数无意义，拒绝预测
export const ETA_MAX_ROUNDS = 365;       // 显示上限：超过则显示 "365+"，防止荒谬的几百轮
// 速率源优先级（取 provider 中最短、最可信的窗口）：
//   5h   短窗口，delta 即真实单轮消耗（首选）
//   used 累计型配额（只增不减），delta 即真实单轮消耗
//   7d   滑动窗口（delta 含滑出抵消），无更小窗口时的回退
//   mo   30 天滑动窗口，仅当只剩它时使用
export const RATE_METRIC_PRIORITY = ["5h", "used", "7d", "mo"] as const;
const ETA_MAX_GAP_MS = 15 * 60_000;      // 相邻记录间隔截断：超过 15 分钟只计 15 分钟（排除挂机）

/** 单轮消耗样本：delta 为【已取绝对值】的消耗量（% 或货币单位） */
export interface EtaSample {
  at: number;    // 毫秒时间戳
  delta: number; // 正数，单轮消耗
}

export interface EtaEstimate {
  rounds: number;    // 剩余量 ÷ 混合单轮消耗速率（真实值，未截断）
  activeMs: number;  // rounds × 中位每轮活跃时长（间隔超 15 分钟按 15 分钟计）
  zeroRounds?: number; // 窗口内 0 消耗轮数（>0 表示该桶近期无消耗，仅显示“近x轮0消耗”，不显示轮数 ETA）
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** 中位轮次间隔（毫秒）；相邻记录间隔超 15 分钟按 15 分钟计（排除挂机）。少于 2 条返回 0。 */
export function medianGapMs(samples: EtaSample[]): number {
  const recent = samples.slice(-ETA_WINDOW);
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = recent[i].at - recent[i - 1].at;
    if (!Number.isFinite(gap) || gap < 0) continue;
    gaps.push(Math.min(gap, ETA_MAX_GAP_MS));
  }
  return gaps.length > 0 ? median(gaps) : 0;
}

/**
 * 估计余量。
 * 注意：本函数是通用统计器，不区分指标语义。zeroRounds（近x轮0消耗）的可靠性
 * 取决于传入样本的来源：5h 短窗口 / used 累计型的 delta 是真实单轮消耗；
 * 7d/mo 滑动窗口的 delta 含滑出抵消，仅在没有更小窗口时作为回退
 * （见 RATE_METRIC_PRIORITY）。调用方负责按优先级挑选速率源。
 * @param samples   当前 provider 的消耗样本（时间升序，delta 已取绝对值，已按指标过滤）
 * @param remaining 当前剩余量（配额为剩余 %，余额为剩余货币）
 * @returns 估计结果；样本不足/剩余为空时返回 null（调用方隐藏整个 ETA 段）
 */
export function estimateEta(samples: EtaSample[], remaining: number): EtaEstimate | null {
  if (!Array.isArray(samples) || !Number.isFinite(remaining) || remaining <= 0) return null;

  const recent = samples.slice(-ETA_WINDOW);
  if (recent.length < ETA_MIN_SAMPLES) return null;
  for (let i = 0; i < recent.length; i++) {
    const sample = recent[i];
    if (
      !sample ||
      typeof sample !== "object" ||
      !Number.isFinite(sample.at) ||
      !Number.isFinite(sample.delta) ||
      sample.delta < 0 ||
      (i > 0 && sample.at < recent[i - 1].at)
    ) return null;
  }

  const deltas = recent.map((s) => s.delta);
  const overallMedian = median(deltas);
  // 该桶近期无日常消耗（中位数 ≤ 0）：不隐藏，记录 0 消耗轮数，调用方显示“近x轮0消耗”。
  if (!Number.isFinite(overallMedian) || overallMedian <= 0) {
    const zeroRounds = deltas.filter((v) => v === 0).length;
    return { rounds: 0, activeMs: 0, zeroRounds };
  }

  // 分桶：大额（> alpha×中位数）与日常
  const large = deltas.filter((v) => v > ETA_LARGE_FACTOR * overallMedian);
  const daily = deltas.filter((v) => v <= ETA_LARGE_FACTOR * overallMedian);
  const n = deltas.length;
  const nD = daily.length;
  const nL = large.length;

  // 日常样本不足 3 个时中位数无意义，拒绝预测。
  if (nD < ETA_MIN_DAILY) return null;

  // 频率加权综合速率：eta = (n_d/n)·median(日常) + (n_l/n)·mean(大额)
  const dailyRate = median(daily);
  const largeRate = nL > 0 ? mean(large) * (nL / n) : 0;
  const perRound = (nD / n) * dailyRate + largeRate;
  if (!Number.isFinite(perRound) || perRound <= 0) return null;

  const rounds = remaining / perRound;
  if (!Number.isFinite(rounds) || rounds <= 0) return null;

  // 活跃时长：相邻记录间隔的中位数（超 15 分钟按 15 分钟计，排除挂机）
  const gaps: number[] = [];
  for (let i = 1; i < recent.length; i++) {
    const gap = recent[i].at - recent[i - 1].at;
    if (!Number.isFinite(gap) || gap < 0) return null;
    gaps.push(Math.min(gap, ETA_MAX_GAP_MS));
  }
  const msPerRound = gaps.length > 0 ? median(gaps) : 0;
  const estimatedActiveMs = rounds * msPerRound;
  if (!Number.isFinite(estimatedActiveMs) || estimatedActiveMs < 0) return null;

  return { rounds, activeMs: estimatedActiveMs };
}
