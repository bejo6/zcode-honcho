# zcode-honcho

Persistent memory for [ZCode](https://zcode.dev), powered by [Honcho](https://honcho.dev).

Hermes / dsh / cursor-honcho aligned: capture every turn, inject with TTL refresh + dialectic cadence.
Reads the same `~/.honcho/config.json` as the other Honcho integrations.

## Repository layout

```txt
zcode-honcho/
├── marketplace.json              # ZCode marketplace catalog (repo root)
├── .claude-plugin/marketplace.json
├── plugins/
│   └── zcode-honcho/             # the plugin (hooks, MCP, skills, commands)
└── tests/
    └── smoke.mjs
```

## Install (ZCode marketplace)

1. Open a workspace in ZCode.
2. **Settings → Plugins → Create → Add marketplace**
3. Enter this repository:
   - `bejo6/zcode-honcho`, or
   - `https://github.com/bejo6/zcode-honcho`
4. Under **Personal**, open **Honcho Memory** (`zcode-honcho`) → **Install** → leave it enabled.
5. Configure Honcho once on that machine:

```json
{
  "peerName": "your-name",
  "auth": { "apiKey": "${HONCHO_API_KEY}" },
  "hosts": {
    "zcode": { "workspace": "zcode" }
  }
}
```

Path: `~/.honcho/config.json`. `HONCHO_API_KEY` alone also works. Node ≥ 20 must be on `PATH`.

6. Start a new session (or reload) so hooks load.

ZCode installs a **copy** of the plugin into its own plugin root — it does not keep a live symlink to your git clone.

### Local development

**Settings → Plugins → Create → Add marketplace** → choose this repo’s local directory (the folder that contains `marketplace.json`). After code changes, refresh that marketplace, then reinstall/update the plugin.

## Develop / test

```sh
node tests/smoke.mjs
```

Full configuration reference: [plugins/zcode-honcho/README.md](plugins/zcode-honcho/README.md).

## License

MIT — see [LICENSE](LICENSE).
