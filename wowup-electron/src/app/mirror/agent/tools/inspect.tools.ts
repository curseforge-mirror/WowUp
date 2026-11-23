import { dirname, join, relative, resolve, sep } from "path";
import { Addon, AddonSearchResult, DownloadAuth, WowInstallation } from "wowup-lib-core";

import { AgentToolContext, AgentToolSet } from "../agent-tool";
import { agentSandboxPath } from "../agent-settings";
import { getLatestFile } from "../../../utils/search-result.utils";
import { InstallationNameDeps, resolveAddon, resolveInstallationFor } from "../resolve";
import { canonicalProvider } from "./discovery.tools";
import { downloadToSandbox, resolveScopedPath, safeName } from "./release-download";
import { AgentVersion, CurseVersionClient, listVersions } from "./versions";

export { resolveScopedPath };

export const ADDON_ROOT_PREFIX = "addon:";
const DEFAULT_MAX_LINES = 400;
const MAX_MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;
const MAX_MATCHES = 200;
const MAX_SEARCH_FILE_BYTES = 2 * 1024 * 1024;
const MAX_LISTED_FILES = 1000;
const BINARY_EXTENSIONS = new Set([
  ".blp",
  ".tga",
  ".ogg",
  ".mp3",
  ".wav",
  ".ttf",
  ".otf",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".zip",
  ".7z",
  ".dll",
  ".exe",
]);

export interface InspectProvider {
  getById(addonId: string, installation: WowInstallation): Promise<AddonSearchResult | undefined>;
  getDownloadAuth?(): Promise<DownloadAuth | undefined>;
}

export interface InspectDeps {
  applicationFolderPath: string;
  fileService: {
    unzipFile(zipFilePath: string, outputFolder: string): Promise<string>;
    listEntries(
      sourcePath: string,
      filter: string,
    ): Promise<{ name: string; isDirectory: boolean; isSymbolicLink: boolean }[]>;
    readFile(sourcePath: string): Promise<string>;
    pathExists(sourcePath: string): Promise<boolean>;
    remove(sourcePath: string): Promise<boolean>;
    createDirectory(directoryPath: string): Promise<boolean>;
    statFiles(filePaths: string[]): Promise<{ [path: string]: { size: number } }>;
  };
  downloadService: {
    downloadZipFile(options: {
      auth?: DownloadAuth;
      fileName: string;
      outputFolder: string;
      url: string;
    }): Promise<string>;
  };
  addonService: {
    getAddons(installation: WowInstallation, rescan?: boolean): Promise<Addon[]>;
    getInstallBasePath(addon: Addon): string;
  };
  installService: InstallationNameDeps["installService"];
  getSelected: () => WowInstallation | undefined;
  getProvider: (name: string) => InspectProvider | undefined;
  getSecret: (key: string) => Promise<string | undefined>;
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
  createCurseClient?: (apiKey: string) => CurseVersionClient;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
}

function toSlash(p: string): string {
  return p.split(sep).join("/");
}

function extOf(p: string): string {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
}

interface Scope {
  base: string;
  /** Present for installed addons: the only first-level folders that may be read. */
  folders?: string[];
}

/** Parses the `## Key: Value` metadata lines of a TOC file. */
export function parseTocFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const m = /^##\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
    if (m) {
      fields[m[1]] = m[2];
    }
  }
  return fields;
}

