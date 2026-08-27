import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { chmodSync, readFileSync } from "node:fs";
import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchProviderQuota, isUnProvider, normalizeProvider, fetchWithRetry } from "./lib/providers.js";
import type { FetchPayload } from "./lib/providers.js";
import { LOCALES, QUOTA_COLORS, hexFg, formatRemaining, clampPct, visibleWidth, truncateAnsi, formatItems, annotateItems, missingItems, emptyItems, normalizeLanguage, QuotaComponent, type RenderItem, type Language, setCurrentLanguage, getCurrentLanguage } from "./lib/widget.js";
import { estimateEta, medianGapMs, ETA_MAX_ROUNDS, RATE_METRIC_PRIORITY, type EtaSample, type EtaEstimate } from "./lib/eta.js";

const STATUS_KEY = "pi-quota";
const CMD_NAME = "checkaq";
const AQ10_CMD_NAME = "aq10";
const AQLANG_CMD_NAME = "aqlang";

const RETRY_COUNT = 3;
const RETRY_DELAY_MS = 500;
const AGENT_START_REFRESH_AFTER_MS = 60 * 60_000;
const AGENT_START_FETCH_TIMEOUT_MS = 3_000;
const CHECKAQ_THROTTLE_MS = 1_000;
const CONSUMPTION_CAPACITY = 10;
const DISK_CACHE_DIR = join(homedir(), ".pi", "agent", "pi-check-agent-quota");
const DISK_CACHE_FILE = join(DISK_CACHE_DIR, "quota-cache.json");
const DISK_CACHE_TEMP_FILE = `${DISK_CACHE_FILE}.tmp`;
const DISK_CACHE_MODE = 0o600;
const DISK_CACHE_DIR_MODE = 0o700;

// MiniMax weekly_boost_permille 缺失时按 1.0x（1000‰）计算，避免已用满显示成 0%
const DEFAULT_BOOST_PERMILLE = 1000;

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


type DiskCache = {
  version: 2;
  language?: Language;
  active_round?: ActiveRound;
  providers: Record<string, ProviderCache>;
};

type DiffResult =
  | { kind: "balance"; deltas: { balance: number }; currency: string }
  | { kind: "quota"; deltas: Record<string, number> }
  | { kind: "changed" }
  | { kind: "reset" };

type RefreshResult =
  | { ok: true; snapshot: QuotaSnapshot }
  | { ok: false };

type RefreshTrigger =
  | "session_start"


// ---------- module-level 状态 ----------
// ---------- module-level 状态 ----------

let cachedItems: RenderItem[] = emptyItems();
// 默认中文；session_start 时从磁盘恢复，不同则重注册命令描述。
let currentLanguage: Language = "zh";
// 同步到 widget 私有状态
setCurrentLanguage(currentLanguage);
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


let lastWrittenJson = "";

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
    setCurrentLanguage(currentLanguage);
    return null;
  }
  currentLanguage = normalizeLanguage(disk.language) ?? "zh";
  setCurrentLanguage(currentLanguage);

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
  if (currentStatus === "fetching") return { kind: "annotation", text: `${prefix}(${LOCALES[currentLanguage].fetching})` };
  if (currentStatus === "failed") return { kind: "annotation", text: `${prefix}(${LOCALES[currentLanguage].failed})` };
  return null;
}

