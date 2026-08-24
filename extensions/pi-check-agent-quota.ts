import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { chmodSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STATUS_KEY = "pi-quota";
const CMD_NAME = "checkaq";
const AQ10_CMD_NAME = "aq10";
const AQLANG_CMD_NAME = "aqlang";

const MISSING = "--";

// 余额 ≤ 此阈值（按各 provider 货币单位）变红；可用 PI_QUOTA_BALANCE_ALERT 覆盖
const BALANCE_ALERT = (() => {
  const raw = Number(process.env.PI_QUOTA_BALANCE_ALERT);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
})();

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 500;
const AGENT_START_REFRESH_AFTER_MS = 60 * 60_000;
const AGENT_START_FETCH_TIMEOUT_MS = 3_000;
const CHECKAQ_THROTTLE_MS = 1_000;
const CONSUMPTION_CAPACITY = 10;
const DISK_CACHE_DIR = join(homedir(), ".pi", "agent");
const DISK_CACHE_FILE = join(DISK_CACHE_DIR, "pi-check-agent-quota.json");
const DISK_CACHE_TEMP_FILE = `${DISK_CACHE_FILE}.tmp`;
const DISK_CACHE_MODE = 0o600;
const DISK_CACHE_DIR_MODE = 0o700;

// MiniMax weekly_boost_permille 缺失时按 1.0x（1000‰）计算，避免已用满显示成 0%
const DEFAULT_BOOST_PERMILLE = 1000;

// auth 形状；只有部分 provider 使用自定义 baseUrl
type Auth = { apiKey: string; baseUrl?: string };

class QuotaError extends Error {
  readonly category: string;
  readonly status?: number;

  constructor(category: string, status?: number) {
    super(category);
    this.name = "QuotaError";
    this.category = category;
    this.status = status !== undefined && Number.isFinite(status) ? status : undefined;
  }
}

// 日志只允许输出固定错误类别和 HTTP 状态，绝不输出响应 body、URL 或 Error 对象。
function safeErrorLabel(error: unknown): string {
  if (error instanceof QuotaError) {
    return error.status === undefined ? error.category : `${error.category} (${error.status})`;
  }
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return error instanceof Error ? "error" : "unknown";
}

// ---------- 时间格式化 ----------

function formatResetFromISO(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff) || diff <= 0) return "";
  return diff >= 24 * 3600000 ? formatDays(diff) : formatRemaining(diff);
}

// ---------- 渲染原语 ----------

type RenderItem =
  | { kind: "text"; text: string }
  | { kind: "pct"; pct: number; metric?: string }
  | { kind: "balance"; value: number; currency: string; metric?: string }
  | { kind: "annotation"; text: string };

type FetchPayload = {
  kind: "balance" | "quota";
  items: RenderItem[];
  metrics: Record<string, number>;
  currency?: string;
};

type QuotaSnapshot = FetchPayload & {
  provider: string;
  fetchedAt: number;
};

type ConsumptionRecord = {
  at: number;
  kind: "balance" | "quota";
  deltas: Record<string, number>;
  currency?: string;
};

type ProviderCache = {
  base_line?: QuotaSnapshot;
  trigger_line?: QuotaSnapshot;
  settled_line?: QuotaSnapshot;
  consumptions?: ConsumptionRecord[];
};

type ActiveRound = {
  provider: string;
  provider_changed: boolean;
};

type Language = "zh" | "en";

type Locale = {
  usage: string;
  balance: string;
  using: string;
  fetching: string;
  failed: string;
  changed: string;
  noConsumptionRecords: string;
  quotaUnavailable: string;
  noActiveProvider: string;
  aq10Rounds: (count: number) => string;
  languageChanged: (language: Language) => string;
  invalidLanguage: string;
  checkaqDescription: string;
  aq10Description: string;
  aqlangDescription: string;
};

const LOCALES: Record<Language, Locale> = {
  zh: {
    usage: "限额",
    balance: "余额",
    using: "使用中",
    fetching: "请求中",
    failed: "失败",
    changed: "变更",
    noConsumptionRecords: "暂无消耗记录",
    quotaUnavailable: "限额不可用",
    noActiveProvider: "当前没有 provider",
    aq10Rounds: (count) => `近${count}轮消耗`,
    languageChanged: () => "语言已切换为中文",
    invalidLanguage: "语言参数只支持 zh 或 en",
    checkaqDescription: "强制刷新限额并显示当前 provider 详情",
    aq10Description: "显示最近 10 轮对话消耗记录",
    aqlangDescription: "切换界面语言（zh/en）",
  },
  en: {
    usage: "Usage",
    balance: "Balance",
    using: "using",
    fetching: "Fetching",
    failed: "Failed",
    changed: "changed",
    noConsumptionRecords: "no consumption records",
    quotaUnavailable: "quota unavailable",
    noActiveProvider: "No active provider",
    aq10Rounds: (count) => `last ${count} rounds`,
    languageChanged: (language) => `Language switched to ${language === "zh" ? "Chinese" : "English"}`,
    invalidLanguage: "Language must be zh or en",
    checkaqDescription: "Force-refresh quota and show detailed widget for current provider",
    aq10Description: "Show the last 10 conversation consumption records",
    aqlangDescription: "Switch interface language (zh/en)",
  },
};

function normalizeLanguage(value: unknown): Language | null {
  return value === "zh" || value === "en" ? value : null;
}

type DiskCache = {
  version: 2;
  language?: Language;
  active_round?: ActiveRound;
  providers: Record<string, ProviderCache>;
};

type DiffResult =
  | { kind: "balance"; deltas: { balance: number }; currency: string }
  | { kind: "quota"; deltas: Record<string, number> }
  | { kind: "changed" };

type RefreshResult =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false };

type RefreshTrigger =
  | "session_start"
  | "model_select"
  | "checkaq"
  | "agent_settled"
  | "agent_start_stale";

function finiteNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string" || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function requiredNumber(value: unknown, label: string): number {
  const n = finiteNumber(value);
  if (n === null) throw new Error(`invalid ${label}`);
  return n;
}

function requiredPercent(value: unknown, label: string): number {
  const n = requiredNumber(value, label);
  if (n < 0 || n > 100) throw new Error(`invalid ${label}`);
  return n;
}

