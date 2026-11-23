export const AGENT_CHANNEL_CONFIGURE = "mirror-agent:configure";
export const AGENT_CHANNEL_CALL = "mirror-agent:call";
export const AGENT_CHANNEL_RESULT = "mirror-agent:result";
export const AGENT_CHANNEL_PROGRESS = "mirror-agent:progress";
export const AGENT_CHANNEL_WOW_RUNNING = "mirror-agent:wow-running";
export const AGENT_DEFAULT_PORT = 17483;

export interface AgentConfig {
  enabled: boolean;
  port: number;
  key: string;
}

export interface AgentStatus {
  listening: boolean;
  url: string;
  error?: string;
}

export interface AgentCallRequest {
  callId: string;
  name: string;
  args: Record<string, unknown>;
}

export interface AgentToolResult {
  text: string;
  isError?: boolean;
}

export interface AgentCallResponse {
  callId: string;
  result: AgentToolResult;
}

export interface AgentProgress {
  callId: string;
  message: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

type Prop = Record<string, unknown>;

const str = (description: string): Prop => ({ type: "string", description });
const bool = (description: string): Prop => ({ type: "boolean", description });
const int = (description: string): Prop => ({ type: "integer", description });
const strList = (description: string): Prop => ({ type: "array", items: { type: "string" }, description });

const INSTALLATION = str(
  "Installation id or name (see list_installations). Optional when WowUp has only one installation or a clear default.",
);
const ADDON_ID = str("Id of an installed addon, as returned by list_addons.");
const INSTALLED_PROVIDER = str("Instead of addonId: the installed addon's provider (with installedExternalId).");
const INSTALLED_EXTERNAL_ID = str("Instead of addonId: the installed addon's id at its provider.");
const PROVIDER = str("Addon provider name, e.g. Curse, GitHub, WowUpHub, Wago, Tukui, WowInterface, RaiderIO.");
const EXTERNAL_ID = str("The addon's id at the provider (as returned by search_addons or get_addon_details).");
const VERSION = str("A version or file id from list_versions. Omit for the latest.");
const PREVIEW = bool(
  "When true, nothing is backed up or changed; returns what the change would add, remove and replace.",
);
const ROOT = str("A sandbox folder returned by fetch_release, or addon:<addonId> for an installed addon's folders.");

function schema(properties: Record<string, Prop> = {}, required: string[] = []): Record<string, unknown> {
  const s: Record<string, unknown> = { type: "object", properties };
  if (required.length > 0) {
    s.required = required;
  }
  return s;
}

const CHANGE_NOTE =
  " Takes a backup first and returns its id (backupId); use rollback to undo. Pass preview: true to see the effect without changing anything.";

export const AGENT_TOOLS: AgentToolDefinition[] = [
  {
    name: "list_installations",
    description:
      "List the World of Warcraft installations WowUp manages (id, name, client type, folder path, addon count). Use the id or name as the `installation` argument of other tools.",
    inputSchema: schema(),
  },
  {
    name: "list_addons",
    description:
      "List installed addons for an installation, trimmed to name, provider, externalId, installed and latest version, folders, auto-update, ignored and game versions. Optional filters narrow the list.",
    inputSchema: schema({
      installation: INSTALLATION,
      name: str("Case-insensitive substring of the addon name."),
      provider: PROVIDER,
      hasUpdate: bool("Only addons with (true) or without (false) an available update."),
      ignored: bool("Only addons that are (true) or are not (false) ignored."),
      autoUpdate: bool("Only addons with auto-update on (true) or off (false)."),
    }),
  },
  {
    name: "search_addons",
    description:
      "Search all enabled providers for addons compatible with an installation. Returns name, provider, externalId, latest version, downloads and author per result.",
    inputSchema: schema({ query: str("Search text."), installation: INSTALLATION, provider: PROVIDER }, ["query"]),
  },
  {
    name: "get_addon_details",
    description:
      "Get details for one addon: summary, author, links, latest files with per-file game versions and folders. Give addonId for an installed addon, or provider and externalId for any addon.",
    inputSchema: schema({ installation: INSTALLATION, addonId: ADDON_ID, provider: PROVIDER, externalId: EXTERNAL_ID }),
  },
  {
    name: "get_changelog",
    description:
      "Get the changelog text of an addon's latest (or a given) version. Give addonId for an installed addon, or provider and externalId.",
    inputSchema: schema({
      installation: INSTALLATION,
      addonId: ADDON_ID,
      provider: PROVIDER,
      externalId: EXTERNAL_ID,
      version: VERSION,
    }),
  },
  {
    name: "get_description",
    description:
      "Get an addon's full description text from its provider. Give addonId for an installed addon, or provider and externalId.",
    inputSchema: schema({ installation: INSTALLATION, addonId: ADDON_ID, provider: PROVIDER, externalId: EXTERNAL_ID }),
  },
  {
    name: "find_by_url",
    description:
      "Resolve an addon page URL (CurseForge, GitHub, WoWInterface, ...) to its provider and externalId plus basic details.",
    inputSchema: schema({ url: str("Addon page or repository URL."), installation: INSTALLATION }, ["url"]),
  },
  {
    name: "browse_category",
    description:
      "Browse a provider's category listing page (e.g. Curse categories). Returns addons with name, provider, externalId and latest version.",
    inputSchema: schema(
      {
        category: str("Category name or id."),
        provider: PROVIDER,
        installation: INSTALLATION,
        page: int("Page number, starting at 1."),
      },
      ["category"],
    ),
  },
  {
    name: "featured_addons",
    description: "List the featured or popular addons for an installation's client type.",
    inputSchema: schema({ installation: INSTALLATION, provider: PROVIDER }),
  },
  {
    name: "list_versions",
    description:
      "List an addon's release history (up to 50 files) for the installation's game flavor, with the file WowUp would install for it: fileId, version, release date, channel (stable, beta, alpha), game versions, folders, download url. CurseForge and GitHub give full history; other providers only the latest file.",
    inputSchema: schema({
      addonId: ADDON_ID,
      provider: PROVIDER,
      externalId: EXTERNAL_ID,
      installation: INSTALLATION,
      includeChangelog: bool("Also fetch each version's changelog where the provider supports it."),
    }),
  },
  {
    name: "fetch_release",
    description:
      "Download a release of an addon into a sandbox folder, so its code can be inspected before installing: without a version the file install_addon would install for the installation, with one that version's file for the installation's flavor. Returns { root, path, files }; pass root to list_files, read_file, search_files and read_toc.",
    inputSchema: schema({
      provider: PROVIDER,
      externalId: EXTERNAL_ID,
      addonId: ADDON_ID,
      version: VERSION,
      installation: INSTALLATION,
    }),
  },
  {
    name: "list_files",
    description:
      "List files under a sandbox root (from fetch_release, or addon:<addonId>), optionally inside a subfolder.",
    inputSchema: schema({ root: ROOT, path: str("Subfolder relative to the root. Omit for the root.") }, ["root"]),
  },
  {
    name: "read_file",
    description:
      "Read a text file under a sandbox root, paged by line. Returns { text, totalLines, nextLine? }; call again with startLine = nextLine for more.",
    inputSchema: schema(
      {
        root: ROOT,
        path: str("File path relative to the root."),
        startLine: int("First line to return, starting at 1 (default 1)."),
        maxLines: int("Maximum lines to return (default 400)."),
      },
      ["root", "path"],
    ),
  },
  {
    name: "search_files",
    description:
      "Search file contents under a sandbox root for a text or regular expression. Returns up to 200 matches as file:line: text.",
    inputSchema: schema(
      {
        root: ROOT,
        pattern: str("Text to find (or a regular expression when regex is true)."),
        regex: bool("Treat pattern as a regular expression."),
      },
      ["root", "pattern"],
    ),
  },
  {
    name: "read_toc",
    description:
      "Read an addon's TOC file(s) and return their `## Key: value` pairs (Interface, Version, Dependencies, ...). Give addonId for an installed addon, or root and folder.",
    inputSchema: schema({
      addonId: ADDON_ID,
      root: ROOT,
      folder: str("Addon folder name inside the root."),
    }),
  },
  {
    name: "check_updates",
    description:
      "Refresh addon data from the providers and report which addons have updates (name, installed version, new version) per installation. Reports progress per installation.",
    inputSchema: schema({
      installation: INSTALLATION,
      all: bool("Check every installation instead of one."),
    }),
  },
  {
    name: "get_addon_errors",
    description:
      "Read Lua errors captured by BugGrabber in the installation's SavedVariables, newest first. Each has message, counter, time, session, stack and the addon folder responsible.",
    inputSchema: schema({
      installation: INSTALLATION,
      limit: int("Maximum errors to return (default 20)."),
      contains: str("Only errors whose message or stack contains this text."),
    }),
  },
  {
    name: "install_addon",
    description:
      "Install an addon from a provider into an installation. With a version, installs that file and marks the addon ignored so it is not auto-updated." +
      CHANGE_NOTE,
    inputSchema: schema(
      { provider: PROVIDER, externalId: EXTERNAL_ID, version: VERSION, installation: INSTALLATION, preview: PREVIEW },
      ["provider", "externalId"],
    ),
  },
  {
    name: "update_addons",
    description: "Update the given installed addons, or all addons that have updates." + CHANGE_NOTE,
    inputSchema: schema({
      installation: INSTALLATION,
      addonIds: strList("Ids of installed addons to update."),
      all: bool("Update every addon that has an update."),
      preview: PREVIEW,
    }),
  },
  {
    name: "remove_addon",
    description:
      "Uninstall an installed addon and delete its folders. Give addonId, or provider and externalId." + CHANGE_NOTE,
    inputSchema: schema({
      addonId: ADDON_ID,
      provider: PROVIDER,
      externalId: EXTERNAL_ID,
      installation: INSTALLATION,
      preview: PREVIEW,
    }),
  },
  {
    name: "replace_addon",
    description:
      "Replace an installed addon (addonId, or installedProvider and installedExternalId) with another addon or release, given by provider and externalId (removes the old one, installs the new one). Preview reports whether settings carry over (same folders) or not." +
      CHANGE_NOTE,
    inputSchema: schema(
      {
        addonId: ADDON_ID,
        installedProvider: INSTALLED_PROVIDER,
        installedExternalId: INSTALLED_EXTERNAL_ID,
        provider: str("Provider of the addon to install instead."),
        externalId: str(
          "Id at that provider of the addon to install instead (from search_addons or get_addon_details).",
        ),
        version: VERSION,
        installation: INSTALLATION,
        preview: PREVIEW,
      },
      ["provider", "externalId"],
    ),
  },
  {
    name: "switch_provider",
    description:
      "Move an installed addon (addonId, or installedProvider and installedExternalId) to another provider it is already known on (uses its recorded externalIds)." +
      CHANGE_NOTE,
    inputSchema: schema(
      {
        addonId: ADDON_ID,
        installedProvider: INSTALLED_PROVIDER,
        installedExternalId: INSTALLED_EXTERNAL_ID,
        provider: str("The provider to move it to, one it is known on (see get_addon_details)."),
        installation: INSTALLATION,
        preview: PREVIEW,
      },
      ["provider"],
    ),
  },
  {
    name: "set_auto_update",
    description:
      "Turn auto-update on or off for an installed addon. Give addonId, or provider and externalId." + CHANGE_NOTE,
    inputSchema: schema(
      {
        addonId: ADDON_ID,
        provider: PROVIDER,
        externalId: EXTERNAL_ID,
        enabled: bool("Auto-update on (true) or off (false)."),
        installation: INSTALLATION,
        preview: PREVIEW,
      },
      ["enabled"],
    ),
  },
  {
    name: "set_ignored",
    description:
      "Mark an installed addon as ignored (never updated) or not. Give addonId, or provider and externalId." +
      CHANGE_NOTE,
    inputSchema: schema(
      {
        addonId: ADDON_ID,
        provider: PROVIDER,
        externalId: EXTERNAL_ID,
        ignored: bool("Ignored (true) or not (false)."),
        installation: INSTALLATION,
        preview: PREVIEW,
      },
      ["ignored"],
    ),
  },
  {
    name: "rescan",
    description: "Rescan an installation's AddOns folder and re-match folders to providers." + CHANGE_NOTE,
    inputSchema: schema({ installation: INSTALLATION, preview: PREVIEW }),
  },
  {
    name: "import_addons",
    description: "Install the addons listed in a WowUp export string or JSON into an installation." + CHANGE_NOTE,
    inputSchema: schema(
      { text: str("WowUp export string or its JSON."), installation: INSTALLATION, preview: PREVIEW },
      ["text"],
    ),
  },
  {
    name: "export_addons",
    description:
      "Export an installation's addon list as a WowUp export string that import_addons accepts. Read only, no backup is taken.",
    inputSchema: schema({ installation: INSTALLATION }),
  },
  {
    name: "list_backups",
    description:
      "List backups taken before agent changes (id, tool, createdAt, addon names), newest first. Use an id with rollback.",
    inputSchema: schema(),
  },
  {
    name: "rollback",
    description:
      "Undo a change by restoring its backup: removes folders the change added, restores addon folders and records, and restores SavedVariables (deferred while WoW is running; call again after closing WoW to finish). Takes a safety backup of the current state first and returns its id.",
    inputSchema: schema({ backupId: str("Backup id from list_backups or a change result.") }, ["backupId"]),
  },
];
