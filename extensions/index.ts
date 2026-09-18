import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { closeSync, constants as fsConstants, fchmodSync, fstatSync, openSync, readFileSync } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { fetchProviderQuota, isUnProvider, normalizeProvider, fetchWithRetry } from "./lib/providers.js";
import type { Auth, FetchPayload } from "./lib/providers.js";
import { LOCALES, QUOTA_COLORS, hexFg, formatRemaining, formatDays, clampPct, annotateItems, missingItems, emptyItems, normalizeLanguage, QuotaComponent, formatAge, getQuotaSettings, setQuotaSettings, resetQuotaSettings, AUTO_REFRESH_MAX_MINUTES, type Component, type QuotaSettings, type RenderItem, type Language, setCurrentLanguage } from "./lib/widget.js";
import { estimateEta, medianGapMs, ETA_MAX_ROUNDS, RATE_METRIC_PRIORITY, type EtaSample, type EtaEstimate } from "./lib/eta.js";

const STATUS_KEY = "pi-quota";
const AQCHECK_CMD_NAME = "aqcheck";
const AQ10_CMD_NAME = "aq10";
const AQLANG_CMD_NAME = "aqlang";
const AQSET_CMD_NAME = "aqset";
const AQAUTO_CMD_NAME = "aqauto";
const AQPICK_CMD_NAME = "aqpick";

const AGENT_START_REFRESH_AFTER_MS = 60 * 60_000;
const AGENT_START_FETCH_TIMEOUT_MS = 3_000;
const AQCHECK_THROTTLE_MS = 1_000;
const CONSUMPTION_CAPACITY = 10;
const AQPICK_TIMEOUT_MS = 10_000;
const AQPICK_STATUS_KEY = "pi-quota-pick";
const DISK_CACHE_DIR = join(homedir(), ".pi", "agent", "pi-check-agent-quota");
const DISK_CACHE_FILE = join(DISK_CACHE_DIR, "quota-cache.json");
const DISK_CACHE_MODE = 0o600;
const DISK_CACHE_DIR_MODE = 0o700;
const MAX_DISK_CACHE_BYTES = 1024 * 1024;
const MAX_PAYLOAD_ITEMS = 32;
const MAX_PAYLOAD_METRICS = 16;
const MAX_DISPLAY_TEXT_LENGTH = 256;
const MAX_METRIC_NAME_LENGTH = 64;
const MAX_CURRENCY_LENGTH = 8;
const UNSAFE_DISPLAY_TEXT_RE = /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/u;
const UNSAFE_DISPLAY_TEXT_GLOBAL_RE = /[\u0000-\u001f\u007f-\u009f]|\p{Cf}/gu;
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "prototype", "constructor"]);

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
  settings?: Partial<QuotaSettings>;
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

type PiModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

type AqPickProvider = {
  id: string;
  label: string;
  models: PiModel[];
  snapshot: QuotaSnapshot;
};

type RefreshTrigger =
  | "session_start"
  | "model_select"
  | "agent_start_stale"
  | "agent_settled"
  | "aqcheck"
  | "auto_refresh"
  | "aqpick";

let cachedItems: RenderItem[] = emptyItems();

let currentLanguage: Language = "zh";

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

const providerState = new Map<string, RuntimeProviderState>();

let baseRound: { provider: string; snapshot: QuotaSnapshot } | null = null;

let roundProviderChanged = false;

type InflightRequest = {
  provider: string;
  controller: AbortController;
  done: Promise<RefreshResult>;
  resolveDone: (result: RefreshResult) => void;
};
let inflightRequest: InflightRequest | null = null;
let aqPickController: AbortController | null = null;
let aqPickSwitchSnapshot: { provider: string; fetchedAt: number } | null = null;
let isShuttingDown = false;

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  minimax: "MiniMax",
  "minimax-cn": "MiniMax CN",
  moonshotai: "Kimi API",
  "moonshotai-cn": "Kimi API CN",
  "kimi-coding": "Kimi For Coding",
  zai: "Z.AI / GLM",
  "zai-coding-cn": "Z.AI Coding Plan",
  deepseek: "DeepSeek",
  openrouter: "OpenRouter",
  "opencode-go": "OpenCode Go",
  "openai-codex": "OpenAI Codex",
};

let lastAqCheckAt = 0;
let lastAqCheckProvider: string | null = null;

function readDiskCacheSync(): DiskCache | null {
  let fd: number | undefined;
  try {
    fd = openSync(DISK_CACHE_FILE, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || info.size > MAX_DISK_CACHE_BYTES) return null;
    fchmodSync(fd, DISK_CACHE_MODE);
    const raw = readFileSync(fd, "utf8");
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
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {}
    }
  }
}

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
    settings: getQuotaSettings(),
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
    .catch(() => {});
}

