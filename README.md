# pi-check-agent-quota

Display AI provider quota and balance, plus consumption of recent dialogue rounds in the pi TUI.

English | [中文说明](./README_CN.md)

![widget preview](https://raw.githubusercontent.com/Linen9/pi-check-agent-quota/main/assets/screenshot-en.png)

## Supported Providers

| Provider | Display |
|---|---|
| MiniMax (`minimax`, `minimax-cn`) | 5h / 7d usage |
| Kimi API (`moonshotai`, `moonshotai-cn`) | Balance |
| Kimi For Coding (`kimi-coding`) | 5h / 7d usage |
| Z.AI / GLM (`zai`) | Balance |
| Z.AI Coding Plan (`zai-coding-cn`) | Usage |
| DeepSeek (`deepseek`) | Balance |
| OpenRouter (`openrouter`) | Balance |
| OpenCode Go (`opencode-go`) | 5h / 7d / mo usage |

Other providers are not queried, widget shows `--`. `opencode-go` uses pi's existing `OPENCODE_API_KEY`.

## Installation

```bash
pi install npm:pi-check-agent-quota
```

API keys reuse pi's existing provider authentication, no extra configuration required.

## Display

### Color and Status

- **Quota colors**: low usage green, near-limit yellow, over-limit red; consumption delta purple.
- **Last round consumption**: balance `(¥-0.20)`, bucket `(-20%)`; increase shows `+`, no change shows no sign.
- **Status labels**:
  - Conversation in progress → `(using)`
  - Fetch failed → `(Failed)`
  - Cross-provider switch → `(changed)`
- **Balance alert**: number turns red when below threshold (default 10, configurable via `PI_QUOTA_BALANCE_ALERT`).

### Estimated Remaining (ETA)

Shown on the right side of the status bar as `Available: N rounds/2h15m`:

- **Consumption rate**: shortest available window by priority (`5h` → `used` → `7d` → `mo`). `5h`/`used` deltas are true per-round consumption; `7d`/`mo` are sliding windows, used only as fallback when no smaller window exists.
- **Bottleneck bucket**: rounds for each bucket = remaining / unified rate, take the first to exhaust. `7d`/`mo` that will reset first is not a constraint.
- **Hidden when**: insufficient samples, any bucket exhausted, or request failed.
- **Special displays**:
  - No consumption recently → `0 used in last N rounds` (supported for both balance and bucket types)
  - Over 365 rounds → `365+ rounds`
  - ≤5 rounds or ≤30 minutes remaining → number highlighted in red
- **Layout**: auto-wraps on narrow windows, recalculates on resize, time precise to minutes (`2h15m`).

## Commands

| Command | Description |
|---|---|
| `/checkaq` | Force refresh and show live quota for current provider |
| `/aq10` | Show summary of last 10 rounds with consumption |
| `/aqlang zh\|en` | Switch interface language (default zh) |

`/aq10` example:

```text
minimax-cn last 2 rounds 5h 23% / 7d 11%
opencode-go last 5 rounds 5h 15% / 7d 10% / mo 5%
openrouter last 5 rounds $0.69
```

## Migrate Cache from Older Versions (For Existing Users)

Since v0.1.2, cache file has moved from `~/.pi/agent/pi-check-agent-quota.json` to `~/.pi/agent/pi-check-agent-quota/quota-cache.json`.

**No migration required** — the plugin will start fresh at the new location, only `/aq10` history will be cleared.

To keep history, move the file manually:

```bash
mkdir -p ~/.pi/agent/pi-check-agent-quota
mv ~/.pi/agent/pi-check-agent-quota.json ~/.pi/agent/pi-check-agent-quota/quota-cache.json
```

After confirming the new location is readable/writable, the old file can be removed (the `mv` above already does it).

## Privacy

- Only the corresponding provider's API key is sent to its quota endpoint;
- No prompt, reply, file or conversation content is read or uploaded; no API key or full response is stored; no telemetry;
- Local cache is at `~/.pi/agent/pi-check-agent-quota/quota-cache.json`, readable/writable only by current user;
- Custom `baseUrl` allows only HTTPS (HTTP allowed for loopback), requests do not follow redirects.

## Development

Source in `extensions/index.ts` (entry) + `extensions/lib/` (`providers.ts` / `widget.ts` / `eta.ts`), try:

```bash
pi -e ./extensions/index.ts
```

## License

MIT