export function createInspectTools(deps: InspectDeps): AgentToolSet {
  const { fileService } = deps;
  const sandboxBase = agentSandboxPath(deps.applicationFolderPath);

  const findAddon = async (addonId: string): Promise<Addon> => {
    const installs = await deps.installService.getWowInstallationsAsync();
    const all: Addon[] = [];
    for (const i of installs) {
      all.push(...((await deps.addonService.getAddons(i)) ?? []));
    }
    return resolveAddon({ addonId }, all);
  };

  const scopeFor = async (root: string | undefined): Promise<Scope> => {
    if (!root) {
      throw new Error("`root` is required (a root from fetch_release, or addon:<addonId>).");
    }
    if (root.startsWith(ADDON_ROOT_PREFIX)) {
      const addon = await findAddon(root.slice(ADDON_ROOT_PREFIX.length));
      return { base: deps.addonService.getInstallBasePath(addon), folders: addon.installedFolderList ?? [] };
    }
    if (root === "." || root === ".." || /[\\/:]/.test(root)) {
      throw new Error(`"${root}" is not a sandbox root; use the root returned by fetch_release.`);
    }
    return { base: resolveScopedPath(sandboxBase, root) };
  };

  /** Absolute path of `rel` inside the scope, enforcing the addon-folder allow-list. */
  const pathIn = (scope: Scope, rel: string): string => {
    const abs = resolveScopedPath(scope.base, rel);
    if (scope.folders) {
      const first = toSlash(relative(resolve(scope.base), abs)).split("/")[0];
      if (!first || !scope.folders.some((f) => f.toLowerCase() === first.toLowerCase())) {
        throw new Error(`"${rel}" is not inside one of the addon's folders: ${scope.folders.join(", ")}`);
      }
    }
    return abs;
  };

  const relOf = (scope: Scope, abs: string): string => toSlash(relative(resolve(scope.base), abs));

  /** Lists files under `dir`, joining names onto `dir` so results stay under it even when `dir` is a symlink. */
  const walk = async (dir: string): Promise<string[]> => {
    const out: string[] = [];
    for (const entry of await fileService.listEntries(dir, "*")) {
      const full = join(dir, entry.name);
      if (entry.isDirectory && !entry.isSymbolicLink) {
        out.push(...(await walk(full)));
      } else if (!entry.isDirectory) {
        out.push(full);
      }
    }
    return out;
  };

  const listUnder = async (dir: string): Promise<string[]> => {
    if (!(await fileService.pathExists(dir))) {
      throw new Error(`Nothing exists at ${dir}.`);
    }
    return walk(dir);
  };

  /** Every file the scope allows, as absolute paths. */
  const allFiles = async (scope: Scope): Promise<string[]> => {
    if (!scope.folders) {
      return listUnder(scope.base);
    }
    const out: string[] = [];
    for (const f of scope.folders) {
      out.push(...(await listUnder(join(scope.base, f))));
    }
    return out;
  };

  const pickVersion = (versions: AgentVersion[], wanted: string): AgentVersion => {
    const hit = versions.find((v) => v.version === wanted || v.fileId === wanted);
    if (!hit) {
      const known = versions
        .slice(0, 10)
        .map((v) => v.version)
        .join(", ");
      throw new Error(`Version "${wanted}" not found. Available: ${known || "none"}`);
    }
    return hit;
  };

  const download = async (
    provider: string,
    externalId: string,
    version: string,
    url: string,
    ctx: AgentToolContext,
  ): Promise<{ root: string; path: string; files: string[]; filesTruncated?: boolean }> => {
    const root = safeName(`${provider}-${externalId}-${version}`);
    const folder = await downloadToSandbox(deps, provider, root, url, (retry, waitMs, e) =>
      ctx.progress(
        `Downloading ${provider} ${externalId} ${version} failed (${e instanceof Error ? e.message : String(e)}); ` +
          `retry ${retry} in ${Math.round(waitMs / 1000)} s`,
      ),
    );
    const files = (await walk(folder)).map((p) => relOf({ base: folder }, p)).sort();
    return {
      root,
      path: folder,
      files: files.slice(0, MAX_LISTED_FILES),
      ...(files.length > MAX_LISTED_FILES ? { filesTruncated: true } : {}),
    };
  };

  const providerOf = (name: string): InspectProvider => {
    const p = deps.getProvider(canonicalProvider(name));
    if (!p) {
      throw new Error(`Provider "${name}" is not available (disabled or unknown).`);
    }
    return p;
  };

  return {
    fetch_release: async (args, ctx) => {
      const addonId = str(args, "addonId");
      const wanted = str(args, "version");
      if (addonId) {
        const addon = await findAddon(addonId);
        ctx.progress(`Downloading ${addon.name}`);
        return download(
          addon.providerName ?? "",
          addon.externalId ?? addon.id,
          addon.latestVersion ?? addon.installedVersion ?? "latest",
          addon.downloadUrl,
          ctx,
        );
      }
      const providerArg = str(args, "provider");
      const externalId = str(args, "externalId");
      if (!providerArg || !externalId) {
        throw new Error("Pass provider and externalId, or an installed addonId.");
      }
      const provider = canonicalProvider(providerArg);
      const installation = await resolveInstallationFor(deps, args.installation);
      let chosen: { version: string; downloadUrl: string };
      if (wanted) {
        // That version's file for the installation's flavor, as a pinned install_addon takes it
        const versions = await listVersions(provider, externalId, {
          clientType: installation.clientType,
          getSecret: deps.getSecret,
          getLatest: (name, id) => providerOf(name).getById(id, installation),
          fetchJson: deps.fetchJson,
          createCurseClient: deps.createCurseClient,
        });
        chosen = pickVersion(versions, wanted);
      } else {
        // The file install_addon installs: the provider's latest for the installation's flavor and channel
        const result = await providerOf(provider).getById(externalId, installation);
        if (!result) {
          throw new Error(`${provider} has no addon with externalId "${externalId}" for ${installation.displayName}.`);
        }
        const file = getLatestFile(result, installation.defaultAddonChannelType);
        if (!file) {
          throw new Error(`${provider} lists no files for ${result.name}.`);
        }
        chosen = file;
      }
      ctx.progress(`Downloading ${provider} ${externalId} ${chosen.version}`);
      return download(provider, externalId, chosen.version, chosen.downloadUrl, ctx);
    },

    list_files: async (args) => {
      const scope = await scopeFor(str(args, "root"));
      const rel = str(args, "path") ?? "";
      if (scope.folders && rel === "") {
        return { files: scope.folders };
      }
      const dir = rel === "" ? scope.base : pathIn(scope, rel);
      const files = (await listUnder(dir)).map((p) => relOf(scope, p)).sort();
      return {
        files: files.slice(0, MAX_LISTED_FILES),
        ...(files.length > MAX_LISTED_FILES ? { truncated: true } : {}),
      };
    },

    read_file: async (args) => {
      const scope = await scopeFor(str(args, "root"));
      const rel = str(args, "path");
      if (!rel) {
        throw new Error("`path` is required.");
      }
      const abs = pathIn(scope, rel);
      if (BINARY_EXTENSIONS.has(extOf(abs))) {
        throw new Error(`"${rel}" is a binary file type and cannot be read as text.`);
      }
      const lines = (await fileService.readFile(abs)).split(/\r?\n/);
      if (lines.length > 0 && lines[lines.length - 1] === "") {
        lines.pop();
      }
      const start = Math.max(1, num(args, "startLine", 1));
      const max = Math.min(MAX_MAX_LINES, Math.max(1, num(args, "maxLines", DEFAULT_MAX_LINES)));
      const slice = lines
        .slice(start - 1, start - 1 + max)
        .map((l) =>
          l.length > MAX_LINE_CHARS
            ? `${l.slice(0, MAX_LINE_CHARS)} ...[truncated ${l.length - MAX_LINE_CHARS} chars]`
            : l,
        );
      const end = start - 1 + slice.length;
      return {
        text: slice.join("\n"),
        totalLines: lines.length,
        ...(end < lines.length ? { nextLine: end + 1 } : {}),
      };
    },

    search_files: async (args) => {
      const scope = await scopeFor(str(args, "root"));
      const pattern = typeof args.pattern === "string" ? args.pattern : "";
      if (pattern === "") {
        throw new Error("`pattern` is required.");
      }
      const test = ((): ((line: string) => boolean) => {
        if (args.regex === true) {
          const re = new RegExp(pattern);
          return (line) => re.test(line);
        }
        return (line) => line.includes(pattern);
      })();

      const candidates = (await allFiles(scope))
        .filter((p) => !BINARY_EXTENSIONS.has(extOf(p)))
        .sort((a, b) => relOf(scope, a).localeCompare(relOf(scope, b)));
      const stats = await fileService.statFiles(candidates);
      const matches: string[] = [];
      let truncated = false;
      for (const file of candidates) {
        if ((stats[file]?.size ?? 0) > MAX_SEARCH_FILE_BYTES) {
          continue;
        }
        let text: string;
        try {
          text = await fileService.readFile(file);
        } catch {
          continue;
        }
        const rel = relOf(scope, file);
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          if (test(lines[i])) {
            if (matches.length >= MAX_MATCHES) {
              truncated = true;
              break;
            }
            matches.push(`${rel}:${i + 1}: ${lines[i].trim().slice(0, 300)}`);
          }
        }
        if (truncated) {
          break;
        }
      }
      return { matches, truncated };
    },

    read_toc: async (args) => {
      const addonId = str(args, "addonId");
      let scope: Scope;
      let folders: string[];
      if (addonId) {
        const addon = await findAddon(addonId);
        scope = { base: deps.addonService.getInstallBasePath(addon), folders: addon.installedFolderList ?? [] };
        folders = scope.folders ?? [];
      } else {
        scope = await scopeFor(str(args, "root"));
        const folder = str(args, "folder");
        if (!folder) {
          throw new Error("Pass addonId, or root and folder.");
        }
        pathIn(scope, folder);
        folders = [folder];
      }

      const out: { folder: string; file: string; fields: Record<string, string> }[] = [];
      for (const folder of folders) {
        const dir = pathIn(scope, folder);
        const tocs = (await listUnder(dir))
          .filter((p) => extOf(p) === ".toc" && dirname(p).toLowerCase() === dir.toLowerCase())
          .sort();
        for (const toc of tocs) {
          out.push({
            folder,
            file: toc.slice(dir.length + 1),
            fields: parseTocFields(await fileService.readFile(toc)),
          });
        }
      }
      return out;
    },
  };
}
