# WowUp agent control (MCP) — design

Status: design, 2026-11-23. Fork: `curseforge-mirror/WowUp`, branch `mirror` (every push to `mirror` publishes a
release, so this work lives on a branch until it's ready).

## Intent

Anyone who installs our WowUp fork can point their own AI agent at WowUp and have it do the whole addon job in plain
words: "find an addon that does X and install it", "X is breaking, find a replacement", "what changed in my addons
this week". The agent should be able to do everything an agent can do today by calling the CurseForge API directly,
but through WowUp, so it works across every source WowUp knows (CurseForge, Wago, GitHub, WowInterface, the WowUp
Hub), uses the keys the user already entered in WowUp, and leaves WowUp's own records and screen in step with what
happened.

Reading an addon's code before installing it must stay possible: the server is a way to act through WowUp, not a
layer that hides what is being installed.

## Goals

- An MCP server built into the fork, off until the user turns it on in Options, that any MCP-capable agent app can
  connect to: Claude Code, Cursor and others directly over HTTP; Claude Desktop (whose config file only takes stdio
  servers) through the widely used `mcp-remote` bridge (`npx -y mcp-remote <url>`). No key to copy or paste.
- Tools that cover WowUp's addon functionality: find, inspect, install, update, remove, switch source, rescan, check for
  updates, import and export lists, and settings such as auto-update and ignore.
- Inspection tools: download any candidate release into a sandbox and list, read and search its files, for agents with
  or without access to the user's disk.
- A backup before every change an agent makes, and a rollback that undoes it.
- A diff against upstream small enough that pulling upstream stays routine.

## Non-goals

- Deciding how much an agent may do alone. Tools act when called; whether the agent asks first is between the agent
  and its user. (For this project's own user: ask first unless the change was named.) Each change tool can preview
  instead of acting, which is what an agent uses to ask.
- Editing SavedVariables, launching WoW, or anything WowUp itself doesn't do (beyond reading addon error logs, below).
- Remote access. Only programs on the same machine.

## Anti-goals

- A diff that touches many upstream files or the dependency lockfile, so every upstream pull conflicts.
- A second copy of WowUp's logic that drifts from the buttons' behaviour (install, remove and update must go through
  the same code the UI uses).
- Ceremony: confirmation prompts, permission tiers and similar defensive layers. One on/off switch.

## Constraints

- Upstream moves fast (2.26 beta moves scanning, installing and the providers into the background process). The design
  must not depend on which side of that move a given operation lives.
- `package.json` / `package-lock.json`: upstream's Dependabot rewrites the lockfile often, so adding a dependency
  means a lockfile conflict on most pulls.
- The renderer holds the UI state (addon lists, install progress, notifications); changes made behind its back don't
  show until it reloads.

## Decided

**Where the work happens.** In the window (renderer), through WowUp's existing `AddonService` and friends, the same
methods the buttons call (`search`, `getAddon`, `getFullDescription`, `getChangelogForSearchResult`,
`getChangelogForAddon`, `installPotentialAddon` / `installAddon`, `updateAddon`, `removeAddon`, `setProvider`,
`rescanInstallation`, `syncClient` / `syncAllClients`, `findGameVersionMismatches`, `getAddonByUrl`,
`getCategoryPage`, `getFeaturedAddons`, the import/export service, and the install/WoW-installation services). These
exist on both 2.25 and 2.26, so the design doesn't care where upstream puts the heavy lifting, and the UI stays in
sync because it is the UI's own code running.

**How an agent reaches it.** The background process (main) runs a small MCP endpoint and forwards each tool call to
the window over one IPC channel pair of our own; a renderer service of our own runs it and sends the result back. The
preload already exposes generic `invoke`/`on`/`send`, so no preload change is needed.

**Transport.** MCP Streamable HTTP on `127.0.0.1` with a configurable port, no key. The server binds to loopback only and
rejects any request with a foreign `Origin` header with 403 (the MCP spec's guard against web pages), the same
switch + local address + Origin check that other local MCP servers (Figma's desktop app, JetBrains IDEs) use; a key in
WowUp's plain-JSON settings file would protect nothing against local programs. Any `Authorization` header is ignored. The MCP protocol layer is written by hand in our files (initialize, tools/list, tools/call,
ping; JSON-RPC 2.0), not taken from the MCP SDK, so `package.json` and the lockfile stay untouched. A `tools/call`
answers as an SSE stream (`text/event-stream`) whenever the client accepts it: progress notifications every ~10 s
while the tool runs (with the client's `progressToken` when it sent one), then the result. Clients built on the MCP
TypeScript SDK reset their 60-second request timeout on progress, so a full update check or a large download never
times out. Plain JSON responses otherwise.

**Switch and setup.** Options → Addons (where the fork already added the CurseForge key field) gets one block: the
on/off switch, the address, and "copy setup" for Claude Code (a
`claude mcp add --transport http …` line), for Claude Desktop (an `mcp-remote` entry for its config file) and for a generic JSON MCP config (just the `url`, as Cursor and most others take). Turning it on or
off applies at once; no restart.

**Files.** Everything new lives under `wowup-electron/app/mirror/agent/` (main) and
`wowup-electron/src/app/mirror/agent/` (renderer). Upstream files get only hooks:
- `app/main.ts`: one line starting the agent module with the window (main.ts is already in our diff);
- one line where the renderer starts up so our agent service is created (an existing startup spot);
- the Options block, as a component of our own included by one tag in `options-addon-section.component.html` (already
  in our diff) plus its declaration.
`MIRROR.md` lists the feature and its hook points.

**Tools.** Names are snake_case. Every tool that names an addon accepts either an installed addon's WowUp id or a
`provider` + `externalId` pair, and every tool that depends on a game install takes an `installation` (id or name,
defaulting to the selected one).

- Discovery: `list_installations`, `list_addons` (with filters: name, provider, has update, ignored, auto-update),
  `search_addons` (all enabled providers or a chosen one), `get_addon_details` (summary, authors, downloads, dates,
  game versions per flavor, latest file per channel, source and project links, dependencies), `get_changelog`,
  `get_description`, `find_by_url` (CurseForge, Wago, GitHub, WowInterface links), `browse_category`,
  `featured_addons`, `list_versions` (an addon's release history with dates, game versions per flavor and changelogs,
  where the source publishes one: CurseForge files and GitHub releases; others return their latest only).
  WowUp's providers only expose the newest file per channel, so `list_versions` reads the history itself, in our files,
  through the same APIs and the same keys WowUp already holds; no upstream provider file changes.
- Inspection: `fetch_release` (downloads a search result's or installed addon's release into the sandbox, unpacks it,
  returns its folder and file list), `list_files`, `read_file` (line ranges), `search_files` (text or regex) — all
  scoped to the sandbox or to an installed addon's folders; `read_toc`.
- Health: `check_updates` (one install or all; returns available updates and game-version mismatches),
  `get_addon_errors` (reads BugGrabber/BugSack's saved errors from the install's `WTF` folder when present: message,
  count, last seen, stack, the addon each points at).
- Changes: `install_addon` (optionally a specific version from `list_versions`, installed through WowUp's own install
  path; an addon pinned to an older version is set to ignore updates so auto-update doesn't undo it, and
  `set_ignored` lifts that), `update_addons` (some or all), `remove_addon`, `replace_addon` (back up, remove, install
  another addon in its place: the fork-swap done by hand on 2026-11-23), `switch_provider` (WowUp's own setProvider,
  for an addon whose other source WowUp already knows), `set_auto_update`, `set_ignored`, `rescan`, `import_addons`,
  `export_addons`.
- Recovery: `list_backups`, `rollback`.

Every change tool takes `preview: true`, which returns what would happen without doing it: entries added or dropped,
folders replaced, version before and after, and whether settings carry over (same folder names keep the same
SavedVariables).

**Backups.** Before any change, the agent service writes a backup to `<WowUp user data>/agent-backups/<time>-<tool>/`:
the affected addon folders, the affected WowUp addon records (JSON), and copies of the matching SavedVariables files
(account and character) from the install's `WTF` folder, with a `manifest.json` saying what was done and how to undo
it. The change tool's result includes the backup id.

`rollback` puts the addon back exactly as the backup holds it: folders, records and SavedVariables, removing whatever
the change added. It restores whatever is there now, including later updates by the user, auto-update or another
agent change, and it first backs up the current state, so a rollback can itself be rolled back. SavedVariables are
only written while that install's WoW isn't running (WoW rewrites them on logout); with WoW running, rollback restores
the rest and says the settings files are waiting, and running `rollback` again once WoW is closed finishes them.

Changes that only change records keep only records (no folder or SavedVariables copies), and their manifest says how
they roll back (`restoreMode`). A rescan's (`"records"`) puts every record back whole in place of the re-created ones;
no folder changes. A `set_auto_update` or `set_ignored` backup (`"settings"`) writes back only the settings those tools
change (`isIgnored`, `autoUpdateEnabled`, `autoUpdateNotificationsEnabled`), onto the addon's record as it is at
rollback time: the same id, else the same provider and externalId in that installation. A later update, reinstall or
replacement is kept as it is, and an addon removed since gets nothing back (no record claiming folders that are gone);
the result lists it under `skipped`. The safety backup of such a rollback is a settings backup too.

An install also writes the folders of the required dependencies WowUp installs after it (`installDependencies`), so
`install_addon`, `replace_addon`, `switch_provider`, `import_addons` and `update_addons` work those out before the
backup the way WowUp does: the release's (for an update, the record's) required dependencies at its provider that no
record installed then has as provider and externalId or among its externalIds (for `replace_addon`, without the addon
it removes first), and theirs in turn. Each one's folders come from the provider's file listing, or for a placeholder
or empty listing (GitHub, Zip, Wago, WowInterface) from a sandbox download, a few at a time with WowUp's retries. The
backup copies those folders too, with the records that claim them; previews list the dependencies under `alsoInstalls`
with their folders and count the ones on disk in `foldersReplaced`. When a dependency's folders can't be learned, a
single change fails before its backup with nothing changed, and a batch (`update_addons`, `import_addons`) leaves that
target out, as it does for a release it can't download. A dependency whose latest file has no download link
(CurseForge, when the author turns off third-party downloads) writes nothing, but WowUp still saves its record before
that install fails: it counts among the change's records (so rollback removes it), and a preview names it in its
action ("saves a record ... it can't download") instead of under `alsoInstalls`. WowUp looks each dependency up
again when it installs it, so a release published in between can write other folders than were planned: after the
change, a dependency record whose folders differ from its plan gets a warning in the result, naming the folders the
backup doesn't cover.

A backup notes what its change added (`added`), which rollback removes, by what the call itself made, not by every
record that appeared while it ran: WowUp's own hourly auto-update isn't blocked and can save records meanwhile. Only
the records the change created go in: the addon an install, replace, switch or import produced (by its id, or by
provider and externalId when WowUp makes the record itself) and those of the dependencies worked out before the
backup (by provider and externalId). An update makes no record of its own, only its dependencies'; a removal or a
settings change makes none. Any other record that appeared is left out of the backup and listed in the result under
`changedByWowUp` ("changed by WowUp during this change, not included in the backup"). A rescan re-creates every
record, so all the installation's new records are its own. "Appeared" is counted from the records there when the
backup was taken (its `recordIdsAtBackup`), not from when the call started: a record WowUp saved while the call waited
for its update check to finish (say its auto-update installing a dependency the call then finds installed) is not the
change's, so rollback doesn't take it away from the folders it restores.

A backup is pruned only when it is both older than 30 days and outside the newest 50.

**Sandbox.** `<WowUp user data>/agent-sandbox/<provider>-<id>-<version>/`, cleared when WowUp starts. Results carry
the absolute path too, for agents that can read the disk themselves.

**Base version.** Built on the current `mirror` plus upstream 2.25.5 (one test-file conflict). Moving to 2.26 waits for
it to go stable, so our CurseForge-key, link-lookup and GitHub-speed changes get ported to upstream's moved provider
code once instead of after each beta; the agent code only calls `AddonService` methods that 2.26 keeps.

## Left to the builder

- Exact tool argument and result shapes, error wording, and how results are trimmed for size.
- How the renderer service maps a tool call onto `AddonService` (and which helper services), including dependency
  installs and progress reporting.
- How preview is computed for each change tool.
- The default port, and how the Options block looks.
- Tests: unit tests for the MCP layer and the backup/rollback logic alongside the existing specs; a real launch driven
  over CDP with real input events to prove a tool call from Claude Code installs, previews and rolls back.
