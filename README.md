# Agent Usage Term

Compact terminal and tmux status-bar monitor for Z.AI Coding Plan token quota.

Built on the same Z.AI endpoint, severity thresholds, and GLM peak-hour schedule used by `agent-usage-bar` and `agent-usage-widget`, with zero external dependencies and a local cache so tmux polling never hammers the API.

## Requirements

- Node.js 20+
- A Z.AI API key in any of these locations (first match wins):
  1. `ZAI_API_KEY` environment variable
  2. `~/.config/agent-usage-term/env`
  3. `~/.config/agent-usage-bar/env`
  4. `~/projects/code/agent-usage-widget/.env` or `~/projects/agent-usage-widget/.env`
  5. `ANTHROPIC_AUTH_TOKEN` when `ANTHROPIC_BASE_URL` contains `z.ai`

## Usage

```sh
# One-shot compact line
agent-usage-term

# Shorter line (for shell prompts or tight spaces)
agent-usage-term --compact

# Force refresh (ignores 2-minute cache and backoff)
agent-usage-term --refresh

# Live compact view for a small terminal or tmux split pane
# Keys: r = refresh now, q = quit
agent-usage-term watch

# Machine-readable JSON
agent-usage-term --json
```

## tmux integration

`agent-usage-term tmux` prints a tmux-styled segment using a local cache (`~/.cache/agent-usage-term/zai.json`, default TTL 120s). When tmux refreshes its status bar every 15 seconds, cached reads return immediately without making network requests.

Print the ready-to-use snippet:

```sh
agent-usage-term tmux-snippet
```

Example `~/.tmux.conf`:

```tmux
set -g status-interval 15
set -g status-right-length 80
set -g status-right "#(~/.local/bin/agent-usage-term tmux) %H:%M %d-%b"
```

Available tmux styles (`--style`):

- `pill` (default): dark high-contrast badge that stays readable on tmux's default green status bar and dark themes
- `plain`: colored text without background fill
- `minimal`: plain text without tmux color tags (`ZAI 46%`)

## iTerm2 Status Bar extension

Pin Z.AI usage permanently in iTerm2's built-in Status Bar (no app modification required):

```sh
agent-usage-term iterm2-install
```

Then in iTerm2:

1. If Python Runtime is not installed yet: `Scripts -> Manage -> Install Python Runtime`
2. Start the script once via `Scripts -> AutoLaunch -> agent_usage_zai.py` (it auto-starts on future iTerm2 launches)
3. Enable the bar: `Settings -> Profiles -> Session -> Status bar enabled` -> `Configure Status Bar` -> drag **Z.AI Usage** onto the bar

Click the **Z.AI Usage** badge on the status bar anytime to force-refresh and open the detail popover.

## Indicators

- **Severity colors**: green `< 70%`, amber `70-89%`, red `>= 90%`
- **Reset time**: displays local reset clock and countdown (for example, `Reset 19:04 (3h 10m)`)
- **Stale fallback**: if a refresh fails or hits HTTP 429, the last known percentage stays visible with `*` and backs off exponentially (60s up to 15m).
