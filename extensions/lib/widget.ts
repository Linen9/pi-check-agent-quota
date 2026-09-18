import type { Theme } from "@earendil-works/pi-coding-agent";

export type RenderItem =
  | { kind: "text"; text: string }
  | { kind: "pct"; pct: number; metric?: string }
  | { kind: "balance"; value: number; currency: string; metric?: string }
  | { kind: "annotation"; text: string }
  | { kind: "age"; text: string }
  | { kind: "eta"; text: string };

export type Language = "zh" | "en";

export type Locale = {
  usage: string;
  balance: string;
  using: string;
  fetching: string;
  failed: string;
  changed: string;
  reset: string;
  noConsumptionRecords: string;
  quotaUnavailable: string;
  noActiveProvider: string;
  aq10Rounds: (count: number) => string;
  languageChanged: (language: Language) => string;
  invalidLanguage: string;
  aqcheckDescription: string;
  aq10Description: string;
  aqlangDescription: string;
  aqsetDescription: string;
  aqsetUsage: string;
  aqsetShow: (s: { pctYellow: number; pctRed: number; balanceAlert: number }) => string;
  aqsetApplied: (s: { pctYellow: number; pctRed: number; balanceAlert: number }) => string;
  aqsetReset: string;
  aqautoDescription: string;
  aqautoUsage: string;
  aqautoStatusOn: (minutes: number) => string;
  aqautoStatusOff: string;
  aqautoEnabled: (minutes: number) => string;
  aqautoDisabled: string;
  aqpickDescription: string;
  aqpickUsage: string;
  aqpickRefreshing: string;
  aqpickProviderPrompt: string;
  aqpickModelPrompt: (provider: string) => string;
  aqpickNoProviders: string;
  aqpickRequiresUi: string;
  aqpickSwitchFailed: string;
  aqpickSwitched: (provider: string, model: string) => string;
  aqpickCurrent: string;
  aqpickUsed: string;
  aqpickResetsIn: (time: string) => string;
  etaZeroRounds: (count: number) => string;
  etaRoundsOnly: (rounds: string) => string;
  etaWithTime: (rounds: string, time: string) => string;
  etaCapped: (max: number) => string;
};

