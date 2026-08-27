// lib/providers.ts
// HTTP 助手 + 6 fetcher + 路由表。纯函数，零 pi 依赖。
export type Auth = { apiKey: string; baseUrl?: string };

export type RenderItem =
  | { kind: "text"; text: string }
  | { kind: "pct"; pct: number; metric?: string }
  | { kind: "balance"; value: number; currency: string; metric?: string }
  | { kind: "annotation"; text: string };

export type FetchPayload = {
  kind: "balance" | "quota";
  items: RenderItem[];
  metrics: Record<string, number>;
  currency?: string;
  // 各配额桶的绝对重置时间（Unix 毫秒）；未知或已过期时省略。
  resetAt?: Record<string, number>;
};

export type Fetcher = (auth: Auth, signal: AbortSignal) => Promise<FetchPayload>;

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 500;
const DEFAULT_BOOST_PERMILLE = 1000;

export class QuotaError extends Error {
  readonly category: string;
  readonly status?: number;

  constructor(category: string, status?: number) {
    super(category);
    this.name = "QuotaError";
    this.category = category;
    this.status = status !== undefined && Number.isFinite(status) ? status : undefined;
  }
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function requiredNumber(value: unknown, label: string): number {
  const n = finiteNumber(value);
  if (n === null) throw new Error(`invalid ${label}`);
  return n;
}

export function requiredPercent(value: unknown, label: string): number {
  const n = requiredNumber(value, label);
  if (n < 0 || n > 100) throw new Error(`invalid ${label}`);
  return n;
}


export function sanitizeMs(ms: unknown): number | null {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function formatRemaining(ms: unknown): string {
  const v = sanitizeMs(ms);
  if (v === null) return "";
  const totalMin = Math.floor(v / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

export function formatDays(ms: unknown): string {
  const v = sanitizeMs(ms);
  if (v === null) return "";
  const totalH = Math.floor(v / 3600000);
  const d = Math.floor(totalH / 24);
  const h = totalH % 24;
  return `${d}d${h}h`;
}

// 钳制到 [0,100]；NaN/非数字归零，避免异常值显示成低用量绿。
export function clampPct(pct: unknown): number {
  const n = Number(pct);
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

export function usedPct(limit: unknown, remaining: unknown): number {
  const lim = Number(limit ?? 0);
  const rem = Number(remaining ?? 0);
  if (!Number.isFinite(lim) || !Number.isFinite(rem) || lim <= 0) return 0;
  return clampPct(((lim - rem) / lim) * 100);
}


export function tier(prefix: string, label: string, pct: number, reset: string): RenderItem[] {
  return [
    { kind: "text", text: prefix + label },
    { kind: "pct", pct, metric: label.trim() },
    { kind: "text", text: reset ? ` (${reset})` : "" },
  ];
}

export function resetAtFromISO(iso: string): number | null {
  const resetAt = new Date(iso).getTime();
  return Number.isFinite(resetAt) && resetAt > Date.now() ? resetAt : null;
}

export function formatResetFromISO(iso: string): string {
  const resetAt = resetAtFromISO(iso);
  if (resetAt === null) return "";
  const diff = resetAt - Date.now();
  return diff >= 24 * 3600000 ? formatDays(diff) : formatRemaining(diff);
}

export function bearerHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

// 自定义 baseUrl 只允许 HTTPS；本机回环地址可使用 HTTP，避免把 API key 发往明文公网地址。
export function quotaUrl(customBaseUrl: string | undefined, defaultBaseUrl: string, path: string): string {
  const raw = customBaseUrl?.trim() || defaultBaseUrl;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new QuotaError("invalid_base_url");
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  const isLoopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopback)) {
    throw new QuotaError("insecure_base_url");
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new QuotaError("unsafe_base_url");
  }
  const basePath = parsed.pathname.replace(/\/+$/, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  return `${parsed.origin}${basePath}${suffix}`;
}

// 合并超时和外部 abort signal：任一触发都中断 fetch
export function makeSignal(timeoutMs: number, external: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), external]);
}

// fetch + status 校验 + body 解析；错误中不携带响应 body，避免敏感信息进入日志
export async function jsonFetch<T = any>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  const r = await fetch(url, {
    headers,
    signal: makeSignal(timeoutMs, signal),
    redirect: "error",
  });
  if (!r.ok) throw new QuotaError("http", r.status);
  const raw = await r.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    // 不把响应片段放进错误消息，避免服务端 body 被写入日志。
    throw new QuotaError("invalid_json");
  }
}

