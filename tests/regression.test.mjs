import assert from "node:assert/strict";
import { after, test } from "node:test";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { estimateEta, RATE_METRIC_PRIORITY } from "../extensions/lib/eta.ts";
import { extractChatGptAccountId, quotaUrl } from "../extensions/lib/providers.ts";
import { getQuotaSettings, setQuotaSettings, resetQuotaSettings, QUOTA_SETTINGS_DEFAULTS, pctColor, balanceColor, formatAge, setCurrentLanguage } from "../extensions/lib/widget.ts";

const originalHome = process.env.HOME;
const testHome = await mkdtemp(join(tmpdir(), "pi-check-agent-quota-test-"));
const cachePath = join(testHome, ".pi", "agent", "pi-check-agent-quota", "quota-cache.json");
await mkdir(join(testHome, ".pi", "agent"), { recursive: true });
process.env.HOME = testHome;
let caseId = 0;

after(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(testHome, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, "");

async function cleanCache() {
  await unlink(cachePath).catch(() => {});
  await unlink(`${cachePath}.tmp`).catch(() => {});
}

async function harness(
  provider,
  fetchImpl,
  authImpl = async () => ({ auth: { apiKey: "test-key" } }),
  options = {},
) {
  globalThis.fetch = fetchImpl;
  const mod = await import(`../extensions/index.ts?regression=${++caseId}`);
  const handlers = {};
  const commands = {};
  const widgets = [];
  const notices = [];
  const selectCalls = [];
  const setModelCalls = [];
  const statuses = [];
  let widgetSetCalls = 0;
  let activeComponent = null;
  let currentModel = options.currentModel ?? {
    provider,
    id: `${provider}-model`,
    name: `${provider}-model`,
  };
  let currentProvider = currentModel.provider;
  const availableModels = options.models ?? [currentModel];

  const pi = {
    on(name, handler) {
      handlers[name] = handler;
    },
    registerCommand(name, definition) {
      commands[name] = definition;
    },
    async setModel(model) {
      setModelCalls.push(model);
      const configured = typeof options.setModelResult === "function"
        ? await options.setModelResult(model)
        : options.setModelResult;
      const success = configured ?? true;
      if (success) {
        currentModel = model;
        currentProvider = model.provider;
        if (options.emitModelSelectOnSet && handlers.model_select) {
          await handlers.model_select({}, ctx);
        }
      }
      return success;
    },
  };
  mod.default(pi);

  const ctx = {
    get model() {
      return currentModel;
    },
    scopedModels: options.scopedModels ?? [],
    hasUI: options.hasUI ?? true,
    modelRegistry: {
      getProviderAuth: authImpl,
      getAvailable: () => availableModels,
    },
    isIdle: () => true,
    ui: {
      setWidget(_key, factory) {
        widgetSetCalls++;
        activeComponent = factory({
          requestRender() {
            if (activeComponent) widgets.push(stripAnsi(activeComponent.render(300).join("")));
          },
        }, { fg: (_color, text) => text });
        widgets.push(stripAnsi(activeComponent.render(300).join("")));
      },
      notify(message) {
        notices.push(stripAnsi(message));
      },
      setStatus(key, text) {
        statuses.push({ key, text });
      },
      async select(title, values) {
        selectCalls.push({ title, values });
        return options.select ? await options.select(title, values, selectCalls.length - 1) : undefined;
      },
    },
  };

  return {
    handlers,
    commands,
    widgets,
    notices,
    selectCalls,
    setModelCalls,
    statuses,
    get widgetSetCalls() {
      return widgetSetCalls;
    },
    ctx,
    setProvider(value) {
      currentProvider = value;
      currentModel = { ...currentModel, provider: value, id: `${value}-model`, name: `${value}-model` };
    },
  };
}

function openCodeUsage(rolling, weekly, monthly, resetSeconds = [3600, 2 * 86400, 30 * 86400]) {
  const reset = (seconds) => new Date(Date.now() + seconds * 1000).toISOString();
  return JSON.stringify({
    useBalance: false,
    usage: {
      rolling: { status: "ok", percent: rolling, resetsAt: reset(resetSeconds[0]) },
      weekly: { status: "ok", percent: weekly, resetsAt: reset(resetSeconds[1]) },
      monthly: { status: "ok", percent: monthly, resetsAt: reset(resetSeconds[2]) },
    },
  });
}

test("ETA uses hybrid v2.0: five samples minimum, large rounds folded in by frequency, zeros honest", () => {
  const samples = (deltas) => deltas.map((delta, index) => ({ at: index * 60_000, delta }));

  assert.equal(estimateEta(samples([1, 1, 1, 1]), 95), null);
  assert.ok(estimateEta(samples([1, 1, 1, 1, 1]), 95));

  const spike = estimateEta(samples([1, 1, 1, 1, 10]), 95);
  assert.ok(spike);
  assert.ok(Math.abs(spike.rounds - 95 / 2.8) < 0.01, `expected ~33.93, got ${spike.rounds}`);

  const oneZero = estimateEta(samples([1, 1, 1, 1, 0]), 95);
  assert.ok(oneZero);

  assert.equal(oneZero.rounds, 95);

  const allZero = estimateEta(samples([0, 0, 0, 0, 0]), 95);
  assert.ok(allZero && allZero.zeroRounds === 5, `expected zeroRounds=5, got ${JSON.stringify(allZero)}`);

  const interleaved = estimateEta(samples([0, 1, 0, 0, 0, 0, 0]), 95);
  assert.ok(interleaved && interleaved.zeroRounds === 5, `expected zeroRounds=5 (trailing run), got ${JSON.stringify(interleaved)}`);

  const recentSpend = estimateEta(samples([0, 0, 0, 0, 1]), 95);
  assert.ok(recentSpend && recentSpend.zeroRounds === undefined, `expected no zeroRounds, got ${JSON.stringify(recentSpend)}`);
  assert.ok(recentSpend && Math.abs(recentSpend.rounds - 475) < 1e-6, `expected rounds≈475, got ${JSON.stringify(recentSpend)}`);

  const sporadic = estimateEta(samples([1, 0, 1, 0, 0, 1, 0, 0, 1, 0]), 95);
  assert.ok(sporadic && sporadic.zeroRounds === undefined, `expected no zeroRounds, got ${JSON.stringify(sporadic)}`);
  assert.ok(sporadic && Math.abs(sporadic.rounds - 237.5) < 1e-6, `expected rounds=237.5, got ${JSON.stringify(sporadic)}`);

  const justWentIdle = estimateEta(samples([1, 1, 1, 1, 1, 0, 0, 0, 0, 0]), 95);
  assert.ok(justWentIdle && justWentIdle.zeroRounds === 5, `expected zeroRounds=5, got ${JSON.stringify(justWentIdle)}`);

  const normal = estimateEta(samples([1, 1, 1, 1, 1]), 95);
  assert.ok(normal && normal.zeroRounds === undefined);

  const far = estimateEta(samples([0.01, 0.01, 0.01, 0.01, 0.01]), 100);
  assert.ok(far && far.rounds > 365);
});

test("PI_QUOTA_AUTO_REFRESH_MINUTES enables idle background fetches", async (t) => {
  await cleanCache();
  process.env.PI_QUOTA_AUTO_REFRESH_MINUTES = "2";
  resetQuotaSettings();
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: "50", currency: "CNY" }] }),
    };
  });
  const timers = t.mock.timers;
  timers.enable({ apis: ["setInterval", "Date"] });
  try {
    api.handlers.session_start({ reason: "startup" }, api.ctx);
    await sleep(40);
    assert.equal(calls, 1);

    timers.tick(60_000);
    await sleep(60);
    assert.equal(calls, 1);

    timers.tick(60_000);
    await sleep(80);
    assert.equal(calls, 2);

    timers.tick(4 * 60_000);
    await sleep(80);
    assert.ok(calls >= 3, `expected a third auto fetch, got ${calls}`);
  } finally {
    timers.reset();
    delete process.env.PI_QUOTA_AUTO_REFRESH_MINUTES;
    resetQuotaSettings();
    await api.handlers.session_shutdown({ reason: "reload" }, api.ctx);
    await sleep(40);
    await cleanCache();
  }
});

