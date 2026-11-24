# curseforge-mirror/WowUp

WowUp with the CurseForge provider back, no ads and no tracking. It follows upstream WowUp releases. This is the `beta`
branch: upstream's beta, 2.26.0-beta.1 (`develop`), merged with `mirror` and with agent control (below). `mirror` itself
is based on upstream 2.25.5.

## What's different

Every fork change is listed here. Upstream files only carry small hooks, so merges stay cheap. Since 2.26 the addon
providers, scans and installs run in the main process (`wowup-electron/app/`); the renderer (`wowup-electron/src/`) keeps
stand-ins that call them over IPC.

| Change | Where |
| :--- | :--- |
| CurseForge provider built into the normal (wago) flavor, running on your own API key: Options > Addons > CurseForge API Key. Off until a key is set. The renderer puts the key in the provider config it starts main's providers with (`IPC_ADDON_PROVIDERS_INIT`), and starts them again when the key changes; main keeps a keyless CurseForge out of scans and installs, and scans fingerprint folders for CurseForge too. | `wowup-electron/src/app/mirror/mirror.ts` (`mirrorProviderConfig`, `applyMirrorProviderRules`, hooked into `src/app/services/addons/addon.provider.factory.ts`), `wowup-electron/app/mirror/providers.ts` (`mirrorAllowsProvider`, hooked into `isEnabled` in `app/services/addon-providers/addon-provider-registry.ts`; `MIRROR_CURSEFORGE_PROVIDER` in `app/controllers/index.ts`), `src/common/mirror/provider-keys.ts`, the options addon section template |
| No ad space is ever requested. Wago's public token comes from its ad page, so Wago runs only with a personal Wago access key (Options > Addons). | `src/app/mirror/mirror.ts` (`MIRROR_ADS_ENABLED`), `src/app/services/session/session.service.ts`; main keeps a keyless Wago off in `app/mirror/providers.ts` |
| The main process cancels requests to ad, consent and telemetry hosts. | `wowup-electron/app/mirror/block-ads.ts` |
| The app updates from this repo's GitHub releases. Remote bundle updates are off and the shell trusts only our bundle key (`mirror-2026-a`). | `wowup-shell/scripts/set-flavor.js`, `scripts/build-shell.js`, `src/bundle-keys.ts` |
| Installers are unsigned (no WowUp LLC publisher pin), so Windows warns on first install. | `electron-build/electron-builder.json`, `electron-build/sign-windows.js` |
| Installing from a CurseForge link looks the project up by its exact slug. Upstream searches the slug's first word and checks one page of results, which misses most Forever add-ons (thousands start with "forever"). | `wowup-electron/app/services/addon-providers/curse-addon-provider.ts` (`searchBySlug`, `getAddonBySlug`) |
| GitHub update checks run 8 repositories at a time (upstream: 3), reuse each response for 2 minutes so a repository installed in several WoW installs is fetched once, and read `release.json` through the API asset endpoint instead of the website's download link (about 10 s per file). One check of 218 GitHub add-ons across 4 installs went from about 6 minutes to about 12 seconds. | `wowup-electron/app/services/addon-providers/github-addon-provider.ts` (`getWithRateLimit`, `getReleaseMetadata`, `GET_ALL_CONCURRENCY`) |

Keys never go in git or in builds. The app stores them in `%APPDATA%\WowUp\sensitive.json`, a plain JSON file.

## Taking an upstream release

```bash
git fetch upstream
git checkout master && git merge --ff-only upstream/master && git push origin master
git checkout mirror && git merge master && git push origin mirror
git checkout beta && git merge upstream/develop && git merge mirror && git push origin beta
```

Conflicts, if any, land on the hook lines listed above. Keep both sides.

## Building locally