// 重试：500ms 间隔，最多 3 次，仅当外部 signal 未 abort 时继续
export async function fetchWithRetry<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < RETRY_COUNT; attempt++) {
    if (signal.aborted) throw new DOMException("aborted", "AbortError");
    try {
      return await fn();
    } catch (err) {
      if (signal.aborted) throw err instanceof Error ? err : new Error(String(err));
      lastErr = err;
      if (attempt < RETRY_COUNT - 1) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ---------- 快照差异 ----------

// ---------- provider 路由 ----------


// 表驱动：加新 provider 只改这张表
export const PROVIDER_FETCHERS: Record<string, Fetcher> = {
  minimax: fetchMinimaxGlobal,
  "minimax-cn": fetchMinimaxCn,
  moonshotai: fetchMoonshotGlobal,
  "moonshotai-cn": fetchMoonshotCn,
  "kimi-coding": fetchKimi,
  zai: fetchZhipuBalance,
  "zai-coding-cn": fetchZhipuCoding,
  deepseek: fetchDeepseek,
  openrouter: fetchOpenrouter,
  "opencode-go": fetchOpencodeGo,
};

// 这些 provider 没有 API-key 可查的配额接口，统一显示 --
// volcengine/doubao 的 GetCodingPlanUsage 需要 HMAC-SHA256 V4 签名，暂未支持
export const UN_PROVIDERS: ReadonlySet<string> = new Set([
  "volcengine",
  "doubao",
  "qwen-token-plan",
  "qwen-token-plan-cn",
  "qwen-token-plan-individual",
  "xiaomi",
  "xiaomi-token-plan-cn",
  "xiaomi-token-plan-ams",
  "xiaomi-token-plan-sgp",
]);

// 每个 provider 别名独立缓存。
export function normalizeProvider(provider: string | undefined): string | null {
  return provider ?? null;
}

// 未列入 fetcher 的 provider 显示 --。
export function isUnProvider(provider: string): boolean {
  return UN_PROVIDERS.has(provider) || !Object.hasOwn(PROVIDER_FETCHERS, provider);
}

export async function fetchProviderQuota(
  providerId: string,
  auth: Auth,
  signal: AbortSignal,
): Promise<FetchPayload | null> {
  // 兜底：未支持 provider 返回 null。
  if (isUnProvider(providerId)) return null;
  const fetcher = PROVIDER_FETCHERS[providerId];
  if (!fetcher) return null;
  return fetcher(auth, signal);
}

// ---------- 各 provider fetchers ----------

/** MiniMax: GET {base}/v1/token_plan/remains
 *  字段无官方 schema，按线上观察解析；weekly 字段缺失时按 1.0x 计算。 */
/** MiniMax Token Plan 共用实现：国际站 api.minimax.io / 国内站 api.minimaxi.com（订阅 key 与站点绑定）。 */
async function fetchMinimaxBase(auth: Auth, signal: AbortSignal, defaultBase: string): Promise<FetchPayload> {
  const url = quotaUrl(auth.baseUrl, defaultBase, "/v1/token_plan/remains");
  const j = await jsonFetch<any>(
    url,
    bearerHeaders(auth.apiKey, { "Content-Type": "application/json" }),
    15_000,
    signal,
  );
  const baseResp = j.base_resp;
  if (baseResp?.status_code !== undefined && baseResp.status_code !== 0) {
    throw new QuotaError("provider_rejected", finiteNumber(baseResp.status_code) ?? undefined);
  }
  const general = j.model_remains?.find((m: any) => m.model_name === "general");
  if (!general) throw new Error("general model not found");

  const fiveHourRemaining = requiredPercent(
    general.current_interval_remaining_percent,
    "MiniMax 5h remaining percent",
  );
  const fiveHourPct = 100 - fiveHourRemaining;
  const weeklyStatus = general.current_weekly_status;
  const weeklyRaw = general.current_weekly_remaining_percent;
  const weeklyRemaining = weeklyRaw === undefined || weeklyRaw === null
    ? null
    : requiredPercent(weeklyRaw, "MiniMax 7d remaining percent");
  // weekly boost 缺失按 1.0x 计算；负值拒绝整次更新。
  const weeklyBoostRaw = general.weekly_boost_permille;
  const weeklyBoostPermille = weeklyBoostRaw === undefined || weeklyBoostRaw === null
    ? DEFAULT_BOOST_PERMILLE
    : requiredNumber(weeklyBoostRaw, "MiniMax weekly boost");
  if (weeklyBoostPermille < 0) throw new Error("invalid MiniMax weekly boost");
  const weeklyBoost = weeklyBoostPermille / 1000;
  const weeklyPct = weeklyRemaining === null ? 0 : (100 - weeklyRemaining) * weeklyBoost;
  const fiveHourResetMs = sanitizeMs(general.remains_time);
  const weeklyResetMs = sanitizeMs(general.weekly_remains_time);
  const fiveHourReset = fiveHourResetMs === null ? "" : formatRemaining(fiveHourResetMs);
  const weeklyReset = weeklyResetMs === null ? "" : formatDays(weeklyResetMs);
  const resetAt: Record<string, number> = {};
  if (fiveHourResetMs !== null) resetAt["5h"] = Date.now() + fiveHourResetMs;

  const items = tier("Usage: ", "5h ", fiveHourPct, fiveHourReset);
  const metrics: Record<string, number> = { "5h": fiveHourPct };
  if (weeklyStatus === 1 && weeklyRemaining !== null) {
    items.push(...tier(" / ", "7d ", weeklyPct, weeklyReset));
    metrics["7d"] = weeklyPct;
    if (weeklyResetMs !== null) resetAt["7d"] = Date.now() + weeklyResetMs;
  }
  return {
    kind: "quota",
    items,
    metrics,
    resetAt: Object.keys(resetAt).length > 0 ? resetAt : undefined,
  };
}

/** MiniMax 国际站（minimax） */
export async function fetchMinimaxGlobal(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  return fetchMinimaxBase(auth, signal, "https://api.minimax.io");
}

/** MiniMax 国内站（minimax-cn） */
export async function fetchMinimaxCn(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  return fetchMinimaxBase(auth, signal, "https://api.minimaxi.com");
}

/** Kimi For Coding: GET {base}/v1/usages */
/** Moonshot/Kimi 开放平台余额共用实现：GET {base}/users/me/balance（按量付费）。
 *  国际站 api.moonshot.ai（USD）/ 国内站 api.moonshot.cn（CNY）。
 *  kimi-coding（Kimi For Coding 订阅）是桶型，走 fetchKimi 的 /v1/usages，不在此处。 */
async function fetchMoonshotBase(auth: Auth, signal: AbortSignal, defaultBase: string, currency: string): Promise<FetchPayload> {
  const url = quotaUrl(auth.baseUrl, defaultBase, "/users/me/balance");
  const j = await jsonFetch<any>(url, bearerHeaders(auth.apiKey), 10_000, signal);
  const data = j?.data ?? j;
  const balance = requiredNumber(data.available_balance ?? data.balance, "Moonshot available balance");
  return {
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: balance, currency, metric: "balance" },
    ],
    metrics: { balance },
    currency,
  };
}