test("auto refresh is disabled by default (no background fetches while idle)", async (t) => {
  await cleanCache();
  delete process.env.PI_QUOTA_AUTO_REFRESH_MINUTES;
  resetQuotaSettings();
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: "50", currency: "CNY" }] }),
    };
  });
  const timers = t.mock.timers;
  timers.enable({ apis: ["setInterval", "Date"] });
  try {
    api.handlers.session_start({ reason: "startup" }, api.ctx);
    await sleep(40);
    assert.equal(calls, 1);
    timers.tick(10 * 60_000);
    await sleep(80);
    assert.equal(calls, 1, "default off: no background fetch");
  } finally {
    timers.reset();
    await api.handlers.session_shutdown({ reason: "reload" }, api.ctx);
    await sleep(40);
    await cleanCache();
  }
});

test("formatAge escalates minutes → hours → days → months (zh/en)", () => {
  const now = Date.now();
  setCurrentLanguage("zh");
  assert.equal(formatAge(now - 30_000), "刚刚");
  assert.equal(formatAge(now - 3 * 60_000), "3分钟前");
  assert.equal(formatAge(now - (2 * 60 + 5) * 60_000), "2小时5分钟前");
  assert.equal(formatAge(now - (3 * 24 + 4) * 3_600_000), "3天4小时前");
  assert.equal(formatAge(now - 3 * 24 * 3_600_000), "3天前");
  assert.equal(formatAge(now - 32 * 24 * 3_600_000), "1个月2天前");
  setCurrentLanguage("en");
  assert.equal(formatAge(now - 30_000), "now");
  assert.equal(formatAge(now - 3 * 60_000), "3m ago");
  assert.equal(formatAge(now - (2 * 60 + 5) * 60_000), "2h5m ago");
  assert.equal(formatAge(now - (3 * 24 + 4) * 3_600_000), "3d4h ago");
  assert.equal(formatAge(now - 32 * 24 * 3_600_000), "1mo2d ago");
  setCurrentLanguage("zh");
});

test("rate source picks the shortest window by priority (5h → used → 7d → mo)", () => {

  assert.deepEqual([...RATE_METRIC_PRIORITY], ["5h", "used", "7d", "mo"]);

  const zeros = [0, 0, 0, 0, 0].map((delta, at) => ({ at: at * 60_000, delta }));
  assert.equal(estimateEta(zeros, 90)?.zeroRounds, 5);

  const pick = (metrics) => RATE_METRIC_PRIORITY.find((m) => metrics.includes(m)) ?? null;
  assert.equal(pick(["5h", "7d", "mo"]), "5h");
  assert.equal(pick(["used"]), "used");
  assert.equal(pick(["7d", "mo"]), "7d");
  assert.equal(pick(["mo"]), "mo");
  assert.equal(pick([]), null);
});

test("ETA rejects invalid input and non-monotonic timestamps", () => {
  const valid = (deltas = [1, 1, 1, 1, 1]) => deltas.map((delta, index) => ({
    at: index * 60_000,
    delta,
  }));

  assert.equal(estimateEta(valid(), Number.NaN), null);
  assert.equal(estimateEta(valid([1, 1, 1, 1, Number.NaN]), 95), null);
  assert.equal(estimateEta(valid([1, 1, 1, 1, -1]), 95), null);
  assert.equal(estimateEta([
    { at: 0, delta: 1 },
    { at: 60_000, delta: 1 },
    { at: 30_000, delta: 1 },
    { at: 90_000, delta: 1 },
    { at: 120_000, delta: 1 },
  ], 95), null);

  assert.equal(estimateEta(valid([Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE, Number.MIN_VALUE]), 95), null);
});

test("OAuth header-shaped auth (kimi-coding) resolves bearer from auth.headers", async () => {
  await cleanCache();
  let seen = null;
  const api = await harness("kimi-coding", async (url, options = {}) => {
    seen = { url, auth: options.headers?.Authorization };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        usage: { limit: "100", remaining: "96", resetTime: new Date(Date.now() + 86_400_000).toISOString() },
        limits: [{
          window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
          detail: { limit: "100", remaining: "90", resetTime: new Date(Date.now() + 5 * 3_600_000).toISOString() },
        }],
      }),
    };
  }, async () => ({ auth: { headers: { Authorization: "Bearer kimi-oauth-token" } } }));

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  assert.equal(seen.auth, "Bearer kimi-oauth-token");
  assert.match(api.widgets.at(-1), /限额: 5h 10%/);
  assert.match(api.widgets.at(-1), /\/ 7d 4%/);
  assert.doesNotMatch(api.widgets.at(-1), /^--$/);

  await sleep(60);
  const diskRaw = await readFile(cachePath, "utf8");
  assert.ok(!diskRaw.includes("kimi-oauth-token"), "OAuth token must never be persisted");
  await cleanCache();
});

test("Kimi window fully consumed (remaining omitted) parses via used/limit", async () => {
  await cleanCache();

  const api = await harness("kimi-coding", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      usage: { limit: "100", used: "25", remaining: "75", resetTime: new Date(Date.now() + 86_400_000).toISOString() },
      limits: [{
        window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
        detail: { limit: "100", used: "100", resetTime: new Date(Date.now() + 5 * 3_600_000).toISOString() },
      }],
    }),
  }));

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  assert.match(api.widgets.at(-1), /限额: 5h 100%/);
  assert.match(api.widgets.at(-1), /\/ 7d 25%/);

  assert.doesNotMatch(api.widgets.at(-1), /预计可用：\d/);
  await cleanCache();
});

test("OpenAI Codex account header extraction rejects oversized or header-unsafe claims", () => {
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const token = (accountId) => `${b64u({ alg: "none" })}.${b64u({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.sig`;
  assert.equal(extractChatGptAccountId(token("acct_123")), "acct_123");
  assert.equal(extractChatGptAccountId(token("acct_123\r\nInjected: yes")), null);
  assert.equal(extractChatGptAccountId(`a.${"x".repeat(65 * 1024)}.b`), null);
});