async function writeDiskFile(data: string): Promise<void> {
  await mkdir(DISK_CACHE_DIR, { recursive: true, mode: DISK_CACHE_DIR_MODE });
  const directory = await lstat(DISK_CACHE_DIR);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error("unsafe cache directory");
  }
  await chmod(DISK_CACHE_DIR, DISK_CACHE_DIR_MODE);

  const tempFile = `${DISK_CACHE_FILE}.${randomUUID()}.tmp`;
  try {
    const handle = await open(tempFile, "wx", DISK_CACHE_MODE);
    try {
      await handle.writeFile(data, { encoding: "utf8" });
    } finally {
      await handle.close();
    }
    await rename(tempFile, DISK_CACHE_FILE);
    await chmod(DISK_CACHE_FILE, DISK_CACHE_MODE);
  } finally {
    await unlink(tempFile).catch(() => {});
  }
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

  if (disk.settings && typeof disk.settings === "object" && !Array.isArray(disk.settings)) {
    setQuotaSettings(disk.settings);
  }

  providerState.clear();

  for (const [provider, rawEntry] of Object.entries(disk.providers)) {

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

function isSnapshotFresh(snapshot: QuotaSnapshot | null): boolean {
  return !!snapshot && Date.now() - snapshot.fetchedAt <= AGENT_START_REFRESH_AFTER_MS;
}

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

        if (delta === 0) return "(0%)";
        const abs = Math.abs(delta);
        let rounded: number;
        let text: string;
        if (abs > 0 && abs < 0.1) {
          rounded = Math.round(abs * 100) / 100;
          if (rounded === 0) return "(0%)";
          text = `${rounded.toFixed(2)}%`;
        } else {
          rounded = Math.round(abs * 10) / 10;
          if (rounded === 0) return "(0%)";
          text = Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
        }
        const sign = delta > 0 ? "-" : "+";
        return `(${sign}${text})`;
      }

      const cur = snapshot.currency ?? "";
      if (delta === 0) return `(${cur}0.00)`;
      const absBal = Math.abs(delta);
      if (absBal > 0 && absBal < 0.01) {
        const roundedBal = Math.round(delta * 1000) / 1000;
        if (roundedBal === 0) return `(${cur}0.00)`;
        const sign = roundedBal > 0 ? "+" : "";
        return `(${sign}${cur}${roundedBal.toFixed(3)})`;
      } else {
        const roundedBal = Number(delta.toFixed(2));
        if (roundedBal === 0) return `(${cur}0.00)`;
        const sign = roundedBal > 0 ? "+" : "";
        return `(${sign}${cur}${roundedBal.toFixed(2)})`;
      }
    };
    items = annotateItems(items, annotationFor);
  }

  if (!isIdle) {
    items.push({ kind: "annotation", text: ` (${LOCALES[currentLanguage].using})` });
  } else {

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

const AGE_TICK_MS = 60_000;
let lastCtx: ExtensionContext | null = null;
let ageTickTimer: ReturnType<typeof setInterval> | null = null;

function autoRefreshMs(): number {
  const minutes = getQuotaSettings().autoRefreshMinutes;
  if (!Number.isFinite(minutes) || minutes <= 0) return 0;
  return minutes * 60_000;
}

let lastAutoAttemptAt = 0;

const AQAUTO_DEBOUNCE_MS = 1_000;
let lastAqautoArgs = "";
let lastAqautoAt = 0;

function ensureAgeTicker(): void {
  if (ageTickTimer) return;
  ageTickTimer = setInterval(() => {

    if (!activeWidget || isShuttingDown || !lastCtx) return;
    if (!currentProvider || isUnProvider(currentProvider)) return;

    const interval = autoRefreshMs();
    if (interval > 0 && Date.now() - lastAutoAttemptAt >= interval) {
      lastAutoAttemptAt = Date.now();
      void refreshQuota(lastCtx, "auto_refresh");
    }

    if (currentStatus !== "failed") refreshWidget(lastCtx);
  }, AGE_TICK_MS);

  ageTickTimer.unref?.();
}

function stopAgeTicker(): void {
  if (ageTickTimer) {
    clearInterval(ageTickTimer);
    ageTickTimer = null;
  }
}

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

function refreshWidget(ctx: ExtensionContext): void {
  lastCtx = ctx;
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

    const status = statusAnnotation(false);
    cachedItems = status ? [status] : emptyItems();
    renderWidget(ctx);
    return;
  }
  const diff = lastDiff?.kind === "changed" ? { kind: "changed" } as DiffResult : lastDiff;
  cachedItems = renderSnapshotWithDiff(snap, diff, ctx.isIdle());

  const snapForAge = latestLineSnapshot(currentProvider!);
  const ageText = snapForAge?.fetchedAt ? formatAge(snapForAge.fetchedAt) : "";

  const etaTextBase = currentStatus !== "failed" ? formatEta(currentEta(currentProvider!)) : null;
  if (ageText) {

    cachedItems = [...cachedItems, { kind: "age", text: etaTextBase ? `${ageText} ·` : ageText } as RenderItem];
  }
  if (etaTextBase) {
    cachedItems = [...cachedItems, { kind: "eta", text: etaTextBase } as RenderItem];
  }

  renderWidget(ctx);
}