/** Moonshot AI 国际站（moonshotai）：api.moonshot.ai，USD */
export async function fetchMoonshotGlobal(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  return fetchMoonshotBase(auth, signal, "https://api.moonshot.ai/v1", "$");
}

/** Moonshot AI 国内站（moonshotai-cn）：api.moonshot.cn，CNY */
export async function fetchMoonshotCn(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  return fetchMoonshotBase(auth, signal, "https://api.moonshot.cn/v1", "¥");
}

export async function fetchKimi(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const url = quotaUrl(auth.baseUrl, "https://api.kimi.com/coding", "/v1/usages");
  const j = await jsonFetch<any>(url, bearerHeaders(auth.apiKey), 10_000, signal);

  const items: RenderItem[] = [];
  const metrics: Record<string, number> = {};
  const resetAt: Record<string, number> = {};
  const fiveHour = j.limits?.[0]?.detail;
  if (fiveHour) {
    const limit = requiredNumber(fiveHour.limit, "Kimi 5h limit");
    const remaining = requiredNumber(fiveHour.remaining, "Kimi 5h remaining");
    if (limit <= 0) throw new Error("invalid Kimi 5h limit");
    const pct = usedPct(limit, remaining);
    items.push(...tier("Usage: ", "5h ", pct, formatResetFromISO(fiveHour.resetTime ?? "")));
    metrics["5h"] = pct;
    const fiveHourResetAt = resetAtFromISO(fiveHour.resetTime ?? "");
    if (fiveHourResetAt !== null) resetAt["5h"] = fiveHourResetAt;
  }
  const weekly = j.usage;
  if (weekly) {
    const limit = requiredNumber(weekly.limit, "Kimi 7d limit");
    const remaining = requiredNumber(weekly.remaining, "Kimi 7d remaining");
    if (limit <= 0) throw new Error("invalid Kimi 7d limit");
    const pct = usedPct(limit, remaining);
    items.push(...tier(" / ", "7d ", pct, formatResetFromISO(weekly.resetTime ?? "")));
    metrics["7d"] = pct;
    const weeklyResetAt = resetAtFromISO(weekly.resetTime ?? "");
    if (weeklyResetAt !== null) resetAt["7d"] = weeklyResetAt;
  }
  if (items.length === 0) throw new Error("no quota data");
  return {
    kind: "quota",
    items,
    metrics,
    resetAt: Object.keys(resetAt).length > 0 ? resetAt : undefined,
  };
}