test("OpenAI Codex OAuth queries wham/usage with account header and records consumption", async () => {
  await cleanCache();
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const jwt = `${b64u({ alg: "none" })}.${b64u({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })}.sig`;
  let seen = null;
  let calls = 0;
  const wham = (p5, p7) => JSON.stringify({
    plan_type: "plus",
    rate_limit: {
      allowed: true,
      limit_reached: false,
      primary_window: { used_percent: p5, limit_window_seconds: 18000, reset_after_seconds: 2547, reset_at: Math.floor(Date.now() / 1000) + 2547 },
      secondary_window: { used_percent: p7, limit_window_seconds: 604800, reset_after_seconds: 86000, reset_at: Math.floor(Date.now() / 1000) + 86000 },
    },
  });
  const api = await harness("openai-codex", async (url, options = {}) => {
    seen = { url, auth: options.headers?.Authorization, accountId: options.headers?.["chatgpt-account-id"] };
    calls++;
    return { ok: true, status: 200, text: async () => wham(calls === 1 ? 55 : 56, 20) };
  }, async () => ({ auth: { apiKey: jwt } }));

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  assert.equal(seen.url, "https://chatgpt.com/backend-api/wham/usage");
  assert.match(seen.auth, /^Bearer /);
  assert.equal(seen.accountId, "acct_123");
  assert.match(api.widgets.at(-1), /限额: 5h 55%/);
  assert.match(api.widgets.at(-1), /\/ 7d 20%/);
  assert.match(api.widgets.at(-1), /\(plus\)/);

  await sleep(60);
  const diskRaw = await readFile(cachePath, "utf8");
  assert.ok(!diskRaw.includes(jwt), "OAuth token must never be persisted");

  await api.handlers.agent_start({}, api.ctx);
  await api.handlers.agent_settled({}, api.ctx);
  await sleep(80);
  await api.commands.aq10.handler({}, api.ctx);
  assert.equal(api.notices.at(-1), "openai-codex 近1轮消耗 5h 1%");
  await cleanCache();
});

test("OpenAI Codex ignores unsafe plan_type text", async () => {
  await cleanCache();
  const api = await harness("openai-codex", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      plan_type: "\x1b[31mplus\x1b[0m\nsecret",
      rate_limit: {
        primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 1800 },
        secondary_window: { used_percent: 5, limit_window_seconds: 604800, reset_after_seconds: 86_400 },
      },
    }),
  }));

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  assert.doesNotMatch(api.widgets.at(-1), /secret|plus/);
  await cleanCache();
});

test("OpenCode Go uses the official endpoint, renders three windows, and records consumption", async () => {
  await cleanCache();
  let calls = 0;
  let authorization = "";
  const api = await harness("opencode-go", async (url, options = {}) => {
    assert.equal(url, "https://opencode.ai/zen/go/v1/usage");
    assert.equal(options.redirect, "error");
    authorization = options.headers?.Authorization;
    calls++;
    const values = calls === 1 ? [10, 20, 30] : [15, 25, 35];
    return {
      ok: true,
      status: 200,
      text: async () => openCodeUsage(...values),
    };
  });

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  assert.equal(authorization, "Bearer test-key");
  const cacheStat = await stat(cachePath);
  assert.equal(cacheStat.mode & 0o777, 0o600);
  assert.match(api.widgets.at(-1), /限额: 5h 10%/);
  assert.match(api.widgets.at(-1), /\/ 7d 20%/);
  assert.match(api.widgets.at(-1), /\/ mo 30%/);

  await api.handlers.agent_start({}, api.ctx);
  await api.handlers.agent_settled({}, api.ctx);
  await sleep(80);
  assert.equal(calls, 2);
  await api.commands.aq10.handler({}, api.ctx);
  assert.equal(api.notices.at(-1), "opencode-go 近1轮消耗 5h 5% / 7d 5% / mo 5%");
  await api.commands.aqlang.handler("en", api.ctx);
  assert.match(api.widgets.at(-1), /Usage: 5h 15%/);
  assert.equal(api.notices.at(-1), "Language switched to English");
  await api.commands.aq10.handler({}, api.ctx);
  assert.equal(api.notices.at(-1), "opencode-go last 1 rounds 5h 5% / 7d 5% / mo 5%");
  const languageCache = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(languageCache.language, "en");
  await api.commands.aqlang.handler("zh", api.ctx);
  assert.match(api.widgets.at(-1), /限额: 5h 15%/);
  assert.equal(api.notices.at(-1), "语言已切换为中文");
  await cleanCache();
});

test("ETA hides when any quota window is exhausted", async () => {
  await cleanCache();
  let calls = 0;
  const usage = [
    [100, 10, 10],
    [100, 11, 10],
    [100, 12, 10],
    [100, 13, 10],
    [100, 14, 10],
    [100, 15, 10],
  ];
  const api = await harness("opencode-go", async () => {
    const values = usage[Math.min(calls++, usage.length - 1)];
    return {
      ok: true,
      status: 200,
      text: async () => openCodeUsage(...values),
    };
  });

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  for (let i = 0; i < 5; i++) {
    await api.handlers.agent_start({}, api.ctx);
    await api.handlers.agent_settled({}, api.ctx);
  }
  await sleep(40);

  assert.doesNotMatch(api.widgets.at(-1), /预计可用：/);
  assert.match(api.widgets.at(-1), /刚刚/);
  assert.doesNotMatch(api.widgets.at(-1), /刚刚 ·/);
  await cleanCache();
});

test("ETA falls back to longer windows when the 5h window resets first", async () => {
  await cleanCache();
  let calls = 0;
  const usage = [
    [0, 0, 0],
    [1, 1, 1],
    [2, 2, 2],
    [3, 3, 3],
    [4, 4, 4],
    [5, 5, 5],
  ];
  const api = await harness("opencode-go", async () => {
    const values = usage[Math.min(calls++, usage.length - 1)];
    return {
      ok: true,
      status: 200,
      text: async () => openCodeUsage(...values, [1, 86400, 30 * 86400]),
    };
  });

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  for (let i = 0; i < 5; i++) {
    await api.handlers.agent_start({}, api.ctx);
    await api.handlers.agent_settled({}, api.ctx);
    await sleep(30);
  }
  await sleep(40);

  assert.match(api.widgets.at(-1), /预计可用：\d+轮/);
  assert.match(api.widgets.at(-1), /预计可用：9\d轮/);
  await cleanCache();
});

