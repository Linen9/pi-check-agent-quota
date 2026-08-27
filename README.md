# pi-check-agent-quota

在 pi TUI 中显示 AI provider 的配额、余额，以及最近几轮对话的消耗。

![widget preview](https://raw.githubusercontent.com/Linen9/pi-check-agent-quota/main/assets/screenshot.png)

## 支持的 provider

| Provider | 接口 | 显示 |
|---|---|---|
| MiniMax (`minimax`, `minimax-cn`) | `GET /v1/token_plan/remains` | 5h / 7d 使用率 |
| Kimi Coding (`moonshotai`, `moonshotai-cn`, `kimi-coding`) | `GET /v1/usages` | 5h / 7d 使用率 |
| Z.AI / GLM (`zai`, `zai-coding-cn`) | `GET /api/monitor/usage/quota/limit` | 使用量 / 总量 / 使用率 |
| DeepSeek (`deepseek`) | `GET /user/balance` | 余额 |
| OpenRouter (`openrouter`) | `GET /api/v1/credits` | 余额 |
| OpenCode Go (`opencode-go`) | `GET /zen/go/v1/usage` | 5h / 7d / mo 使用率 |

其他 provider 不查询，Widget 显示 `--`。`opencode-go` 使用 pi 已有的 `OPENCODE_API_KEY`。

## 安装

```bash
pi install npm:pi-check-agent-quota
```

API key 复用 pi 已有的 provider 认证，无需额外配置。

## 显示

![中文界面](https://raw.githubusercontent.com/Linen9/pi-check-agent-quota/main/assets/screenshot.png)

![英文界面](https://raw.githubusercontent.com/Linen9/pi-check-agent-quota/main/assets/screenshot-en.png)

- 配额颜色：低用量绿色、接近上限黄色、超限红色；消耗差值紫色；
- 上一轮消耗：余额 `(¥-0.20)`、桶型 `(-20%)`；回升为正，无变化不带符号；
- 对话进行中显示 `(使用中)`，抓取失败显示 `(失败)`，跨 provider 的轮次显示 `(变更)`；
- 余额低于阈值变红（默认 10，可用环境变量 `PI_QUOTA_BALANCE_ALERT` 调整）。
- 余量预估（ETA）：状态栏左侧显示配额，右侧显示 `~N轮·预计可用2h15m`（按近期消耗节奏估算，样本不足或无消耗时隐藏）；窄窗口自动换行；`N<5` 或 `预计可用 ≤30m` 时数字标红；时间精确到分（`2h15m`），窗口拖拉自动重算贴边。

## 命令

| 命令 | 说明 |
|---|---|
| `/checkaq` | 强制刷新并显示当前 provider 的实时配额 |
| `/aq10` | 显示最近 10 条有消耗的对话轮次汇总 |
| `/aqlang zh\|en` | 切换界面语言（默认中文） |

`/aq10` 示例：

```text
minimax-cn 近2轮消耗 5h 23% / 7d 11%
opencode-go 近5轮消耗 5h 15% / 7d 10% / mo 5%
openrouter 近5轮消耗 $0.69
```

## 从旧版本迁移缓存（可选）

v0.1.2 起，缓存文件从 `~/.pi/agent/pi-check-agent-quota.json` 迁移到了
`~/.pi/agent/pi-check-agent-quota/quota-cache.json`。

**不迁移也能正常使用**——插件会在新位置从头开始累计，只是 `/aq10` 的历史消耗记录会清空。

如果想保留历史记录，手动搬移即可：

```bash
mkdir -p ~/.pi/agent/pi-check-agent-quota
mv ~/.pi/agent/pi-check-agent-quota.json ~/.pi/agent/pi-check-agent-quota/quota-cache.json
```

确认新位置能正常读写后，旧文件即可删除（上面的 `mv` 已完成移动）。

## Migrating cache from older versions (optional)

Since v0.1.2, the cache file has moved from `~/.pi/agent/pi-check-agent-quota.json`
to `~/.pi/agent/pi-check-agent-quota/quota-cache.json`.

**Migration is optional** — the plugin works fine without it; it will simply start
fresh, and your `/aq10` consumption history will be reset.

To keep your history, move the file manually:

```bash
mkdir -p ~/.pi/agent/pi-check-agent-quota
mv ~/.pi/agent/pi-check-agent-quota.json ~/.pi/agent/pi-check-agent-quota/quota-cache.json
```

## 隐私

- 只向对应 provider 的配额接口发送该 provider 的 API key；
- 不读取、不上传 prompt、回复、文件或对话内容；不保存 API key 和完整响应；无遥测；
- 本地缓存位于 `~/.pi/agent/pi-check-agent-quota/quota-cache.json`，仅当前用户可读写；
- 自定义 `baseUrl` 仅允许 HTTPS（本机回环可用 HTTP），请求不跟随重定向。

## 开发

源码位于 `extensions/index.ts`（入口）+`extensions/lib/`（`providers.ts`/`widget.ts`/`eta.ts`），试运行：

```bash
pi -e ./extensions/index.ts
```

## 更新日志

### v0.1.2
- 目录拆分：`extensions/pi-check-agent-quota.ts` → `extensions/index.ts` + `extensions/lib/providers.ts` + `extensions/lib/widget.ts` + `extensions/lib/eta.ts`（纯移动，零行为变化；`package.json: pi.extensions` 改为 `./extensions/index.ts`）
- 缓存迁移：`~/.pi/agent/pi-check-agent-quota.json` → `~/.pi/agent/pi-check-agent-quota/quota-cache.json`（独立数据目录，不自动迁移，详见上节；权限保持 0600/0700；写入加 dirty 检查跳过无效写盘）
- ETA 余量预估：变点截断（3x）+ EWMA（0.35），窗口 10，最少样本 4；状态栏左侧配额、右侧 `~N轮·预计可用2h15m`（窄窗口换行，`N<5` 或 `≤30m` 标红，精确到分，拖拉窗口自动贴边）

### v0.1.1
- 首个 npm 发布版本

## License

MIT