export const LOCALES: Record<Language, Locale> = {
  zh: {
    usage: "限额",
    balance: "余额",
    using: "使用中",
    fetching: "请求中",
    failed: "失败",
    changed: "变更",
    reset: "已重置",
    noConsumptionRecords: "暂无消耗记录",
    quotaUnavailable: "限额不可用",
    noActiveProvider: "当前没有 provider",
    aq10Rounds: (count) => `近${count}轮消耗`,
    languageChanged: () => "语言已切换为中文",
    invalidLanguage: "语言参数只支持 zh 或 en",
    aqcheckDescription: "强制刷新限额并显示当前 provider 详情",
    aq10Description: "显示最近 10 轮对话消耗记录",
    aqlangDescription: "切换界面语言（zh/en）",
    aqsetDescription: "查看/设置显示阈值：/aqset <红> <黄> <余额告警>，无参数查看",
    aqsetUsage: "用法：/aqset <红阈值> <黄阈值> <余额告警>，如 /aqset 80 40 10（红线需大于黄线）",
    aqsetShow: (s) => `当前阈值：/aqset ${s.pctRed} ${s.pctYellow} ${s.balanceAlert}（红色≥${s.pctRed} 黄色≥${s.pctYellow} 余额≤${s.balanceAlert}）`,
    aqsetApplied: (s) => `已设置：红色≥${s.pctRed} 黄色≥${s.pctYellow} 余额≤${s.balanceAlert}，立即生效并持久化`,
    aqsetReset: "已恢复默认阈值",
    aqautoDescription: "查看/设置挂机自动抓取：/aqauto <分钟>（0-30，0=关闭）",
    aqautoUsage: "用法：/aqauto <分钟数>，只接受 0-30 的整数（0=关闭），如 /aqauto 4",
    aqautoStatusOn: (minutes) => `自动抓取：每 ${minutes} 分钟一次`,
    aqautoStatusOff: "自动抓取：关闭",
    aqautoEnabled: (minutes) => `已开启：每 ${minutes} 分钟自动抓取，立即生效并持久化`,
    aqautoDisabled: "已关闭自动抓取，立即生效并持久化",
    aqpickDescription: "现场刷新配额并按 provider 选择模型",
    aqpickUsage: "用法：/aqpick（不接受参数）",
    aqpickRefreshing: "正在刷新可选 provider 的配额…",
    aqpickProviderPrompt: "选择 provider（实时配额）",
    aqpickModelPrompt: (provider) => `选择 ${provider} 的模型`,
    aqpickNoProviders: "没有获取到可选 provider 的实时配额",
    aqpickRequiresUi: "/aqpick 需要可交互界面",
    aqpickSwitchFailed: "模型切换失败，当前模型未改变",
    aqpickSwitched: (provider, model) => `已切换至 ${provider}/${model}`,
    aqpickCurrent: "当前",
    aqpickUsed: "已用",
    aqpickResetsIn: (time) => `${time}后重置`,
    etaZeroRounds: (count) => ` 预计可用：近${count}轮0消耗`,
    etaRoundsOnly: (rounds) => ` 预计可用：${rounds}轮`,
    etaWithTime: (rounds, time) => ` 预计可用：${rounds}轮/${time}`,
    etaCapped: (max) => ` 预计可用：${max}+轮`,
  },
  en: {
    usage: "Usage",
    balance: "Balance",
    using: "using",
    fetching: "Fetching",
    failed: "Failed",
    changed: "changed",
    reset: "reset",
    noConsumptionRecords: "no consumption records",
    quotaUnavailable: "quota unavailable",
    noActiveProvider: "No active provider",
    aq10Rounds: (count) => `last ${count} rounds`,
    languageChanged: (language) => `Language switched to ${language === "zh" ? "Chinese" : "English"}`,
    invalidLanguage: "Language must be zh or en",
    aqcheckDescription: "Force-refresh quota and show detailed widget for current provider",
    aq10Description: "Show the last 10 conversation consumption records",
    aqlangDescription: "Switch interface language (zh/en)",
    aqsetDescription: "View/set display thresholds: /aqset <red> <yellow> <balance alert>, no args to view",
    aqsetUsage: "Usage: /aqset <red> <yellow> <balanceAlert>, e.g. /aqset 80 40 10 (red must be above yellow)",
    aqsetShow: (s) => `Current: /aqset ${s.pctRed} ${s.pctYellow} ${s.balanceAlert} (red ≥${s.pctRed}, yellow ≥${s.pctYellow}, balance ≤${s.balanceAlert})`,
    aqsetApplied: (s) => `Set: red ≥${s.pctRed}, yellow ≥${s.pctYellow}, balance ≤${s.balanceAlert}, effective immediately and persisted`,
    aqsetReset: "Thresholds reset to defaults",
    aqautoDescription: "View/set idle auto refresh: /aqauto <minutes> (0-30, 0 = off)",
    aqautoUsage: "Usage: /aqauto <minutes>; accepts integers from 0 to 30 only (0 = off), e.g. /aqauto 4",
    aqautoStatusOn: (minutes) => `Auto refresh: every ${minutes} minutes`,
    aqautoStatusOff: "Auto refresh: off",
    aqautoEnabled: (minutes) => `Enabled: auto refresh every ${minutes} minutes, effective immediately and persisted`,
    aqautoDisabled: "Auto refresh disabled, effective immediately and persisted",
    aqpickDescription: "Refresh live quotas and choose a model by provider",
    aqpickUsage: "Usage: /aqpick (no arguments)",
    aqpickRefreshing: "Refreshing quota for selectable providers…",
    aqpickProviderPrompt: "Choose provider (live quota)",
    aqpickModelPrompt: (provider) => `Choose a model from ${provider}`,
    aqpickNoProviders: "No selectable provider returned live quota",
    aqpickRequiresUi: "/aqpick requires an interactive UI",
    aqpickSwitchFailed: "Model switch failed; current model was not changed",
    aqpickSwitched: (provider, model) => `Switched to ${provider}/${model}`,
    aqpickCurrent: "current",
    aqpickUsed: "used",
    aqpickResetsIn: (time) => `resets in ${time}`,
    etaZeroRounds: (count) => ` Available: 0 used in last ${count} rounds`,
    etaRoundsOnly: (rounds) => ` Available: ${rounds} rounds`,
    etaWithTime: (rounds, time) => ` Available: ${rounds} rounds / ${time}`,
    etaCapped: (max) => ` Available: ${max}+ rounds`,
  },
};

export function normalizeLanguage(value: unknown): Language | null {
  return value === "zh" || value === "en" ? value : null;
}

const MISSING = "--";

export type QuotaSettings = {
  pctYellow: number;
  pctRed: number;
  balanceAlert: number;
  autoRefreshMinutes: number;
};

function envNum(name: string, fallback: number, min: number, max: number): number {
  const raw = Number(process.env[name]);
  if (!Number.isFinite(raw) || raw <= min || raw >= max) return fallback;
  return raw;
}

export const AUTO_REFRESH_MAX_MINUTES = 30;