test("aqset changes thresholds, persists and takes effect immediately", async () => {
  await cleanCache();
  resetQuotaSettings();
  const api = await harness("deepseek", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ balance_infos: [{ total_balance: "50", currency: "CNY" }] }),
  }));
  const theme = { fg: (_c, t) => t };

  api.handlers.session_start({}, api.ctx);
  await sleep(40);

  assert.doesNotMatch(balanceColor(50, "¥", theme), /\x1b\[38;2;238;122;95/);

  await api.commands.aqset.handler("80 40 100", api.ctx);
  assert.equal(getQuotaSettings().balanceAlert, 100);
  assert.match(balanceColor(50, "¥", theme), /\x1b\[38;2;238;122;95/);
  assert.match(api.notices.at(-1), /红色≥80 黄色≥40 余额≤100|red ≥80.*yellow ≥40.*balance ≤100/);

  await sleep(60);
  let disk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(disk.settings.balanceAlert, 100);

  await api.commands.aqset.handler("30 25 100", api.ctx);
  assert.equal(getQuotaSettings().pctRed, 30);
  assert.doesNotMatch(pctColor(23), /\x1b\[38;2;238;122;95/);
  assert.match(pctColor(35), /\x1b\[38;2;238;122;95/);

  setQuotaSettings({ pctRed: 20, pctYellow: 80 });
  assert.equal(getQuotaSettings().pctRed, 30);
  assert.equal(getQuotaSettings().pctYellow, 25);

  await api.commands.aqset.handler("", api.ctx);
  assert.match(api.notices.at(-1), /\/aqset 30 25 100/);

  await api.commands.aqset.handler("80 40", api.ctx);
  assert.match(api.notices.at(-1), /用法|Usage/);
  await api.commands.aqset.handler("foo 40 10", api.ctx);
  assert.match(api.notices.at(-1), /用法|Usage/);
  await api.commands.aqset.handler("0 40 10", api.ctx);
  assert.match(api.notices.at(-1), /用法|Usage/);
  await api.commands.aqset.handler("40 40 10", api.ctx);
  assert.match(api.notices.at(-1), /用法|Usage/);
  await sleep(60);
  disk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(disk.settings.pctRed, 30);

  await api.commands.aqset.handler("reset", api.ctx);
  assert.match(api.notices.at(-1), /默认|default/i);
  await sleep(60);
  disk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(disk.settings.pctRed, QUOTA_SETTINGS_DEFAULTS.pctRed);
  assert.equal(disk.settings.balanceAlert, QUOTA_SETTINGS_DEFAULTS.balanceAlert);
  await cleanCache();
});

test("aqauto accepts only numeric 0-30, persists, and fires on schedule", async (t) => {
  await cleanCache();
  resetQuotaSettings();
  delete process.env.PI_QUOTA_AUTO_REFRESH_MINUTES;
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: "50", currency: "CNY" }] }),
    };
  });
  const timers = t.mock.timers;
  timers.enable({ apis: ["setInterval", "Date"] });
  try {
    api.handlers.session_start({ reason: "startup" }, api.ctx);
    await sleep(40);
    assert.equal(calls, 1);

    await api.commands.aqauto.handler("", api.ctx);
    assert.match(api.notices.at(-1), /关闭|off/i);

    timers.tick(5 * 60_000);
    await sleep(60);
    assert.equal(calls, 1);

    await api.commands.aqauto.handler("1", api.ctx);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 1);
    timers.tick(60_000);
    await sleep(80);
    assert.equal(calls, 2, "command-enabled auto fetch fires after 1 minute");

    await sleep(60);
    let disk = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(disk.settings.autoRefreshMinutes, 1);

    await api.commands.aqauto.handler("30", api.ctx);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 30);
    await api.commands.aqauto.handler("31", api.ctx);
    assert.match(api.notices.at(-1), /用法|Usage/);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 30);
    await sleep(60);
    disk = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(disk.settings.autoRefreshMinutes, 30);

    await api.commands.aqauto.handler("on", api.ctx);
    assert.match(api.notices.at(-1), /用法|Usage/);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 30);
    await api.commands.aqauto.handler("off", api.ctx);
    assert.match(api.notices.at(-1), /用法|Usage/);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 30);
    await api.commands.aqauto.handler("5 10", api.ctx);
    assert.match(api.notices.at(-1), /用法|Usage/);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 30);
    await api.commands.aqauto.handler("0", api.ctx);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 0);
    await sleep(60);
    disk = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(disk.settings.autoRefreshMinutes, 0);
    const before = calls;
    timers.tick(10 * 60_000);
    await sleep(80);
    assert.equal(calls, before, "off: no background fetch");

    await api.commands.aqauto.handler("foo", api.ctx);
    assert.match(api.notices.at(-1), /用法|Usage/);
    await api.commands.aqauto.handler("0.5", api.ctx);
    assert.match(api.notices.at(-1), /用法|Usage/);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 0);
    await api.commands.aqauto.handler("-3", api.ctx);
    assert.match(api.notices.at(-1), /用法|Usage/);
    await sleep(60);
    disk = JSON.parse(await readFile(cachePath, "utf8"));
    assert.equal(disk.settings.autoRefreshMinutes, 0);

    await api.commands.aqauto.handler("7", api.ctx);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 7);
    const noticesBefore = api.notices.length;
    await api.commands.aqauto.handler("7", api.ctx);
    assert.equal(api.notices.length, noticesBefore);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 7);
    await api.commands.aqauto.handler("8", api.ctx);
    assert.equal(getQuotaSettings().autoRefreshMinutes, 8);
  } finally {
    timers.reset();
    resetQuotaSettings();
    await api.handlers.session_shutdown({ reason: "reload" }, api.ctx);
    await sleep(40);
    await cleanCache();
  }
});

test("aqpick refreshes provider quotas, sorts current first, then switches through a model picker", async () => {
  await cleanCache();
  const deepseek = { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" };
  const codex53 = { provider: "openai-codex", id: "gpt-5.3-codex", name: "GPT-5.3 Codex" };
  const codex54 = { provider: "openai-codex", id: "gpt-5.4", name: "GPT-\x1b[31m5.4\nUnsafe\u202Etxt" };
  const kimi = { provider: "kimi-coding", id: "kimi-k2.5", name: "Kimi K2.5" };
  const unsupported = { provider: "future-provider", id: "future-model", name: "Future" };
  const authProviders = [];
  const fetchUrls = [];
  const api = await harness(
    "deepseek",
    async (url) => {
      fetchUrls.push(String(url));
      if (String(url).includes("deepseek.com")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ balance_infos: [{ total_balance: "50", currency: "CNY" }] }),
        };
      }
      if (String(url).includes("/wham/usage")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            rate_limit: {
              primary_window: { used_percent: 28, limit_window_seconds: 18_000, reset_after_seconds: 3_600 },
              secondary_window: { used_percent: 62, limit_window_seconds: 604_800, reset_after_seconds: 172_800 },
            },
          }),
        };
      }
      throw new Error(`unexpected fetch ${url}`);
    },
    async (provider) => {
      authProviders.push(provider);
      return provider === "kimi-coding" ? { auth: {} } : { auth: { apiKey: "test-key" } };
    },
    {
      currentModel: deepseek,
      models: [deepseek, codex53, codex54, kimi, unsupported],
      emitModelSelectOnSet: true,
      select: async (_title, values, index) => index === 0
        ? values.find((value) => value.startsWith("OpenAI Codex"))
        : values.find((value) => value.includes("gpt-5.4")),
    },
  );

  await api.commands.aqpick.handler("", api.ctx);

  assert.deepEqual(new Set(authProviders), new Set(["deepseek", "openai-codex", "kimi-coding"]));
  assert.equal(fetchUrls.filter((url) => url.includes("deepseek.com")).length, 1);
  assert.equal(fetchUrls.filter((url) => url.includes("/wham/usage")).length, 1);
  assert.equal(api.selectCalls.length, 2);
  const providerValues = api.selectCalls[0].values;
  assert.equal(providerValues.length, 2);
  assert.match(providerValues[0], /^DeepSeek（当前） — 余额 ¥50\.00$/);
  assert.match(providerValues[1], /^OpenAI Codex — 5h已用28%（.+后重置） · 7d已用62%（.+后重置）$/);
  assert.equal(api.selectCalls[1].values.length, 2);
  assert.ok(api.selectCalls[1].values.every((value) => !value.includes("已用")));
  assert.ok(api.selectCalls[1].values.every((value) => !/[\x00-\x1f\x7f-\x9f]|\p{Cf}/u.test(value)));
  assert.equal(api.setModelCalls.length, 1);
  assert.equal(api.setModelCalls[0], codex54);
  assert.match(api.notices.at(-1), /openai-codex\/gpt-5\.4/);
  assert.equal(fetchUrls.length, 2, "aqpick switch reuses its live snapshot on model_select");
  assert.equal(api.statuses.at(0).text, "正在刷新可选 provider 的配额…");
  assert.equal(api.statuses.at(-1).text, undefined);
  await sleep(60);
  const aqpickDisk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.deepEqual(Object.keys(aqpickDisk.providers), ["openai-codex"], "only the selected provider is persisted");
  await cleanCache();
});