function validatePayload(payload: unknown): void {
  if (!payload || typeof payload !== "object") throw new Error("invalid quota data");
  const p = payload as Partial<FetchPayload>;
  if (p.kind !== "balance" && p.kind !== "quota") throw new Error("invalid quota kind");
  if (!Array.isArray(p.items) || p.items.length === 0) throw new Error("invalid quota items");
  const metrics = p.metrics;
  if (
    !metrics ||
    typeof metrics !== "object" ||
    Array.isArray(metrics) ||
    Object.keys(metrics).length === 0 ||
    Object.values(metrics).some((value) => !Number.isFinite(value))
  ) {
    throw new Error("invalid quota metrics");
  }
  for (const raw of p.items) {
    if (!raw || typeof raw !== "object") throw new Error("invalid quota item");
    const item = raw as Record<string, unknown>;
    switch (item.kind) {
      case "text":
      case "annotation":
        if (typeof item.text !== "string") throw new Error("invalid quota text");
        break;
      case "pct": {
        // 上限不校验：MiniMax weekly_boost 加成后可以超过 100，显示层用 clampPct 钳制。
        const pct = item.pct;
        if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0) {
          throw new Error("invalid quota percentage");
        }
        if (item.metric !== undefined && typeof item.metric !== "string") {
          throw new Error("invalid quota metric");
        }
        break;
      }
      case "balance": {
        const value = item.value;
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid balance");
        if (typeof item.currency !== "string" || item.currency === "") {
          throw new Error("invalid balance currency");
        }
        if (item.metric !== undefined && typeof item.metric !== "string") {
          throw new Error("invalid quota metric");
        }
        break;
      }
      default:
        throw new Error("invalid quota item");
    }
  }
  if (p.kind === "balance") {
    if (typeof p.currency !== "string" || p.currency === "") throw new Error("invalid balance currency");
    if (!Number.isFinite(metrics.balance)) throw new Error("invalid balance");
  }
}

function isValidSnapshot(value: unknown): value is QuotaSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<QuotaSnapshot>;
  if (typeof snapshot.provider !== "string" || !Number.isFinite(snapshot.fetchedAt)) return false;
  try {
    validatePayload(snapshot as FetchPayload);
    return true;
  } catch {
    return false;
  }
}

function isValidConsumptionRecord(value: unknown): value is ConsumptionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ConsumptionRecord>;
  if (!Number.isFinite(record.at)) return false;
  if (record.kind !== "balance" && record.kind !== "quota") return false;
  if (!record.deltas || typeof record.deltas !== "object" || Array.isArray(record.deltas)) return false;
  if (record.currency !== undefined && typeof record.currency !== "string") return false;
  const values = Object.values(record.deltas);
  return values.length > 0 && values.every((value) => Number.isFinite(value) && value < 0);
}

// 配额状态色使用固定的 24-bit ANSI 色值。
const QUOTA_COLORS = {
  green: "#1FA87A",
  yellow: "#F09A3E",
  red: "#EE7A5F",
  consumption: "#7A5FD0",
} as const;

function hexFg(hex: string, text: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

// 上色前由 clampPct 把 NaN/负值钳制到 [0,100]。
function pctColor(pct: number): string {
  const safe = clampPct(pct);
  const rounded = `${Math.round(safe)}%`;
  if (safe >= 80) return hexFg(QUOTA_COLORS.red, rounded);
  if (safe >= 41) return hexFg(QUOTA_COLORS.yellow, rounded);
  return hexFg(QUOTA_COLORS.green, rounded);
}

function balanceColor(value: number, currency: string, theme: Theme): string {
  const safe = Number.isFinite(value) && value !== 0 ? value : 0;
  if (safe <= BALANCE_ALERT) return hexFg(QUOTA_COLORS.red, `${currency}${safe.toFixed(2)}`);
  return theme.fg("dim", `${currency}${safe.toFixed(2)}`);
}

function formatItems(items: RenderItem[], theme: Theme): string {
  return items
    .map((it) => {
      if (it.kind === "text") return theme.fg("dim", localizeText(it.text));
      if (it.kind === "pct") return pctColor(it.pct);
      if (it.kind === "balance") return balanceColor(it.value, it.currency, theme);
      return hexFg(QUOTA_COLORS.consumption, localizeText(it.text));
    })
    .join("");
}

function localizeText(text: string): string {
  const locale = LOCALES[currentLanguage];
  const prefixes: Array<[string, string]> = [
    ["Usage: ", `${locale.usage}: `],
    ["限额: ", `${locale.usage}: `],
    ["Balance: ", `${locale.balance}: `],
    ["余额: ", `${locale.balance}: `],
  ];
  for (const [source, replacement] of prefixes) {
    if (text.startsWith(source)) return replacement + text.slice(source.length);
  }

  const statuses: Array<[string, string]> = [
    [" (using)", ` (${locale.using})`],
    [" (使用中)", ` (${locale.using})`],
    [" (Fetching)", ` (${locale.fetching})`],
    [" (请求中)", ` (${locale.fetching})`],
    ["(Fetching)", `(${locale.fetching})`],
    ["(请求中)", `(${locale.fetching})`],
    [" (Failed)", ` (${locale.failed})`],
    [" (失败)", ` (${locale.failed})`],
    ["(Failed)", `(${locale.failed})`],
    ["(失败)", `(${locale.failed})`],
    [" (changed)", ` (${locale.changed})`],
    [" (变更)", ` (${locale.changed})`],
  ];
  for (const [source, replacement] of statuses) {
    if (text === source) return replacement;
  }
  return text;
}

// 把差值注释注入到 pct / balance 项之后。
function annotateItems(
  items: RenderItem[],
  annotationFor: (item: Extract<RenderItem, { kind: "pct" | "balance" }>) => string | undefined,
): RenderItem[] {
  const out: RenderItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    out.push(item);
    if (item.kind !== "pct" && item.kind !== "balance") continue;
    const annotation = annotationFor(item);
    if (!annotation) continue;
    out.push({ kind: "annotation", text: ` ${annotation}` });
  }
  return out;
}

// 桶型配额：`Usage: 5h X% (4h52m)` / ` / 7d X% (4d23h)`
// prefix="Usage: " 给首桶；prefix=" / " 给后续桶（自动拼上 "7d " 这种 label）
function tier(prefix: string, label: string, pct: number, reset: string): RenderItem[] {
  return [
    { kind: "text", text: prefix + label },
    { kind: "pct", pct, metric: label.trim() },
    { kind: "text", text: reset ? ` (${reset})` : "" },
  ];
}