function showMissing(ctx: ExtensionContext): void {
  cachedItems = missingItems();
  renderWidget(ctx);
}

function markUnProviderChanged(providerId: string): void {
  if (baseRound && baseRound.provider !== providerId) {
    roundProviderChanged = true;
    lastDiff = { kind: "changed" };
  } else {
    lastDiff = null;
  }
}

function bearerFromAuthHeaders(headers: unknown): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  const record = headers as Record<string, unknown>;
  const value = record["Authorization"] ?? record["authorization"];
  if (typeof value !== "string") return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m ? m[1] : undefined;
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const safe = promise.then(
    (value) => value,
    () => undefined,
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

  if (isUnProvider(providerId)) {
    currentProvider = providerId;
    currentStatus = "un-provider";

    markUnProviderChanged(providerId);
    providerState.delete(providerId);
    showMissing(ctx);
    return { ok: false };
  }

  const existingBeforeAuth = inflightRequest;
  if (existingBeforeAuth?.provider === providerId) {
    return await existingBeforeAuth.done;
  }

  let resolved: Awaited<ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>>;
  try {
    resolved = await ctx.modelRegistry.getProviderAuth(providerId);
  } catch {

    if (currentProvider === providerId) {
      currentStatus = "failed";
      refreshWidget(ctx);
    }
    return { ok: false };
  }
  const resolvedAuth = resolved?.auth;

  const auth = resolvedAuth?.apiKey ? resolvedAuth : { ...resolvedAuth, apiKey: bearerFromAuthHeaders(resolvedAuth?.headers) };

  if (isShuttingDown || currentProvider !== providerId) return { ok: false };
  currentStatus = "fetching";
  refreshWidget(ctx);

  const apiKey = auth?.apiKey;
  if (!apiKey) {
    currentProvider = providerId;
    currentStatus = "ok";
    showMissing(ctx);
    return { ok: false };
  }
  const fetchAuth: Auth = { apiKey, baseUrl: auth.baseUrl };

  const existingAfterAuth = inflightRequest;
  if (existingAfterAuth?.provider === providerId) {
    return await existingAfterAuth.done;
  }

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

  lastAutoAttemptAt = Date.now();

  let result: RefreshResult = { ok: false };
  try {
    const payload = await fetchWithRetry(controller.signal, () =>
      fetchProviderQuota(providerId, fetchAuth, controller.signal),
    );
    if (payload === null) {
      currentStatus = "un-provider";
      result = { ok: false };
      return result;
    }
    validatePayload(payload);

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

    if (inflightRequest === request && currentProvider === providerId) {
      currentStatus = "failed";
    }
  } finally {
    const isCurrent = inflightRequest === request;
    const isCurrentProvider = currentProvider === providerId;
    if (isCurrent) {
      inflightRequest = null;
    }

    request.resolveDone(result);

    if (isCurrent && isCurrentProvider) {
      refreshWidget(ctx);
    }
  }
  return result;
}

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

  roundProviderChanged = false;

  if (!latestCachedSnapshot(providerId)) loadFromDisk();
  const cachedSnapshot = latestCachedSnapshot(providerId);
  if (cachedSnapshot && isSnapshotFresh(cachedSnapshot)) {
    baseRound = { provider: providerId, snapshot: cachedSnapshot };
  } else {

    const refreshResult = await withTimeout(
      refreshQuota(ctx, "agent_start_stale"),
      AGENT_START_FETCH_TIMEOUT_MS,
    );
    if (refreshResult?.ok) {
      baseRound = { provider: providerId, snapshot: refreshResult.snapshot };
    } else {

      const fallback = latestCachedSnapshot(providerId);
      baseRound = fallback ? { provider: providerId, snapshot: fallback } : null;
    }
  }

  if (baseRound?.provider === providerId) writeDiskCacheAsync();
  refreshWidget(ctx);
}

function finishSettledRound(ctx: ExtensionContext): void {
  baseRound = null;
  roundProviderChanged = false;

  writeDiskCacheAsync();
  refreshWidget(ctx);
}