test("aqpick starts every candidate provider concurrently", async () => {
  await cleanCache();
  const models = [
    { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
    { provider: "moonshotai", id: "kimi-k2", name: "Kimi K2" },
    { provider: "openrouter", id: "openrouter-auto", name: "OpenRouter Auto" },
    { provider: "zai", id: "glm-5", name: "GLM-5" },
  ];
  let releaseAuth;
  const authGate = new Promise((resolve) => {
    releaseAuth = resolve;
  });
  const started = [];
  const api = await harness("deepseek", async () => {
    throw new Error("must not fetch without auth");
  }, async (provider) => {
    started.push(provider);
    await authGate;
    return { auth: {} };
  }, { currentModel: models[0], models });

  const run = api.commands.aqpick.handler("", api.ctx);
  await Promise.resolve();
  assert.deepEqual(new Set(started), new Set(["deepseek", "moonshotai", "openrouter", "zai"]));
  releaseAuth();
  await run;
  assert.equal(api.selectCalls.length, 0);
  await cleanCache();
});

test("aqpick uses one live attempt per provider instead of background-style retries", async () => {
  await cleanCache();
  const model = { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" };
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    return { ok: false, status: 500, text: async () => "server error" };
  }, undefined, { currentModel: model, models: [model] });

  await api.commands.aqpick.handler("", api.ctx);
  assert.equal(calls, 1);
  assert.equal(api.selectCalls.length, 0);
  assert.match(api.notices.at(-1), /没有获取到|No selectable/i);
  await cleanCache();
});

test("aqpick respects scoped models and directly switches a provider with one model", async () => {
  await cleanCache();
  const current = { provider: "openai-codex", id: "gpt-5.4", name: "GPT-5.4" };
  const kimi = { provider: "kimi-coding", id: "kimi-k2.5", name: "Kimi K2.5" };
  const deepseek = { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" };
  const authProviders = [];
  const api = await harness(
    "openai-codex",
    async (url) => {
      assert.match(String(url), /api\.kimi\.com\/coding\/v1\/usages/);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          usage: { limit: "100", remaining: "80", resetTime: new Date(Date.now() + 86_400_000).toISOString() },
          limits: [{
            detail: { limit: "100", remaining: "90", resetTime: new Date(Date.now() + 3_600_000).toISOString() },
          }],
        }),
      };
    },
    async (provider) => {
      authProviders.push(provider);
      return { auth: { apiKey: "test-key" } };
    },
    {
      currentModel: current,
      models: [current, kimi, deepseek],
      scopedModels: [{ model: kimi }],
      select: async (_title, values) => values[0],
    },
  );

  await api.commands.aqpick.handler("", api.ctx);
  assert.deepEqual(authProviders, ["kimi-coding"]);
  assert.equal(api.selectCalls.length, 1, "single-model provider skips the model picker");
  assert.match(api.selectCalls[0].values[0], /^Kimi For Coding — 5h已用10%/);
  assert.equal(api.setModelCalls[0], kimi);
  await sleep(60);
  await cleanCache();
});

test("aqpick keeps the current model when selection is cancelled or switching fails", async () => {
  await cleanCache();
  const deepseek = { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" };
  const response = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ balance_infos: [{ total_balance: "12", currency: "CNY" }] }),
  });

  const cancelled = await harness("deepseek", response, undefined, {
    currentModel: deepseek,
    models: [deepseek],
    select: async () => undefined,
  });
  await cancelled.commands.aqpick.handler("", cancelled.ctx);
  assert.equal(cancelled.setModelCalls.length, 0);

  const failed = await harness("deepseek", response, undefined, {
    currentModel: deepseek,
    models: [deepseek],
    select: async (_title, values) => values[0],
    setModelResult: false,
  });
  await failed.commands.aqpick.handler("", failed.ctx);
  assert.equal(failed.setModelCalls.length, 1);
  assert.equal(failed.ctx.model, deepseek);
  assert.match(failed.notices.at(-1), /失败|failed/i);
  await cleanCache();
});

test("aqpick stops after its total timeout and hides unfinished providers", async (t) => {
  await cleanCache();
  const model = { provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" };
  const api = await harness("deepseek", (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
  }), undefined, { currentModel: model, models: [model] });
  const timers = t.mock.timers;
  timers.enable({ apis: ["setTimeout"] });
  try {
    const run = api.commands.aqpick.handler("", api.ctx);
    await Promise.resolve();
    await Promise.resolve();
    timers.tick(10_000);
    await run;
    assert.equal(api.selectCalls.length, 0);
    assert.equal(api.setModelCalls.length, 0);
    assert.match(api.notices.at(-1), /没有获取到|No selectable/i);
  } finally {
    timers.reset();
    await cleanCache();
  }
});

test("aqpick rejects arguments and requires interactive UI before resolving auth", async () => {
  await cleanCache();
  let authCalls = 0;
  const auth = async () => {
    authCalls++;
    return { auth: { apiKey: "test-key" } };
  };
  const withArgs = await harness("deepseek", async () => {
    throw new Error("must not fetch");
  }, auth);
  await withArgs.commands.aqpick.handler("deepseek", withArgs.ctx);
  assert.match(withArgs.notices.at(-1), /用法|Usage/);

  const noUi = await harness("deepseek", async () => {
    throw new Error("must not fetch");
  }, auth, { hasUI: false });
  await noUi.commands.aqpick.handler("", noUi.ctx);
  assert.match(noUi.notices.at(-1), /交互|interactive/i);
  assert.equal(authCalls, 0);
  await cleanCache();
});

test("aqset settings are restored from disk on reload", async () => {
  await cleanCache();
  resetQuotaSettings();
  await writeFile(cachePath, JSON.stringify({
    version: 2,
    settings: { pctRed: 25, pctYellow: 20, balanceAlert: 999, autoRefreshMinutes: 999 },
    providers: {},
  }));
  const api = await harness("deepseek", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ balance_infos: [{ total_balance: "37.03", currency: "CNY" }] }),
  }));

  api.handlers.session_start({ reason: "reload" }, api.ctx);
  await sleep(50);
  assert.equal(getQuotaSettings().pctRed, 25);
  assert.equal(getQuotaSettings().pctYellow, 20);
  assert.equal(getQuotaSettings().balanceAlert, 999);

  assert.equal(getQuotaSettings().autoRefreshMinutes, 30);
  await api.commands.aqset.handler("", api.ctx);
  assert.match(api.notices.at(-1), /\/aqset \d+ \d+ 999/);
  await cleanCache();
  resetQuotaSettings();
});

test("language preference is restored from JSON after reload", async () => {
  await cleanCache();
  await writeFile(cachePath, JSON.stringify({ version: 2, language: "en", providers: {} }));
  const api = await harness("deepseek", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ balance_infos: [{ total_balance: "37.03", currency: "CNY" }] }),
  }));

  api.handlers.session_start({ reason: "reload" }, api.ctx);
  await sleep(50);
  assert.match(api.widgets.at(-1), /Balance: ¥37\.03/);

  assert.equal(api.commands.aq10.description, "Show the last 10 conversation consumption records");
  await cleanCache();
});

test("all extension command names use the aq prefix", async () => {
  await cleanCache();
  const api = await harness("deepseek", async () => {
    throw new Error("must not fetch");
  });

  assert.deepEqual(Object.keys(api.commands).sort(), ["aq10", "aqauto", "aqcheck", "aqlang", "aqpick", "aqset"]);
  assert.equal(api.commands.checkaq, undefined);
  await cleanCache();
});