function renderSnapshotWithDiff(
  snapshot: QuotaSnapshot,
  diff: DiffResult | null,
  isIdle: boolean,
): RenderItem[] {
  let items: RenderItem[] = snapshot.items.map((it) => ({ ...it }));
  if (diff && diff.kind !== "changed" && diff.kind !== "reset") {
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
        // 四舍五入到 1 位小数（0.16→0.2）
        const rounded = Math.round(delta * 10) / 10;
        if (rounded === 0) return "(0%)";
        const sign = rounded > 0 ? "-" : "+";
        const abs = Math.abs(rounded);
        // 去掉多余的 .0（如 0.6 保持 0.6，1.0 显示 1%）
        const text = Number.isInteger(abs) ? `${abs}%` : `${abs.toFixed(1).replace(/\.0$/, "")}%`;
        return `(${sign}${text})`;
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
    items.push({ kind: "annotation", text: ` (${LOCALES[currentLanguage].using})` });
  } else {
    // 请求状态优先显示。
    if (diff?.kind === "changed") {
      items.push({ kind: "annotation", text: ` (${LOCALES[currentLanguage].changed})` });
    } else if (diff?.kind === "reset") {
      items.push({ kind: "annotation", text: ` (${LOCALES[currentLanguage].reset})` });
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

  // 失败时只显示单行状态（(失败)），不追加 ETA：避免窄窗口拆成两行，且失败时旧快照推算的 ETA 不可信。
  if (currentStatus !== "failed") {
    const etaText = formatEta(currentEta(currentProvider!));
    if (etaText) {
      cachedItems = [...cachedItems, { kind: "annotation", text: etaText } as RenderItem];
    }
  }

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
  } catch {
    // 认证解析失败也属于当前查询失败：静默降级（错误详情可能含敏感信息，不写入日志）。
    if (currentProvider === providerId) {
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
  } catch {
    // 请求失败静默降级：不打印错误日志（错误详情可能含敏感信息）。
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
  // 检测桶重置：任一桶骤降 >30% 视为窗口重置
  if (diff.kind === "quota" && Object.values(diff.deltas).some((v) => v < -30)) {
    lastDiff = { kind: "reset" };
    finishSettledRound(ctx);
    return;
  }
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
  setCurrentLanguage(currentLanguage);
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
  if (
    p.resetAt !== undefined &&
    (!p.resetAt ||
      typeof p.resetAt !== "object" ||
      Array.isArray(p.resetAt) ||
      Object.values(p.resetAt).some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0))
  ) {
    throw new Error("invalid quota resetAt");
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
        const pct = item.pct;
        if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0) {
          throw new Error("invalid quota pct");
        }
        if (item.metric !== undefined && typeof item.metric !== "string") {
          throw new Error("invalid quota metric");
        }
        break;
      }
      case "balance": {
        const value = item.value;
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid quota balance");
        if (typeof item.currency !== "string" || item.currency === "") {
          throw new Error("invalid balance currency");
        }
        if (item.metric !== undefined && typeof item.metric !== "string") {
          throw new Error("invalid quota metric");
        }
        break;
      }
      default:
        throw new Error("invalid quota item kind");
    }
  }
  if (p.kind === "balance") {
    if (typeof p.currency !== "string" || p.currency === "") throw new Error("invalid balance currency");
    if (!Number.isFinite(metrics.balance)) throw new Error("invalid balance");
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
  // 允许 0（空转轮次）以便 ETA 感知近期零消耗，仍拒绝正值与非有限值
  return values.length > 0 && values.every((value) => Number.isFinite(value) && value <= 0);
}

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
    // 余额增加可能是充值或调整，无法证明本轮无消耗，不生成消费样本。
    const value = diff.deltas.balance;
    if (Number.isFinite(value)) {
      if (value < 0) out.balance = value;
      else if (value === 0) out.balance = 0;
    }
  } else if (diff.kind === "quota") {
    // 使用率增加代表消耗，反转为负值；回退或不变都记录为 0。
    for (const [key, value] of Object.entries(diff.deltas)) {
      if (Number.isFinite(value)) out[key] = value > 0 ? -value : 0;
    }
  }
  return Object.keys(out).length > 0 ? out : null;
}

function appendConsumption(records: ConsumptionRecord[] | undefined, record: ConsumptionRecord): ConsumptionRecord[] {
  const list = records ?? [];
  return [...list, record].slice(-CONSUMPTION_CAPACITY);
}

