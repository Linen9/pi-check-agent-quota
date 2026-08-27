// lib/widget.ts
// 渲染 + 组件 + i18n + ANSI 工具。纯函数，零 providers 依赖。

import type { Theme } from "@earendil-works/pi-coding-agent";

export type RenderItem =
  | { kind: "text"; text: string }
  | { kind: "pct"; pct: number; metric?: string }
  | { kind: "balance"; value: number; currency: string; metric?: string }
  | { kind: "annotation"; text: string };


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
  checkaqDescription: string;
  aq10Description: string;
  aqlangDescription: string;
  etaWithTime: (rounds: number, time: string) => string;
  etaRoundsOnly: (rounds: number) => string;
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
    checkaqDescription: "强制刷新限额并显示当前 provider 详情",
    aq10Description: "显示最近 10 轮对话消耗记录",
    aqlangDescription: "切换界面语言（zh/en）",
    etaWithTime: (rounds, time) => ` 预计可用：${rounds}轮/${time}`,
    etaRoundsOnly: (rounds) => ` 预计可用：${rounds}轮`,
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
    checkaqDescription: "Force-refresh quota and show detailed widget for current provider",
    aq10Description: "Show the last 10 conversation consumption records",
    aqlangDescription: "Switch interface language (zh/en)",
    etaWithTime: (rounds, time) => ` Available: ${rounds} rounds/${time}`,
    etaRoundsOnly: (rounds) => ` Available: ${rounds} rounds`,
  },
};

export function normalizeLanguage(value: unknown): Language | null {
  return value === "zh" || value === "en" ? value : null;
}

type DiskCache = {
  version: 2;
  language?: Language;
  active_round?: ActiveRound;
  providers: Record<string, ProviderCache>;
};

export const QUOTA_COLORS = {
  green: "#1FA87A",
  yellow: "#F09A3E",
  red: "#EE7A5F",
  consumption: "#7A5FD0",
} as const;


// widget 私有语言状态，由 index.ts 通过 setCurrentLanguage 注入
let _currentLanguage: Language = "zh";
export function setCurrentLanguage(lang: Language) { _currentLanguage = lang; }
export function getCurrentLanguage(): Language { return _currentLanguage; }

export function hexFg(hex: string, text: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

// 上色前由 clampPct 把 NaN/负值钳制到 [0,100]。
export function pctColor(pct: number): string {
  const safe = clampPct(pct);
  const rounded = `${Math.round(safe)}%`;
  if (safe >= 80) return hexFg(QUOTA_COLORS.red, rounded);
  if (safe >= 41) return hexFg(QUOTA_COLORS.yellow, rounded);
  return hexFg(QUOTA_COLORS.green, rounded);
}

export function balanceColor(value: number, currency: string, theme: Theme): string {
  const safe = Number.isFinite(value) && value !== 0 ? value : 0;
  if (safe <= BALANCE_ALERT) return hexFg(QUOTA_COLORS.red, `${currency}${safe.toFixed(2)}`);
  return theme.fg("dim", `${currency}${safe.toFixed(2)}`);
}

export function formatItems(items: RenderItem[], theme: Theme): string {
  return items
    .map((it) => {
      if (it.kind === "text") return theme.fg("dim", localizeText(it.text));
      if (it.kind === "pct") return pctColor(it.pct);
      if (it.kind === "balance") return balanceColor(it.value, it.currency, theme);
      const text = localizeText(it.text);
      // ETA 基色跟随“限额”二字（dim），仅紧急片段已在 formatEta 中标红
      if (text.includes("预计可用") || text.includes("轮·")) {
        return theme.fg("dim", text);
      }
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

// 把差值注释注入到 pct / balance 项之后。
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

// 桶型配额：`Usage: 5h X% (4h52m)` / ` / 7d X% (4d23h)`
// prefix="Usage: " 给首桶；prefix=" / " 给后续桶（自动拼上 "7d " 这种 label）
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


// 自实现 Component：只 render() 和 invalidate()。

export interface Component {
  render(width: number): string[];
  invalidate(): void;
  dispose?(): void;
}

export class QuotaComponent implements Component {
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
    // 左右贴边：左区（配额）贴左，右区（ETA）贴右；窄窗口换行
    const etaIdx = this.items.findIndex((it) => it.kind === "annotation" && it.text.includes("预计可用"));
    // 兼容英文：也检测 "est."
    const etaIdxEn = etaIdx === -1 ? this.items.findIndex((it) => it.kind === "annotation" && it.text.includes("est.")) : -1;
    const splitIdx = etaIdx !== -1 ? etaIdx : etaIdxEn;
    if (splitIdx === -1) {
      const text = formatItems(this.items, this.themeRef());
      const lines = text ? [truncateAnsi(text, width)] : [];
      this.cache = { width, lines };
      return lines;
    }
    const leftItems = this.items.slice(0, splitIdx);
    const rightItems = this.items.slice(splitIdx);
    const left = formatItems(leftItems, this.themeRef());
    const right = formatItems(rightItems, this.themeRef());
    const lw = visibleWidth(left);
    const rw = visibleWidth(right);
    if (lw + rw + 1 <= width) {
      const pad = " ".repeat(width - lw - rw);
      const lines = [left + pad + right];
      this.cache = { width, lines };
      return lines;
    } else {
      // 窄窗口：左区一行，ETA 单独一行（右贴边）
      const line1 = left ? truncateAnsi(left, width) : "";
      const pad2 = " ".repeat(Math.max(0, width - rw));
      const line2 = rw <= width ? pad2 + right : truncateAnsi(right, width);
      const lines = line1 ? [line1, line2] : [line2];
      // 截断 lines 到 MAX 10 行以内（当前最多 2 行）
      this.cache = { width, lines };
      return lines;
    }
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

export const ANSI_RE = /\x1b\[[0-9;]*m/g;

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