function computeSettingsDefaults(): QuotaSettings {
  const pctYellow = envNum("PI_QUOTA_PCT_YELLOW", 40, 0, 100);
  const configuredRed = envNum("PI_QUOTA_PCT_RED", 80, 0, 100);

  const pctRed = configuredRed > pctYellow ? configuredRed : 80;
  const safeYellow = pctRed > pctYellow ? pctYellow : 40;
  return {
    pctYellow: safeYellow,
    pctRed,
    balanceAlert: envNum("PI_QUOTA_BALANCE_ALERT", 10, 0, Number.MAX_SAFE_INTEGER),

    autoRefreshMinutes: Math.min(
      AUTO_REFRESH_MAX_MINUTES,
      Math.max(0, envNum("PI_QUOTA_AUTO_REFRESH_MINUTES", 0, 0, Number.MAX_SAFE_INTEGER)),
    ),
  };
}

export const QUOTA_SETTINGS_DEFAULTS: Readonly<QuotaSettings> = computeSettingsDefaults();

let _quotaSettings: QuotaSettings = computeSettingsDefaults();

export function getQuotaSettings(): Readonly<QuotaSettings> {
  return _quotaSettings;
}

export function setQuotaSettings(patch: Partial<QuotaSettings>): Readonly<QuotaSettings> {
  const next = { ..._quotaSettings };
  if (patch.pctYellow !== undefined && Number.isFinite(patch.pctYellow) && patch.pctYellow > 0 && patch.pctYellow < 100) {
    next.pctYellow = patch.pctYellow;
  }
  if (patch.pctRed !== undefined && Number.isFinite(patch.pctRed) && patch.pctRed > 0 && patch.pctRed < 100) {
    next.pctRed = patch.pctRed;
  }
  if (patch.balanceAlert !== undefined && Number.isFinite(patch.balanceAlert) && patch.balanceAlert > 0) {
    next.balanceAlert = patch.balanceAlert;
  }
  if (patch.autoRefreshMinutes !== undefined && Number.isFinite(patch.autoRefreshMinutes)) {

    next.autoRefreshMinutes = Math.min(AUTO_REFRESH_MAX_MINUTES, Math.max(0, Math.round(patch.autoRefreshMinutes)));
  }

  if (next.pctRed > next.pctYellow) {
    _quotaSettings = next;
  } else {
    _quotaSettings = {
      ...next,
      pctRed: _quotaSettings.pctRed,
      pctYellow: _quotaSettings.pctYellow,
    };
  }
  return _quotaSettings;
}

export function resetQuotaSettings(): Readonly<QuotaSettings> {

  _quotaSettings = computeSettingsDefaults();
  return _quotaSettings;
}

export const QUOTA_COLORS = {
  green: "#1FA87A",
  yellow: "#F09A3E",
  red: "#EE7A5F",
  consumption: "#7A5FD0",
} as const;

let _currentLanguage: Language = "zh";
export function setCurrentLanguage(lang: Language) { _currentLanguage = lang; }
export function getCurrentLanguage(): Language { return _currentLanguage; }

