# WowUp Agent Control (MCP) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in MCP server inside the curseforge-mirror WowUp fork that lets any local agent do the whole addon job
through WowUp: find, inspect, install, update, replace, roll back.

**Architecture:** The main process serves MCP (hand-written JSON-RPC over Streamable HTTP on 127.0.0.1) and relays each
tool call to the renderer over our own IPC channels; a renderer service runs the call through WowUp's existing
`AddonService` and helper services (the code the buttons use), taking a backup before every change. Everything new
lives in our own folders; upstream files get one-line hooks.

**Tech Stack:** Electron 43 main (Node `http`), Angular 17 renderer, TypeScript; mocha + chai (main specs),
Jasmine/Karma-Electron (renderer specs); `curseforge-v2` client (already a dependency).

**Spec:** `docs/superpowers/specs/2026-11-23-wowup-agent-mcp-design.md`

## Global Constraints

- Work on branch `agent-mcp`. Never push `mirror` (every push to `mirror` publishes a release); don't push at all unless asked.
- Commit messages: one sentence, one line, present tense, no AI attribution or co-author trailers.
- No changes to `package.json` / `package-lock.json`; no new dependencies. The MCP layer is written by hand.
- Upstream files get only hooks: `app/main.ts` (one call), `src/app/app.component.ts` (inject + `initialize()`),
  `options-addon-section.component.html` (one tag), `src/app/modules/options.module.ts` (one import), plus `MIRROR.md`.
- No i18n keys: the Options block uses plain English strings (adding keys means touching every locale file).
- Server binds `127.0.0.1` only; requests need `Authorization: Bearer <key>`; off until enabled in Options; enabling,
  disabling, changing port or regenerating the key applies at once.
- Tool names are snake_case and exactly those in the spec's Tools list (plus `list_versions`, `list_backups`, `rollback`).
- Every change tool accepts `preview: true` and then changes nothing.
- Backups: `<userData>/agent-backups/<yyyyMMdd-HHmmss>-<tool>/` with `manifest.json`; pruned only when both older than
  30 days and outside the newest 50. Sandbox: `<userData>/agent-sandbox/<provider>-<id>-<version>/`, cleared at start.
- `tools/call` answers as SSE when the client's `Accept` includes `text/event-stream`, sending `notifications/progress`
  every 10 s while running; otherwise plain JSON.
- SavedVariables are written only while that installation's WoW process is not running.

## Review Focus

- An addon named by display name, or an installation name matching two installs: expect an error listing the
  candidates, never a silent pick. (Task 5 test `resolve rejects ambiguous names`.)
- The WowUp window reloads or closes mid-call: the pending MCP call returns a tool error within a second, the server
  keeps serving. (Task 4 test `relay fails pending calls when the window goes away`.)
- `read_file` / `list_files` / `search_files` given `..` segments, absolute paths or symlinks out of scope: rejected.
  (Task 7 test `inspection paths cannot escape their root`.)
- Enabling on a port already in use: Options shows the error text, the app keeps running, a later port change works.
  (Task 3 test `start reports EADDRINUSE and can start again on another port`.)
- Replacing an addon whose new release uses different folder names: preview reports `settingsCarryOver: false`;
  rollback removes the new folders and restores the old ones. (Task 10 test `replace preview flags folder changes`,
  Task 9 test `rollback removes folders the change added`.)

---

### Task 1: Take upstream 2.25.5

**Files:**
- Modify: whatever `git merge upstream/master` touches; resolve `wowup-electron/src/app/addon-providers/curse-addon-provider.spec.ts`

**Interfaces:**
- Produces: `agent-mcp` = `mirror` + upstream 2.25.5, all suites green.

- [ ] **Step 1: Merge** — `git fetch upstream && git merge upstream/master` on `agent-mcp`.
- [ ] **Step 2: Resolve the spec conflict** keeping both upstream's new tests and our slug-lookup tests.
- [ ] **Step 3: Run** `cd wowup-electron && npm run test:main && npx ng test --watch=false` — Expected: all pass.
- [ ] **Step 4: Update `MIRROR.md`'s base-version line to 2.25.5 and commit** — `git commit -m "Merge upstream 2.25.5"`.

### Task 2: Contract and MCP protocol layer

