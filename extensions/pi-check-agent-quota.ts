import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const STATUS_KEY = "pi-quota";
const CMD_NAME = "checkaq";

const MISSING = "--";

// 余额 ≤ 此阈值（按各 provider 货币单位）变红；可用 PI_QUOTA_BALANCE_ALERT 覆盖
const BALANCE_ALERT = (() => {
  const raw = Number(process.env.PI_QUOTA_BALANCE_ALERT);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
})();

// 配额数字不会秒级变化；session_start / model_select / agent_settled 可能在
// 一秒内连环触发，TTL 内直接复用缓存，避免建连后又被 abort 的空转
const QUOTA_TTL_MS = 60_000;

// session_start 后延迟一拍再后台刷新：让 TUI 首帧先渲染，配额数字晚点出现。
// 400ms 足够覆盖启动时 session_start → resources_discover → model_select 的连环触发，
// 配合 TTL + in-flight 去重合并成一次请求。
const STARTUP_REFRESH_DELAY_MS = 400;

// 磁盘缓存（stale-while-revalidate）：冷启动时若上次值在 10 分钟内，直接渲染
// 旧值（零网络等待），随后后台刷新覆盖。配额数字不会分钟级变化，可安全复用。
const DISK_STALE_MS = 10 * 60_000;
const DISK_CACHE_FILE = join(homedir(), ".pi", "agent", "quota-cache.json");

// MiniMax weekly_boost_permille 缺失时的默认值：1000‰ = 1.0x（不加成）
// 用 0 会让 weeklyPct 恒等于 0%，把「已用满」误显示成「没用」
const DEFAULT_BOOST_PERMILLE = 1000;

// 通用 auth 形状，baseUrl 大部分 provider 没有所以 optional
type Auth = { apiKey: string; baseUrl?: string };

// ---------- 时间格式化 ----------

function formatResetFromISO(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (Number.isNaN(diff) || diff <= 0) return "";
  return diff >= 24 * 3600000 ? formatDays(diff) : formatRemaining(diff);
}

// ---------- 渲染原语 ----------

type RenderItem =
  | { kind: "text"; text: string }
  | { kind: "pct"; pct: number }
  | { kind: "balance"; value: number; currency: string };

// 钳制逻辑见文件尾部 clampPct；这里只负责上色。
// NaN/负值会被 clampPct 归零，绝不会误显示成「低用量绿」。
function pctColor(pct: number, theme: Theme): string {
  const safe = clampPct(pct);
  const rounded = `${Math.round(safe)}%`;
  if (safe >= 80) return theme.fg("error", rounded);
  if (safe >= 41) return theme.fg("warning", rounded);
  return theme.fg("success", rounded); // 低用量走主题 success，浅色主题下也可读
}

function balanceColor(value: number, currency: string, theme: Theme): string {
  const safe = Number.isFinite(value) ? value : 0;
  const color = safe <= BALANCE_ALERT ? "error" : "dim";
  return theme.fg(color, `${currency}${safe.toFixed(2)}`);
}

function formatItems(items: RenderItem[], theme: Theme): string {
  return items
    .map((it) => {
      if (it.kind === "text") return theme.fg("dim", it.text);
      if (it.kind === "pct") return pctColor(it.pct, theme);
      return balanceColor(it.value, it.currency, theme);
    })
    .join("");
}

// 桶型配额：`Usage: 5h X% (4h52m)` / ` / 7d X% (4d23h)`
// prefix="Usage: " 给首桶；prefix=" / " 给后续桶（自动拼上 "7d " 这种 label）
function tier(prefix: string, label: string, pct: number, reset: string): RenderItem[] {
  return [
    { kind: "text", text: prefix + label },
    { kind: "pct", pct },
    { kind: "text", text: reset ? ` (${reset})` : "" },
  ];
}

function missingItems(): RenderItem[] {
  return [{ kind: "text", text: MISSING }];
}

// ---------- HTTP 助手 ----------

function bearerHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${apiKey}`, ...extra };
}

// 合并超时和外部 abort signal：任一触发都中断 fetch
function makeSignal(timeoutMs: number, external: AbortSignal): AbortSignal {
  return AbortSignal.any([AbortSignal.timeout(timeoutMs), external]);
}

// fetch + status 校验 + body 解析；保留原 parse-fail 错误格式便于排错
async function jsonFetch<T = any>(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<T> {
  const r = await fetch(url, { headers, signal: makeSignal(timeoutMs, signal) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const raw = await r.text();
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`parse fail: ${raw.slice(0, 100)}`);
  }
}

// ---------- ANSI 宽度裁剪 ----------
// 实现见文件尾部 visibleWidth / truncateAnsi（为何自实现的说明在该处）。

// ---------- Component 最小实现 ----------
// 自实现 Component：只 render() 和 invalidate()。

interface Component {
  render(width: number): string[];
  invalidate(): void;
}

class QuotaComponent implements Component {
  // themeRef 是函数而非实例：主题切换时 pi 会替换 globalThis 上的 Theme 对象
  // （theme.js setGlobalTheme），构造时捕获实例会导致配色滞留到下次 refresh。
  // 这里在 render 时才解引用，配合 invalidate() 清缓存即可实时跟随主题。
  private cache: { width: number; lines: string[] } | null = null;
  private readonly items: RenderItem[];
  private readonly themeRef: () => Theme;

  constructor(items: RenderItem[], themeRef: () => Theme) {
    this.items = items;
    this.themeRef = themeRef;
  }

  render(width: number): string[] {
    if (this.cache && this.cache.width === width) return this.cache.lines;
    const text = formatItems(this.items, this.themeRef());
    const lines = text ? [truncateAnsi(text, width)] : [];
    this.cache = { width, lines };
    return lines;
  }

  invalidate(): void {
    // 主题变更时被 TUI 递归调用（tui.js invalidate → child.invalidate）
    this.cache = null;
  }
}

// ---------- module-level 状态 ----------

let cachedItems: RenderItem[] = missingItems();
let activeRequestId = 0;
let currentController: AbortController | null = null;
// in-flight 去重：同 provider 的请求已在途时不再重复发起（连环事件只发一次）
let inflightProvider: string | null = null;

// TTL 缓存键：provider 变了必须立刻重取，不能复用上一个 provider 的数字
let lastFetchAt = 0;
let lastFetchProvider: string | null = null;

function widgetFactory(_tui: unknown, theme: Theme): Component {
  // 传 getter：pi 每次 setWidget 都会重新调用工厂并注入当时的 theme，
  // 但主题热切换不走 setWidget，只递归 invalidate()，所以必须延迟解引用。
  return new QuotaComponent(cachedItems, () => theme);
}

// ---------- 磁盘缓存 ----------

type DiskCache = { version: 1; provider: string; items: RenderItem[]; fetchedAt: number };

// 同步读：启动路径上只花 ~1ms，换来「首帧即有配额数字」
function readDiskCacheSync(): DiskCache | null {
  try {
    const j = JSON.parse(readFileSync(DISK_CACHE_FILE, "utf8")) as DiskCache;
    if (j.version !== 1 || !j.provider || !Array.isArray(j.items)) return null;
    return j;
  } catch {
    return null;
  }
}

// fire-and-forget：写盘失败不影响 UI，下次启动自然回到 "--"
function writeDiskCacheAsync(cache: DiskCache): void {
  writeFile(DISK_CACHE_FILE, JSON.stringify(cache), "utf8").catch(() => {});
}

// 冷启动先用磁盘旧值渲染 widget（仅限 provider 匹配且未过期）
function hydrateFromDiskCache(ctx: ExtensionContext): void {
  try {
    const providerId = ctx.model?.provider;
    if (!providerId) return;
    const disk = readDiskCacheSync();
    if (!disk || disk.provider !== providerId) return;
    if (Date.now() - disk.fetchedAt > DISK_STALE_MS) return;
    cachedItems = disk.items;
    ctx.ui.setWidget(STATUS_KEY, widgetFactory, { placement: "belowEditor" });
  } catch {
    // 尽力而为：任何异常都回退到 "--"，绝不影响启动
  }
}

// 延迟后台刷新：不阻塞当前事件（session_start / agent_settled）。
// 无 UI（--print / RPC）时直接跳过；定时器触发时若会话已切换，
// ctx 会抛 stale——静默跳过即可，不影响下一次事件重新调度。
function scheduleRefresh(ctx: ExtensionContext): void {
  if (!ctx.hasUI) return;
  setTimeout(() => {
    try {
      // refreshQuota 内部有安全网；这里再挂 .catch 防止意外 rejection 崩进程
      void refreshQuota(ctx).catch(() => {});
    } catch {
      // ctx 已失效（session 切换/关闭）——静默跳过
    }
  }, STARTUP_REFRESH_DELAY_MS);
}

// ---------- extension entry ----------

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    // 启动关键路径零网络：先用磁盘缓存渲染（若新鲜），网络刷新延迟到首帧之后
    hydrateFromDiskCache(ctx);
    scheduleRefresh(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    // 用户主动切模型，等待刷新结果合理（in-flight 去重会挡掉重复）
    await refreshQuota(ctx);
  });
  pi.on("agent_settled", async (_event, ctx) => {
    // 不阻塞本轮结束：后台刷新，TTL / in-flight 去重自动合并
    scheduleRefresh(ctx);
  });
  pi.registerCommand(CMD_NAME, {
    description: "Force-refresh quota and show detailed widget for current provider",
    handler: async (_args, ctx) => {
      await refreshQuota(ctx, true); // 命令 = 强制刷新，绕过 TTL
    },
  });
}

// ---------- quota refresh ----------

async function refreshQuota(ctx: ExtensionContext, force = false): Promise<void> {
  let fetchFailed = false; // fetch 失败时不刷新磁盘缓存时间戳，避免旧值保鲜期被滚动
  try {
    const myRequestId = ++activeRequestId;
    // 抢占式 abort：掐上一轮 TCP 连接、释放带宽、跳过 JSON parse
    currentController?.abort();
    const controller = new AbortController();
    currentController = controller;

    const providerId = ctx.model?.provider;
    let newItems: RenderItem[] = missingItems();

    // TTL 命中且 provider 未变 → 复用缓存，只重挂 widget（拿新 theme）。
    // force=true 跳过 TTL：/checkaq 命令的语义是「强制刷新」，不该被缓存拦。
    if (
      !force &&
      providerId &&
      providerId === lastFetchProvider &&
      Date.now() - lastFetchAt < QUOTA_TTL_MS
    ) {
      ctx.ui.setWidget(STATUS_KEY, widgetFactory, { placement: "belowEditor" });
      return;
    }

    // in-flight 去重：同 provider 的请求已在途时跳过（session_start → model_select
    // → agent_settled 连环触发只会发出一次请求，不再 abort 重启空转）
    if (!force && providerId && providerId === inflightProvider) return;
    inflightProvider = providerId ?? null;

    if (!providerId) {
      newItems = [];
    } else {
      const resolved = await ctx.modelRegistry.getProviderAuth(providerId);
      const auth = resolved?.auth;
      if (!auth?.apiKey) {
        newItems = missingItems();
      } else {
        try {
          newItems = await fetchProviderQuota(providerId, auth, controller.signal);
        } catch (err) {
          // 超时、上一轮 abort、网络/HTTP/JSON 错都归这里。
          // 网络失败时保留上次成功值（可能来自磁盘缓存），不降级成 "--"；
          // 完全无缓存时（冷启动首跑）才显示 "--"。
          // 被抢占的 abort 是预期行为，其余（key 无效 / 端点变更 / 配额接口下线）
          // 需要留痕，否则无法区分「没配 key」和「key 错了」。
          const aborted = controller.signal.aborted || (err as Error)?.name === "AbortError";
          if (!aborted) {
            console.error(`[pi-check-agent-quota] ${providerId} quota fetch failed:`, err);
          }
          fetchFailed = true; // 失败不写盘：保留旧磁盘时间戳，让 stale 窗口正常过期
          newItems = cachedItems; // 保留旧值；cachedItems 初始为 missingItems()
        }
      }
    }

    // 被新一轮抢占 → 丢弃，避免旧 provider setWidget 覆盖新 provider
    if (myRequestId !== activeRequestId) return;

    lastFetchAt = Date.now();
    lastFetchProvider = providerId ?? null;
    inflightProvider = null;
    cachedItems = newItems;
    // 持久化到磁盘，下次冷启动直接渲染旧值（仅成功时写，失败不滚动 stale 窗口）
    if (providerId && !fetchFailed) {
      writeDiskCacheAsync({
        version: 1,
        provider: providerId,
        items: newItems,
        fetchedAt: Date.now(),
      });
    }
    // setWidget 工厂只跑一次；refreshQuota 末尾再调一次让工厂拿当前 theme + 当前 cachedItems 重跑
    ctx.ui.setWidget(STATUS_KEY, widgetFactory, { placement: "belowEditor" });
  } catch (err) {
    // 安全网：吞掉 stale ctx / getProviderAuth 等异常，绝不让 pi 进程退出。
    // stale 是定时器延迟触发的预期场景（会话已切换），不打印误导性错误
    const staleCtx = (err as Error)?.message?.includes("This extension ctx is stale");
    if (!staleCtx) {
      console.error("[pi-check-agent-quota] refreshQuota error:", err);
    }
  }
}

// ---------- provider 路由 ----------

type Fetcher = (auth: Auth, signal: AbortSignal) => Promise<RenderItem[]>;

// 表驱动：加新 provider 只改这张表
const PROVIDER_FETCHERS: Record<string, Fetcher> = {
  minimax: fetchMinimax,
  "minimax-cn": fetchMinimax,
  "minimax-intl": fetchMinimax,
  zhipu: fetchZhipu,
  "zhipu-cn": fetchZhipu,
  "zhipu-intl": fetchZhipu,
  glm: fetchZhipu,
  moonshot: fetchKimi,
  kimi: fetchKimi,
  "kimi-coding": fetchKimi,
  deepseek: fetchDeepseek,
  openrouter: fetchOpenrouter,
};

// 这些 provider 没有 API-key 可查的配额接口，统一显示 --
// volcengine/doubao 的 GetCodingPlanUsage 需要 HMAC-SHA256 V4 签名，暂未支持
const NO_QUOTA_API: ReadonlySet<string> = new Set([
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

async function fetchProviderQuota(
  providerId: string,
  auth: Auth,
  signal: AbortSignal,
): Promise<RenderItem[]> {
  if (NO_QUOTA_API.has(providerId)) return missingItems();
  const fetcher = PROVIDER_FETCHERS[providerId];
  if (!fetcher) throw new Error(`unsupported provider: ${providerId}`);
  return fetcher(auth, signal);
}

// ---------- 各 provider fetchers ----------

/** MiniMax: GET {base}/v1/token_plan/remains
 *  字段来源：无官方 schema，社区从线上抓取观察（current_interval_remaining_percent
 *  是新接口字段，旧 current_interval_total_count/usage_count 恒为 0）。
 *  weekly_* 系列字段更冷门，已用 DEFAULT_BOOST_PERMILLE 兜底，若 API 变更
 *  表现为 7d 桶消失或归零，属预期降级，不崩。 */
async function fetchMinimax(auth: Auth, signal: AbortSignal): Promise<RenderItem[]> {
  const url = `${auth.baseUrl || "https://www.minimaxi.com"}/v1/token_plan/remains`;
  const j = await jsonFetch<any>(
    url,
    bearerHeaders(auth.apiKey, { "Content-Type": "application/json" }),
    15_000,
    signal,
  );
  const baseResp = j.base_resp;
  if (baseResp?.status_code !== undefined && baseResp.status_code !== 0) {
    throw new Error(`api code ${baseResp.status_code}: ${baseResp.status_msg ?? "?"}`);
  }
  const general = j.model_remains?.find((m: any) => m.model_name === "general");
  if (!general) throw new Error("general model not found");

  const fiveHourPct = 100 - (general.current_interval_remaining_percent ?? 0);
  const weeklyStatus = general.current_weekly_status;
  const weeklyRemaining = general.current_weekly_remaining_percent;
  // 缺省按 1.0x：默认 0 会让整个 weeklyPct 归零，把满负荷显示成空闲
  const weeklyBoost = (general.weekly_boost_permille ?? DEFAULT_BOOST_PERMILLE) / 1000;
  const weeklyPct = (100 - (typeof weeklyRemaining === "number" ? weeklyRemaining : 0)) * weeklyBoost;
  const fiveHourReset = formatRemaining(general.remains_time);
  const weeklyReset = formatDays(general.weekly_remains_time);

  const items = tier("Usage: ", "5h ", fiveHourPct, fiveHourReset);
  if (weeklyStatus === 1 && typeof weeklyRemaining === "number") {
    items.push(...tier(" / ", "7d ", weeklyPct, weeklyReset));
  }
  return items;
}

/** Kimi For Coding: GET {base}/v1/usages */
async function fetchKimi(auth: Auth, signal: AbortSignal): Promise<RenderItem[]> {
  const url = `${auth.baseUrl || "https://api.kimi.com/coding"}/v1/usages`;
  const j = await jsonFetch<any>(url, bearerHeaders(auth.apiKey), 10_000, signal);

  const items: RenderItem[] = [];
  const fiveHour = j.limits?.[0]?.detail;
  if (fiveHour) {
    const pct = usedPct(fiveHour.limit, fiveHour.remaining);
    items.push(...tier("Usage: ", "5h ", pct, formatResetFromISO(fiveHour.resetTime ?? "")));
  }
  const weekly = j.usage;
  if (weekly) {
    const pct = usedPct(weekly.limit, weekly.remaining);
    items.push(...tier(" / ", "7d ", pct, formatResetFromISO(weekly.resetTime ?? "")));
  }
  if (items.length === 0) throw new Error("no quota data");
  return items;
}

/** Zhipu GLM: GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
 *  无 coding plan 时端点返回 500 / code≠0；用裸 API key 当 Authorization value（不加 Bearer） */
async function fetchZhipu(auth: Auth, signal: AbortSignal): Promise<RenderItem[]> {
  const j = await jsonFetch<any>(
    "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
    { Authorization: auth.apiKey },
    10_000,
    signal,
  );
  if (j.code !== undefined && j.code !== 0 && j.code !== 200) {
    throw new Error(j.msg ?? `api code ${j.code}`);
  }
  const limits: any[] = j.data?.limits ?? j.data ?? [];
  if (!Array.isArray(limits) || limits.length === 0) throw new Error("no limits");
  const l = limits[0];
  const used = Number(l.usage ?? l.currentUsage ?? l.used ?? 0);
  const total = Number(l.quota ?? l.total ?? 0);
  const pct = clampPct(total > 0 ? (used / total) * 100 : 0);
  return [
    { kind: "text", text: `Usage: ${used}/${total} (` },
    { kind: "pct", pct },
    { kind: "text", text: ")" },
  ];
}

/** DeepSeek: GET https://api.deepseek.com/user/balance */
async function fetchDeepseek(auth: Auth, signal: AbortSignal): Promise<RenderItem[]> {
  const j = await jsonFetch<any>(
    "https://api.deepseek.com/user/balance",
    bearerHeaders(auth.apiKey),
    10_000,
    signal,
  );
  const info = j.balance_infos?.[0];
  if (!info) throw new Error("no balance");
  const parsed = parseFloat(info.total_balance ?? "0");
  const total = Number.isFinite(parsed) ? parsed : 0;
  // API 返回 currency（CNY/USD），动态映射，不硬编码 ¥
  const cur = info.currency;
  const currency = cur === "USD" ? "$" : cur === "CNY" ? "¥" : String(cur ?? "?");
  return [
    { kind: "text", text: "Balance: " },
    { kind: "balance", value: total, currency },
  ];
}

/** OpenRouter: GET https://openrouter.ai/api/v1/credits */
async function fetchOpenrouter(auth: Auth, signal: AbortSignal): Promise<RenderItem[]> {
  const j = await jsonFetch<any>(
    "https://openrouter.ai/api/v1/credits",
    bearerHeaders(auth.apiKey),
    10_000,
    signal,
  );
  const credits = Number(j.data?.total_credits ?? 0);
  const usage = Number(j.data?.total_usage ?? 0);
  const remaining = Number.isFinite(credits) && Number.isFinite(usage) ? credits - usage : 0;
  return [
    { kind: "text", text: "Balance: " },
    { kind: "balance", value: remaining, currency: "$" },
  ];
}

// ---------- 数字与百分比 ----------

// 脏输入守卫：非有限数 / 负数一律视为「无数据」返回 null。
// 与 formatResetFromISO 的既有守卫保持同一套标准，避免渲染出 "NaNm" / "InfinityhNaNm"。
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

// 钳制到 [0,100]；NaN/非数字归零。
// 不钳制的话：NaN 会因为 `NaN >= 80` 和 `NaN >= 41` 都为 false 而落进「低用量绿」，
// 负值同理，把异常显示成健康状态。
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

// ---------- ANSI 宽度裁剪（自实现）----------
// 官方 pi-tui 的 truncateToWidth 语义不匹配：truncateToVisualLines 是 wrap + 取尾行
// （visual-truncate.js: slice(-maxVisualLines)），会丢信息头部；且扩展无法 import
// pi-tui（jiti 从扩展目录解析 node_modules，pi-tui 在 pi-coding-agent 内部）。
// 因此保留自实现：只做单行截断。

const ANSI_RE = /\x1b\[[0-9;]*m/g;

// 可见宽度：剥掉 SGR 序列后，East Asian Wide / Fullwidth 记 2 列，其余记 1 列。
// 零宽/组合字符记 0，避免 emoji 变体选择符虚增宽度。
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