export function hexFg(hex: string, text: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

export function pctColor(pct: number, _theme?: Theme): string {
  const safe = clampPct(pct);
  const rounded = `${Math.round(safe)}%`;
  const settings = getQuotaSettings();
  if (safe >= settings.pctRed) return hexFg(QUOTA_COLORS.red, rounded);
  if (safe >= settings.pctYellow) return hexFg(QUOTA_COLORS.yellow, rounded);
  return hexFg(QUOTA_COLORS.green, rounded);
}

export function balanceColor(value: number, currency: string, theme: Theme): string {
  const safe = Number.isFinite(value) && value !== 0 ? value : 0;
  if (safe <= getQuotaSettings().balanceAlert) return hexFg(QUOTA_COLORS.red, `${currency}${safe.toFixed(2)}`);
  return theme.fg("dim", `${currency}${safe.toFixed(2)}`);
}

export function formatAge(fetchedAt: number): string {
  const ageMs = Date.now() - fetchedAt;
  if (!Number.isFinite(ageMs) || ageMs < 0) return "";
  if (ageMs < 60_000) return _currentLanguage === "zh" ? "刚刚" : "now";

  const totalMin = Math.floor(ageMs / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const totalH = Math.floor(ageMs / 3_600_000);
  const d = Math.floor(totalH / 24);
  const hRem = totalH % 24;
  const mo = Math.floor(d / 30);
  const dRem = d % 30;
  if (_currentLanguage === "zh") {
    if (mo > 0) return dRem > 0 ? `${mo}个月${dRem}天前` : `${mo}个月前`;
    if (d > 0) return hRem > 0 ? `${d}天${hRem}小时前` : `${d}天前`;
    if (h > 0) return m > 0 ? `${h}小时${m}分钟前` : `${h}小时前`;
    return `${m}分钟前`;
  } else {
    if (mo > 0) return dRem > 0 ? `${mo}mo${dRem}d ago` : `${mo}mo ago`;
    if (d > 0) return hRem > 0 ? `${d}d${hRem}h ago` : `${d}d ago`;
    if (h > 0) return m > 0 ? `${h}h${m}m ago` : `${h}h ago`;
    return `${m}m ago`;
  }
}

export function formatItems(items: RenderItem[], theme: Theme): string {
  return items
    .map((it) => {
      if (it.kind === "text") return theme.fg("dim", localizeText(it.text));
      if (it.kind === "pct") return pctColor(it.pct, theme);
      if (it.kind === "balance") return balanceColor(it.value, it.currency, theme);
      if (it.kind === "eta") return theme.fg("dim", localizeText(it.text));
      if (it.kind === "age") return theme.fg("dim", it.text);
      const text = localizeText(it.text);
      return hexFg(QUOTA_COLORS.consumption, text);
    })
    .join("");
}

export function localizeText(text: string): string {
  const locale = LOCALES[_currentLanguage];
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
    [" (reset)", ` (${locale.reset})`],
    [" (已重置)", ` (${locale.reset})`],
  ];
  for (const [source, replacement] of statuses) {
    if (text === source) return replacement;
  }
  return text;
}

export function annotateItems(
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

export function tier(prefix: string, label: string, pct: number, reset: string): RenderItem[] {
  return [
    { kind: "text", text: prefix + label },
    { kind: "pct", pct, metric: label.trim() },
    { kind: "text", text: reset ? ` (${reset})` : "" },
  ];
}

export function missingItems(): RenderItem[] {
  return [{ kind: "text", text: MISSING }];
}

export function emptyItems(): RenderItem[] {
  return [];
}

export interface Component {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

export class QuotaComponent implements Component {
  private cache: { width: number; language: Language; theme: Theme | null; lines: string[] } | null = null;
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
    const curTheme = this.themeRef();
    const curLang = _currentLanguage;
    if (this.cache && this.cache.width === width && this.cache.language === curLang && this.cache.theme === curTheme) return this.cache.lines;

    const splitIdx = this.items.findIndex((it) => it.kind === "age" || it.kind === "eta");
    if (splitIdx === -1) {
      const text = formatItems(this.items, curTheme);
      const lines = text ? [truncateAnsi(text, width)] : [];
      this.cache = { width, language: curLang, theme: curTheme, lines };
      return lines;
    }
    const leftItems = this.items.slice(0, splitIdx);
    const rightItemsFull = this.items.slice(splitIdx);
    const left = formatItems(leftItems, curTheme);
    const rightFull = formatItems(rightItemsFull, curTheme);
    const lw = visibleWidth(left);
    const rwFull = visibleWidth(rightFull);
    if (lw + rwFull + 1 <= width) {
      const pad = " ".repeat(width - lw - rwFull);
      const lines = [left + pad + rightFull];
      this.cache = { width, language: curLang, theme: curTheme, lines };
      return lines;
    }

    let right = rightFull;
    let rw = rwFull;
    const hasAge = rightItemsFull.some((it) => it.kind === "age");
    if (width < 60 && hasAge) {
      const stripped = rightItemsFull.filter((it) => it.kind !== "age");
      const rightStripped = formatItems(stripped, curTheme);
      const rwStripped = visibleWidth(rightStripped);
      if (lw + rwStripped + 1 <= width) {
        const pad = " ".repeat(width - lw - rwStripped);
        const lines = [left + pad + rightStripped];
        this.cache = { width, language: curLang, theme: curTheme, lines };
        return lines;
      }
      right = rightStripped;
      rw = rwStripped;
    }

    const line1 = left ? truncateAnsi(left, width) : "";
    const pad2 = " ".repeat(Math.max(0, width - rw));
    const line2 = rw <= width ? pad2 + right : truncateAnsi(right, width);
    const lines = line1 ? [line1, line2] : [line2];
    this.cache = { width, language: curLang, theme: curTheme, lines };
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

export function renderItemsEqual(a: RenderItem[], b: RenderItem[]): boolean {
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
              : item.kind === "age" && other.kind === "age"
                ? item.text === other.text
                : item.kind === "eta" && other.kind === "eta"
                  ? item.text === other.text
                  : false);
  });
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

export const ANSI_RE = /\x1b\[[0-9;]*m/g;

export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) continue;
    if (cp >= 0x0300 && cp <= 0x036f) continue;
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

export function truncateAnsi(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (visibleWidth(s) <= maxWidth) return s;

  const ELLIPSIS = "…";
  const budget = maxWidth - 1;
  let out = "";
  let w = 0;
  let i = 0;

  while (i < s.length) {
    ANSI_RE.lastIndex = i;
    const m = ANSI_RE.exec(s);
    if (m && m.index === i) {
      out += m[0];
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