**Files:**
- Create: `wowup-electron/src/common/mirror/agent-contract.ts`
- Create: `wowup-electron/app/mirror/agent/mcp-protocol.ts`
- Test: `wowup-electron/app/mirror/agent/mcp-protocol.spec.ts`

**Interfaces:**
- Produces (`agent-contract.ts`):
  - channels `AGENT_CHANNEL_CONFIGURE = "mirror-agent:configure"`, `AGENT_CHANNEL_CALL = "mirror-agent:call"`,
    `AGENT_CHANNEL_RESULT = "mirror-agent:result"`, `AGENT_CHANNEL_PROGRESS = "mirror-agent:progress"`,
    `AGENT_CHANNEL_WOW_RUNNING = "mirror-agent:wow-running"`; `AGENT_DEFAULT_PORT = 17483`
  - `AgentConfig { enabled: boolean; port: number; key: string }`, `AgentStatus { listening: boolean; url: string; error?: string }`
  - `AgentCallRequest { callId: string; name: string; args: Record<string, unknown> }`
  - `AgentToolResult { text: string; isError?: boolean }`, `AgentCallResponse { callId: string; result: AgentToolResult }`,
    `AgentProgress { callId: string; message: string }`
  - `AgentToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }` and
    `AGENT_TOOLS: AgentToolDefinition[]` — one entry per spec tool, JSON Schema `inputSchema` (common properties:
    `installation?: string`, `addonId?: string`, `provider?: string`, `externalId?: string`, `preview?: boolean`).