test("unknown providers do not resolve auth or fetch and report quota unavailable", async () => {
  await cleanCache();
  let authCalls = 0;
  let fetchCalls = 0;
  const api = await harness(
    "future-provider",
    async () => {
      fetchCalls++;
      throw new Error("must not fetch");
    },
    async () => {
      authCalls++;
      throw new Error("must not resolve auth");
    },
  );

  api.handlers.session_start({}, api.ctx);
  await sleep(20);
  await api.commands.aqcheck.handler({}, api.ctx);
  await api.commands.aq10.handler({}, api.ctx);
  assert.equal(authCalls, 0);
  assert.equal(fetchCalls, 0);
  assert.equal(api.widgets.at(-1), "--");
  assert.equal(api.notices.at(-1), "future-provider: 限额不可用");
  await cleanCache();
});

test("session shutdown aborts in-flight quota requests", async () => {
  await cleanCache();
  let fetchCalls = 0;
  let aborted = false;
  const api = await harness("deepseek", async (_url, { signal } = {}) => {
    fetchCalls++;
    await new Promise((_, reject) => {
      signal.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    });
  });

  api.handlers.session_start({}, api.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fetchCalls, 1);
  await api.handlers.session_shutdown({ reason: "reload" }, api.ctx);
  await sleep(30);
  assert.equal(aborted, true);
  assert.equal(fetchCalls, 1);
  await cleanCache();
});

test("same-provider in-flight requests are awaited instead of duplicated", async () => {
  await cleanCache();
  let calls = 0;
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const api = await harness("deepseek", async () => {
    calls++;
    await pending;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: "37.03", currency: "CNY" }] }),
    };
  });

  api.handlers.session_start({}, api.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  const modelSelect = api.handlers.model_select({}, api.ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 1);
  release();
  await modelSelect;
  await sleep(20);
  assert.equal(calls, 1);
  await cleanCache();
});

test("auth resolution failure is converted to Failed without an unhandled rejection", async () => {
  await cleanCache();
  let fetchCalls = 0;
  const api = await harness(
    "deepseek",
    async () => {
      fetchCalls++;
      throw new Error("must not fetch after auth failure");
    },
    async () => {
      throw new Error("auth failure");
    },
  );

  api.handlers.session_start({}, api.ctx);
  await sleep(30);
  assert.equal(fetchCalls, 0);
  assert.equal(api.widgets.at(-1), "(失败)");
  await cleanCache();
});

test("reload restores a valid base_line before refreshing", async () => {
  await cleanCache();
  const fetchedAt = Date.now();
  const base = {
    provider: "deepseek",
    fetchedAt,
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: 100, currency: "¥", metric: "balance" },
    ],
    metrics: { balance: 100 },
    currency: "¥",
  };
  await writeFile(cachePath, JSON.stringify({
    version: 2,
    providers: { deepseek: { trigger_line: base, base_line: base } },
  }));

  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    const balance = calls === 1 ? 110 : 90;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: String(balance), currency: "CNY" }] }),
    };
  });

  api.handlers.session_start({ reason: "reload" }, api.ctx);
  await sleep(50);
  await api.handlers.agent_settled({}, api.ctx);
  await sleep(80);
  await api.commands.aq10.handler({}, api.ctx);
  assert.equal(api.notices.at(-1), "deepseek 近1轮消耗 ¥10.00");
  assert.equal(calls, 2);
  await cleanCache();
});

test("reload restores cross-provider flag from active_round", async () => {
  await cleanCache();
  const fetchedAt = Date.now();
  const baseA = {
    provider: "deepseek",
    fetchedAt,
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: 100, currency: "¥", metric: "balance" },
    ],
    metrics: { balance: 100 },
    currency: "¥",
  };
  await writeFile(cachePath, JSON.stringify({
    version: 2,
    active_round: { provider: "deepseek", provider_changed: true },
    providers: { deepseek: { trigger_line: baseA, base_line: baseA } },
  }));

  const api = await harness("deepseek", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ balance_infos: [{ total_balance: "90", currency: "CNY" }] }),
  }));

  api.handlers.session_start({ reason: "reload" }, api.ctx);
  await sleep(50);
  await api.handlers.agent_settled({}, api.ctx);
  await sleep(40);

  const widget = api.widgets.at(-1);
  assert.match(widget, /\(变更\)/);
  assert.doesNotMatch(widget, /¥-10\.00/);
  await cleanCache();
});

test("startup clears stale active_round from disk", async () => {
  await cleanCache();
  const fetchedAt = Date.now();
  const baseA = {
    provider: "deepseek",
    fetchedAt,
    kind: "balance",
    items: [
      { kind: "text", text: "Balance: " },
      { kind: "balance", value: 100, currency: "¥", metric: "balance" },
    ],
    metrics: { balance: 100 },
    currency: "¥",
  };
  await writeFile(cachePath, JSON.stringify({
    version: 2,
    active_round: { provider: "deepseek", provider_changed: true },
    providers: { deepseek: { trigger_line: baseA, base_line: baseA } },
  }));

  const api = await harness("deepseek", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ balance_infos: [{ total_balance: "90", currency: "CNY" }] }),
  }));

  api.handlers.session_start({ reason: "startup" }, api.ctx);
  await sleep(200);

  const disk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(disk.active_round, undefined, "active_round should be cleared after startup");

  assert.ok(disk.providers.deepseek.trigger_line, "trigger_line should be preserved");
  assert.equal(disk.providers.deepseek.base_line, undefined, "base_line should be cleared after startup");

  api.handlers.session_start({ reason: "reload" }, api.ctx);
  await sleep(50);
  await api.handlers.agent_settled({}, api.ctx);
  await sleep(40);

  const widget = api.widgets.at(-1);
  assert.doesNotMatch(widget, /\(changed\)/, "should not show (changed) after startup cleared active_round");
  assert.doesNotMatch(widget, /¥-10\.00/, "stale base_line diff should not be restored");

  await cleanCache();
});

test("privacy: fetch failure is silent (no error logs, no secrets)", async () => {
  await cleanCache();
  const logs = [];
  const originalError = console.error;
  console.error = (...args) => logs.push(args.join(" "));
  const api = await harness("deepseek", async () => ({
    ok: true,
    status: 200,
    text: async () => "{\"secret\":\"do-not-log-this-response\"}",
  }));
  api.handlers.session_start({ reason: "startup" }, api.ctx);
  await sleep(1700);
  console.error = originalError;

  assert.equal(logs.length, 0, "fetch failure must not emit error logs");
  await cleanCache();
});

test("privacy: deterministic authorization failures are not retried", async () => {
  await cleanCache();
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    return { ok: false, status: 401, text: async () => "unauthorized" };
  });

  api.handlers.session_start({ reason: "startup" }, api.ctx);
  await sleep(100);
  assert.equal(calls, 1);
  await cleanCache();
});

test("security: oversized quota responses are rejected once and never persisted", async () => {
  await cleanCache();
  let calls = 0;
  const oversized = JSON.stringify({
    balance_infos: [{ total_balance: "10", currency: "CNY" }],
    marker: `oversized-marker-${"x".repeat(1024 * 1024)}`,
  });
  const api = await harness("deepseek", async () => {
    calls++;
    return { ok: true, status: 200, text: async () => oversized };
  });

  api.handlers.session_start({ reason: "startup" }, api.ctx);
  await sleep(120);
  assert.equal(calls, 1);
  const diskRaw = await readFile(cachePath, "utf8");
  assert.ok(!diskRaw.includes("oversized-marker"));
  await cleanCache();
});

