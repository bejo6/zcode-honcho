---
description: Show Honcho memory status, resolved config, or force a sync
argument-hint: "[config|flush]"
---

You are handling the `/honcho $ARGUMENTS` command for the Honcho memory plugin. Use the honcho MCP tools (honcho_status, honcho_flush) — do not guess paths or run scripts.

Based on `$ARGUMENTS`:

- **Empty or `status`** — call the `honcho_status` tool. Present the result as a short, readable summary: enabled state, peer, workspace, resolved session name (with the dashboard link), capture queue depth, and last sync/fetch including any error messages. If the API key is missing, say exactly what to configure (`HONCHO_API_KEY` or `auth.apiKey` in `~/.honcho/config.json`).
- **`config`** — call the `honcho_status` tool and report the resolved configuration in detail: config file path, host block used (`hosts.zcode`), session strategy and resolved session name, injection components (sessionStart and perTurn), capture settings (saveMessages, saveToolUse, noise patterns), and message upload limits. Note anything that looks misconfigured (e.g. an unknown sessionStrategy, or `perTurn: []` when Hermes/dsh-style refresh was intended).
- **`flush`** — call the `honcho_flush` tool and report the result plainly: how many messages were uploaded, or what failed and that it will retry on the next turn boundary.

Keep the output compact — this is a status command, not a report. Do not call honcho_search, honcho_chat, or honcho_remember here.