async function handleAgentSettled(ctx: ExtensionContext): Promise<void> {
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) {
    baseRound = null;
    lastDiff = null;
    return;
  }

  if (isUnProvider(providerId)) {
    if (isShuttingDown) return;
    await refreshQuota(ctx, "agent_settled");
    finishSettledRound(ctx);
    return;
  }

  const refreshResult = await refreshQuota(ctx, "agent_settled");
  if (!refreshResult.ok) {

    return;
  }
  const snap = refreshResult.snapshot;
  const state = providerState.get(providerId) ?? {};
  state.settled_line = snap;
  providerState.set(providerId, state);

  if (roundProviderChanged) {

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

  const ar = disk?.active_round;
  if (ar && typeof ar === "object" && !Array.isArray(ar) && ar.provider === providerId) {
    roundProviderChanged = ar.provider_changed === true;
  }
}

function handleSessionStart(ctx: ExtensionContext, reason: SessionStartReason): void {
  const isReload = reason === "reload";

  baseRound = null;
  roundProviderChanged = false;
  if (!isReload) lastDiff = null;

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

    writeDiskCacheAsync();
  }
  currentStatus = "ok";
  refreshWidget(ctx);

  void refreshQuota(ctx, "session_start");
}

function handleModelSelect(ctx: ExtensionContext): void {
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) return;
  const aqPickSnapshotIsFresh =
    aqPickSwitchSnapshot?.provider === providerId &&
    Date.now() - aqPickSwitchSnapshot.fetchedAt <= AQPICK_TIMEOUT_MS;
  aqPickSwitchSnapshot = null;
  currentProvider = providerId;
  currentStatus = isUnProvider(providerId) ? "un-provider" : aqPickSnapshotIsFresh ? "ok" : "fetching";
  if (!baseRound) {

    lastDiff = null;
  } else if (baseRound.provider !== providerId) {

    roundProviderChanged = true;
    lastDiff = { kind: "changed" };

    writeDiskCacheAsync();
  }
  refreshWidget(ctx);
  if (!aqPickSnapshotIsFresh) void refreshQuota(ctx, "model_select");
}

async function runAqCheck(ctx: ExtensionContext): Promise<void> {
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) {
    ctx.ui.notify(LOCALES[currentLanguage].noActiveProvider, "warning");
    return;
  }
  if (isUnProvider(providerId)) {
    currentProvider = providerId;
    currentStatus = "un-provider";

    markUnProviderChanged(providerId);
    providerState.delete(providerId);
    showMissing(ctx);
    return;
  }

  const now = Date.now();
  const withinThrottle =
    lastAqCheckProvider === providerId && lastAqCheckAt !== 0 && now - lastAqCheckAt <= AQCHECK_THROTTLE_MS;
  if (withinThrottle) {

    const request = inflightRequest;
    if (request?.provider === providerId) await request.done;
    refreshWidget(ctx);
    return;
  }

  lastAqCheckAt = now;
  lastAqCheckProvider = providerId;
  await refreshQuota(ctx, "aqcheck");
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

        if (Number.isFinite(v) && v < 0) {
          totalsByMetric[k] = (totalsByMetric[k] ?? 0) + v;
        }
      }
    }
  }
  const parts: string[] = [];
  for (const [metric, value] of Object.entries(totalsByMetric)) {

    parts.push(`${metric} ${Math.abs(Math.round(value))}%`);
  }
  if (balanceCurrency !== undefined) {

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

async function runAqSet(args: string, ctx: ExtensionContext): Promise<void> {
  const locale = LOCALES[currentLanguage];
  const parts = args.trim().split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    ctx.ui.notify(locale.aqsetShow(getQuotaSettings()), "info");
    return;
  }

  if (parts.length === 1 && parts[0] === "reset") {
    resetQuotaSettings();
    writeDiskCacheAsync();
    activeWidget?.refresh();
    ctx.ui.notify(locale.aqsetReset, "info");
    return;
  }

  if (parts.length !== 3) {
    ctx.ui.notify(locale.aqsetUsage, "warning");
    return;
  }
  const [rawRed, rawYellow, rawAlert] = parts;
  const red = Number(rawRed);
  const yellow = Number(rawYellow);
  const alert = Number(rawAlert);
  const valid =
    Number.isFinite(red) && red > 0 && red < 100 &&
    Number.isFinite(yellow) && yellow > 0 && yellow < 100 &&
    Number.isFinite(alert) && alert > 0 &&
    red > yellow;
  if (!valid) {
    ctx.ui.notify(locale.aqsetUsage, "warning");
    return;
  }

  setQuotaSettings({ pctRed: red, pctYellow: yellow, balanceAlert: alert });
  writeDiskCacheAsync();
  await diskWriteQueue;

  activeWidget?.refresh();
  ctx.ui.notify(locale.aqsetApplied(getQuotaSettings()), "info");
}