test("security: provider display data cannot inject terminal or bidi controls", async () => {
  await cleanCache();
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        balance_infos: [{ total_balance: "10", currency: "USD\u001b]52;c;secret\u0007\u202E" }],
      }),
    };
  });

  api.handlers.session_start({ reason: "startup" }, api.ctx);
  await sleep(100);
  assert.equal(calls, 1);
  const rendered = api.widgets.join("\n");
  assert.doesNotMatch(rendered, /secret|\]52|\u202E/u);
  await cleanCache();
});

test("security: disk cache symlinks are rejected without reading or chmodding the target", async () => {
  await cleanCache();
  await mkdir(dirname(cachePath), { recursive: true });
  const target = join(testHome, `cache-symlink-target-${caseId}.json`);
  const injected = JSON.stringify({
    version: 2,
    language: "en",
    providers: {
      deepseek: {
        trigger_line: {
          provider: "deepseek",
          fetchedAt: Date.now(),
          kind: "balance",
          items: [
            { kind: "text", text: "LEAK: " },
            { kind: "balance", value: 999, currency: "$", metric: "balance" },
          ],
          metrics: { balance: 999 },
          currency: "$",
        },
      },
    },
  });
  await writeFile(target, injected, { mode: 0o644 });
  await chmod(target, 0o644);
  await symlink(target, cachePath);

  try {
    const api = await harness("deepseek", async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: "10", currency: "CNY" }] }),
    }));
    api.handlers.session_start({ reason: "reload" }, api.ctx);
    assert.doesNotMatch(api.widgets.join("\n"), /LEAK/);
    await sleep(100);
    assert.equal(await readFile(target, "utf8"), injected);
    assert.equal((await stat(target)).mode & 0o777, 0o644);
    await api.handlers.session_shutdown({ reason: "reload" }, api.ctx);
  } finally {
    await cleanCache();
    await unlink(target).catch(() => {});
  }
});

test("security: custom baseUrl rejects credentials, query strings, fragments, and public HTTP", () => {
  assert.throws(() => quotaUrl("https://user:pass@example.com", "https://safe.example", "/quota"), /unsafe_base_url/);
  assert.throws(() => quotaUrl("https://example.com?target=other", "https://safe.example", "/quota"), /unsafe_base_url/);
  assert.throws(() => quotaUrl("https://example.com#fragment", "https://safe.example", "/quota"), /unsafe_base_url/);
  assert.throws(() => quotaUrl("http://public.example", "https://safe.example", "/quota"), /insecure_base_url/);
  assert.equal(quotaUrl("http://127.0.0.1:8787/api", "https://safe.example", "/quota"), "http://127.0.0.1:8787/api/quota");
});

test("privacy: public HTTP custom baseUrl is rejected before fetch", async () => {
  await cleanCache();
  let fetchCalls = 0;
  const api = await harness(
    "moonshotai",
    async () => {
      fetchCalls++;
      throw new Error("must not fetch insecure baseUrl");
    },
    async () => ({ auth: { apiKey: "test-key", baseUrl: "http://public.example" } }),
  );
  api.handlers.session_start({ reason: "startup" }, api.ctx);
  await sleep(1700);
  assert.equal(fetchCalls, 0);
  await cleanCache();
});

test("privacy: a configured custom baseUrl is the only destination for its provider credential", async () => {
  await cleanCache();
  let seen;
  const api = await harness(
    "deepseek",
    async (url, options = {}) => {
      seen = { url: String(url), authorization: options.headers?.Authorization };
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ balance_infos: [{ total_balance: "10", currency: "CNY" }] }),
      };
    },
    async () => ({ auth: { apiKey: "proxy-only-key", baseUrl: "https://quota-proxy.example/api" } }),
  );

  api.handlers.session_start({ reason: "startup" }, api.ctx);
  await sleep(100);
  assert.equal(seen.url, "https://quota-proxy.example/api/user/balance");
  assert.equal(seen.authorization, "Bearer proxy-only-key");
  assert.doesNotMatch(seen.url, /api\.deepseek\.com/);
  await cleanCache();
});

test("changed does not hide the current fetching or failed status", async () => {
  await cleanCache();
  let provider = "deepseek";
  let calls = 0;
  let rejectPending;
  const pending = new Promise((_, reject) => {
    rejectPending = reject;
  });
  const api = await harness("deepseek", async () => {
    calls++;
    if (calls === 1) {
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ balance_infos: [{ total_balance: "100", currency: "CNY" }] }),
      };
    }
    await pending;
  });

  api.handlers.session_start({ reason: "startup" }, api.ctx);
  await sleep(50);
  await api.handlers.agent_start({}, api.ctx);
  api.setProvider("future-provider");
  api.handlers.model_select({}, api.ctx);
  api.setProvider(provider);
  api.handlers.model_select({}, api.ctx);
  await sleep(20);
  assert.match(api.widgets.at(-1), /\(变更\).*\(请求中\)/);
  rejectPending(new Error("network down"));
  await sleep(1100);
  assert.match(api.widgets.at(-1), /\(变更\).*\(失败\)/);
  await cleanCache();
});

test("zero balance delta is rendered without a sign", async () => {
  await cleanCache();
  const api = await harness("deepseek", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ balance_infos: [{ total_balance: "37.03", currency: "CNY" }] }),
  }));

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  await api.handlers.agent_start({}, api.ctx);
  await api.handlers.agent_settled({}, api.ctx);
  await sleep(40);
  const widget = api.widgets.at(-1);
  assert.match(widget, /\(¥0\.00\)/);
  assert.doesNotMatch(widget, /[+-]¥0\.00/);

  const disk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(disk.providers.deepseek?.consumptions?.length, 1);
  assert.equal(disk.providers.deepseek.consumptions[0].deltas.balance, 0);
  await cleanCache();
});

test("balance increase is not recorded as zero consumption", async () => {
  await cleanCache();
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    const balance = calls === 1 ? 100 : 110;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: String(balance), currency: "CNY" }] }),
    };
  });

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  await api.handlers.agent_start({}, api.ctx);
  await api.handlers.agent_settled({}, api.ctx);
  await sleep(40);

  const disk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(disk.providers.deepseek?.consumptions, undefined);
  await cleanCache();
});

test("corrupted cache items are rejected without crashing the widget", async () => {
  await cleanCache();
  const fetchedAt = Date.now();
  await writeFile(cachePath, JSON.stringify({
    version: 2,
    providers: {
      deepseek: {
        trigger_line: {
          provider: "deepseek",
          fetchedAt,
          kind: "balance",
          items: [
            { kind: "text", text: "Balance: " },
            { kind: "evil", text: {} },
          ],
          metrics: { balance: 100 },
          currency: "¥",
        },
      },
    },
  }));
  const api = await harness("deepseek", async () => {
    throw new Error("network down");
  });

  api.handlers.session_start({ reason: "reload" }, api.ctx);
  await sleep(1300);
  const widget = api.widgets.at(-1) ?? "";
  assert.doesNotMatch(widget, /undefined|NaN/);
  assert.match(widget, /\(失败\)/);
  await cleanCache();
});

test("missing API key does not clear the cross-provider changed mark", async () => {
  await cleanCache();
  const api = await harness("deepseek", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ balance_infos: [{ total_balance: "100", currency: "CNY" }] }),
  }), async (provider) => provider === "kimi-coding" ? { auth: {} } : { auth: { apiKey: "test-key" } });

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  await api.handlers.agent_start({}, api.ctx);
  api.setProvider("kimi-coding");
  await api.handlers.model_select({}, api.ctx);
  await sleep(20);
  assert.equal(api.widgets.at(-1), "--");

  api.setProvider("deepseek");
  await api.handlers.model_select({}, api.ctx);
  await sleep(40);
  assert.match(api.widgets.at(-1), /\(变更\)/);

  await api.handlers.agent_settled({}, api.ctx);
  await sleep(40);
  await api.commands.aq10.handler({}, api.ctx);
  assert.equal(api.notices.at(-1), "deepseek: 暂无消耗记录");
  await cleanCache();
});

