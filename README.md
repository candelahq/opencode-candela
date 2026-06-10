# opencode-candela

OpenCode plugin for [Candela](https://github.com/candelahq/candela) — session tracking, cost toasts, rich budget warnings, and budget-aware session compaction.

[![npm](https://img.shields.io/npm/v/opencode-candela)](https://www.npmjs.com/package/opencode-candela)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

## What It Does

When you use [OpenCode](https://opencode.ai/) with Candela running locally, this plugin automatically:

| Feature | Description |
|---------|-------------|
| **Session cost toasts** | Shows token usage and cost when a session goes idle |
| **Rich budget warnings** | Daily spend, active grants, reset countdowns, color-coded urgency |
| **Shell env injection** | Sets `CANDELA_PROXY_URL` and `OPENAI_BASE_URL` in all shells |
| **Compaction context** | Injects current budget + grant state into session compaction summaries |

If Candela is not running, the plugin gracefully no-ops — zero overhead.

---

## Installation

### Option 1: npm (recommended)

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-candela"]
}
```

### Option 2: Local install

```bash
# Project-scoped
mkdir -p .opencode/plugins
cp -r node_modules/opencode-candela/src .opencode/plugins/opencode-candela/

# Global
mkdir -p ~/.config/opencode/plugins/opencode-candela
cp -r node_modules/opencode-candela/src/* ~/.config/opencode/plugins/opencode-candela/
```

---

## Prerequisites

1. **Candela running locally** — `candela start` (requires [candela](https://github.com/candelahq/candela) v0.4.6+)
2. **Authentication** — run `candela auth login` once to set up Google OAuth credentials (no `gcloud` CLI dependency)
3. **OpenCode installed** — `npm install -g opencode-ai`

The plugin auto-detects Candela on `localhost:8181`. To use a custom URL:

```bash
export CANDELA_PROXY_URL="http://localhost:9090"
```

---

## How It Works

### Session Cost Toast

When your OpenCode session goes idle, the plugin shows a summary:

```
📊 142.3K tokens · $0.47 · 12 calls · 3m42s
```

### Budget Warnings

On startup and after each session, the plugin checks your full budget state:

```
💰 Budget: $10.00 remaining (80% used)
   Active grants: +$5.00 bonus (resets in 3d 14h)
   Total remaining (waterfall): $15.00
⚠️ Daily budget is running low!
```

### Shell Environment

Every shell spawned by OpenCode gets Candela's proxy URL injected:

```bash
echo $CANDELA_PROXY_URL    # http://localhost:8181
echo $OPENAI_BASE_URL      # http://localhost:8181/proxy/openai/v1
```

### Compaction Context

When OpenCode compacts a long session, current budget and grant state is injected:

> This session has used 142.3K tokens ($0.47) across 12 LLM calls.
> Model breakdown:
>   - claude-sonnet-4 (anthropic): 98.2K tokens, $0.31
>   - gemini-2.5-pro (google): 44.1K tokens, $0.16
> Daily budget: $10.00 remaining of $50.00 (80% used).
> Active grants: +$5.00 bonus (resets in 3d 14h). Total remaining: $15.00.

---

## Configuration

The plugin works with zero configuration. Optional env vars:

| Variable | Default | Description |
|----------|---------|-------------|
| `CANDELA_PROXY_URL` | `http://localhost:8181` | Candela server URL |

---

## Combining with Candela Provider Config

For full integration, use this plugin alongside Candela providers in your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-candela"],
  "provider": {
    "candela-anthropic": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Claude via Candela",
      "options": {
        "baseURL": "http://localhost:8181/proxy/anthropic/v1"
      },
      "models": {
        "claude-sonnet-4-20250514": { "name": "Claude Sonnet 4" },
        "claude-opus-4-20250514": { "name": "Claude Opus 4" }
      }
    },
    "candela-gemini": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Gemini via Candela",
      "options": {
        "baseURL": "http://localhost:8181/proxy/gemini-oai/v1"
      },
      "models": {
        "gemini-3.5-pro": { "name": "Gemini 3.5 Pro" },
        "gemini-3.5-flash": { "name": "Gemini 3.5 Flash" },
        "gemini-2.5-pro": { "name": "Gemini 2.5 Pro" },
        "gemini-2.5-flash": { "name": "Gemini 2.5 Flash" }
      }
    }
  }
}
```

---

## Related

- [Candela](https://github.com/candelahq/candela) — OTel-native LLM observability platform
- [Candela Desktop](https://github.com/candelahq/candela-desktop) — Flutter macOS desktop app
- [candela-cline](https://www.npmjs.com/package/candela-cline) — Cline plugin
- [candela-vscode](https://open-vsx.org/extension/candelahq/candela-vscode) — VS Code extension

---

## Troubleshooting

### OpenCode Hangs, Shows Stale Models, or Behaves Unexpectedly

If OpenCode hangs, shows stale models, or behaves unexpectedly after config changes, delete the OpenCode database:

```bash
rm -rf ~/.local/share/opencode/opencode.db*
```

Then restart OpenCode. This clears cached state (model lists, provider connections, etc.) and forces a fresh sync.

---

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