/** Zhipu GLM: GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *  无 coding plan 时端点返回 500 / code≠0；用裸 API key 当 Authorization value（不加 Bearer） */
/** Zhipu GLM (zai): GET https://www.bigmodel.cn/api/biz/account/query-customer-account-report
 *  账户现金余额。zai 是余额型配置（pi auth 中选择 zai 时使用）。 */
export async function fetchZhipuBalance(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://www.bigmodel.cn/api/biz/account/query-customer-account-report",
    { Authorization: auth.apiKey },
    10_000,
    signal,
  );
  if (j.code !== undefined && j.code !== 0 && j.code !== 200) {
    throw new QuotaError("provider_rejected", finiteNumber(j.code) ?? undefined);
  }
  const data = j.data;
  if (!data || typeof data !== "object") throw new Error("no Zhipu account data");
  // availableBalance 是可用的现金余额（充值 − 已用 − 冻结）。
  const balance = requiredNumber(data.availableBalance ?? data.balance, "Zhipu available balance");
  return {
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: balance, currency: "¥", metric: "balance" },
    ],
    metrics: { balance },
    currency: "¥",
  };
}

/** Zhipu GLM Coding Plan (zai-coding-cn): GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *  Coding Plan 订阅配额。zai-coding-cn 是桶型配置（pi auth 中选择 zai-coding-cn 时使用）；
 *  非订阅账户该端点返回 code=500 "当前用户不存在coding plan"。 */
export async function fetchZhipuCoding(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    { Authorization: auth.apiKey },
    10_000,
    signal,
  );
  if (j.code !== undefined && j.code !== 0 && j.code !== 200) {
    throw new QuotaError("provider_rejected", finiteNumber(j.code) ?? undefined);
  }
  const limits: any[] = j.data?.limits ?? j.data ?? [];
  if (!Array.isArray(limits) || limits.length === 0) throw new Error("no limits");
  const l = limits[0];
  const used = requiredNumber(l.usage ?? l.currentUsage ?? l.used, "Zhipu usage");
  const total = requiredNumber(l.quota ?? l.total, "Zhipu quota");
  if (total <= 0) throw new Error("invalid Zhipu quota");
  const pct = clampPct((used / total) * 100);
  return {
    kind: "quota",
    items: [
      { kind: "text", text: `Usage: ${used}/${total} (` },
      { kind: "pct", pct, metric: "used" },
      { kind: "text", text: ")" },
    ],
    metrics: { used: pct },
  };
}

