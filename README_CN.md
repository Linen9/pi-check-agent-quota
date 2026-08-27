# pi-check-agent-quota

在 pi TUI 中显示 AI provider 的配额、余额，以及最近几轮对话的消耗。

[English](./README.md) | 中文说明

![widget preview](https://raw.githubusercontent.com/Linen9/pi-check-agent-quota/main/assets/screenshot.png)

## 支持的 provider

| Provider | 显示 |
|---|---|
| MiniMax (`minimax`, `minimax-cn`) | 5h / 7d 使用率 |
| Kimi API (`moonshotai`, `moonshotai-cn`) | 余额 |
| Kimi For Coding (`kimi-coding`) | 5h / 7d 使用率 |
| Z.AI / GLM (`zai`) | 余额 |
| Z.AI Coding Plan (`zai-coding-cn`) | 使用率 |
| DeepSeek (`deepseek`) | 余额 |
| OpenRouter (`openrouter`) | 余额 |
| OpenCode Go (`opencode-go`) | 5h / 7d / mo 使用率 |

其他 provider 不查询，Widget 显示 `--`。`opencode-go` 使用 pi 已有的 `OPENCODE_API_KEY`。

## 安装

```bash
pi install npm:pi-check-agent-quota
```

API key 复用 pi 已有的 provider 认证，无需额外配置。

## 显示

### 颜色与状态

- **配额颜色**：低用量绿色、接近上限黄色、超限红色；消耗差值紫色。
- **上一轮消耗**：余额 `(¥-0.20)`、桶型 `(-20%)`；回升为正，无变化不带符号。
- **状态标注**：
  - 对话进行中 → `(使用中)`
  - 抓取失败 → `(失败)`
  - 跨 provider 切换 → `(变更)`
- **余额告警**：低于阈值（默认 10，可用环境变量 `PI_QUOTA_BALANCE_ALERT` 调整）时数字标红。

### 余量预估（ETA）

状态栏右侧显示 `预计可用：N轮/2h15m`：

- **消耗速率**：按窗口优先级取最短可用窗口（`5h` → `used` → `7d` → `mo`）。`5h`/`used` 的增量是真实单轮消耗；`7d`/`mo` 为滑动窗口，仅在无更小窗口时作为回退。
- **瓶颈桶**：各桶轮数 = 各自剩余量 ÷ 统一速率，取最先耗尽的瓶颈。`7d`/`mo` 先重置则不构成约束。
- **隐藏条件**：样本不足、任一桶已耗尽、或请求失败时隐藏。
- **特殊显示**：
  - 近期无消耗 → `近x轮0消耗`（余额型和桶型都支持）
  - 超过 365 轮 → `365+轮`
  - 剩余 ≤5 轮或 ≤30 分钟 → 数字标红
- **布局**：窄窗口自动换行，拖拉窗口自动重算贴边，时间精确到分（`2h15m`）。

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

## 从旧版本迁移缓存（老用户须知）

v0.1.2 起，缓存文件从 `~/.pi/agent/pi-check-agent-quota.json` 迁移到了 `~/.pi/agent/pi-check-agent-quota/quota-cache.json`。

**不迁移也能正常使用**——插件会在新位置从头开始累计，只是 `/aq10` 的历史消耗记录会清空。

如果想保留历史记录，手动搬移即可：

```bash
mkdir -p ~/.pi/agent/pi-check-agent-quota
mv ~/.pi/agent/pi-check-agent-quota.json ~/.pi/agent/pi-check-agent-quota/quota-cache.json
```

确认新位置能正常读写后，旧文件即可删除（上面的 `mv` 已完成移动）。

> **Migration is optional** — the plugin works fine without it; it will simply start fresh, and your `/aq10` consumption history will be reset. To keep your history, move the file manually using the commands above.

## 隐私

- 只向对应 provider 的配额接口发送该 provider 的 API key；
- 不读取、不上传 prompt、回复、文件或对话内容；不保存 API key 和完整响应；无遥测；
- 本地缓存位于 `~/.pi/agent/pi-check-agent-quota/quota-cache.json`，仅当前用户可读写；
- 自定义 `baseUrl` 仅允许 HTTPS（本机回环可用 HTTP），请求不跟随重定向。

## 开发

源码位于 `extensions/index.ts`（入口）+ `extensions/lib/`（`providers.ts` / `widget.ts` / `eta.ts`），试运行：

```bash
pi -e ./extensions/index.ts
```

## License

MIT
