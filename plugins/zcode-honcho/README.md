# zcode-honcho

Persistent memory for [ZCode](https://zcode.dev), powered by [Honcho](https://honcho.dev).

A ZCode port of [dsh-honcho](https://github.com/plastic-labs/dsh-honcho) — Hermes/dsh-aligned memory loop.
It reads the same `~/.honcho/config.json` as the other Honcho integrations (claude-honcho, codex-honcho,
dsh-honcho, cursor-honcho), so there is one place to configure all of them — and pointing two of them at the
same `workspace` gives them one shared memory.

## What it does

**Captures every turn.** User prompts (UserPromptSubmit) and assistant replies (Stop) are queued locally —
secrets redacted first — and flushed to Honcho at turn boundaries. A failed upload is retried on the next
flush; nothing is sent twice after success.

**Injects memory each prompt** (Hermes / dsh / cursor-honcho):

| Turn | Behavior |
| --- | --- |
| First | Wait up to ~5s for `session.context()` (and dialectic when due) |
| Later | Serve the cached block; refresh in the background when the TTL expires |
| Dialectic | Periodic background profile refresh (every N turns), not a blocking per-prompt call |

`SessionStart` only bootstraps peers, optional directives, and a warm cache. The reliable inject path is
`UserPromptSubmit`.

**Gives the model five MCP tools:**

| Tool              | For                                                                        |
| ----------------- | -------------------------------------------------------------------------- |
| `honcho_search`   | Looking something up. Searches raw messages _and_ derived conclusions.     |
| `honcho_chat`     | Asking a question of judgment. Reasons over everything Honcho knows. Slow. |
| `honcho_remember` | Saving a durable fact, preference, or decision.                            |
| `honcho_status`   | Live status: peer, workspace, session, queue depth, last sync.             |
| `honcho_flush`    | Sync the capture queue now.                                                |

**`/honcho`** shows status, resolved config, or forces a sync — see below.

The server is a single zero-dependency Node script; nothing to `npm install`.

## Install

From the **repository root** (the folder that contains `marketplace.json`):

1. In ZCode: **Settings → Plugins → Create → Add marketplace** → paste the GitHub repo
   (`bejo6/zcode-honcho` or the HTTPS URL), or choose this directory locally.
2. Under **Personal**, install **Honcho Memory** (`zcode-honcho`) and leave it enabled.
3. Put your Honcho API key and name in `~/.honcho/config.json`:

```json
{
  "peerName": "your-name",
  "auth": { "apiKey": "${HONCHO_API_KEY}" },
  "hosts": {
    "zcode": { "workspace": "zcode" }
  }
}
```

Get a key at [app.honcho.dev](https://app.honcho.dev). `HONCHO_API_KEY` in the environment also works on its
own — the config file is only needed to change defaults. Node ≥ 20 must be on PATH (it provides `node`).

See the [root README](../../README.md) for the short marketplace walkthrough.

## Configuration

Everything behavioral lives in `~/.honcho/config.json` under `hosts.zcode` — the same file the other Honcho
integrations read. Root holds identity and connection; the host block holds behavior. The file is strict JSON
(no comments, no trailing commas).

```jsonc
{
  "peerName": "your-name",
  "workspace": "honcho",
  "baseUrl": "https://api.honcho.dev", // bare host or …/v3 both fine
  "timeoutMs": 30000,
  "auth": { "apiKey": "${HONCHO_API_KEY}" },
  "enabled": true, // global kill switch

  "hosts": {
    "zcode": {
      "workspace": "zcode",
      "aiPeer": "zcode", // defaults to the host name
      "observationMode": "unified", // unified | directional
      "sessionStrategy": "per-directory", // see Sessions below
      "sessionPeerPrefix": true,
      "sessionPrefix": "", // literal prefix on every generated name, e.g. "vps-"
      "sessions": { "/path/to/repo": "pinned-session-name" }, // pin a session
      "injection": {
        "sessionStart": ["directives", "summary", "peerCard"], // + representation
        "perTurn": ["userContext", "dialectic"],
        "searchTopK": 10,
        "searchMaxDistance": 0.6,
        "maxConclusions": 15,
        "maxRenderedConclusions": 4,
        "contextTokens": 1500,
        "cadence": { "dialectic": 5, "ttlSeconds": 300 },
        "dialectic": { "reasoning": "low", "maxChars": 600 }
      },
      "capture": {
        "saveMessages": true,
        "saveToolUse": false, // one-line summaries of tool activity
        "writeFrequency": "async", // accepted for contract parity; flushing happens at turn boundaries
        "noisePatterns": [] // additive to the built-in secret patterns
      },
      "messageUpload": {
        "maxUserTokens": 6000,
        "maxAssistantTokens": 6000
      }
    }
  }
}
```

### Alignment with dsh / Hermes / cursor-honcho

Defaults match dsh-honcho: `perTurn: ["userContext", "dialectic"]`, dialectic every 5 turns, context TTL 300s.

ZCode is hook-based rather than in-process, so refresh/dialectic after turn 1 run in a **detached background
Node process** (same idea as cursor-honcho) instead of an in-process timer. Turn 1 may block up to ~5s; later
turns never block on the network. Set `"perTurn": []` to disable per-turn inject. `capture.writeFrequency` is
accepted for contract parity; flushing happens at turn boundaries regardless.

Everything else — config resolution, session naming, secret redaction, representation filtering — is ported
from dsh-honcho and behaves the same.

### Sharing memory with other integrations

Each integration defaults to its own Honcho `workspace` — `zcode` here — and a workspace is the isolation
boundary, so **by default they do not see each other's memory.** Point them at the same `workspace` to merge:

```jsonc
"hosts": {
  "zcode":        { "workspace": "shared" },
  "claude_code":  { "workspace": "shared" }
}
```

Keep `peerName` identical across them too, since conclusions are stored per peer.

### Sessions

Default: one long-lived session per project directory, named `<peerName>-<dir>`, matching claude-honcho.
Pin a different name for any path with the root `sessions` map — an override always wins.

| `sessionStrategy`         | Session name               | Notes                                                                 |
| ------------------------- | -------------------------- | --------------------------------------------------------------------- |
| `per-directory` (default) | `<peer>-<dir>`             | Stable across restarts and branches                                   |
| `per-repo`                | `<peer>-<repo-root>`       | Same memory from any subdirectory                                     |
| `git-remote`              | `<peer>-<host-owner-repo>` | From the `origin` URL, so the same repo on two machines is one session |
| `git-branch`              | `<peer>-<dir>-<branch>`    | Falls back to `per-directory` outside a repo or on a detached HEAD    |
| `per-session`             | `<peer>-chat-<id>`         | A clean slate every restart                                           |
| `global`                  | `<peer>`                   | One memory for everything                                             |

Prefer the wider scopes: Honcho's Deriver needs a single session to accumulate enough material before it can
reason well.

## Commands

| Command          | Does                                                                              |
| ---------------- | --------------------------------------------------------------------------------- |
| `/honcho`        | Status: peer, workspace, session, strategy, pending uploads, last sync/fetch      |
| `/honcho config` | Resolved settings and the file they came from                                     |
| `/honcho flush`  | Sync now                                                                          |

## Requirements

- Node `>=20` on PATH (for the MCP server and hooks)
- A Honcho API key, or a self-hosted Honcho at `baseUrl`

## Credit

Ported from [dsh-honcho](https://github.com/plastic-labs/dsh-honcho) (MIT, Plastic Labs), which credits
[dsh-honcho-sync](https://github.com/nanpaidashi/dsh-honcho-sync) for the initial design and the sibling
Honcho integrations — [claude-honcho](https://github.com/plastic-labs/claude-honcho) and
[codex-honcho](https://github.com/plastic-labs/codex-honcho) — for the config contract, session-naming
convention, and secret redaction.

## License

MIT