// ---------- ETA 胶水 (有状态，依赖 currentProvider / providerState) ----------
// 速率源按窗口优先级取最短可用窗口（5h → used → 7d → mo，见 RATE_METRIC_PRIORITY）：
// 5h/used 的 delta 是真实单轮消耗；7d/mo 是滑动窗口（delta 含滑出抵消），
// 仅在 provider 没有更小窗口时作为回退。
// 各桶轮数 = 各自剩余量 ÷ 统一速率，取最先耗尽的瓶颈。
function currentEta(provider: string): EtaEstimate | null {
  const snap = latestLineSnapshot(provider);
  const records = providerState.get(provider)?.consumptions;
  if (!snap || !records) return null;

  const metrics = Object.keys(snap.metrics);

  // 余额型：单指标，直接估算。
  if (snap.kind === "balance") {
    return estimateEta(toSamples(records, "balance"), snap.metrics.balance ?? 0);
  }

  // 任一桶已耗尽：整体已没有可用轮次，不能跳过该瓶颈去展示其他桶的 ETA。
  for (const metric of metrics) {
    if (100 - clampPct(snap.metrics[metric]) <= 0) return null;
  }

  // 速率源按优先级选取：5h（短窗口）→ used（累计型）→ 7d → mo。
  // 5h/used 的 delta 是真实单轮消耗；7d/mo 是滑动窗口（delta 含滑出抵消），
  // 仅在 provider 没有更小窗口时作为回退。
  const rateMetric = RATE_METRIC_PRIORITY.find((m) => metrics.includes(m)) ?? null;
  if (rateMetric === null) return null; // 无可识别窗口：不估算
  const rateSamples = toSamples(records, rateMetric);
  const remainingRate = 100 - clampPct(snap.metrics[rateMetric]);
  const rateEta = estimateEta(rateSamples, remainingRate);
  if (rateEta?.zeroRounds !== undefined) {
    // 速率桶近期无消耗：整体显示“近x轮0消耗”。
    return { rounds: 0, activeMs: 0, zeroRounds: rateEta.zeroRounds };
  }
  if (!rateEta || rateEta.rounds <= 0 || rateEta.activeMs <= 0) return null;
  const perRound = remainingRate / rateEta.rounds;
  if (!Number.isFinite(perRound) || perRound <= 0) return null;

  const msPerRound = medianGapMs(rateSamples);

  // 各桶轮数 = 剩余量 ÷ 统一速率；取最小（最先耗尽的瓶颈）。
  let best: EtaEstimate | null = null;
  let bestRounds = Number.POSITIVE_INFINITY;
  for (const metric of metrics) {
    const remaining = 100 - clampPct(snap.metrics[metric]);
    const resetAt = snap.resetAt?.[metric];
    if (resetAt !== undefined) {
      const resetRemainingMs = resetAt - Date.now();
      if (resetRemainingMs <= 0) return null; // 已过期视为异常
      const roundsInWindow = remaining / perRound;
      const activeMs = roundsInWindow * msPerRound;
      if (activeMs > resetRemainingMs) {
        // 该桶在耗尽前会先重置（重置后恢复），不构成约束，跳过。
        continue;
      }
    }
    const rounds = remaining / perRound;
    if (!Number.isFinite(rounds) || rounds <= 0) return null;
    if (rounds < bestRounds) {
      bestRounds = rounds;
      best = { rounds, activeMs: rounds * msPerRound };
    }
  }
  return best;
}

function toSamples(records: ConsumptionRecord[], metric: string): EtaSample[] {
  const out: EtaSample[] = [];
  // 取最近 10 轮（含无该指标消耗的轮次按 0 计），避免长期未动的桶被旧样本高估
  const recent = records.slice(-10);
  for (const r of recent) {
    const v = r.deltas[metric];
    if (Number.isFinite(v) && v < 0) out.push({ at: r.at, delta: Math.abs(v) });
    else out.push({ at: r.at, delta: 0 });
  }
  return out;
}

function formatEta(eta: EtaEstimate | null): string | null {
  if (!eta) return null;
  const locale = LOCALES[currentLanguage];
  const label = currentLanguage === "zh" ? "预计可用" : "Available";
  // 该桶近期无消耗：显示“近x轮0消耗”，不显示轮数 ETA。
  if (eta.zeroRounds !== undefined) {
    return locale.etaZeroRounds(eta.zeroRounds);
  }
  // 显示上限：超过 ETA_MAX_ROUNDS 显示 "365+"，防止荒谬的几百轮。
  if (eta.rounds > ETA_MAX_ROUNDS) {
    return ` ${label}：${ETA_MAX_ROUNDS}+轮`;
  }
  const rounds = Math.max(1, Math.round(eta.rounds));
  const time = formatRemaining(eta.activeMs);
  const isUrgentRounds = rounds <= 5;
  const isUrgentTime = eta.activeMs <= 30 * 60_000;
  // 基色跟随“限额”二字（dim），仅紧急时对应片段标红
  const roundsPart = isUrgentRounds ? hexFg(QUOTA_COLORS.red, String(rounds)) : String(rounds);
  const timePart = isUrgentTime ? hexFg(QUOTA_COLORS.red, time) : time;
  if (!time) {
    return ` ${label}：${roundsPart}轮`;
  }
  return ` ${label}：${roundsPart}轮/${timePart}`;
}
