export const ETA_WINDOW = 10;
export const ETA_MIN_SAMPLES = 5;
export const ETA_LARGE_FACTOR = 3;
export const ETA_MIN_DAILY = 3;
export const ETA_MAX_ROUNDS = 365;

export const RATE_METRIC_PRIORITY = ["5h", "used", "7d", "mo"] as const;
const ETA_MAX_GAP_MS = 15 * 60_000;

export interface EtaSample {
  at: number;
  delta: number;
}

export interface EtaEstimate {
  rounds: number;
  activeMs: number;
  zeroRounds?: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

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

  let zeroRounds = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const sample = recent[i];
    if (!sample || sample.delta !== 0) break;
    zeroRounds++;
  }
  if (zeroRounds >= ETA_MIN_SAMPLES) return { rounds: 0, activeMs: 0, zeroRounds };

  const large = deltas.filter((v) => v > ETA_LARGE_FACTOR * overallMedian);
  const daily = deltas.filter((v) => v <= ETA_LARGE_FACTOR * overallMedian);
  const n = deltas.length;
  const nD = daily.length;
  const nL = large.length;

  if (nD < ETA_MIN_DAILY) return null;

  const dailyRate = median(daily);
  const largeRate = nL > 0 ? mean(large) * (nL / n) : 0;
  const perRound = (nD / n) * dailyRate + largeRate;
  if (!Number.isFinite(perRound) || perRound <= 0) return null;

  const rounds = remaining / perRound;
  if (!Number.isFinite(rounds) || rounds <= 0) return null;

  const msPerRound = medianGapMs(recent);
  const estimatedActiveMs = rounds * msPerRound;
  if (!Number.isFinite(estimatedActiveMs) || estimatedActiveMs < 0) return null;

  return { rounds, activeMs: estimatedActiveMs };
}
