import { dirname, isAbsolute, join, relative, resolve, sep } from "path";
import { Addon, AddonSearchResult, DownloadAuth, WowInstallation } from "wowup-lib-core";

import { AgentToolSet } from "../agent-tool";
import { agentSandboxPath } from "../agent-settings";
import { resolveAddon, resolveInstallation } from "../resolve";
import { canonicalProvider } from "./discovery.tools";
import { AgentVersion, CurseVersionClient, listVersions } from "./versions";

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
    listDirectoryRecursive(dirPath: string): Promise<string[]>;
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
  installService: { getWowInstallationsAsync(): Promise<WowInstallation[]> };
  getSelected: () => WowInstallation | undefined;
  getProvider: (name: string) => InspectProvider | undefined;
  getSecret: (key: string) => Promise<string | undefined>;
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
  createCurseClient?: (apiKey: string) => CurseVersionClient;
}

/**
 * Resolves `relativePath` under `rootDir` lexically; throws when it is absolute or leaves the root.
 * Symlinks are deliberately not resolved (WowUp's symlink mode makes addon folders symlinks).
 */
export function resolveScopedPath(rootDir: string, relativePath: string): string {
  const rel = relativePath ?? "";
  if (isAbsolute(rel) || /^[\\/]/.test(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new Error(`"${relativePath}" is absolute; pass a path relative to the root.`);
  }
  const base = resolve(rootDir);
  const abs = resolve(base, rel);
  const back = relative(base, abs);
  if (back === ".." || back.startsWith(".." + sep) || isAbsolute(back)) {
    throw new Error(`"${relativePath}" is outside the root.`);
  }
  return abs;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function num(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : fallback;
}

function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "_");
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
  for (const line of text.replace(/^﻿/, "").split(/\r?\n/)) {
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

  const listUnder = async (dir: string): Promise<string[]> => {
    if (!(await fileService.pathExists(dir))) {
      throw new Error(`Nothing exists at ${dir}.`);
    }
    return fileService.listDirectoryRecursive(dir);
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

  const pickVersion = (versions: AgentVersion[], wanted: string | undefined): AgentVersion => {
    if (versions.length === 0) {
      throw new Error("The provider lists no releases for this addon.");
    }
    if (wanted) {
      const hit = versions.find((v) => v.version === wanted || v.fileId === wanted);
      if (!hit) {
        throw new Error(
          `Version "${wanted}" not found. Available: ${versions
            .slice(0, 10)
            .map((v) => v.version)
            .join(", ")}`,
        );
      }
      return hit;
    }
    return versions.find((v) => v.channel === "stable") ?? versions[0];
  };

  const download = async (
    provider: string,
    externalId: string,
    version: string,
    url: string,
  ): Promise<{ root: string; path: string; files: string[]; filesTruncated?: boolean }> => {
    if (!url) {
      throw new Error("This release has no download URL (the provider does not allow direct downloads).");
    }
    const root = safeName(`${provider}-${externalId}-${version}`);
    const folder = resolveScopedPath(sandboxBase, root);
    const zipName = `${root}.zip`;
    const zipPath = join(sandboxBase, zipName);
    await fileService.createDirectory(sandboxBase);
    if (await fileService.pathExists(folder)) {
      await fileService.remove(folder);
    }
    let auth: DownloadAuth | undefined;
    try {
      auth = await deps.getProvider(canonicalProvider(provider))?.getDownloadAuth?.();
    } catch (e) {
      console.error("Agent download auth failed", e);
    }
    const saved = await deps.downloadService.downloadZipFile({
      auth,
      fileName: zipName,
      outputFolder: sandboxBase,
      url,
    });
    try {
      await fileService.unzipFile(saved || zipPath, folder);
    } finally {
      await fileService.remove(saved || zipPath).catch(() => false);
    }
    const files = (await fileService.listDirectoryRecursive(folder)).map((p) => relOf({ base: folder }, p)).sort();
    return {
      root,
      path: folder,
      files: files.slice(0, MAX_LISTED_FILES),
      ...(files.length > MAX_LISTED_FILES ? { filesTruncated: true } : {}),
    };
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
        );
      }
      const providerArg = str(args, "provider");
      const externalId = str(args, "externalId");
      if (!providerArg || !externalId) {
        throw new Error("Pass provider and externalId, or an installed addonId.");
      }
      const provider = canonicalProvider(providerArg);
      const installs = await deps.installService.getWowInstallationsAsync();
      const versions = await listVersions(provider, externalId, {
        getSecret: deps.getSecret,
        getLatest: (name, id) => {
          const p = deps.getProvider(canonicalProvider(name));
          if (!p) {
            throw new Error(`Provider "${name}" is not available (disabled or unknown).`);
          }
          return p.getById(id, resolveInstallation(args.installation, installs, deps.getSelected()));
        },
        fetchJson: deps.fetchJson,
        createCurseClient: deps.createCurseClient,
      });
      const chosen = pickVersion(versions, wanted);
      ctx.progress(`Downloading ${provider} ${externalId} ${chosen.version}`);
      return download(provider, externalId, chosen.version, chosen.downloadUrl);
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