async function runAqAuto(args: string, ctx: ExtensionContext): Promise<void> {
  const raw = args.trim();

  const now = Date.now();
  if (raw !== "" && raw === lastAqautoArgs && now - lastAqautoAt < AQAUTO_DEBOUNCE_MS) return;
  lastAqautoArgs = raw;
  lastAqautoAt = now;

  const locale = LOCALES[currentLanguage];
  const parts = raw.split(/\s+/).filter(Boolean);

  if (parts.length === 0) {
    const minutes = getQuotaSettings().autoRefreshMinutes;
    ctx.ui.notify(minutes > 0 ? locale.aqautoStatusOn(minutes) : locale.aqautoStatusOff, "info");
    return;
  }

  const [cmd] = parts;
  let value: number | null = null;
  if (parts.length === 1) {
    const n = Number(cmd);

    if (Number.isInteger(n) && n >= 0 && n <= AUTO_REFRESH_MAX_MINUTES) value = n;
  }
  if (value === null) {
    ctx.ui.notify(locale.aqautoUsage, "warning");
    return;
  }

  setQuotaSettings({ autoRefreshMinutes: value });
  writeDiskCacheAsync();
  await diskWriteQueue;
  ctx.ui.notify(value > 0 ? locale.aqautoEnabled(value) : locale.aqautoDisabled, "info");
}

function isSafeDisplayText(value: unknown, maxLength: number, allowEmpty = false): value is string {
  return typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    value.length <= maxLength &&
    !UNSAFE_DISPLAY_TEXT_RE.test(value);
}

function isSafeMetricName(value: unknown): value is string {
  return isSafeDisplayText(value, MAX_METRIC_NAME_LENGTH) && !UNSAFE_OBJECT_KEYS.has(value);
}