```bash
export BUNDLE_SIGNING_KEY="$(cat ~/.wowup-mirror/bundle-signing-key.pem)" BUNDLE_SIGNING_KEY_ID=mirror-2026-a
cd wowup-lib && npm install && npm run build
cd ../wowup-shell && npm install
cd ../wowup-electron && npm install && npm run build:prod
cd ../wowup-shell && npm run electron:publish:never   # installers land in wowup-shell/release/
```

Builds rewrite `wowup-electron/app/env/environment.ts` and `wowup-shell/package.json`. Don't commit those changes.

## Releasing

Every push to `mirror` builds and publishes a release (**Mirror release (Windows)**; it can also be run from the
Actions tab), and installed apps update from it. The version is set at build time and never committed: upstream's
MAJOR.MINOR, with PATCH = upstream patch × 1000 + the workflow's run number (2.25.4 → 2.25.4002, 2.25.4003, …), so it
always increases, across upstream bumps too. Don't rename the workflow file: that restarts the run number. The
installers are unsigned (no code-signing certificate), so Windows SmartScreen warns on a first install.

Pushes to `beta` build the same way but publish a GitHub **pre-release**. `beta` is upstream's beta (`develop`)
merged with `mirror`, plus our own work in progress. Installs on WowUp's Beta update channel (Options) take it;
Stable installs only ever see `mirror`'s releases. After each stable release, merge `mirror` into `beta` so beta
never falls behind.

People who install the fork bring their own keys, in **Options → Addons**: a CurseForge API key from
[console.curseforge.com](https://console.curseforge.com/), and optionally a Wago access key (Wago Patreon). Each
provider stays off until it has a key.

The workflow needs the `BUNDLE_SIGNING_KEY` (PEM) and `BUNDLE_SIGNING_KEY_ID` (`mirror-2026-a`) secrets. The private
key also lives in `~/.wowup-mirror/`. If it's ever lost, generate a new one with
`node wowup-shell/scripts/generate-bundle-key.mts <id> <file>`, swap it into `bundle-keys.ts` and ship a release.
Installers carry both the shell and the bundle, so nothing is stranded.

## Agent control (MCP)

WowUp can let AI agents on the same computer search, install, update and remove addons, check addon health and roll changes back, through a local MCP server. It is **off by default**. Turn it on in **Options → Addons → Let AI agents control WowUp (MCP)**.

Every change an agent makes is backed up first, in `agent-backups/` inside WowUp's app data folder (old backups are pruned after 30 days, keeping the newest 50). Downloads are unpacked and inspected in `agent-sandbox/` in the same folder, which is wiped at each start. The server listens on `127.0.0.1` only (default port 17483) and rejects any request carrying a foreign `Origin` header (which is what keeps web pages out). There is no key: like other local MCP servers (Figma's desktop app, JetBrains IDEs), it relies on the on/off switch, the local-only address and the Origin check, and ignores any `Authorization` header.

Connecting, using the **Copy setup** buttons in Options:

- **Claude Code**: paste the copied `claude mcp add --transport http wowup …` command into a terminal.
- **Claude Desktop**: merge the copied JSON (`mcp-remote` via `npx`) into `claude_desktop_config.json`.
- **Other apps**: the copied JSON (just the `url`) fits any client that speaks streamable HTTP.

Code lives in `wowup-electron/app/mirror/agent/` (main process: HTTP server, and the sandbox downloads, since 2.26 only downloads in main) and `wowup-electron/src/app/mirror/agent/` (renderer: tools, backups, Options block). Hook points into upstream files:

| File | Hook |
| :--- | :--- |
| `wowup-electron/app/main.ts` | starts the agent server and registers its IPC channels |
| `wowup-electron/src/app/app.component.ts` | initializes `AgentBridgeService` at startup |
| `wowup-electron/src/app/components/options/options-addon-section/options-addon-section.component.html` | the `<app-agent-options>` tag after the CurseForge key block |
| `wowup-electron/src/app/modules/options.module.ts` | `AgentOptionsComponent` in `imports` |
