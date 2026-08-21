# pi-check-agent-quota

Show your AI provider quota and balance in the pi TUI as a status widget.

![widget preview](https://raw.githubusercontent.com/Linen9/pi-check-agent-quota/main/assets/screenshot.png)

Supports: **MiniMax** (5h / weekly buckets), **Kimi for Coding** (5h / 7d), **Zhipu GLM** (coding plan usage), **DeepSeek** (balance), **OpenRouter** (credits). Providers without a quota API display `--`.

```
Usage: 5h 43% (4h52m) / 7d 78% (4d23h)     Balance: $12.34
```

## Install

```bash
pi install npm:pi-check-agent-quota
```

The widget appears below the editor on the next session start. No configuration needed — API keys are read from your existing provider auth in pi.

## Usage

- **Widget** — shows quota automatically on startup, model switch, and after each agent turn. Numbers are cached (60s in-memory TTL, 10min disk cache) so startup and network cost stay near zero.
- **`/checkaq`** — force-refresh the widget for the current provider, bypassing the cache.
- **Color coding** — <41% green, 41–79% yellow, ≥80% red (or balance ≤ alert threshold).
- **`PI_QUOTA_BALANCE_ALERT`** — override the balance alert threshold (default: 10, in the provider's currency unit).

## Supported providers

| Provider | Endpoint | Display |
|---|---|---|
| MiniMax (`minimax`, `minimax-cn`, `minimax-intl`) | `GET /v1/token_plan/remains` | 5h + 7d usage % |
| Kimi for Coding (`moonshot`, `kimi`, `kimi-coding`) | `GET /v1/usages` | 5h + 7d usage % |
| Zhipu GLM (`zhipu*`, `glm`) | `GET /api/monitor/usage/quota/limit` | used/total % |
| DeepSeek (`deepseek`) | `GET /user/balance` | balance (¥/$) |
| OpenRouter (`openrouter`) | `GET /api/v1/credits` | balance ($) |

Volcengine / Doubao / Qwen token plans / Xiaomi show `--` (no API-key quota endpoint, or requires HMAC-V4 signing — not yet implemented).

## Development

Everything lives in one file: `extensions/pi-check-agent-quota.ts` (the pure helpers are exported, so you can poke them directly without a pi session):

```bash
node -e "import('./extensions/pi-check-agent-quota.ts').then(m => console.log(m.formatRemaining(3600000)))"
```

Load the extension with `pi -e ./extensions/pi-check-agent-quota.ts` to try it in a throwaway session.

## License

MIT