function safeDisplayText(value: string, maxLength = 96): string {
  return value
    .replace(UNSAFE_DISPLAY_TEXT_GLOBAL_RE, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function providerDisplayName(provider: string): string {
  return PROVIDER_LABELS[provider] ?? safeDisplayText(provider);
}

function aqPickModels(ctx: ExtensionContext): PiModel[] {
  const source = ctx.scopedModels.length > 0
    ? ctx.scopedModels.map((entry) => entry.model)
    : ctx.modelRegistry.getAvailable();
  const seen = new Set<string>();
  const models: PiModel[] = [];
  for (const model of source) {
    const provider = normalizeProvider(model.provider);
    if (!provider || isUnProvider(provider)) continue;
    const key = `${provider}/${model.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    models.push(model);
  }
  return models;
}

function aqPickResetText(resetAt: number | undefined): string {
  if (resetAt === undefined) return "";
  const remaining = resetAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) return "";
  return remaining >= 24 * 3_600_000 ? formatDays(remaining) : formatRemaining(remaining);
}

function aqPickSummary(snapshot: QuotaSnapshot): string {
  const locale = LOCALES[currentLanguage];
  if (snapshot.kind === "balance") {
    const value = snapshot.metrics.balance;
    return `${locale.balance} ${safeDisplayText(snapshot.currency ?? "", MAX_CURRENCY_LENGTH)}${value.toFixed(2)}`;
  }

  return Object.entries(snapshot.metrics).map(([metric, rawPct]) => {
    const label = metric === "used" ? locale.usage : metric;
    const pct = Math.round(clampPct(rawPct));
    const usage = currentLanguage === "zh"
      ? `${label}${locale.aqpickUsed}${pct}%`
      : `${label} ${locale.aqpickUsed} ${pct}%`;
    const reset = aqPickResetText(snapshot.resetAt?.[metric]);
    if (!reset) return usage;
    const resetText = locale.aqpickResetsIn(reset);
    return currentLanguage === "zh" ? `${usage}（${resetText}）` : `${usage} (${resetText})`;
  }).join(" · ");
}

async function fetchAqPickProvider(
  ctx: ExtensionContext,
  provider: string,
  models: PiModel[],
  signal: AbortSignal,
): Promise<AqPickProvider | null> {
  const resolved = await ctx.modelRegistry.getProviderAuth(provider);
  const resolvedAuth = resolved?.auth;
  const apiKey = resolvedAuth?.apiKey || bearerFromAuthHeaders(resolvedAuth?.headers);
  if (!apiKey || signal.aborted) return null;

  const auth: Auth = { apiKey, baseUrl: resolvedAuth?.baseUrl };
  const payload = await fetchProviderQuota(provider, auth, signal);
  if (!payload || signal.aborted) return null;
  validatePayload(payload);
  return {
    id: provider,
    label: providerDisplayName(provider),
    models,
    snapshot: { provider, fetchedAt: Date.now(), ...payload },
  };
}

async function collectAqPickProviders(ctx: ExtensionContext): Promise<AqPickProvider[]> {
  const grouped = new Map<string, PiModel[]>();
  for (const model of aqPickModels(ctx)) {
    const provider = normalizeProvider(model.provider);
    if (!provider) continue;
    const models = grouped.get(provider) ?? [];
    models.push(model);
    grouped.set(provider, models);
  }
  const entries = [...grouped.entries()];
  if (entries.length === 0) return [];

  aqPickController?.abort();
  const controller = new AbortController();
  aqPickController = controller;
  const choices: AqPickProvider[] = [];
  let timedOut = false;

  const work = Promise.all(entries.map(async ([provider, models]) => {
    try {
      const choice = await fetchAqPickProvider(ctx, provider, models, controller.signal);
      if (choice && !controller.signal.aborted) choices.push(choice);
    } catch {}
  })).then(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve();
    }, AQPICK_TIMEOUT_MS);
  });

  await Promise.race([work, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  if (timedOut) void work.catch(() => {});
  if (aqPickController === controller) aqPickController = null;

  const current = normalizeProvider(ctx.model?.provider);
  choices.sort((a, b) => {
    if (a.id === current && b.id !== current) return -1;
    if (b.id === current && a.id !== current) return 1;
    return a.label.localeCompare(b.label, "en", { sensitivity: "base" }) || a.id.localeCompare(b.id);
  });

  return choices;
}

function aqPickProviderOption(choice: AqPickProvider, current: string | null): string {
  const locale = LOCALES[currentLanguage];
  const marker = choice.id === current
    ? currentLanguage === "zh" ? `（${locale.aqpickCurrent}）` : ` (${locale.aqpickCurrent})`
    : "";
  return `${choice.label}${marker} — ${aqPickSummary(choice.snapshot)}`;
}

function aqPickModelOption(model: PiModel, current: PiModel | undefined): string {
  const name = safeDisplayText(model.name);
  const id = safeDisplayText(model.id);
  const base = name === id ? id : `${name} (${id})`;
  if (model.provider !== current?.provider || model.id !== current.id) return base;
  const marker = LOCALES[currentLanguage].aqpickCurrent;
  return currentLanguage === "zh" ? `${base}（${marker}）` : `${base} (${marker})`;
}

async function runAqPick(args: string, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
  const locale = LOCALES[currentLanguage];
  if (args.trim() !== "") {
    ctx.ui.notify(locale.aqpickUsage, "warning");
    return;
  }
  if (!ctx.hasUI) {
    ctx.ui.notify(locale.aqpickRequiresUi, "warning");
    return;
  }

  ctx.ui.setStatus(AQPICK_STATUS_KEY, locale.aqpickRefreshing);
  let choices: AqPickProvider[];
  try {
    choices = await collectAqPickProviders(ctx);
  } finally {
    ctx.ui.setStatus(AQPICK_STATUS_KEY, undefined);
  }
  if (choices.length === 0) {
    ctx.ui.notify(locale.aqpickNoProviders, "warning");
    return;
  }

  const current = normalizeProvider(ctx.model?.provider);
  const providerOptions = choices.map((choice) => ({
    choice,
    text: aqPickProviderOption(choice, current),
  }));
  const providerText = await ctx.ui.select(locale.aqpickProviderPrompt, providerOptions.map((item) => item.text));
  if (!providerText) return;
  const selectedProvider = providerOptions.find((item) => item.text === providerText)?.choice;
  if (!selectedProvider) return;

  let selectedModel: PiModel | undefined;
  if (selectedProvider.models.length === 1) {
    selectedModel = selectedProvider.models[0];
  } else {
    const modelOptions = selectedProvider.models.map((model) => ({
      model,
      text: aqPickModelOption(model, ctx.model),
    }));
    const modelText = await ctx.ui.select(
      locale.aqpickModelPrompt(selectedProvider.label),
      modelOptions.map((item) => item.text),
    );
    if (!modelText) return;
    selectedModel = modelOptions.find((item) => item.text === modelText)?.model;
  }
  if (!selectedModel) return;

  const previousState = providerState.get(selectedProvider.id);
  const previousStateCopy = previousState ? { ...previousState } : undefined;
  updateSuccessfulLine(selectedProvider.id, selectedProvider.snapshot, "aqpick");

  const switchSnapshot = {
    provider: selectedProvider.id,
    fetchedAt: selectedProvider.snapshot.fetchedAt,
  };
  aqPickSwitchSnapshot = switchSnapshot;
  let switched = false;
  try {
    switched = await pi.setModel(selectedModel);
  } catch {}
  if (!switched) {
    if (previousStateCopy) providerState.set(selectedProvider.id, previousStateCopy);
    else providerState.delete(selectedProvider.id);
    if (aqPickSwitchSnapshot === switchSnapshot) aqPickSwitchSnapshot = null;
    ctx.ui.notify(locale.aqpickSwitchFailed, "warning");
    return;
  }
  if (aqPickSwitchSnapshot === switchSnapshot) aqPickSwitchSnapshot = null;
  lastAutoAttemptAt = Date.now();
  writeDiskCacheAsync();
  ctx.ui.notify(
    locale.aqpickSwitched(safeDisplayText(selectedProvider.id), safeDisplayText(selectedModel.id)),
    "info",
  );
}

async function runAq10(ctx: ExtensionContext): Promise<void> {
  const locale = LOCALES[currentLanguage];
  const providerId = normalizeProvider(ctx.model?.provider);
  if (!providerId) {
    ctx.ui.notify(locale.noActiveProvider, "warning");
    return;
  }
  const safeProviderId = safeDisplayText(providerId);
  if (isUnProvider(providerId)) {
    ctx.ui.notify(`${safeProviderId}: ${locale.quotaUnavailable}`, "info");
    return;
  }
  const records = providerState.get(providerId)?.consumptions ?? [];
  if (records.length === 0) {
    ctx.ui.notify(`${safeProviderId}: ${locale.noConsumptionRecords}`, "info");
    return;
  }
  const body = summarizeConsumptions(records);
  if (!body) {
    ctx.ui.notify(`${safeProviderId}: ${locale.noConsumptionRecords}`, "info");
    return;
  }
  const colored = hexFg(QUOTA_COLORS.consumption, body);
  ctx.ui.notify(`${safeProviderId} ${locale.aq10Rounds(records.length)} ${colored}`, "info");
}

function registerLocalizedCommands(pi: ExtensionAPI): void {
  const locale = LOCALES[currentLanguage];
  pi.registerCommand(AQCHECK_CMD_NAME, {
    description: locale.aqcheckDescription,
    handler: async (_args, ctx) => {
      await runAqCheck(ctx);
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
  pi.registerCommand(AQSET_CMD_NAME, {
    description: locale.aqsetDescription,
    handler: async (args, ctx) => {
      await runAqSet(args, ctx);
    },
  });
  pi.registerCommand(AQAUTO_CMD_NAME, {
    description: locale.aqautoDescription,
    handler: async (args, ctx) => {
      await runAqAuto(args, ctx);
    },
  });
  pi.registerCommand(AQPICK_CMD_NAME, {
    description: locale.aqpickDescription,
    handler: async (args, ctx) => {
      await runAqPick(args, ctx, pi);
    },
  });
}

export default function (pi: ExtensionAPI) {
  pi.on("session_shutdown", async () => {

    isShuttingDown = true;
    stopAgeTicker();
    const request = inflightRequest;
    inflightRequest = null;
    request?.controller.abort();
    aqPickController?.abort();
    aqPickController = null;
    aqPickSwitchSnapshot = null;

    await diskWriteQueue;
  });
  pi.on("session_start", (event, ctx) => {
    handleSessionStart(ctx, event.reason);
    ensureAgeTicker();
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
  if (!Array.isArray(p.items) || p.items.length === 0 || p.items.length > MAX_PAYLOAD_ITEMS) {
    throw new Error("invalid quota items");
  }

  const metrics = p.metrics;
  if (!metrics || typeof metrics !== "object" || Array.isArray(metrics)) {
    throw new Error("invalid quota metrics");
  }
  const metricEntries = Object.entries(metrics);
  if (
    metricEntries.length === 0 ||
    metricEntries.length > MAX_PAYLOAD_METRICS ||
    metricEntries.some(([key, value]) => !isSafeMetricName(key) || !Number.isFinite(value))
  ) {
    throw new Error("invalid quota metrics");
  }

  if (p.resetAt !== undefined) {
    if (!p.resetAt || typeof p.resetAt !== "object" || Array.isArray(p.resetAt)) {
      throw new Error("invalid quota resetAt");
    }
    const resetEntries = Object.entries(p.resetAt);
    if (
      resetEntries.length > MAX_PAYLOAD_METRICS ||
      resetEntries.some(([key, value]) =>
        !isSafeMetricName(key) ||
        !Object.hasOwn(metrics, key) ||
        typeof value !== "number" ||
        !Number.isFinite(value) ||
        value <= 0)
    ) {
      throw new Error("invalid quota resetAt");
    }
  }

  for (const raw of p.items) {
    if (!raw || typeof raw !== "object") throw new Error("invalid quota item");
    const item = raw as Record<string, unknown>;
    switch (item.kind) {
      case "text":
      case "annotation":
        if (!isSafeDisplayText(item.text, MAX_DISPLAY_TEXT_LENGTH, true)) {
          throw new Error("invalid quota text");
        }
        break;
      case "pct": {
        const pct = item.pct;
        if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0) {
          throw new Error("invalid quota pct");
        }
        if (item.metric !== undefined && !isSafeMetricName(item.metric)) {
          throw new Error("invalid quota metric");
        }
        break;
      }
      case "balance": {
        const value = item.value;
        if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("invalid quota balance");
        if (!isSafeDisplayText(item.currency, MAX_CURRENCY_LENGTH)) {
          throw new Error("invalid balance currency");
        }
        if (item.metric !== undefined && !isSafeMetricName(item.metric)) {
          throw new Error("invalid quota metric");
        }
        break;
      }
      default:
        throw new Error("invalid quota item kind");
    }
  }
  if (p.kind === "balance") {
    if (!isSafeDisplayText(p.currency, MAX_CURRENCY_LENGTH)) throw new Error("invalid balance currency");
    if (!Number.isFinite(metrics.balance)) throw new Error("invalid balance");
  }
}

function isValidConsumptionRecord(value: unknown): value is ConsumptionRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ConsumptionRecord>;
  if (!Number.isFinite(record.at)) return false;
  if (record.kind !== "balance" && record.kind !== "quota") return false;
  if (!record.deltas || typeof record.deltas !== "object" || Array.isArray(record.deltas)) return false;
  if (record.currency !== undefined && !isSafeDisplayText(record.currency, MAX_CURRENCY_LENGTH)) return false;
  const entries = Object.entries(record.deltas);
  return entries.length > 0 &&
    entries.length <= MAX_PAYLOAD_METRICS &&
    entries.every(([key, amount]) => isSafeMetricName(key) && Number.isFinite(amount) && amount <= 0);
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

    const value = diff.deltas.balance;
    if (Number.isFinite(value)) {
      if (value < 0) out.balance = value;
      else if (value === 0) out.balance = 0;
    }
  } else if (diff.kind === "quota") {

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

function currentEta(provider: string): EtaEstimate | null {
  const snap = latestLineSnapshot(provider);
  const records = providerState.get(provider)?.consumptions;
  if (!snap || !records) return null;

  const metrics = Object.keys(snap.metrics);

  if (snap.kind === "balance") {
    return estimateEta(toSamples(records, "balance"), snap.metrics.balance ?? 0);
  }

  for (const metric of metrics) {
    if (100 - clampPct(snap.metrics[metric]) <= 0) return null;
  }

  const rateMetric = RATE_METRIC_PRIORITY.find((m) => metrics.includes(m)) ?? null;
  if (rateMetric === null) return null;
  const rateSamples = toSamples(records, rateMetric);
  const remainingRate = 100 - clampPct(snap.metrics[rateMetric]);
  const rateEta = estimateEta(rateSamples, remainingRate);
  if (rateEta?.zeroRounds !== undefined) {

    return { rounds: 0, activeMs: 0, zeroRounds: rateEta.zeroRounds };
  }
  if (!rateEta || rateEta.rounds <= 0 || rateEta.activeMs <= 0) return null;
  const perRound = remainingRate / rateEta.rounds;
  if (!Number.isFinite(perRound) || perRound <= 0) return null;

  const msPerRound = medianGapMs(rateSamples);

  let best: EtaEstimate | null = null;
  let bestRounds = Number.POSITIVE_INFINITY;
  for (const metric of metrics) {
    const remaining = 100 - clampPct(snap.metrics[metric]);
    const resetAt = snap.resetAt?.[metric];
    if (resetAt !== undefined) {
      const resetRemainingMs = resetAt - Date.now();
      if (resetRemainingMs <= 0) return null;
      const roundsInWindow = remaining / perRound;
      const activeMs = roundsInWindow * msPerRound;
      if (activeMs > resetRemainingMs) {

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

  if (eta.zeroRounds !== undefined) {
    return locale.etaZeroRounds(eta.zeroRounds);
  }

  if (eta.rounds > ETA_MAX_ROUNDS) {
    return locale.etaCapped(ETA_MAX_ROUNDS);
  }
  const rounds = Math.max(1, Math.round(eta.rounds));

  const time = eta.activeMs >= 24 * 3_600_000 ? formatDays(eta.activeMs) : formatRemaining(eta.activeMs);
  const isUrgentRounds = rounds <= 5;
  const isUrgentTime = eta.activeMs <= 30 * 60_000;

  const roundsPart = isUrgentRounds ? hexFg(QUOTA_COLORS.red, String(rounds)) : String(rounds);
  const timePart = isUrgentTime ? hexFg(QUOTA_COLORS.red, time) : time;
  if (!time) {
    return locale.etaRoundsOnly(roundsPart);
  }
  return locale.etaWithTime(roundsPart, timePart);
}