/** DeepSeek: GET https://api.deepseek.com/user/balance */
export async function fetchDeepseek(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://api.deepseek.com/user/balance",
    bearerHeaders(auth.apiKey),
    10_000,
    signal,
  );
  const info = j.balance_infos?.[0];
  if (!info) throw new Error("no balance");
  const total = requiredNumber(info.total_balance, "DeepSeek balance");
  // API 返回 currency（CNY/USD），按返回值映射符号
  const cur = info.currency;
  const currency = cur === "USD" ? "$" : cur === "CNY" ? "¥" : String(cur ?? "?");
  return {
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: total, currency, metric: "balance" },
    ],
    metrics: { balance: total },
    currency,
  };
}

/** OpenRouter: GET https://openrouter.ai/api/v1/credits */
export async function fetchOpenrouter(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://openrouter.ai/api/v1/credits",
    bearerHeaders(auth.apiKey),
    10_000,
    signal,
  );
  const credits = requiredNumber(j.data?.total_credits, "OpenRouter credits");
  const usage = requiredNumber(j.data?.total_usage, "OpenRouter usage");
  const remaining = credits - usage;
  return {
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: remaining, currency: "$", metric: "balance" },
    ],
    metrics: { balance: remaining },
    currency: "$",
  };
}

/** OpenCode Go: GET https://opencode.ai/zen/go/v1/usage
 *  接口返回 usage.rolling / weekly / monthly，字段为 status、percent、resetsAt；
 *  兼容 rollingUsage 等旧键名。 */
export async function fetchOpencodeGo(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const j = await jsonFetch<any>(
    "https://opencode.ai/zen/go/v1/usage",
    bearerHeaders(auth.apiKey),
    10_000,
    signal,
  );

  const usageRoot = j?.usage && typeof j.usage === "object" && !Array.isArray(j.usage)
    ? j.usage
    : j?.data && typeof j.data === "object" && !Array.isArray(j.data)
      ? j.data
      : j;
  const windows = [
    { keys: ["rolling", "rollingUsage"], label: "5h ", longReset: false },
    { keys: ["weekly", "weeklyUsage"], label: "7d ", longReset: true },
    { keys: ["monthly", "monthlyUsage"], label: "mo ", longReset: true },
  ] as const;
  const items: RenderItem[] = [];
  const metrics: Record<string, number> = {};
  const resetAtByMetric: Record<string, number> = {};

  for (const [index, window] of windows.entries()) {
    const usage = window.keys
      .map((key) => usageRoot?.[key])
      .find((value) => value && typeof value === "object" && !Array.isArray(value));
    if (!usage) {
      throw new Error(`missing OpenCode Go ${window.keys[0]}`);
    }
    const status = usage.status ?? "ok";
    if (status !== "ok" && status !== "rate-limited") {
      throw new Error(`invalid OpenCode Go ${window.keys[0]} status`);
    }
    const pct = requiredPercent(
      usage.usagePercent ?? usage.percent ?? usage.percentage,
      `OpenCode Go ${window.keys[0]} usage percent`,
    );
    const resetsAt = usage.resetsAt;
    let resetAt: number | null = null;
    let reset = "";
    if (typeof resetsAt === "string") {
      const resetTime = new Date(resetsAt).getTime();
      if (Number.isNaN(resetTime)) throw new Error(`invalid OpenCode Go ${window.keys[0]} reset`);
      const remainingMs = resetTime - Date.now();
      if (remainingMs > 0) {
        resetAt = resetTime;
        reset = window.longReset ? formatDays(remainingMs) : formatRemaining(remainingMs);
      }
    } else if (usage.resetInSec === undefined && usage.resetSeconds === undefined) {
      throw new Error(`missing OpenCode Go ${window.keys[0]} reset`);
    } else {
      const resetMs = requiredNumber(
        usage.resetInSec ?? usage.resetSeconds,
        `OpenCode Go ${window.keys[0]} reset`,
      ) * 1000;
      if (resetMs > 0) {
        resetAt = Date.now() + resetMs;
        reset = window.longReset ? formatDays(resetMs) : formatRemaining(resetMs);
      }
    }
    items.push(...tier(index === 0 ? "Usage: " : " / ", window.label, pct, reset));
    metrics[window.label.trim()] = pct;
    if (resetAt !== null) resetAtByMetric[window.label.trim()] = resetAt;
  }

  return {
    kind: "quota",
    items,
    metrics,
    resetAt: Object.keys(resetAtByMetric).length > 0 ? resetAtByMetric : undefined,
  };
}