- Produces (`mcp-protocol.ts`):
  - `type CallTool = (name: string, args: Record<string, unknown>, onProgress: (message: string) => void) => Promise<AgentToolResult>`
  - `MCP_SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"]`
  - `handleMcpMessage(message: unknown, callTool: CallTool, onProgress?: (n: JsonRpcNotification) => void): Promise<JsonRpcResponse | undefined>`
    — handles `initialize` (echo the client's version when supported, else the first; `capabilities: { tools: {} }`,
    `serverInfo: { name: "wowup", version }`), `notifications/*` (no response), `ping`, `tools/list` (from `AGENT_TOOLS`),
    `tools/call` (unknown tool → JSON-RPC error -32602; tool result → `{ content: [{ type: "text", text }], isError }`;
    progress → `notifications/progress` with the request's `_meta.progressToken` and an increasing `progress`),
    anything else → -32601; malformed → -32600.

- [ ] **Step 1: Write the failing tests** in `mcp-protocol.spec.ts`: `initialize echoes a supported version`,
  `initialize falls back to the newest version`, `notifications get no response`, `tools/list returns every AGENT_TOOLS
  entry` (`expect(names).to.deep.equal(AGENT_TOOLS.map(t => t.name))`), `tools/call wraps the tool text`,
  `tools/call marks tool errors with isError`, `tools/call on an unknown tool is -32602`, `progress carries the
  client's progressToken`, `unknown method is -32601`, `garbage is -32600`.
- [ ] **Step 2: Run** `cd wowup-electron && npx tsc -p app/tsconfig.spec.json && npx cross-env NODE_PATH=../wowup-shell/node_modules mocha out-tsc/app-spec/wowup-electron/app/mirror/agent/*.spec.js` — Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `agent-contract.ts` and `mcp-protocol.ts` (no Electron imports in `mcp-protocol.ts`).
- [ ] **Step 4: Run the same command** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Add the agent contract and an MCP message handler"`.

### Task 3: HTTP server

**Files:**
- Create: `wowup-electron/app/mirror/agent/mcp-http-server.ts`
- Test: `wowup-electron/app/mirror/agent/mcp-http-server.spec.ts`

**Interfaces:**
- Consumes: `handleMcpMessage`, `CallTool` (Task 2).
- Produces: `class McpHttpServer { start(config: { port: number; key: string }, callTool: CallTool): Promise<AgentStatus>; stop(): Promise<void>; get status(): AgentStatus }`
  — listens on `127.0.0.1:<port>`, path `/mcp`; `POST` only (`GET` → 405, other paths → 404); missing/wrong bearer
  → 401; an `Origin` header that isn't `null`, `http://127.0.0.1:*` or `http://localhost:*` → 403; `tools/call` with
  `Accept` containing `text/event-stream` → SSE (`event: message` frames: progress every 10 s, then the response);
  otherwise JSON; notifications → 202. `start` while running restarts on the new config; errors (e.g. `EADDRINUSE`)
  resolve to `{ listening: false, url, error }` rather than throwing. Progress interval is a constructor option
  (`progressIntervalMs = 10000`) so tests can shorten it.

- [ ] **Step 1: Write the failing tests** (real server on an ephemeral port, Node `fetch`): `rejects a missing key with 401`,
  `rejects a foreign Origin with 403`, `answers initialize as JSON`, `streams progress then the result over SSE`
  (`progressIntervalMs: 20`, a tool that waits 70 ms → at least 2 progress frames before the result frame),
  `answers notifications with 202`, `start reports EADDRINUSE and can start again on another port`,
  `stop closes the port`.
- [ ] **Step 2: Run** the Task 2 mocha command — Expected: FAIL.
- [ ] **Step 3: Implement** `McpHttpServer`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Serve MCP over local HTTP with a bearer key and streamed progress"`.

### Task 4: Main-process relay and startup hook

**Files:**
- Create: `wowup-electron/app/mirror/agent/agent-relay.ts`, `wowup-electron/app/mirror/agent/wow-process.ts`, `wowup-electron/app/mirror/agent/index.ts`
- Modify: `wowup-electron/app/main.ts` (after `registerControllers(...)` in `createWindow`: `initializeAgent(win);`)
- Test: `wowup-electron/app/mirror/agent/agent-relay.spec.ts`, `wowup-electron/app/mirror/agent/wow-process.spec.ts`

**Interfaces:**
- Consumes: `McpHttpServer`, contract channels.
- Produces:
  - `createRendererRelay(target: { send(channel: string, payload: unknown): void; isDestroyed(): boolean; once(event: "destroyed", cb: () => void): void }, ipc: { on(channel: string, l: (e: unknown, p: any) => void): void }): CallTool & { failAll(reason: string): void }`
    — sends `AgentCallRequest` on `AGENT_CHANNEL_CALL` with a fresh `callId`, resolves on the matching
    `AGENT_CHANNEL_RESULT`, forwards `AGENT_CHANNEL_PROGRESS` to the call's `onProgress`; a destroyed or reloading
    target fails every pending call with `{ isError: true, text: "WowUp's window went away; try again" }`.
  - `isWowRunning(executablePath: string): Promise<boolean>` — `tasklist /FO CSV /NH` on Windows, `ps -A -o comm=` elsewhere, matched on the executable's file name.
  - `initializeAgent(win: BrowserWindow): void` — `ipcMain.handle(AGENT_CHANNEL_CONFIGURE, (_e, c: AgentConfig) => c.enabled ? server.start(c, relay) : server.stop().then(() => server.status))`;
    `ipcMain.handle(AGENT_CHANNEL_WOW_RUNNING, (_e, exe: string) => isWowRunning(exe))`; fails pending calls on
    `did-start-loading` and `destroyed`; replaces handlers if called again (window recreated).

- [ ] **Step 1: Write the failing tests:** `relay resolves the matching callId only`, `relay forwards progress to the
  right call`, `relay fails pending calls when the window goes away`, `isWowRunning matches the executable name
  case-insensitively` (inject the process-list function).
- [ ] **Step 2: Run** the mocha command — Expected: FAIL.
- [ ] **Step 3: Implement** the three files and the `main.ts` hook.
- [ ] **Step 4: Run** `npm run test:main` — Expected: all main specs PASS.
- [ ] **Step 5: Commit** — `git commit -m "Relay agent tool calls from the main process to WowUp's window"`.

### Task 5: Renderer bridge, settings, argument resolution

**Files:**
- Create: `wowup-electron/src/app/mirror/agent/agent-bridge.service.ts`, `agent-settings.ts`, `resolve.ts`, `agent-tool.ts`
- Modify: `wowup-electron/src/app/app.component.ts` (inject `AgentBridgeService`; call `initialize()` beside `_wowUpProtocolService.initialize()`)
- Test: `wowup-electron/src/app/mirror/agent/agent-bridge.service.spec.ts`, `resolve.spec.ts`

**Interfaces:**
- Produces:
  - `agent-tool.ts`: `type AgentToolHandler = (args: Record<string, unknown>, ctx: AgentToolContext) => Promise<unknown>`; `interface AgentToolContext { progress(message: string): void }`; `type AgentToolSet = Record<string, AgentToolHandler>`
  - `agent-settings.ts`: preference keys `mirror_agent_enabled` (PreferenceStorageService, `"true"`/`"false"`),
    `mirror_agent_port` (PreferenceStorageService), `mirror_agent_key` (SensitiveStorageService);
    `newAgentKey(): string` (32 random bytes, base64url via `crypto.getRandomValues`).
  - `AgentBridgeService` (`providedIn: "root"`): `initialize(): Promise<void>` (reads settings, sends
    `AGENT_CHANNEL_CONFIGURE`, listens on `AGENT_CHANNEL_CALL`, clears `<userData>/agent-sandbox`, prunes backups);
    `getConfig(): Promise<AgentConfig>`; `setEnabled(enabled: boolean)`, `setPort(port: number)`,
    `regenerateKey()` — each saves and returns the new `AgentStatus`; `status$: Observable<AgentStatus>`;
    `registerTools(tools: AgentToolSet): void` (Tasks 6–10 call it from the constructor wiring); handler results are
    `JSON.stringify(value, null, 2)` into `AgentToolResult.text`; a thrown error becomes `{ isError: true, text: error.message }`.
  - `resolve.ts`: `resolveInstallation(arg: unknown, installs: WowInstallation[], selected?: WowInstallation): WowInstallation`
    (matches id, then case-insensitive display name/label, then client type name like "Forever"; none → error listing
    the choices; several → error listing them); `resolveAddon(args: { addonId?: string; provider?: string; externalId?: string }, installed: Addon[]): Addon`
    (by id, or provider + externalId; a bare name is refused with the closest matches listed).

- [ ] **Step 1: Write the failing tests:** `bridge runs a registered tool and returns its JSON`, `bridge turns a thrown
  error into isError`, `bridge reports an unknown tool`, `bridge forwards progress`, `resolve rejects ambiguous names`,
  `resolve finds an installation by client type`, `resolve refuses a bare addon name and lists matches`.
- [ ] **Step 2: Run** `npx ng test --watch=false --include='src/app/mirror/agent/**/*.spec.ts'` — Expected: FAIL.
- [ ] **Step 3: Implement** the four files and the `app.component.ts` hook.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Run agent tool calls in WowUp's window"`.

### Task 6: Discovery tools and release history

**Files:**
- Create: `wowup-electron/src/app/mirror/agent/tools/discovery.tools.ts`, `tools/versions.ts`
- Test: `tools/discovery.tools.spec.ts`, `tools/versions.spec.ts`

**Interfaces:**
- Consumes: `AddonService` (`search`, `getAddons`, `getAddonByUrl`, `getFullDescription`, `getChangelogForSearchResult`,
  `getChangelogForAddon`, `getCategoryPage`, `getFeaturedAddons`), `AddonProviderFactory.getProvider(name).getById`,
  `WarcraftInstallationService.getWowInstallationsAsync`, `SensitiveStorageService` (`PREF_CF2_API_KEY`,
  `PREF_GITHUB_PERSONAL_ACCESS_TOKEN`), `resolve.ts`.
- Produces: `createDiscoveryTools(deps): AgentToolSet` with `list_installations`, `list_addons`, `search_addons`,
  `get_addon_details`, `get_changelog`, `get_description`, `find_by_url`, `browse_category`, `featured_addons`,
  `list_versions`; and `versions.ts`: `listVersions(provider: string, externalId: string, deps): Promise<AgentVersion[]>`,
  `toSearchResultFile(v: AgentVersion): AddonSearchResultFile` where
  `AgentVersion { fileId: string; version: string; releaseDate: string; channel: "stable" | "beta" | "alpha"; gameVersions: string[]; folders: string[]; downloadUrl: string; changelog?: string }`.
  CurseForge: `cfv2.CFV2Client.getModFiles({ modId, pageSize: 50 })` (+ `getModFileChangelog` when asked);
  GitHub: `GET https://api.github.com/repos/{owner}/{repo}/releases?per_page=50` with the token when set, a release's
  zip asset as the download; other providers: the latest file from `getById` only.
  List results are trimmed to the fields an agent needs (name, provider, externalId, version, latest version,
  folders, auto-update, ignored, game versions); `list_addons` filters `name`, `provider`, `hasUpdate`, `ignored`,
  `autoUpdate`.

- [ ] **Step 1: Write the failing tests:** `list_addons filters by hasUpdate`, `search_addons passes the resolved
  installation`, `get_addon_details includes per-file game versions`, `listVersions maps CurseForge files`
  (releaseType 1/2/3 → stable/beta/alpha, `modules[].name` → folders), `listVersions maps GitHub releases`,
  `toSearchResultFile keeps the download url and folders`.
- [ ] **Step 2: Run** the Task 5 `ng test` command — Expected: FAIL.
- [ ] **Step 3: Implement** and register the set in `AgentBridgeService`.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Add agent tools to find addons and read their release history"`.

### Task 7: Inspection tools

**Files:**
- Create: `wowup-electron/src/app/mirror/agent/tools/inspect.tools.ts`
- Test: `tools/inspect.tools.spec.ts`

**Interfaces:**
- Consumes: `DownloadService.downloadZipFile`, `FileService` (`unzipFile`, `listDirectoryRecursive`, `readFile`, `pathExists`, `remove`), `listVersions`/`getById`, `resolve.ts`, `WowUpService.applicationFolderPath`.
- Produces: `createInspectTools(deps): AgentToolSet` with `fetch_release` (`{ provider, externalId, version? }` or an
  installed `addonId`; returns `{ root, path, files }` where `path` is the absolute folder, for agents that read the disk), `list_files` (`{ root, path? }`), `read_file`
  (`{ root, path, startLine = 1, maxLines = 400 }`, returns `{ text, totalLines, nextLine? }`), `search_files`
  (`{ root, pattern, regex? }`, max 200 matches with file:line), `read_toc` (`{ addonId }` or `{ root, folder }`, the
  TOC's `## Key: value` pairs per TOC file). `root` is a sandbox folder from `fetch_release` or `addon:<addonId>` for
  an installed addon's folders; `resolveScopedPath(root: string, relative: string): string` throws for any result
  outside the root.

- [ ] **Step 1: Write the failing tests:** `fetch_release downloads into the sandbox folder name`, `read_file pages
  long files`, `search_files caps matches`, `inspection paths cannot escape their root` (`..\\..\\WTF`, absolute
  `C:\\`, `/etc/passwd` all throw), `read_toc returns interface and version lines`.
- [ ] **Step 2–4: Run → implement → run** with the Task 5 `ng test` command.
- [ ] **Step 5: Commit** — `git commit -m "Add agent tools to download and read an addon's code"`.

### Task 8: Health tools

**Files:**
- Create: `wowup-electron/src/app/mirror/agent/tools/health.tools.ts`, `wowup-electron/src/app/mirror/agent/lua-literal.ts`
- Test: `tools/health.tools.spec.ts`, `lua-literal.spec.ts`

**Interfaces:**
- Consumes: `AddonService.syncClient` / `syncAllClients` / `getAllAddonsAvailableForUpdate` / `findGameVersionMismatches`, `WtfService.getWtfPath`, `FileService`.
- Produces: `parseLuaAssignments(source: string): Record<string, unknown>` (top-level `Name = <literal>` pairs; strings
  with escapes, long brackets `[[…]]`/`[=[…]=]`, numbers, booleans, nil, nested tables with `[key] =`, `key =` and
  positional entries); `createHealthTools(deps): AgentToolSet` with `check_updates` (`{ installation? | all: true }`,
  progress message per installation) and `get_addon_errors` (reads `WTF/Account/*/SavedVariables/!BugGrabber.lua`,
  newest first, `{ limit = 20, contains? }` → `{ message, counter, time, session, stack, addon }` where `addon` is the
  first `Interface/AddOns/<folder>/` in message or stack).

- [ ] **Step 1: Write the failing tests:** `parses BugGrabber's error list` (fixture modelled on BugGrabber's format:
  `BugGrabberDB = { ["errors"] = { { ["message"] = "...", ["counter"] = 3, ["stack"] = "[string \"@Interface/AddOns/Sorted/Data.lua\"]:12: ..." } } }`),
  `parses long-bracket strings`, `get_addon_errors names the addon folder`, `check_updates reports one installation`.
- [ ] **Step 2–4: Run → implement → run** with the Task 5 `ng test` command.
- [ ] **Step 5: Commit** — `git commit -m "Add agent tools for update checks and addon errors"`.

### Task 9: Backups and rollback

**Files:**
- Create: `wowup-electron/src/app/mirror/agent/agent-backup.service.ts`, `tools/recovery.tools.ts`
- Test: `agent-backup.service.spec.ts`

**Interfaces:**
- Consumes: `FileService` (`copy`, `remove`, `pathExists`, `listDirectories`, `writeFile`, `readFile`), `AddonStorageService` (`setAsync`, `removeAsync`, `getAllForInstallationIdAsync`), `AddonService.getFullInstallPath`, `WtfService.getWtfPath`, `ElectronService.invoke(AGENT_CHANNEL_WOW_RUNNING, exe)`.
- Produces:
  - `BackupManifest { id: string; tool: string; createdAt: string; installationId: string; records: Addon[]; folders: string[]; savedVariables: string[]; added: { addonIds: string[]; folders: string[] }; savedVariablesPending?: boolean }`
  - `AgentBackupService`: `create(tool: string, installation: WowInstallation, addons: Addon[], extraFolders?: string[]): Promise<BackupManifest>`
    (copies each addon's `installedFolderList` folders and the SavedVariables files whose base name equals a folder
    name, account-wide and per character); `recordAdded(id: string, added: Addon[]): Promise<void>`;
    `list(): Promise<Array<Pick<BackupManifest, "id" | "tool" | "createdAt"> & { addons: string[] }>>`;
    `rollback(id: string): Promise<RollbackResult>`; `prune(now?: Date): Promise<number>`.
  - `RollbackResult { safetyBackupId: string; restoredFolders: string[]; removedFolders: string[]; restoredRecords: number; removedRecords: number; savedVariables: "restored" | "pending-wow-running" | "none" }`
  - `createRecoveryTools(deps): AgentToolSet` with `list_backups` and `rollback` (`{ backupId }`).
  - Rollback order: safety backup of the current state → remove `added` folders and records → restore folders and
    records → SavedVariables (or mark pending; a later `rollback` of the same id finishes only the pending part).

- [ ] **Step 1: Write the failing tests:** `create copies folders, records and matching SavedVariables`,
  `rollback restores folders and records`, `rollback removes folders the change added`, `rollback takes a safety
  backup first`, `rollback leaves SavedVariables pending while WoW runs and finishes them later`,
  `prune keeps the newest 50 and anything younger than 30 days`.
- [ ] **Step 2–4: Run → implement → run** with the Task 5 `ng test` command.
- [ ] **Step 5: Commit** — `git commit -m "Back up before agent changes and roll them back"`.

### Task 10: Change tools

**Files:**
- Create: `wowup-electron/src/app/mirror/agent/tools/change.tools.ts`
- Test: `tools/change.tools.spec.ts`

**Interfaces:**
- Consumes: `AgentBackupService`, `AddonService` (`getAddon(externalId, provider, installation, targetFile?)`,
  `installAddon`, `updateAddon`, `removeAddon`, `setProvider`, `rescanInstallation`, `saveAddon`),
  `AddonProviderFactory.getProvider(...).getById`, `AddonBrokerService` (`getExportPayload`, `parseImportString`,
  `getImportSummary`, `installImportSummary`), `listVersions`/`toSearchResultFile`, `resolve.ts`.
- Produces: `createChangeTools(deps): AgentToolSet` with `install_addon` (`{ provider, externalId, version?, installation?, preview? }`;
  a `version` installs that file via `getAddon(..., toSearchResultFile(v))` and sets `isIgnored = true`),
  `update_addons` (`{ addonIds? | all: true }`), `remove_addon`, `replace_addon` (`{ addonId, provider, externalId, version? }`),
  `switch_provider` (`{ addonId, provider }` using the addon's known `externalIds`), `set_auto_update` (`{ addonId, enabled }`),
  `set_ignored` (`{ addonId, ignored }`), `rescan`, `import_addons` (`{ text }` = WowUp's export string or JSON),
  `export_addons`. Each change returns `{ backupId, changed }`; with `preview: true` it returns
  `ChangePreview { action: string; installation: string; add: AddonLine[]; remove: AddonLine[]; foldersReplaced: string[]; settingsCarryOver: boolean | "partial" }`
  where `AddonLine { name: string; provider: string; externalId: string; version: string; folders: string[] }` and
  nothing is backed up or changed. Install progress (`AddonInstallState` + percent) goes to `ctx.progress`.

- [ ] **Step 1: Write the failing tests:** `preview changes nothing`, `install_addon backs up then installs`,
  `install_addon with a version pins it`, `replace preview flags folder changes` (old `["A","A_Options"]`, new `["A"]`
  → `settingsCarryOver: "partial"`; new `["B"]` → `false`), `replace_addon removes then installs and records what it
  added`, `update_addons all only touches addons with updates`.
- [ ] **Step 2–4: Run → implement → run** with the Task 5 `ng test` command.
- [ ] **Step 5: Commit** — `git commit -m "Add agent tools that install, update, replace and remove addons"`.

### Task 11: Options block

**Files:**
- Create: `wowup-electron/src/app/mirror/agent/agent-options.component.ts` (standalone, selector `app-agent-options`, inline template), `agent-setup.ts`
- Modify: `options-addon-section.component.html` (`<app-agent-options></app-agent-options>` after our CurseForge key block), `src/app/modules/options.module.ts` (add `AgentOptionsComponent` to `imports`), `MIRROR.md` (feature, hook points, how to connect)
- Test: `agent-options.component.spec.ts`, `agent-setup.spec.ts`

**Interfaces:**
- Consumes: `AgentBridgeService` (`getConfig`, `setEnabled`, `setPort`, `regenerateKey`, `status$`).
- Produces: `agent-setup.ts`: `claudeCodeCommand(url: string, key: string): string` →
  `claude mcp add --transport http wowup <url> --header "Authorization: Bearer <key>"`;
  `claudeDesktopConfig(url, key): string` → JSON `{ "mcpServers": { "wowup": { "command": "npx", "args": ["-y", "mcp-remote", url, "--header", "Authorization: Bearer " + key] } } }`;
  `genericConfig(url, key): string` → JSON `{ "mcpServers": { "wowup": { "url": url, "headers": { "Authorization": "Bearer " + key } } } }`.
  UI: a slide toggle "Let AI agents control WowUp (MCP)", the address, port field, masked key with show/copy and
  "New key", three "Copy setup" buttons, and the status error text when `listening` is false while enabled.

- [ ] **Step 1: Write the failing tests:** `setup strings carry the url and key`, `toggle calls setEnabled`,
  `shows the server error`.
- [ ] **Step 2–4: Run → implement → run** with the Task 5 `ng test` command, then the full `npm test` — Expected: PASS.
- [ ] **Step 5: Commit** — `git commit -m "Add the Options switch and setup for agent control"`.

### Task 12: End-to-end check on a real launch

**Files:**
- Create: `wowup-electron/scripts/mirror-agent-smoke.mjs` (MCP client: initialize → tools/list → a tool call, SSE aware)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Build and launch** the dev app (`npm start`) with `--remote-debugging-port=9333`, against a scratch
  installation: a temp folder holding an empty `_forever_\Wow.exe`, added through Options, never the user's real
  installs. Drive Options with CDP real input events (`Input.dispatchMouseEvent`), not `el.click()`.
- [ ] **Step 2: Enable agent control** in Options; run `node scripts/mirror-agent-smoke.mjs <url> <key>` — Expected:
  initialize OK, every `AGENT_TOOLS` name listed, `list_installations` shows the scratch install.
- [ ] **Step 3: Exercise** `search_addons` ("tiptac"), `get_addon_details`, `list_versions`, `fetch_release` +
  `read_toc`, `install_addon` with `preview: true` then for real, `list_backups`, `rollback` — Expected: the addon
  appears in My Addons without a reload, rollback removes it, and the screen updates.
- [ ] **Step 4: Register with Claude Code** (`claude mcp add …` from the Options copy button) and confirm
  `claude mcp list` shows `wowup` connected.
- [ ] **Step 5: Run every suite** (`npm test` in `wowup-electron`) and `npm run lint` — Expected: PASS.
- [ ] **Step 6: Commit** — `git commit -m "Add a smoke test client for agent control"`.