function missingItems(): RenderItem[] {
  return [{ kind: "text", text: MISSING }];
}

function emptyItems(): RenderItem[] {
  return [];
}

// ---------- HTTP 助手 ----------

function bearerHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

// 自定义 baseUrl 只允许 HTTPS；本机回环地址可使用 HTTP，避免把 API key 发往明文公网地址。
function quotaUrl(customBaseUrl: string | undefined, defaultBaseUrl: string, path: string): string {
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
function makeSignal(timeoutMs: number, external: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), external]);
}

// fetch + status 校验 + body 解析；错误中不携带响应 body，避免敏感信息进入日志
async function jsonFetch<T = any>(
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
async function fetchWithRetry<T>(signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
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

function diffSnapshot(before: QuotaSnapshot, after: QuotaSnapshot): DiffResult {
  if (!isValidSnapshot(before) || !isValidSnapshot(after)) return { kind: "changed" };
  if (before.kind !== after.kind) return { kind: "changed" };
  if (before.kind === "balance" && after.kind === "balance") {
    if (before.currency !== after.currency) return { kind: "changed" };
    return {
      kind: "balance",
      deltas: { balance: after.metrics.balance - before.metrics.balance },
      currency: after.currency!,
    };
  }
  // 桶集合不一致时不计算差值。
  const beforeKeys = Object.keys(before.metrics);
  const afterKeys = Object.keys(after.metrics);
  if (beforeKeys.length !== afterKeys.length || beforeKeys.some((key) => !Object.hasOwn(after.metrics, key))) {
    return { kind: "changed" };
  }
  const deltas: Record<string, number> = {};
  for (const key of beforeKeys) {
    deltas[key] = after.metrics[key] - before.metrics[key];
  }
  return { kind: "quota", deltas };
}

function diffToConsumption(diff: DiffResult): Record<string, number> | null {
  const out: Record<string, number> = {};
  if (diff.kind === "balance") {
    // 余额减少才是消耗。
    const value = diff.deltas.balance;
    if (Number.isFinite(value) && value < 0) out.balance = value;
  } else if (diff.kind === "quota") {
    // 使用率增加代表消耗，反转为负值保存。
    for (const [key, value] of Object.entries(diff.deltas)) {
      if (Number.isFinite(value) && value > 0) out[key] = -value;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function appendConsumption(
  records: ConsumptionRecord[] | undefined,
  record: ConsumptionRecord,
): ConsumptionRecord[] {
  const list = records ?? [];
  return [...list, record].slice(-CONSUMPTION_CAPACITY);
}

// ---------- Component 最小实现 ----------
// 自实现 Component：只 render() 和 invalidate()。

interface Component {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

class QuotaComponent implements Component {
  private cache: { width: number; lines: string[] } | null = null;
  private items: RenderItem[];
  private readonly themeRef: () => Theme;
  private readonly requestRender: () => void;
  private readonly onDispose: (component: QuotaComponent) => void;
  private disposed = false;

  constructor(
    items: RenderItem[],
    themeRef: () => Theme,
    requestRender: () => void,
    onDispose: (component: QuotaComponent) => void,
  ) {
    this.items = items;
    this.themeRef = themeRef;
    this.requestRender = requestRender;
    this.onDispose = onDispose;
  }

  update(items: RenderItem[]): void {
    if (this.disposed || renderItemsEqual(this.items, items)) return;
    this.items = items;
    this.invalidate();
    this.requestRender();
  }

  render(width: number): string[] {
    if (this.cache && this.cache.width === width) return this.cache.lines;
    const text = formatItems(this.items, this.themeRef());
    const lines = text ? [truncateAnsi(text, width)] : [];
    this.cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    this.cache = null;
  }

  refresh(): void {
    if (this.disposed) return;
    this.invalidate();
    this.requestRender();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cache = null;
    this.onDispose(this);
  }
}

function renderItemsEqual(a: RenderItem[], b: RenderItem[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, index) => {
    const other = b[index];
    return item.kind === other.kind &&
      (item.kind === "text" && other.kind === "text"
        ? item.text === other.text
        : item.kind === "pct" && other.kind === "pct"
          ? item.pct === other.pct && item.metric === other.metric
          : item.kind === "balance" && other.kind === "balance"
            ? item.value === other.value && item.currency === other.currency && item.metric === other.metric
            : item.kind === "annotation" && other.kind === "annotation"
              ? item.text === other.text
              : false);
  });
}

// ---------- module-level 状态 ----------

let cachedItems: RenderItem[] = emptyItems();
// 默认中文；session_start 时从磁盘恢复，不同则重注册命令描述。
let currentLanguage: Language = "zh";
let currentProvider: string | null = null;
let currentStatus: "ok" | "fetching" | "failed" | "un-provider" = "ok";
let lastDiff: DiffResult | null = null;
let registeredPi: ExtensionAPI | null = null;

type RuntimeProviderState = {
  trigger_line?: QuotaSnapshot;
  settled_line?: QuotaSnapshot;
  consumptions?: ConsumptionRecord[];
};

// 每个 provider 的运行时状态。
const providerState = new Map<string, RuntimeProviderState>();

// 当前对话轮次基准
let baseRound: { provider: string; snapshot: QuotaSnapshot } | null = null;
// 当前轮次是否跨过 provider；跨过后本轮结算显示 changed
let roundProviderChanged = false;

// 当前进行中的 fetch。每个请求有独立身份，晚到结果不得影响其他请求。
type InflightRequest = {
  provider: string;
  controller: AbortController;
  done: Promise<RefreshResult>;
  resolveDone: (result: RefreshResult) => void;
};
let inflightRequest: InflightRequest | null = null;
let isShuttingDown = false;

// /checkaq 最近一次请求状态（按 provider 计）。
let lastCheckaqAt = 0;
let lastCheckaqProvider: string | null = null;

// ---------- provider 路由 ----------

type Fetcher = (auth: Auth, signal: AbortSignal) => Promise<FetchPayload>;

// 表驱动：加新 provider 只改这张表
const PROVIDER_FETCHERS: Record<string, Fetcher> = {
  minimax: fetchMinimax,
  "minimax-cn": fetchMinimax,
  moonshotai: fetchKimi,
  "moonshotai-cn": fetchKimi,
  "kimi-coding": fetchKimi,
  zai: fetchZhipu,
  "zai-coding-cn": fetchZhipu,
  deepseek: fetchDeepseek,
  openrouter: fetchOpenrouter,
  "opencode-go": fetchOpencodeGo,
};

// 这些 provider 没有 API-key 可查的配额接口，统一显示 --
// volcengine/doubao 的 GetCodingPlanUsage 需要 HMAC-SHA256 V4 签名，暂未支持
const UN_PROVIDERS: ReadonlySet<string> = new Set([
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
function normalizeProvider(provider: string | undefined): string | null {
  return provider ?? null;
}

// 未列入 fetcher 的 provider 显示 --。
function isUnProvider(provider: string): boolean {
  return UN_PROVIDERS.has(provider) || !Object.hasOwn(PROVIDER_FETCHERS, provider);
}

async function fetchProviderQuota(
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
async function fetchMinimax(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const url = quotaUrl(auth.baseUrl, "https://www.minimaxi.com", "/v1/token_plan/remains");
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
  const fiveHourReset = formatRemaining(general.remains_time);
  const weeklyReset = formatDays(general.weekly_remains_time);

  const items = tier("Usage: ", "5h ", fiveHourPct, fiveHourReset);
  const metrics: Record<string, number> = { "5h": fiveHourPct };
  if (weeklyStatus === 1 && weeklyRemaining !== null) {
    items.push(...tier(" / ", "7d ", weeklyPct, weeklyReset));
    metrics["7d"] = weeklyPct;
  }
  return { kind: "quota", items, metrics };
}

/** Kimi For Coding: GET {base}/v1/usages */
async function fetchKimi(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
  const url = quotaUrl(auth.baseUrl, "https://api.kimi.com/coding", "/v1/usages");
  const j = await jsonFetch<any>(url, bearerHeaders(auth.apiKey), 10_000, signal);

  const items: RenderItem[] = [];
  const metrics: Record<string, number> = {};
  const fiveHour = j.limits?.[0]?.detail;
  if (fiveHour) {
    const limit = requiredNumber(fiveHour.limit, "Kimi 5h limit");
    const remaining = requiredNumber(fiveHour.remaining, "Kimi 5h remaining");
    if (limit <= 0) throw new Error("invalid Kimi 5h limit");
    const pct = usedPct(limit, remaining);
    items.push(...tier("Usage: ", "5h ", pct, formatResetFromISO(fiveHour.resetTime ?? "")));
    metrics["5h"] = pct;
  }
  const weekly = j.usage;
  if (weekly) {
    const limit = requiredNumber(weekly.limit, "Kimi 7d limit");
    const remaining = requiredNumber(weekly.remaining, "Kimi 7d remaining");
    if (limit <= 0) throw new Error("invalid Kimi 7d limit");
    const pct = usedPct(limit, remaining);
    items.push(...tier(" / ", "7d ", pct, formatResetFromISO(weekly.resetTime ?? "")));
    metrics["7d"] = pct;
  }
  if (items.length === 0) throw new Error("no quota data");
  return { kind: "quota", items, metrics };
}

/** Zhipu GLM: GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *  无 coding plan 时端点返回 500 / code≠0；用裸 API key 当 Authorization value（不加 Bearer） */
async function fetchZhipu(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
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
async function fetchDeepseek(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
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
async function fetchOpenrouter(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
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
async function fetchOpencodeGo(auth: Auth, signal: AbortSignal): Promise<FetchPayload> {
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
    if (typeof resetsAt === "string") {
      const resetTime = new Date(resetsAt).getTime();
      if (Number.isNaN(resetTime)) throw new Error(`invalid OpenCode Go ${window.keys[0]} reset`);
    } else if (usage.resetInSec === undefined && usage.resetSeconds === undefined) {
      throw new Error(`missing OpenCode Go ${window.keys[0]} reset`);
    }
    const reset = typeof resetsAt === "string"
      ? formatResetFromISO(resetsAt)
      : window.longReset
        ? formatDays(requiredNumber(usage.resetInSec ?? usage.resetSeconds, `OpenCode Go ${window.keys[0]} reset`) * 1000)
        : formatRemaining(requiredNumber(usage.resetInSec ?? usage.resetSeconds, `OpenCode Go ${window.keys[0]} reset`) * 1000);
    items.push(...tier(index === 0 ? "Usage: " : " / ", window.label, pct, reset));
    metrics[window.label.trim()] = pct;
  }

  return { kind: "quota", items, metrics };
}

// ---------- 磁盘缓存 ----------

function readDiskCacheSync(): DiskCache | null {
  try {
    const raw = readFileSync(DISK_CACHE_FILE, "utf8");
    // 读取时顺带收紧文件权限。
    try {
      chmodSync(DISK_CACHE_FILE, DISK_CACHE_MODE);
    } catch {
      // 权限修复失败不影响读取。
    }
    const j = JSON.parse(raw) as DiskCache;
    if (
      !j ||
      typeof j !== "object" ||
      j.version !== 2 ||
      !j.providers ||
      typeof j.providers !== "object" ||
      Array.isArray(j.providers)
    ) return null;
    return j;
  } catch {
    return null;
  }
}

// 该 provider 最新的成功快照。
function latestLineSnapshot(provider: string): QuotaSnapshot | null {
  const state = providerState.get(provider);
  const trigger = state?.trigger_line;
  const settled = state?.settled_line;
  if (!trigger) return settled ?? null;
  if (!settled) return trigger;
  return trigger.fetchedAt >= settled.fetchedAt ? trigger : settled;
}

function latestCachedSnapshot(provider: string): QuotaSnapshot | null {
  const snapshot = latestLineSnapshot(provider);
  return snapshot && isValidSnapshot(snapshot) ? snapshot : null;
}

let diskWriteQueue: Promise<void> = Promise.resolve();
let pendingDiskWrite: string | null = null;
let diskWriteScheduled = false;

function writeDiskCacheAsync(): void {
  if (isShuttingDown) return;
  const providerIds = new Set<string>(providerState.keys());
  if (baseRound) providerIds.add(baseRound.provider);

  const providers: Record<string, ProviderCache> = {};
  for (const provider of providerIds) {
    if (isUnProvider(provider)) continue;
    const entry: ProviderCache = {};
    const state = providerState.get(provider);
    if (state?.trigger_line) entry.trigger_line = state.trigger_line;
    if (state?.settled_line) entry.settled_line = state.settled_line;
    if (baseRound?.provider === provider) {
      entry.base_line = baseRound.snapshot;
    }
    if (state?.consumptions) entry.consumptions = state.consumptions;
    if (Object.keys(entry).length > 0) providers[provider] = entry;
  }
  const active_round: ActiveRound | undefined = baseRound
    ? { provider: baseRound.provider, provider_changed: roundProviderChanged }
    : undefined;
  pendingDiskWrite = JSON.stringify({
    version: 2,
    language: currentLanguage,
    active_round,
    providers,
  } satisfies DiskCache);
  if (diskWriteScheduled) return;
  diskWriteScheduled = true;
  diskWriteQueue = diskWriteQueue
    .then(async () => {
      diskWriteScheduled = false;
      while (pendingDiskWrite !== null) {
        const data = pendingDiskWrite;
        pendingDiskWrite = null;
        await writeDiskFile(data);
      }
    })
    .catch(() => {
      // 保存失败不影响 UI。
    });
}

async function writeDiskFile(data: string): Promise<void> {
  await mkdir(DISK_CACHE_DIR, { recursive: true, mode: DISK_CACHE_DIR_MODE });
  await writeFile(DISK_CACHE_TEMP_FILE, data, { encoding: "utf8", mode: DISK_CACHE_MODE });
  await chmod(DISK_CACHE_TEMP_FILE, DISK_CACHE_MODE);
  await rename(DISK_CACHE_TEMP_FILE, DISK_CACHE_FILE);
  await chmod(DISK_CACHE_FILE, DISK_CACHE_MODE);
}

function updateSuccessfulLine(provider: string, snapshot: QuotaSnapshot, trigger: RefreshTrigger): void {
  const state = providerState.get(provider) ?? {};
  if (trigger === "agent_settled") {
    state.settled_line = snapshot;
  } else {
    state.trigger_line = snapshot;
  }
  providerState.set(provider, state);
}

function loadFromDisk(): DiskCache | null {
  const disk = readDiskCacheSync();
  if (!disk || Array.isArray(disk.providers)) {
    currentLanguage = "zh";
    return null;
  }
  currentLanguage = normalizeLanguage(disk.language) ?? "zh";

  // 校验通过后再替换内存状态。
  providerState.clear();

  for (const [provider, rawEntry] of Object.entries(disk.providers)) {
    // 未支持 provider 的缓存不加载。
    if (isUnProvider(provider)) continue;
    if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) continue;
    const entry = rawEntry as ProviderCache;

    const state: RuntimeProviderState = {};
    if (entry.trigger_line) {
      const trigger = { ...entry.trigger_line, provider };
      if (isValidSnapshot(trigger)) state.trigger_line = trigger;
    }
    if (entry.settled_line) {
      const settled = { ...entry.settled_line, provider };
      if (isValidSnapshot(settled)) state.settled_line = settled;
    }
    if (Array.isArray(entry.consumptions)) {
      const records = entry.consumptions.filter(isValidConsumptionRecord).slice(-CONSUMPTION_CAPACITY);
      if (records.length > 0) state.consumptions = records;
    }
    if (state.trigger_line || state.settled_line || state.consumptions) {
      providerState.set(provider, state);
    }
  }
  return disk;
}

// 缓存是否在新鲜窗口内。
function isSnapshotFresh(snapshot: QuotaSnapshot | null): boolean {
  return !!snapshot && Date.now() - snapshot.fetchedAt <= AGENT_START_REFRESH_AFTER_MS;
}

// ---------- 显示更新 ----------

// 请求状态标注：独立显示不带前导空格，拼接显示带前导空格；无请求状态返回 null。
function statusAnnotation(leadingSpace: boolean): RenderItem | null {
  const prefix = leadingSpace ? " " : "";
  if (currentStatus === "fetching") return { kind: "annotation", text: `${prefix}(Fetching)` };
  if (currentStatus === "failed") return { kind: "annotation", text: `${prefix}(Failed)` };
  return null;
}

function renderSnapshotWithDiff(
  snapshot: QuotaSnapshot,
  diff: DiffResult | null,
  isIdle: boolean,
): RenderItem[] {
  let items: RenderItem[] = snapshot.items.map((it) => ({ ...it }));
  if (diff && diff.kind !== "changed") {
    const annotationFor = (item: Extract<RenderItem, { kind: "pct" | "balance" }>): string | undefined => {
      const metric = item.metric;
      if (!metric) return undefined;
      let delta: number | undefined;
      if (diff.kind === "balance") {
        if (metric !== "balance") return undefined;
        delta = diff.deltas.balance;
      } else {
        delta = diff.deltas[metric];
      }
      if (delta === undefined) return undefined;
      if (item.kind === "pct") {
        // 桶型（已使用百分比）：增加 = 消耗 → 负号；减少 = 恢复 → 正号；零值无符号
        const rounded = Math.round(delta);
        if (rounded === 0) return "(0%)";
        const sign = rounded > 0 ? "-" : "+";
        return `(${sign}${Math.abs(rounded)}%)`;
      }
      // balance：余额减少 = 消耗 → 负号；增加 = 充值 → 正号；零值无符号
      const cur = snapshot.currency ?? "";
      const rounded = Number(delta.toFixed(2));
      if (rounded === 0) return `(${cur}0.00)`;
      const sign = rounded > 0 ? "+" : "";
      return `(${sign}${cur}${rounded.toFixed(2)})`;
    };
    items = annotateItems(items, annotationFor);
  }

  if (!isIdle) {
    items.push({ kind: "annotation", text: " (using)" });
  } else {
    // 请求状态优先显示。
    if (diff?.kind === "changed") {
      items.push({ kind: "annotation", text: " (changed)" });
    }
    const status = statusAnnotation(true);
    if (status) items.push(status);
  }
  return items;
}

let activeWidget: QuotaComponent | null = null;

function widgetFactory(tui: { requestRender?: () => void } | null | undefined, theme: Theme): Component {
  const component = new QuotaComponent(
    cachedItems,
    () => theme,
    () => tui?.requestRender?.(),
    (disposedComponent) => {
      if (activeWidget === disposedComponent) activeWidget = null;
    },
  );
  activeWidget = component;
  return component;
}

function renderWidget(ctx: ExtensionContext): void {
  if (activeWidget) {
    activeWidget.update(cachedItems);
    return;
  }
  ctx.ui.setWidget(STATUS_KEY, widgetFactory, { placement: "belowEditor" });
}

// 同步刷新 widget 内容：在快照/差值/状态变化后调用。
function refreshWidget(ctx: ExtensionContext): void {
  if (!currentProvider) {
    cachedItems = emptyItems();
    renderWidget(ctx);
    return;
  }
  if (isUnProvider(currentProvider)) {
    showMissing(ctx);
    return;
  }
  const snap = latestLineSnapshot(currentProvider);
  if (!snap) {
    // 没有快照时按当前状态显示 请求中 / 失败 / 空。
    const status = statusAnnotation(false);
    cachedItems = status ? [status] : emptyItems();
    renderWidget(ctx);
    return;
  }
  const diff = lastDiff?.kind === "changed" ? { kind: "changed" } as DiffResult : lastDiff;
  cachedItems = renderSnapshotWithDiff(snap, diff, ctx.isIdle());
  renderWidget(ctx);
}

// ---------- 抓取与状态机 ----------

// 未支持/无 key 的 provider 显示 --。
function showMissing(ctx: ExtensionContext): void {
  cachedItems = missingItems();
  renderWidget(ctx);
}

// 未支持 provider 同样按跨 provider 处理。
function markUnProviderChanged(providerId: string): void {
  if (baseRound && baseRound.provider !== providerId) {
    roundProviderChanged = true;
    lastDiff = { kind: "changed" };
  } else {
    lastDiff = null;
  }
}

// 超时返回 undefined（调用方按失败处理）；原请求不取消，继续后台完成。
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const safe = promise.then(
    (value) => value,
    () => undefined, // 原请求拒绝按失败处理，同时避免超时后产生未处理拒绝
  );
  try {
    return await Promise.race([
      safe,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// 通用抓取入口。
async function refreshQuota(ctx: ExtensionContext, trigger: RefreshTrigger): Promise<RefreshResult> {
  if (isShuttingDown) return { ok: false };
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) {
    currentProvider = null;
    currentStatus = "ok";
    lastDiff = null;
    refreshWidget(ctx);
    return { ok: false };
  }

  // 未支持 provider 跳过查询，只显示 --。
  if (isUnProvider(providerId)) {
    currentProvider = providerId;
    currentStatus = "un-provider";
    // 未支持 provider 也算跨 provider，不能清掉本轮 changed 标记。
    markUnProviderChanged(providerId);
    providerState.delete(providerId);
    showMissing(ctx);
    return { ok: false };
  }

  // 同 provider 已有请求时直接等待。
  const existingBeforeAuth = inflightRequest;
  if (existingBeforeAuth?.provider === providerId) {
    return await existingBeforeAuth.done;
  }

  let resolved: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>;
  try {
    resolved = await ctx.modelRegistry.getProviderAuth(providerId);
  } catch (err) {
    // 认证解析失败也属于当前查询失败，但不把错误详情（可能含敏感信息）写入日志。
    if (currentProvider === providerId) {
      console.error(`[pi-check-agent-quota] ${providerId} auth resolution failed: ${safeErrorLabel(err)}`);
      currentStatus = "failed";
      refreshWidget(ctx);
    }
    return { ok: false };
  }
  const auth = resolved?.auth;
  // auth 解析期间可能已经切换 provider 或开始卸载；旧触发不得重新启动请求。
  if (isShuttingDown || currentProvider !== providerId) return { ok: false };
  currentStatus = "fetching";
  refreshWidget(ctx);
  // 没有 API key：显示 --，保留跨 provider 标记和本轮基准。
  if (!auth?.apiKey) {
    currentProvider = providerId;
    currentStatus = "ok";
    showMissing(ctx);
    return { ok: false };
  }

  // auth 解析期间可能已有同 provider 请求开始，再次检查避免重复发起。
  const existingAfterAuth = inflightRequest;
  if (existingAfterAuth?.provider === providerId) {
    return await existingAfterAuth.done;
  }

  // 切换 provider 时取消旧请求；其结束不影响新请求。
  if (existingAfterAuth) {
    existingAfterAuth.controller.abort();
  }

  const controller = new AbortController();
  let resolveDone!: (result: RefreshResult) => void;
  const done = new Promise<RefreshResult>((resolve) => {
    resolveDone = resolve;
  });
  const request: InflightRequest = {
    provider: providerId,
    controller,
    done,
    resolveDone,
  };
  inflightRequest = request;
  // currentStatus 与 widget 已在 auth 解析后置为 fetching。

  let result: RefreshResult = { ok: false };
  try {
    const payload = await fetchWithRetry(controller.signal, () =>
      fetchProviderQuota(providerId, auth, controller.signal),
    );
    if (payload === null) {
      currentStatus = "un-provider";
      result = { ok: false };
      return result;
    }
    validatePayload(payload);

    // 晚到的结果不得覆盖新 provider 的状态。
    if (inflightRequest === request && currentProvider === providerId) {
      const snapshot: QuotaSnapshot = {
        provider: providerId,
        fetchedAt: Date.now(),
        ...payload,
      };
      updateSuccessfulLine(providerId, snapshot, trigger);
      currentStatus = "ok";
      if (trigger !== "agent_settled") writeDiskCacheAsync();
      result = { ok: true, snapshot };
    }
  } catch (err) {
    const aborted = controller.signal.aborted || (err as Error)?.name === "AbortError";
    if (!aborted && inflightRequest === request && currentProvider === providerId) {
      console.error(`[pi-check-agent-quota] ${providerId} quota fetch failed: ${safeErrorLabel(err)}`);
    }
    if (inflightRequest === request && currentProvider === providerId) {
      currentStatus = "failed";
    }
  } finally {
    const isCurrent = inflightRequest === request;
    const isCurrentProvider = currentProvider === providerId;
    if (isCurrent) {
      inflightRequest = null;
    }
    // 唤醒等待该请求的调用方。
    request.resolveDone(result);
    // provider 已切换时，晚到的结果不刷新当前 widget。
    if (isCurrent && isCurrentProvider) {
      refreshWidget(ctx);
    }
  }
  return result;
}

// agent_start：固定本轮基准；缓存超过 1 小时时抓取。
async function handleAgentStart(ctx: ExtensionContext): Promise<void> {
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) {
    baseRound = null;
    roundProviderChanged = false;
    lastDiff = null;
    return;
  }
  currentProvider = providerId;
  if (isUnProvider(providerId)) {
    baseRound = null;
    roundProviderChanged = false;
    lastDiff = null;
    currentStatus = "un-provider";
    showMissing(ctx);
    return;
  }
  // 新轮次开始时重置跨 provider 标记。
  roundProviderChanged = false;
  // 取该 provider 最新的成功缓存。
  if (!latestCachedSnapshot(providerId)) loadFromDisk();
  const cachedSnapshot = latestCachedSnapshot(providerId);
  if (isSnapshotFresh(cachedSnapshot)) {
    baseRound = { provider: providerId, snapshot: cachedSnapshot };
  } else {
    // 缓存过期或缺失时抓取，最多等待 3 秒；超时用最近成功缓存，请求后台继续。
    const refreshResult = await withTimeout(
      refreshQuota(ctx, "agent_start_stale"),
      AGENT_START_FETCH_TIMEOUT_MS,
    );
    if (refreshResult?.ok) {
      baseRound = { provider: providerId, snapshot: refreshResult.snapshot };
    } else {
      // 失败时回退最近成功缓存；没有则本轮不结算。
      const fallback = latestCachedSnapshot(providerId);
      baseRound = fallback ? { provider: providerId, snapshot: fallback } : null;
    }
  }
  // 立即保存本轮基准，reload 后仍可恢复。
  if (baseRound?.provider === providerId) writeDiskCacheAsync();
  refreshWidget(ctx);
}

function finishSettledRound(ctx: ExtensionContext): void {
  baseRound = null;
  roundProviderChanged = false;
  // 结算后清除本轮状态。
  writeDiskCacheAsync();
  refreshWidget(ctx);
}

// agent_settled：用最新抓取值计算本轮消耗。
async function handleAgentSettled(ctx: ExtensionContext): Promise<void> {
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) {
    baseRound = null;
    lastDiff = null;
    return;
  }

  // 未支持/未知 provider：本轮直接结束，不写消费记录。
  if (isUnProvider(providerId)) {
    if (isShuttingDown) return;
    await refreshQuota(ctx, "agent_settled");
    finishSettledRound(ctx);
    return;
  }

  // 只有本次刷新成功才结算。
  const refreshResult = await refreshQuota(ctx, "agent_settled");
  if (!refreshResult.ok) {
    // 请求失败：保留本轮，不结算。
    return;
  }
  const snap = refreshResult.snapshot;
  const state = providerState.get(providerId) ?? {};
  state.settled_line = snap;
  providerState.set(providerId, state);

  if (roundProviderChanged) {
    // 跨过 provider 的本轮不计算差值。
    lastDiff = { kind: "changed" };
    finishSettledRound(ctx);
    return;
  }

  if (!baseRound || baseRound.provider !== providerId) {
    lastDiff = baseRound ? { kind: "changed" } : null;
    finishSettledRound(ctx);
    return;
  }

  const diff = diffSnapshot(baseRound.snapshot, snap);
  if (diff.kind === "changed") {
    lastDiff = { kind: "changed" };
  } else {
    lastDiff = diff;
    const consumption = diffToConsumption(diff);
    if (consumption) {
      const record: ConsumptionRecord = {
        at: Date.now(),
        kind: diff.kind === "balance" ? "balance" : "quota",
        deltas: consumption,
        currency: diff.kind === "balance" ? diff.currency : undefined,
      };
      const state = providerState.get(providerId) ?? {};
      state.consumptions = appendConsumption(state.consumptions, record);
      providerState.set(providerId, state);
    }
  }
  finishSettledRound(ctx);
}

type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

function restoreBaseLine(providerId: string, disk: DiskCache | null): void {
  const diskBase = disk?.providers?.[providerId]?.base_line;
  if (!diskBase || typeof diskBase !== "object" || Array.isArray(diskBase)) return;
  const base = { ...diskBase, provider: providerId };
  if (isValidSnapshot(base)) {
    baseRound = { provider: providerId, snapshot: base };
  }
  // 仅当 active_round 属于当前 provider 时恢复。
  const ar = disk?.active_round;
  if (ar && typeof ar === "object" && !Array.isArray(ar) && ar.provider === providerId) {
    roundProviderChanged = ar.provider_changed === true;
  }
}

function handleSessionStart(ctx: ExtensionContext, reason: SessionStartReason): void {
  const isReload = reason === "reload";
  // 新会话丢弃旧轮次；reload 恢复进行中的轮次。
  baseRound = null;
  roundProviderChanged = false;
  if (!isReload) lastDiff = null;
  // 一次读取恢复语言、缓存和轮次状态。
  const languageBefore = currentLanguage;
  const disk = loadFromDisk();
  if (currentLanguage !== languageBefore && registeredPi) {
    registerLocalizedCommands(registeredPi);
  }
  const providerId = normalizeProvider(ctx.model?.provider);
  currentProvider = providerId;
  if (isReload && providerId && !isUnProvider(providerId)) {
    restoreBaseLine(providerId, disk);
  } else if (!isReload) {
    // 新会话启动时清掉旧轮次。
    writeDiskCacheAsync();
  }
  currentStatus = "ok";
  refreshWidget(ctx);
  // 每次实时抓取，异步执行不阻塞启动。
  void refreshQuota(ctx, "session_start");
}

function handleModelSelect(ctx: ExtensionContext): void {
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) return;
  currentProvider = providerId;
  currentStatus = isUnProvider(providerId) ? "un-provider" : "fetching";
  if (!baseRound) {
    // 对话外切换 provider：不继承上一个 provider 的轮次差值。
    lastDiff = null;
  } else if (baseRound.provider !== providerId) {
    // 对话中跨 provider：本轮显示 changed。
    roundProviderChanged = true;
    lastDiff = { kind: "changed" };
    // 立即保存跨 provider 标记。
    writeDiskCacheAsync();
  }
  refreshWidget(ctx);
  void refreshQuota(ctx, "model_select");
}

// ---------- /checkaq 命令 ----------

async function runCheckaq(ctx: ExtensionContext): Promise<void> {
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) {
    ctx.ui.notify(LOCALES[currentLanguage].noActiveProvider, "warning");
    return;
  }
  if (isUnProvider(providerId)) {
    currentProvider = providerId;
    currentStatus = "un-provider";
    // 切到未支持 provider 不清掉本轮 changed 标记。
    markUnProviderChanged(providerId);
    providerState.delete(providerId);
    showMissing(ctx);
    return;
  }

  const now = Date.now();
  const withinThrottle =
    lastCheckaqProvider === providerId && lastCheckaqAt !== 0 && now - lastCheckaqAt <= CHECKAQ_THROTTLE_MS;
  if (withinThrottle) {
    // 1 秒内的重复执行直接返回；若有请求在途则等待其完成。
    const request = inflightRequest;
    if (request?.provider === providerId) await request.done;
    refreshWidget(ctx);
    return;
  }

  // 每次实时抓取；已有同 provider 请求时等待它。
  lastCheckaqAt = now;
  lastCheckaqProvider = providerId;
  await refreshQuota(ctx, "checkaq");
}

function summarizeConsumptions(records: ConsumptionRecord[]): string {
  const totalsByMetric: Record<string, number> = {};
  let totalBalance = 0;
  let balanceCurrency: string | undefined;
  for (const r of records) {
    if (r.kind === "balance") {
      const value = r.deltas.balance;
      if (Number.isFinite(value) && value < 0) {
        totalBalance += value;
        balanceCurrency = r.currency;
      }
    } else {
      for (const [k, v] of Object.entries(r.deltas)) {
        // 保存的消耗值均为负值。
        if (Number.isFinite(v) && v < 0) {
          totalsByMetric[k] = (totalsByMetric[k] ?? 0) + v;
        }
      }
    }
  }
  const parts: string[] = [];
  for (const [metric, value] of Object.entries(totalsByMetric)) {
    // /aq10 只显示消耗绝对值；零值不带正负符号。
    parts.push(`${metric} ${Math.abs(Math.round(value))}%`);
  }
  if (balanceCurrency !== undefined) {
    // /aq10 显示余额消耗绝对值，不带正负号。
    parts.push(`${balanceCurrency}${Math.abs(totalBalance).toFixed(2)}`);
  }
  return parts.join(" / ");
}

async function runAqLang(args: string, ctx: ExtensionContext): Promise<void> {
  const requested = normalizeLanguage(args.trim().toLowerCase());
  if (!requested) {
    ctx.ui.notify(LOCALES[currentLanguage].invalidLanguage, "warning");
    return;
  }

  currentLanguage = requested;
  writeDiskCacheAsync();
  await diskWriteQueue;
  if (activeWidget) {
    activeWidget.refresh();
  } else {
    refreshWidget(ctx);
  }
  if (registeredPi) registerLocalizedCommands(registeredPi);
  ctx.ui.notify(LOCALES[currentLanguage].languageChanged(currentLanguage), "info");
}

async function runAq10(ctx: ExtensionContext): Promise<void> {
  const locale = LOCALES[currentLanguage];
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) {
    ctx.ui.notify(locale.noActiveProvider, "warning");
    return;
  }
  if (isUnProvider(providerId)) {
    ctx.ui.notify(`${providerId}: ${locale.quotaUnavailable}`, "info");
    return;
  }
  const records = providerState.get(providerId)?.consumptions ?? [];
  if (records.length === 0) {
    ctx.ui.notify(`${providerId}: ${locale.noConsumptionRecords}`, "info");
    return;
  }
  const body = summarizeConsumptions(records);
  if (!body) {
    ctx.ui.notify(`${providerId}: ${locale.noConsumptionRecords}`, "info");
    return;
  }
  const colored = hexFg(QUOTA_COLORS.consumption, body);
  ctx.ui.notify(`${providerId} ${locale.aq10Rounds(records.length)} ${colored}`, "info");
}

function registerLocalizedCommands(pi: ExtensionAPI): void {
  const locale = LOCALES[currentLanguage];
  pi.registerCommand(CMD_NAME, {
    description: locale.checkaqDescription,
    handler: async (_args, ctx) => {
      await runCheckaq(ctx);
    },
  });
  pi.registerCommand(AQ10_CMD_NAME, {
    description: locale.aq10Description,
    handler: async (_args, ctx) => {
      await runAq10(ctx);
    },
  });
  pi.registerCommand(AQLANG_CMD_NAME, {
    description: locale.aqlangDescription,
    handler: async (args, ctx) => {
      await runAqLang(args, ctx);
    },
  });
}

// ---------- extension entry ----------

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {
    // 断开进行中的请求；晚到的结果不再触碰旧 widget 或状态。
    isShuttingDown = true;
    const request = inflightRequest;
    inflightRequest = null;
    request?.controller.abort();
    // 只等待本地保存完成，不等待网络请求。
    await diskWriteQueue;
  });
  pi.on("session_start", (event, ctx) => {
    handleSessionStart(ctx, event.reason);
  });
  pi.on("model_select", (_event, ctx) => {
    handleModelSelect(ctx);
  });
  pi.on("agent_start", async (_event, ctx) => {
    await handleAgentStart(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await handleAgentSettled(ctx);
  });
  registeredPi = pi;
  registerLocalizedCommands(pi);
}

// ---------- 数字与百分比 ----------

// 脏输入守卫：只接受有限正数，其余视为「无数据」，避免渲染出 "NaNm"。
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

// ---------- ANSI 宽度裁剪 ----------
// 扩展无法 import pi-tui，因此自实现单行截断。

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// 可见宽度：剥掉 SGR 序列后按 Unicode 宽度计列：东亚宽字符 2 列，零宽/组合字符 0 列，其余 1 列。
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue; // ZWJ / VS
    if (cp >= 0x0300 && cp <= 0x036f) continue; // 组合音标
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff)
        ? 2
        : 1;
  }
  return w;
}

// 按可见宽度截断，保留 ANSI 序列（不计入宽度），末尾补 SGR reset 防止样式外溢。
export function truncateAnsi(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(s) <= maxWidth) return s;

  const ELLIPSIS = "…";
  const budget = maxWidth - 1; // 给省略号留一列
  let out = "";
  let w = 0;
  let i = 0;

  while (i < s.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m && m.index === i) {
      out += m[0]; // ANSI 序列原样保留，不占宽度
      i = ANSI_RE.lastIndex;
      continue;
    }
    const ch = String.fromCodePoint(s.codePointAt(i) ?? 0);
    const cw = visibleWidth(ch);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
    i += ch.length;
  }
  return `${out}${ELLIPSIS}\x1b[0m`;
}