test("queued disk writes keep the latest memory state", async () => {
  await cleanCache();
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    const balance = calls === 1 ? 100 : 90;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: String(balance), currency: "CNY" }] }),
    };
  });

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  await api.handlers.agent_start({}, api.ctx);
  await api.handlers.agent_settled({}, api.ctx);
  await api.commands.aqlang.handler("en", api.ctx);
  await sleep(60);

  const disk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(disk.language, "en");
  assert.ok(Array.isArray(disk.providers.deepseek?.consumptions));
  assert.equal(disk.providers.deepseek.consumptions.length, 1);
  await cleanCache();
});

test("disk cache parent directories are created before writing", async () => {
  const savedHome = process.env.HOME;
  const home2 = await mkdtemp(join(tmpdir(), "pi-quota-mkdir-"));
  process.env.HOME = home2;
  try {
    const mod = await import(`../extensions/index.ts?mkdir=${++caseId}`);
    const handlers = {};
    const commands = {};
    const pi = { on(name, handler) { handlers[name] = handler; }, registerCommand(name, definition) { commands[name] = definition; } };
    mod.default(pi);
    const ctx = {
      get model() { return { provider: "deepseek" }; },
      modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }) },
      isIdle: () => true,
      ui: { setWidget() {}, notify() {} },
    };
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: "100", currency: "CNY" }] }),
    });

    handlers.session_start({ reason: "startup" }, ctx);
    await sleep(60);
    const file = join(home2, ".pi", "agent", "pi-check-agent-quota", "quota-cache.json");
    const fileStat = await stat(file);
    assert.equal(fileStat.mode & 0o777, 0o600);
    const directoryStat = await stat(dirname(file));
    assert.equal(directoryStat.mode & 0o777, 0o700);
    const disk = JSON.parse(await readFile(file, "utf8"));
    assert.equal(disk.version, 2);
  } finally {
    process.env.HOME = savedHome;
    await rm(home2, { recursive: true, force: true });
  }
});

test("session start always fetches even when the cache is fresh", async () => {
  await cleanCache();
  const fetchedAt = Date.now() - 60_000;
  await writeFile(cachePath, JSON.stringify({
    version: 2,
    providers: {
      deepseek: {
        trigger_line: {
          provider: "deepseek",
          fetchedAt,
          kind: "balance",
          items: [
            { kind: "text", text: "Balance: " },
            { kind: "balance", value: 37.03, currency: "¥", metric: "balance" },
          ],
          metrics: { balance: 37.03 },
          currency: "¥",
        },
      },
    },
  }));
  let fetchCalls = 0;
  const api = await harness("deepseek", async () => {
    fetchCalls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: "50", currency: "CNY" }] }),
    };
  });

  api.handlers.session_start({ reason: "reload" }, api.ctx);
  await sleep(80);
  assert.equal(fetchCalls, 1);
  assert.match(api.widgets.at(-1), /¥50\.00/);
  await cleanCache();
});

test("aqcheck throttles repeat requests within one second", async () => {
  await cleanCache();
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: String(100 - calls * 10), currency: "CNY" }] }),
    };
  });

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  await api.commands.aqcheck.handler({}, api.ctx);
  await sleep(40);
  assert.equal(calls, 2);
  assert.match(api.widgets.at(-1), /¥80\.00/);

  await api.commands.aqcheck.handler({}, api.ctx);
  await sleep(40);
  assert.equal(calls, 2);
  assert.match(api.widgets.at(-1), /¥80\.00/);

  await sleep(1100);
  await api.commands.aqcheck.handler({}, api.ctx);
  await sleep(40);
  assert.equal(calls, 3);
  assert.match(api.widgets.at(-1), /¥70\.00/);
  await cleanCache();
});

test("aqcheck throttle does not starve under continuous presses", async () => {
  await cleanCache();
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: "100", currency: "CNY" }] }),
    };
  });

  api.handlers.session_start({}, api.ctx);
  await sleep(40);

  for (let i = 0; i < 6; i++) {
    await api.commands.aqcheck.handler({}, api.ctx);
    await sleep(300);
  }
  assert.ok(calls >= 3, `expected periodic fetches under continuous presses, got ${calls} calls`);
  await cleanCache();
});

test("agent_start does not block on a slow quota fetch", async () => {
  await cleanCache();
  const fetchedAt = Date.now() - 2 * 60 * 60_000;
  await writeFile(cachePath, JSON.stringify({
    version: 2,
    providers: {
      deepseek: {
        trigger_line: {
          provider: "deepseek",
          fetchedAt,
          kind: "balance",
          items: [
            { kind: "text", text: "Balance: " },
            { kind: "balance", value: 100, currency: "¥", metric: "balance" },
          ],
          metrics: { balance: 100 },
          currency: "¥",
        },
      },
    },
  }));
  let fetchResolvedAt = null;
  let aborted = false;
  const api = await harness("deepseek", async (_url, { signal } = {}) => {
    signal?.addEventListener("abort", () => {
      aborted = true;
    });
    await sleep(4000);
    fetchResolvedAt = Date.now();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: "50", currency: "CNY" }] }),
    };
  });

  const startedAt = Date.now();
  await api.handlers.agent_start({}, api.ctx);
  const handlerDoneAt = Date.now();

  assert.ok(handlerDoneAt - startedAt < 3500, `agent_start blocked for ${handlerDoneAt - startedAt}ms`);
  assert.equal(fetchResolvedAt, null);

  await sleep(1500);
  assert.ok(fetchResolvedAt !== null);
  assert.match(api.widgets.at(-1), /¥50\.00/);
  assert.equal(aborted, false);
  await api.handlers.session_shutdown();
  await sleep(20);
  await cleanCache();
});

test("settled on an unsupported provider ends the round without a record", async () => {
  await cleanCache();
  let calls = 0;
  const api = await harness("deepseek", async () => {
    calls++;
    const balance = calls === 1 ? 100 : 80;
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ balance_infos: [{ total_balance: String(balance), currency: "CNY" }] }),
    };
  });

  api.handlers.session_start({}, api.ctx);
  await sleep(40);
  await api.handlers.agent_start({}, api.ctx);
  api.setProvider("volcengine");
  await api.handlers.model_select({}, api.ctx);
  await api.handlers.agent_settled({}, api.ctx);
  await sleep(40);

  assert.equal(calls, 1);
  assert.equal(api.widgets.at(-1), "--");
  const disk = JSON.parse(await readFile(cachePath, "utf8"));
  assert.equal(disk.active_round, undefined);
  assert.equal(disk.providers.deepseek?.base_line, undefined);
  assert.equal(disk.providers.deepseek?.consumptions, undefined);
  assert.equal(disk.providers.volcengine, undefined);

  api.setProvider("deepseek");
  await api.handlers.agent_start({}, api.ctx);
  await api.handlers.agent_settled({}, api.ctx);
  await sleep(40);
  await api.commands.aq10.handler({}, api.ctx);
  assert.equal(calls, 2);
  assert.equal(api.notices.at(-1), "deepseek 近1轮消耗 ¥20.00");
  await cleanCache();
});
