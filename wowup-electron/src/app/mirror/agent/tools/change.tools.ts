import { firstValueFrom, Observable } from "rxjs";
import {
  Addon,
  AddonDependencyType,
  AddonSearchResult,
  AddonSearchResultFile,
  DownloadAuth,
  getEnumName,
  WowClientType,
  WowInstallation,
} from "wowup-lib-core";

import { ADDON_PROVIDER_GITHUB, ADDON_PROVIDER_UNKNOWN, ADDON_PROVIDER_ZIP } from "../../../../common/constants";
import { AddonInstallState } from "../../../models/wowup/addon-install-state";
import { ExportPayload, ImportSummary, InstallEvent } from "../../../services/addons/addon-broker.service";
import { needsUpdate } from "../../../utils/addon.utils";
import { getLatestFile } from "../../../utils/search-result.utils";
import { AgentToolContext, AgentToolSet } from "../agent-tool";
import { InstallationNameDeps, resolveAddon, resolveInstallationFor } from "../resolve";
import { canonicalProvider } from "./discovery.tools";
import { createLimiter } from "./limiter";
import { DOWNLOAD_RETRIES, FOLDER_DOWNLOADS_AT_ONCE, ReleaseFolderDeps, releaseFolders } from "./release-download";
import { CurseVersionClient, listVersions, toSearchResultFile } from "./versions";

/** One addon in a preview: what a change adds or removes */
export interface AddonLine {
  name: string;
  provider: string;
  externalId: string;
  version: string;
  folders: string[];
}

/** What a change would do; returned instead of changing anything when `preview: true` */
export interface ChangePreview {
  action: string;
  installation: string;
  add: AddonLine[];
  remove: AddonLine[];
  /** Folders on disk now that the change would overwrite or delete */
  foldersReplaced: string[];
  /** Whether the addon keeps its folder names (and so its SavedVariables and settings) */
  settingsCarryOver: boolean | "partial";
  /**
   * Required dependencies of the releases that no installed addon is yet (and theirs in turn), from the release's
   * provider: WowUp installs them along after the addon (skipping one whose listed folders an installed addon already
   * claims). With the folders each one writes; `foldersReplaced` includes those on disk, and the backup covers them.
   */
  alsoInstalls?: AddonLine[];
}

export interface ChangedLine {
  change: "added" | "updated" | "removed";
  addonId: string;
  name: string;
  provider: string;
  externalId: string;
  version: string;
}

/** The slice of a provider these tools call */
export interface ChangeProvider {
  getById(addonId: string, installation: WowInstallation): Promise<AddonSearchResult | undefined>;
  getDownloadAuth?(): Promise<DownloadAuth | undefined>;
}

type OnInstallUpdate = (installState: AddonInstallState, progress: number) => void;

export interface ChangeDeps extends Omit<ReleaseFolderDeps, "getProvider"> {
  addonService: {
    getAllAddons(installation: WowInstallation): Promise<Addon[]>;
    getAddon(
      externalId: string,
      providerName: string,
      installation: WowInstallation,
      targetFile?: AddonSearchResultFile,
    ): Observable<Addon | undefined>;
    installAddon(addon: Addon, onUpdate?: OnInstallUpdate, originalAddon?: Addon): Promise<void>;
    updateAddon(addon: Addon, onUpdate?: OnInstallUpdate, originalAddon?: Addon): Promise<void>;
    removeAddon(addon: Addon | undefined, removeDependencies?: boolean, removeDirectories?: boolean): Promise<void>;
    setProvider(
      addon: Addon | undefined,
      externalId: string,
      providerName: string,
      installation: WowInstallation,
    ): Promise<void>;
    rescanInstallation(installation: WowInstallation): Promise<Addon[]>;
    saveAddon(addon: Addon | undefined): Promise<void>;
    findGameVersionMismatches(
      addons: Addon[],
      refresh?: boolean,
    ): Promise<{ addon: Addon; installation: WowInstallation }[]>;
  };
  brokerService: {
    addonInstall$: Observable<InstallEvent>;
    getExportPayload(installation: WowInstallation): Promise<ExportPayload>;
    parseImportString(importStr: string): Promise<ExportPayload>;
    getImportSummary(exportPayload: ExportPayload, installation: WowInstallation): Promise<ImportSummary>;
    installImportSummary(importSummary: ImportSummary, installation: WowInstallation): Promise<void>;
  };
  backupService: {
    create(
      tool: string,
      installation: WowInstallation,
      addons: Addon[],
      extraFolders?: string[],
      summary?: string,
      options?: { recordsOnly?: boolean; restoreMode?: "records" | "settings" },
    ): Promise<{ id: string; recordIdsAtBackup?: string[] }>;
    recordAdded(id: string, added: Addon[]): Promise<void>;
  };
  installService: InstallationNameDeps["installService"];
  /** The installation WowUp currently shows (SessionService) */
  getSelected: () => WowInstallation | undefined;
  getProvider: (name: string) => ChangeProvider | undefined;
  /** Entry names in the installation's AddOns folder, [] when there is none */
  listAddonFolders: (installation: WowInstallation) => Promise<string[]>;
  encodeBase64: (text: string) => Promise<string>;
  /** Tells My Addons to reload, after a change */
  notifyChanged?: () => void;
  /** Resolves once WowUp isn't checking for updates (its sync rewrites addon records when it ends) */
  whenIdle?: (ctx: AgentToolContext) => Promise<void>;
  getSecret: (key: string) => Promise<string | undefined>;
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
  createCurseClient?: (apiKey: string) => CurseVersionClient;
}

interface InstallPlan {
  /** Provider name to install from (the app's exact name) */
  provider: string;
  externalId: string;
  file: AddonSearchResultFile;
  pinned: boolean;
  line: AddonLine;
}

/** A change's backup, with the ids of the installation's records when it was taken */
interface TakenBackup {
  id: string;
  baselineIds?: string[];
}

/** A required dependency WowUp installs along with a release */
interface Dependency {
  /** Its externalId is the id the release lists it by */
  line: AddonLine;
  /** The externalId its record gets (the provider's own id for it) */
  recordExternalId: string;
  /**
   * Its latest file has no download link (CurseForge, when the author turns off third-party downloads): WowUp saves
   * its record, then the install fails and writes nothing. The record is still the change's, for rollback to remove.
   */
  recordOnly?: boolean;
}

/** A dependency as a release (AddonSearchResultFile) or an installed addon's record (Addon) lists it */
type ListedDependency = { externalAddonId: string; type: AddonDependencyType };

/** Most required dependencies one change looks up, theirs in turn included, before it gives up */
const MAX_DEPENDENCIES = 50;

/**
 * Providers whose folder list is a placeholder, not the zip's folders: GitHub lists the repository name, Zip the file
 * name. Their releases are always downloaded to learn what they write.
 */
const PLACEHOLDER_FOLDER_PROVIDERS = [ADDON_PROVIDER_GITHUB, ADDON_PROVIDER_ZIP].map((p) => p.toLowerCase());

/** For a rescan, which re-creates every record: no folder or SavedVariables copies; rollback puts records back whole */
const RECORDS_ONLY = { recordsOnly: true };

/**
 * For set_auto_update and set_ignored, which change only an addon's ignored and auto-update settings: rollback writes
 * back just those, onto the addon's record there is then, so an update, reinstall or removal afterwards is kept.
 */
const SETTINGS_ONLY = { recordsOnly: true, restoreMode: "settings" as const };

/** With `changedByWowUp`: records that appeared while a change ran that the change didn't make */
const BY_WOWUP_NOTE =
  "Changed by WowUp during this change (for example its own auto-update), not by this call, so not included in the backup.";

const IMPORT_ERRORS: Record<string, string> = {
  GENERIC_IMPORT_ERROR: "The import lists no addons.",
  INVALID_CLIENT_TYPE: "The import was made for another game client than this installation.",
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function folderKey(folder: string): string {
  return folder.toLowerCase();
}

/** Drops repeats, ignoring case (addon folders live on case-insensitive file systems on Windows) */
function uniqueFolders(folders: string[]): string[] {
  const seen = new Set<string>();
  return folders.filter((f) => {
    const k = folderKey(f);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

function overlaps(a: string[], b: string[]): boolean {
  const keys = new Set(b.map(folderKey));
  return a.some((f) => keys.has(folderKey(f)));
}

/** Same folder names → true, some shared → "partial", none → false */
function carryOver(oldFolders: string[], newFolders: string[]): boolean | "partial" {
  const before = new Set(oldFolders.map(folderKey));
  const after = new Set(newFolders.map(folderKey));
  const shared = [...after].filter((k) => before.has(k)).length;
  if (shared > 0 && shared === before.size && shared === after.size) {
    return true;
  }
  return shared > 0 ? "partial" : false;
}

function onDisk(folders: string[], disk: Set<string>): string[] {
  return uniqueFolders(folders).filter((f) => disk.has(folderKey(f)));
}

/**
 * An install with no addon of its own to replace: what it overwrites (its folders already on disk, plus the folders
 * of the unmatched records WowUp drops for it) against what it writes
 */
function installCarryOver(newFolders: string[], disk: Set<string>, dropped: Addon[]): boolean | "partial" {
  return carryOver(uniqueFolders([...onDisk(newFolders, disk), ...dropped.flatMap(foldersOf)]), newFolders);
}

/** One answer for several addons: all the same → that, otherwise "partial" */
function combineCarryOver(values: Array<boolean | "partial">): boolean | "partial" {
  if (values.length === 0 || values.every((v) => v === true)) {
    return true;
  }
  return values.every((v) => v === false) ? false : "partial";
}

function foldersOf(a: Addon): string[] {
  return a.installedFolderList ?? [];
}

function lineOf(a: Addon, version = a.installedVersion): AddonLine {
  return {
    name: a.name,
    provider: a.providerName ?? "",
    externalId: a.externalId ?? "",
    version: version ?? "",
    folders: foldersOf(a),
  };
}

function changedOf(change: ChangedLine["change"], a: Addon, version = a.installedVersion): ChangedLine {
  return {
    change,
    addonId: a.id,
    name: a.name,
    provider: a.providerName ?? "",
    externalId: a.externalId ?? "",
    version: version ?? "",
  };
}

/** "26.11.11" → "v26.11.11"; names like "TipTac-1.2" stay as they are */
function ver(version: string | undefined): string {
  const v = version ?? "";
  return /^\d/.test(v) ? `v${v}` : v;
}

function nameOf(installation: WowInstallation): string {
  return installation.displayName;
}

function isProvider(a: Addon, provider: string, externalId: string): boolean {
  return (a.providerName ?? "").toLowerCase() === provider.toLowerCase() && String(a.externalId ?? "") === externalId;
}

/** The required ones of a release's or record's dependencies, once each, as WowUp's getRequiredDependencies picks */
function requiredOf(dependencies: ListedDependency[] | undefined): string[] {
  return [
    ...new Set(
      (Array.isArray(dependencies) ? dependencies : [])
        .filter((d) => d?.type === AddonDependencyType.Required && d.externalAddonId !== undefined)
        .map((d) => String(d.externalAddonId)),
    ),
  ];
}

/**
 * As WowUp's isDependencyInstalled: a record from that provider (its exact name) with that externalId, or listing it
 * among its externalIds
 */
function hasDependency(installed: Addon[], provider: string, externalId: string): boolean {
  return installed.some(
    (a) =>
      (a.providerName === provider && a.externalId === externalId) ||
      !!a.externalIds?.some((e) => e.providerName === provider && e.id === externalId),
  );
}

function dependencyKey(provider: string, externalId: string): string {
  return `${provider.toLowerCase()}|${externalId}`;
}

/** Dependencies of several releases, once each */
function uniqueDependencies(dependencies: Dependency[]): Dependency[] {
  const seen = new Set<string>();
  return dependencies.filter((d) => {
    const k = dependencyKey(d.line.provider, d.line.externalId);
    if (seen.has(k)) {
      return false;
    }
    seen.add(k);
    return true;
  });
}

function dependencyFolders(dependencies: Dependency[]): string[] {
  return uniqueFolders(dependencies.flatMap((d) => d.line.folders));
}

/** Names for a backup summary, the first few then a count */
function listNames(names: string[], max = 5): string {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

export function createChangeTools(deps: ChangeDeps): AgentToolSet {
  const { addonService, backupService, brokerService } = deps;

  const resolveInstall = async (args: Record<string, unknown>): Promise<WowInstallation> =>
    resolveInstallationFor(deps, args.installation);

  const recordsOf = async (installation: WowInstallation): Promise<Addon[]> =>
    (await addonService.getAllAddons(installation)) ?? [];

  const diskOf = async (installation: WowInstallation): Promise<Set<string>> =>
    new Set(((await deps.listAddonFolders(installation)) ?? []).map(folderKey));

  const providerOf = (name: string): ChangeProvider => {
    const provider = deps.getProvider(canonicalProvider(name));
    if (!provider) {
      throw new Error(`Provider "${name}" is not available (disabled or unknown).`);
    }
    return provider;
  };

  /**
   * The installed addon a change names: its addonId, or its provider and externalId. Tools whose provider and
   * externalId name the addon to switch to or install instead take installedProvider and installedExternalId.
   */
  const installedAddon = (
    args: Record<string, unknown>,
    installed: Addon[],
    keys: { provider: string; externalId: string } = { provider: "provider", externalId: "externalId" },
  ): Addon => {
    const addonId = str(args, "addonId");
    if (addonId) {
      return resolveAddon({ addonId }, installed);
    }
    const provider = str(args, keys.provider);
    const externalId = str(args, keys.externalId);
    if (provider && externalId) {
      return resolveAddon({ provider: canonicalProvider(provider), externalId }, installed);
    }
    throw new Error(`Pass addonId (from list_addons), or ${keys.provider} and ${keys.externalId}.`);
  };
  const INSTALLED_KEYS = { provider: "installedProvider", externalId: "installedExternalId" };

  /**
   * The backup before a change, taken once no sync of WowUp's can rewrite the records it holds. With it the ids of
   * the installation's records then (the backup's own list, else read right after it): a record WowUp saved while
   * the call waited, such as its auto-update installing a dependency the call then finds installed, is no record
   * the change made.
   */
  const takeBackup = async (
    ctx: AgentToolContext,
    ...args: Parameters<ChangeDeps["backupService"]["create"]>
  ): Promise<TakenBackup> => {
    await deps.whenIdle?.(ctx);
    const backup = await backupService.create(...args);
    let baselineIds = backup.recordIdsAtBackup;
    if (!Array.isArray(baselineIds)) {
      try {
        baselineIds = (await recordsOf(args[1])).map((a) => a.id);
      } catch (e) {
        console.error("[agent] could not read the records after the backup; using the ones read before it", e);
      }
    }
    return { id: backup.id, baselineIds };
  };

  /** Install progress as "Downloading TipTac Reborn 25%" */
  const progressFor = (ctx: AgentToolContext, name: string): OnInstallUpdate => {
    return (state, percent) =>
      ctx.progress(`${AddonInstallState[state] ?? "Installing"} ${name} ${Math.round(percent)}%`);
  };

  /** Releases downloaded to learn their folders, a few at a time */
  const learnSlot = createLimiter(FOLDER_DOWNLOADS_AT_ONCE);

  /**
   * The top-level folders a release writes. Releases whose provider lists none before download (Wago, WowInterface)
   * or only a placeholder (GitHub, Zip) are downloaded to the sandbox and read, so previews and backups cover what
   * the install overwrites. Only the sandbox is written to; a download that still fails after WowUp's retries
   * throws before anything is backed up or changed.
   */
  const learnFolders = async (
    listed: string[] | undefined,
    release: { provider: string; externalId: string; name: string; version: string; url: string },
    ctx: AgentToolContext,
  ): Promise<string[]> => {
    if (listed && listed.length > 0 && !PLACEHOLDER_FOLDER_PROVIDERS.includes(release.provider.toLowerCase())) {
      return listed;
    }
    const what = `${release.name} ${release.version}`;
    try {
      const folders = await learnSlot(() => {
        ctx.progress(`Downloading ${what} to see which folders it writes`);
        return releaseFolders(
          deps,
          release.provider,
          release.externalId,
          release.version,
          release.url,
          (retry, waitMs, e) =>
            ctx.progress(
              `Downloading ${what} failed (${message(e)}); retry ${retry} of ${DOWNLOAD_RETRIES} in ${Math.round(waitMs / 1000)} s`,
            ),
        );
      });
      if (folders.length === 0) {
        throw new Error("the zip has no folders");
      }
      return folders;
    } catch (e) {
      throw new Error(`Could not download ${what} to see which folders it writes: ${message(e)}.`);
    }
  };

  /** One change's release: a failed download fails the call */
  const foldersOfRelease = async (...args: Parameters<typeof learnFolders>): Promise<string[]> => {
    try {
      return await learnFolders(...args);
    } catch (e) {
      throw new Error(`${message(e)} Nothing was changed.`);
    }
  };

  /** One target of a batch: its folders, or why they couldn't be learned (the target is then left out, unchanged) */
  const batchFolders = async (learn: () => Promise<string[]>): Promise<string[] | { error: string }> => {
    try {
      return await learn();
    } catch (e) {
      return { error: `${message(e)} Nothing was changed for it.` };
    }
  };

  /**
   * One required dependency as WowUp's install finds it: the latest file at the release's provider for the
   * installation's channel, with the folders it writes learned like a release's. Undefined when WowUp finds nothing
   * to install (provider not available, no such addon, no file). A file without a download link is a record-only
   * dependency: WowUp saves its record before its install fails, so it writes no folder and pulls in none of its own.
   * A lookup or download that fails throws.
   */
  const lookupDependency = async (
    installation: WowInstallation,
    providerName: string,
    externalId: string,
    ctx: AgentToolContext,
  ): Promise<{ dependency: Dependency; requires: string[] } | undefined> => {
    const provider = deps.getProvider(canonicalProvider(providerName));
    if (!provider) {
      return undefined;
    }
    const along = `a required dependency WowUp installs along`;
    let result: AddonSearchResult | undefined;
    try {
      result = await provider.getById(externalId, installation);
    } catch (e) {
      throw new Error(`Could not look up ${providerName} ${externalId}, ${along}: ${message(e)}.`);
    }
    const file = result ? getLatestFile(result, installation.defaultAddonChannelType) : undefined;
    if (!result || !file) {
      return undefined;
    }
    const line = {
      name: result.name,
      provider: result.providerName || providerName,
      externalId,
      version: file.version,
    };
    const recordExternalId = String(result.externalId ?? externalId);
    if (!file.downloadUrl) {
      return { dependency: { line: { ...line, folders: [] }, recordExternalId, recordOnly: true }, requires: [] };
    }
    let folders: string[];
    try {
      folders = await learnFolders(
        file.folders,
        { provider: providerName, externalId, name: result.name, version: file.version, url: file.downloadUrl },
        ctx,
      );
    } catch (e) {
      throw new Error(`${message(e)} ${result.name} is ${along}.`);
    }
    return { dependency: { line: { ...line, folders }, recordExternalId }, requires: requiredOf(file.dependencies) };
  };

  /**
   * What WowUp's installDependencies installs after the releases of one change, theirs in turn included: required
   * dependencies at the release's provider that no record installed then has (`installed`, as it will be when they
   * install) and that the change doesn't install itself (`covered`). Each is looked up once per call, a few
   * downloads at a time; a lookup or download that fails throws.
   */
  const dependencyPlanner = (installation: WowInstallation, installed: Addon[], ctx: AgentToolContext) => {
    const lookups = new Map<string, ReturnType<typeof lookupDependency>>();
    const lookup = (provider: string, externalId: string): ReturnType<typeof lookupDependency> => {
      const key = dependencyKey(provider, externalId);
      const known = lookups.get(key);
      if (known !== undefined) {
        return known;
      }
      const found = lookupDependency(installation, provider, externalId, ctx);
      lookups.set(key, found);
      return found;
    };
    return async (
      provider: string,
      listed: ListedDependency[] | undefined,
      covered: Array<{ provider: string; externalId: string }>,
    ): Promise<Dependency[]> => {
      const seen = new Set(covered.map((c) => dependencyKey(c.provider, c.externalId)));
      const found: Dependency[] = [];
      let looked = 0;
      let level = requiredOf(listed).map((externalId) => ({ provider, externalId }));
      while (level.length > 0) {
        const wanted = level.filter((d) => {
          const k = dependencyKey(d.provider, d.externalId);
          if (seen.has(k) || hasDependency(installed, d.provider, d.externalId)) {
            return false;
          }
          seen.add(k);
          return true;
        });
        looked += wanted.length;
        if (looked > MAX_DEPENDENCIES) {
          throw new Error(`It requires more than ${MAX_DEPENDENCIES} dependencies, too many to back up.`);
        }
        const nodes = await Promise.all(wanted.map((d) => lookup(d.provider, d.externalId)));
        level = [];
        for (const node of nodes) {
          if (node) {
            found.push(node.dependency);
            // WowUp installs a dependency's own dependencies from its provider in turn
            level.push(...node.requires.map((externalId) => ({ provider: node.dependency.line.provider, externalId })));
          }
        }
      }
      return found;
    };
  };

  /** One change's dependencies: one whose folders can't be learned fails the call */
  const dependenciesOfRelease = async (
    planner: ReturnType<typeof dependencyPlanner>,
    ...args: Parameters<ReturnType<typeof dependencyPlanner>>
  ): Promise<Dependency[]> => {
    try {
      return await planner(...args);
    } catch (e) {
      throw new Error(`${message(e)} Nothing was changed.`);
    }
  };

  /** The file an install would write: the given version, or the latest for the installation's channel */
  const planInstall = async (
    installation: WowInstallation,
    providerName: string,
    externalId: string,
    version: string | undefined,
    ctx: AgentToolContext,
  ): Promise<InstallPlan> => {
    const provider = canonicalProvider(providerName);
    const result = await providerOf(provider).getById(externalId, installation);
    if (!result) {
      throw new Error(`${provider} has no addon with externalId "${externalId}".`);
    }

    let file: AddonSearchResultFile | undefined;
    if (version) {
      const versions = await listVersions(provider, externalId, {
        clientType: installation.clientType,
        getSecret: deps.getSecret,
        getLatest: (p, id) => providerOf(p).getById(id, installation),
        fetchJson: deps.fetchJson,
        createCurseClient: deps.createCurseClient,
      });
      const picked = versions.find((v) => v.version === version || v.fileId === version);
      if (!picked) {
        const known = versions.slice(0, 10).map((v) => v.version);
        throw new Error(
          `${result.name} has no version "${version}". Versions: ${known.join(", ") || "none"}. Use list_versions for the full list.`,
        );
      }
      file = toSearchResultFile(picked);
    } else {
      file = getLatestFile(result, installation.defaultAddonChannelType);
      if (!file) {
        throw new Error(`${provider} lists no files for ${result.name}.`);
      }
    }
    if (!file.downloadUrl) {
      throw new Error(`${result.name} ${file.version} has no download link at ${provider}, so it can't be installed.`);
    }

    const resolvedProvider = result.providerName || provider;
    const resolvedId = String(result.externalId ?? externalId);
    const folders = await foldersOfRelease(
      file.folders,
      { provider, externalId, name: result.name, version: file.version, url: file.downloadUrl },
      ctx,
    );
    return {
      provider,
      externalId,
      file,
      pinned: !!version,
      line: {
        name: result.name,
        provider: resolvedProvider,
        externalId: resolvedId,
        version: file.version,
        folders,
      },
    };
  };

  /** The folders an update writes: the provider's listing for the release it installs, else that download's */
  const updateFolders = async (installation: WowInstallation, a: Addon, ctx: AgentToolContext): Promise<string[]> => {
    let listed: string[] | undefined;
    try {
      const result = await providerOf(a.providerName ?? "").getById(a.externalId ?? "", installation);
      const file = (result?.files ?? []).find(
        (f) =>
          (!!a.externalLatestReleaseId && f.externalId === a.externalLatestReleaseId) ||
          (!!a.latestVersion && f.version === a.latestVersion),
      );
      listed = file?.folders;
    } catch (e) {
      console.error(`[agent] could not look up the release ${a.name} updates to`, e);
    }
    return learnFolders(
      listed,
      {
        provider: a.providerName ?? "",
        externalId: a.externalId ?? a.id,
        name: a.name,
        version: a.latestVersion ?? "latest",
        url: a.downloadUrl ?? "",
      },
      ctx,
    );
  };

  /** WowUp's own install record for the plan, made before any backup so a bad target fails cleanly */
  const newAddonFor = async (installation: WowInstallation, plan: InstallPlan): Promise<Addon> => {
    const addon = await firstValueFrom(addonService.getAddon(plan.externalId, plan.provider, installation, plan.file));
    if (!addon) {
      throw new Error(`${plan.provider} returned nothing to install for ${plan.line.name} ${plan.line.version}.`);
    }
    return addon;
  };

  /** Install through WowUp, like its Get Addons page; a pinned version is ignored so auto-update leaves it */
  const install = async (addon: Addon, plan: InstallPlan, ctx: AgentToolContext): Promise<void> => {
    await addonService.saveAddon(addon);
    await addonService.installAddon(addon, progressFor(ctx, addon.name));
    if (plan.pinned) {
      addon.isIgnored = true;
      addon.autoUpdateEnabled = false;
      await addonService.saveAddon(addon);
    }
  };

  /**
   * Runs a change after its backup: then notes in the backup the records that appeared and that the change created
   * (`ours`: its addon, the dependencies it installs; also when it failed partway, so rollback removes a half-done
   * install), and names the backup in any error. A record that appeared for another reason, such as WowUp's own
   * hourly auto-update running meanwhile, is not the change's to undo: it is left out (`byWowUp`).
   */
  const runChange = async (
    backup: TakenBackup,
    installation: WowInstallation,
    before: Addon[],
    what: string,
    ours: (a: Addon) => boolean,
    work: () => Promise<void>,
  ): Promise<{ added: Addon[]; after: Addon[]; byWowUp: Addon[] }> => {
    const beforeIds = new Set(backup.baselineIds ?? before.map((a) => a.id));
    const backupId = backup.id;
    let failure: unknown;
    try {
      await work();
    } catch (e) {
      failure = e;
    }

    let after: Addon[] = [];
    let added: Addon[] = [];
    let byWowUp: Addon[] = [];
    try {
      after = await recordsOf(installation);
      const appeared = after.filter((a) => !!a.id && !beforeIds.has(a.id));
      added = appeared.filter((a) => ours(a));
      byWowUp = appeared.filter((a) => !ours(a));
      if (added.length > 0) {
        await backupService.recordAdded(backupId, added);
      }
    } catch (e) {
      deps.notifyChanged?.();
      const notNoted =
        `noting what it added in backup "${backupId}" failed: ${message(e)}. ` +
        `rollback ${backupId} restores what was backed up but may leave what the change added in place.`;
      throw new Error(
        failure === undefined
          ? `${what} finished, but ${notNoted}`
          : `${what} failed: ${message(failure)}. Then ${notNoted}`,
      );
    }
    deps.notifyChanged?.();

    if (failure !== undefined) {
      throw new Error(
        `${what} failed: ${message(failure)}. A backup was taken first; undo with rollback backupId "${backupId}".`,
      );
    }
    return { added, after, byWowUp };
  };

  /** The added records, the one the plan installed first */
  const addedLines = (added: Addon[], mainId?: string): ChangedLine[] =>
    [...added]
      .sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : 0))
      .map((a) => changedOf("added", a, a.installedVersion ?? a.latestVersion));

  /** For a change's result: the records WowUp itself added while it ran, which its backup leaves out */
  const changedByWowUp = (byWowUp: Addon[]): { changedByWowUp?: { addons: ChangedLine[]; note: string } } =>
    byWowUp.length > 0 ? { changedByWowUp: { addons: addedLines(byWowUp), note: BY_WOWUP_NOTE } } : {};

  /** A record the change made: its own addon (by id, or provider and externalId), or a dependency it installs */
  const madeBy = (
    releases: Array<{ provider: string; externalId: string }>,
    dependencies: Dependency[],
    ids: string[] = [],
  ): ((a: Addon) => boolean) => {
    const isDependency = (a: Addon) =>
      dependencies.some(
        (d) => isProvider(a, d.line.provider, d.line.externalId) || isProvider(a, d.line.provider, d.recordExternalId),
      );
    return (a) =>
      ids.includes(a.id) || releases.some((r) => isProvider(a, r.provider, r.externalId)) || isDependency(a);
  };

  /** Records WowUp's install reconcile drops: unmatched ones claiming a folder the release writes */
  const droppedUnknowns = (installed: Addon[], folders: string[], except?: Addon): Addon[] =>
    installed.filter(
      (a) => a.id !== except?.id && a.providerName === ADDON_PROVIDER_UNKNOWN && overlaps(foldersOf(a), folders),
    );

  /** Records claiming a folder the release writes; backed up because the install may overwrite or drop them */
  const claimants = (installed: Addon[], folders: string[]): Addon[] =>
    installed.filter((a) => overlaps(foldersOf(a), folders));

  /** The required dependencies WowUp installs after a planned release; one that can't be learned fails the call */
  const dependenciesOfPlan = (
    installation: WowInstallation,
    plan: InstallPlan,
    installed: Addon[],
    ctx: AgentToolContext,
  ): Promise<Dependency[]> =>
    dependenciesOfRelease(dependencyPlanner(installation, installed, ctx), plan.line.provider, plan.file.dependencies, [
      plan.line,
    ]);

  /** A preview with the dependencies WowUp installs along noted */
  const withDependencies = (preview: ChangePreview, dependencies: Dependency[]): ChangePreview => {
    const list = (some: Dependency[]) => some.map((d) => `${d.line.provider} ${d.line.externalId}`).join(", ");
    const count = (some: Dependency[]) =>
      some.length === 1 ? "1 required dependency" : `${some.length} required dependencies`;
    const installs = dependencies.filter((d) => !d.recordOnly);
    const recordsOnly = dependencies.filter((d) => d.recordOnly);
    const notes: string[] = [];
    if (installs.length > 0) {
      notes.push(`may also install ${count(installs)}: ${list(installs)}`);
    }
    if (recordsOnly.length > 0) {
      const what = `${count(recordsOnly)} it can't download (no download link)`;
      notes.push(`WowUp also saves a record for ${what}: ${list(recordsOnly)}`);
    }
    if (notes.length === 0) {
      return preview;
    }
    return {
      ...preview,
      action: [preview.action, ...notes].join("; "),
      ...(installs.length > 0 ? { alsoInstalls: installs.map((d) => d.line) } : {}),
    };
  };

  const recordOnlyPreview = (installation: WowInstallation, action: string): ChangePreview => ({
    action,
    installation: nameOf(installation),
    add: [],
    remove: [],
    foldersReplaced: [],
    settingsCarryOver: true,
  });

  return {
    install_addon: async (args, ctx) => {
      const providerArg = str(args, "provider");
      const externalId = str(args, "externalId");
      if (!providerArg || !externalId) {
        throw new Error("Pass provider and externalId (from search_addons or get_addon_details).");
      }
      const installation = await resolveInstall(args);
      const installed = await recordsOf(installation);
      const refuseInstalled = (provider: string, id: string) => {
        const existing = installed.find((a) => isProvider(a, provider, id));
        if (existing) {
          throw new Error(
            `${existing.name} is already installed (addonId ${existing.id}). Use update_addons to update it, or replace_addon to install another version.`,
          );
        }
      };
      refuseInstalled(canonicalProvider(providerArg), externalId);

      const plan = await planInstall(installation, providerArg, externalId, str(args, "version"), ctx);
      refuseInstalled(plan.line.provider, plan.line.externalId);
      const folders = plan.line.folders;
      const dependencies = await dependenciesOfPlan(installation, plan, installed, ctx);
      const written = uniqueFolders([...folders, ...dependencyFolders(dependencies)]);

      if (args.preview === true) {
        const disk = await diskOf(installation);
        const preview: ChangePreview = {
          action: `install_addon ${plan.line.provider} ${plan.line.externalId} ${plan.line.name} ${ver(plan.line.version)}${plan.pinned ? " (pinned: marked ignored)" : ""}`,
          installation: nameOf(installation),
          add: [plan.line],
          remove: droppedUnknowns(installed, folders).map((a) => lineOf(a)),
          foldersReplaced: onDisk(written, disk),
          settingsCarryOver: installCarryOver(folders, disk, droppedUnknowns(installed, folders)),
        };
        return withDependencies(preview, dependencies);
      }

      const addon = await newAddonFor(installation, plan);
      const backup = await takeBackup(
        ctx,
        "install_addon",
        installation,
        claimants(installed, written),
        written,
        `install_addon ${plan.line.provider} ${plan.line.externalId} ${plan.line.name} ${ver(plan.line.version)}`,
      );
      const { added, byWowUp } = await runChange(
        backup,
        installation,
        installed,
        `Installing ${plan.line.name}`,
        madeBy([plan.line], dependencies, [addon.id]),
        () => install(addon, plan, ctx),
      );
      return { backupId: backup.id, changed: addedLines(added, addon.id), ...changedByWowUp(byWowUp) };
    },

    update_addons: async (args, ctx) => {
      const installation = await resolveInstall(args);
      const installed = await recordsOf(installation);
      const ids = Array.isArray(args.addonIds)
        ? [...new Set(args.addonIds.filter((id): id is string => typeof id === "string"))]
        : undefined;
      if (args.all === true && ids && ids.length > 0) {
        throw new Error("Pass addonIds or all: true, not both.");
      }
      let chosen: Addon[];
      if (args.all === true) {
        chosen = installed;
      } else if (ids && ids.length > 0) {
        chosen = ids.map((addonId) => resolveAddon({ addonId }, installed));
      } else {
        throw new Error("Pass addonIds (from list_addons), or all: true for every addon with an update.");
      }

      const withUpdate = chosen.filter((a) => needsUpdate(a));
      // Named addons without an update are reported, not reinstalled
      const skipped = (args.all === true ? [] : chosen.filter((a) => !needsUpdate(a))).map((a) => ({
        addonId: a.id,
        name: a.name,
        reason: a.isIgnored ? "ignored" : "no update known (check_updates refreshes this)",
      }));

      // As WowUp's auto-update does: with all: true an update built for a newer game version than the installation
      // runs is skipped; a named addon is updated anyway, with a warning
      const mismatches =
        withUpdate.length > 0 ? (await addonService.findGameVersionMismatches(withUpdate, true)) ?? [] : [];
      const mismatchOf = (a: Addon) => mismatches.find((m) => m.addon.id === a.id);
      const mismatchText = (a: Addon) =>
        `${a.name} ${ver(a.latestVersion)} is built for game version ${(a.gameVersion ?? []).join(", ") || "unknown"}, ` +
        `newer than ${nameOf(installation)} runs (${mismatchOf(a)?.installation.gameVersion || "unknown"})`;
      const mismatched = withUpdate.filter((a) => !!mismatchOf(a));
      const warnings: string[] = [];
      let targets = withUpdate;
      if (args.all === true) {
        targets = withUpdate.filter((a) => !mismatchOf(a));
        skipped.push(
          ...mismatched.map((a) => ({
            addonId: a.id,
            name: a.name,
            reason: `${mismatchText(a)}. Name it in addonIds to update it anyway.`,
          })),
        );
      }

      // What each update writes, learned before anything is backed up: its release, and the required dependencies
      // WowUp installs after it (from the record's dependencies, which WowUp's sync keeps to the release on offer).
      // One whose release or dependencies can't be learned is left out (skipped, unchanged); the others go ahead.
      const planner = dependencyPlanner(installation, installed, ctx);
      const dependenciesOf = new Map<string, Dependency[]>();
      const learned = await Promise.all(
        targets.map(async (a) => {
          const folders = await batchFolders(async () => {
            const own = await updateFolders(installation, a, ctx);
            dependenciesOf.set(a.id, await planner(a.providerName ?? "", a.dependencies, []));
            return own;
          });
          return [a, folders] as const;
        }),
      );
      const newFolders = new Map<string, string[]>();
      const unlearned: Addon[] = [];
      for (const [a, folders] of learned) {
        if (Array.isArray(folders)) {
          newFolders.set(a.id, folders);
        } else {
          unlearned.push(a);
          skipped.push({ addonId: a.id, name: a.name, reason: folders.error });
        }
      }
      targets = targets.filter((a) => newFolders.has(a.id));
      if (args.all !== true) {
        warnings.push(
          ...mismatched
            .filter((a) => newFolders.has(a.id))
            .map((a) => `${mismatchText(a)}; updated anyway because it was named.`),
        );
      }
      const foldersFor = (a: Addon) => newFolders.get(a.id) ?? [];
      const allNew = uniqueFolders(targets.flatMap(foldersFor));
      const dependencies = uniqueDependencies(targets.flatMap((a) => dependenciesOf.get(a.id) ?? []));
      const written = uniqueFolders([...allNew, ...dependencyFolders(dependencies)]);
      const targetIds = new Set(targets.map((a) => a.id));
      const others = (list: Addon[]) => list.filter((a) => !targetIds.has(a.id));

      if (args.preview === true) {
        const disk = await diskOf(installation);
        const notes = warnings.map((w) => `warning: ${w}`);
        if (unlearned.length > 0) {
          notes.unshift(
            `skipped, the folders their release or a required dependency writes could not be learned: ${unlearned.map((a) => a.name).join(", ")}`,
          );
        }
        if (args.all === true && mismatched.length > 0) {
          const names = mismatched.map((a) => a.name).join(", ");
          notes.unshift(`skipped for their game version (name them in addonIds to force): ${names}`);
        }
        if (targets.length === 0) {
          notes.unshift("nothing to update");
        }
        const preview: ChangePreview = {
          action: [`update_addons: ${targets.length} addon(s)`, ...notes].join("; "),
          installation: nameOf(installation),
          add: targets.map((a) => ({ ...lineOf(a, a.latestVersion), folders: foldersFor(a) })),
          remove: [
            ...targets.map((a) => lineOf(a)),
            ...others(droppedUnknowns(installed, allNew)).map((a) => lineOf(a)),
          ],
          foldersReplaced: onDisk([...targets.flatMap(foldersOf), ...written], disk),
          settingsCarryOver: combineCarryOver(targets.map((a) => carryOver(foldersOf(a), foldersFor(a)))),
        };
        return withDependencies(preview, dependencies);
      }

      if (targets.length === 0) {
        return { changed: [], ...(skipped.length > 0 ? { skipped } : {}), note: "Nothing to update." };
      }

      const backup = await takeBackup(
        ctx,
        "update_addons",
        installation,
        [...targets, ...others(claimants(installed, written))],
        written,
        `update_addons ${listNames(targets.map((a) => `${a.name} ${ver(a.installedVersion)} -> ${ver(a.latestVersion)}`))}`,
      );
      const failed: { addonId: string; name: string; error: string }[] = [];
      // An update makes no record of its own (it keeps the addon's), only the dependencies it installs along
      const { after, added, byWowUp } = await runChange(
        backup,
        installation,
        installed,
        "Updating addons",
        madeBy([], dependencies),
        async () => {
          await Promise.all(
            targets.map(async (a) => {
              try {
                await addonService.updateAddon(a, progressFor(ctx, a.name));
              } catch (e) {
                failed.push({ addonId: a.id, name: a.name, error: message(e) });
              }
            }),
          );
          if (failed.length === targets.length) {
            throw new Error(failed.map((f) => `${f.name}: ${f.error}`).join("; "));
          }
        },
      );

      const failedIds = new Set(failed.map((f) => f.addonId));
      const byId = new Map(after.map((a) => [a.id, a]));
      const changed = targets
        .filter((a) => !failedIds.has(a.id))
        .map((a) => {
          const now = byId.get(a.id) ?? a;
          return changedOf("updated", now, now.installedVersion);
        });
      return {
        backupId: backup.id,
        changed: [...changed, ...addedLines(added)],
        ...(failed.length > 0
          ? { failed, note: `Some updates failed; rollback ${backup.id} undoes the ones that went through.` }
          : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
        ...changedByWowUp(byWowUp),
      };
    },

    remove_addon: async (args, ctx) => {
      const installation = await resolveInstall(args);
      const installed = await recordsOf(installation);
      const addon = installedAddon(args, installed);

      if (args.preview === true) {
        const disk = await diskOf(installation);
        const preview: ChangePreview = {
          action: `remove_addon ${addon.name} ${ver(addon.installedVersion)}: deletes its folders`,
          installation: nameOf(installation),
          add: [],
          remove: [lineOf(addon)],
          foldersReplaced: onDisk(foldersOf(addon), disk),
          settingsCarryOver: carryOver(foldersOf(addon), []),
        };
        return preview;
      }

      const backup = await takeBackup(
        ctx,
        "remove_addon",
        installation,
        [addon],
        [],
        `remove_addon ${addon.providerName ?? ""} ${addon.externalId ?? ""} ${addon.name} ${ver(addon.installedVersion)}`,
      );
      ctx.progress(`Removing ${addon.name}`);
      // A removal makes no record
      const { byWowUp } = await runChange(
        backup,
        installation,
        installed,
        `Removing ${addon.name}`,
        () => false,
        () => addonService.removeAddon(addon, false, true),
      );
      return { backupId: backup.id, changed: [changedOf("removed", addon)], ...changedByWowUp(byWowUp) };
    },

    replace_addon: async (args, ctx) => {
      const installation = await resolveInstall(args);
      const installed = await recordsOf(installation);
      const old = installedAddon(args, installed, INSTALLED_KEYS);
      const providerArg = str(args, "provider");
      const externalId = str(args, "externalId");
      if (!providerArg || !externalId) {
        throw new Error("Pass provider and externalId of the addon to install instead.");
      }
      const refuseOther = (provider: string, id: string) => {
        const other = installed.find((a) => a.id !== old.id && isProvider(a, provider, id));
        if (other) {
          throw new Error(
            `${other.name} is already installed (addonId ${other.id}); replace or remove that one instead.`,
          );
        }
      };
      refuseOther(canonicalProvider(providerArg), externalId);

      const plan = await planInstall(installation, providerArg, externalId, str(args, "version"), ctx);
      refuseOther(plan.line.provider, plan.line.externalId);
      const folders = plan.line.folders;
      // The old addon is removed before the install, so WowUp installs it again when the release requires it
      const dependencies = await dependenciesOfPlan(
        installation,
        plan,
        installed.filter((a) => a.id !== old.id),
        ctx,
      );
      const written = uniqueFolders([...folders, ...dependencyFolders(dependencies)]);

      if (args.preview === true) {
        const disk = await diskOf(installation);
        const preview: ChangePreview = {
          action: `replace_addon ${old.name} ${ver(old.installedVersion)} with ${plan.line.provider} ${plan.line.externalId} ${plan.line.name} ${ver(plan.line.version)}${plan.pinned ? " (pinned: marked ignored)" : ""}`,
          installation: nameOf(installation),
          add: [plan.line],
          remove: [lineOf(old), ...droppedUnknowns(installed, folders, old).map((a) => lineOf(a))],
          foldersReplaced: onDisk([...foldersOf(old), ...written], disk),
          settingsCarryOver: carryOver(foldersOf(old), folders),
        };
        return withDependencies(preview, dependencies);
      }

      const addon = await newAddonFor(installation, plan);
      const backup = await takeBackup(
        ctx,
        "replace_addon",
        installation,
        [old, ...claimants(installed, written).filter((a) => a.id !== old.id)],
        written,
        `replace_addon ${old.name} ${ver(old.installedVersion)} with ${plan.line.provider} ${plan.line.externalId} ${plan.line.name} ${ver(plan.line.version)}`,
      );
      const { added, byWowUp } = await runChange(
        backup,
        installation,
        installed,
        `Replacing ${old.name} with ${plan.line.name}`,
        madeBy([plan.line], dependencies, [addon.id]),
        async () => {
          ctx.progress(`Removing ${old.name}`);
          await addonService.removeAddon(old, false, true);
          await install(addon, plan, ctx);
        },
      );
      return {
        backupId: backup.id,
        changed: [changedOf("removed", old), ...addedLines(added, addon.id)],
        ...changedByWowUp(byWowUp),
      };
    },

    switch_provider: async (args, ctx) => {
      const installation = await resolveInstall(args);
      const installed = await recordsOf(installation);
      const addon = installedAddon(args, installed, INSTALLED_KEYS);
      const providerArg = str(args, "provider");
      if (!providerArg) {
        throw new Error("Pass provider, one the addon is known on (see get_addon_details).");
      }
      const provider = canonicalProvider(providerArg);
      if ((addon.providerName ?? "").toLowerCase() === provider.toLowerCase()) {
        throw new Error(`${addon.name} is already installed from ${addon.providerName ?? provider}.`);
      }
      const ext = (addon.externalIds ?? []).find((e) => e.providerName.toLowerCase() === provider.toLowerCase());
      if (!ext) {
        const known = [...new Set([addon.providerName ?? "", ...(addon.externalIds ?? []).map((e) => e.providerName)])]
          .filter((p) => p !== "")
          .sort();
        throw new Error(
          `${addon.name} is not known on ${provider}. Providers it is known on: ${known.join(", ") || "none"}.`,
        );
      }
      const other = installed.find((a) => a.id !== addon.id && isProvider(a, ext.providerName, ext.id));
      if (other) {
        throw new Error(`${ext.providerName} ${ext.id} is already installed as ${other.name} (addonId ${other.id}).`);
      }

      const plan = await planInstall(installation, ext.providerName, ext.id, undefined, ctx);
      const folders = plan.line.folders;
      // WowUp's setProvider installs the new one (and its dependencies) before it removes the old record
      const dependencies = await dependenciesOfPlan(installation, plan, installed, ctx);
      const written = uniqueFolders([...folders, ...dependencyFolders(dependencies)]);

      if (args.preview === true) {
        const disk = await diskOf(installation);
        const preview: ChangePreview = {
          action: `switch_provider ${addon.name}: ${addon.providerName ?? ""} ${addon.externalId ?? ""} -> ${ext.providerName} ${ext.id} (installs ${ver(plan.line.version)})`,
          installation: nameOf(installation),
          add: [plan.line],
          remove: [lineOf(addon)],
          foldersReplaced: onDisk(written, disk),
          settingsCarryOver: carryOver(foldersOf(addon), folders),
        };
        return withDependencies(preview, dependencies);
      }

      const backup = await takeBackup(
        ctx,
        "switch_provider",
        installation,
        [addon, ...claimants(installed, written).filter((a) => a.id !== addon.id)],
        written,
        `switch_provider ${addon.name} ${addon.providerName ?? ""} ${addon.externalId ?? ""} -> ${ext.providerName} ${ext.id}`,
      );
      ctx.progress(`Switching ${addon.name} to ${ext.providerName}`);
      // setProvider makes the new record itself (its id isn't known here), from the provider and externalId
      const { added, byWowUp } = await runChange(
        backup,
        installation,
        installed,
        `Switching ${addon.name} to ${ext.providerName}`,
        madeBy([{ provider: ext.providerName, externalId: ext.id }, plan.line], dependencies),
        () => addonService.setProvider(addon, ext.id, ext.providerName, installation),
      );
      return {
        backupId: backup.id,
        changed: [changedOf("removed", addon), ...addedLines(added)],
        ...changedByWowUp(byWowUp),
      };
    },

    set_auto_update: async (args, ctx) => {
      if (typeof args.enabled !== "boolean") {
        throw new Error("Pass enabled: true or false.");
      }
      const enabled = args.enabled;
      const installation = await resolveInstall(args);
      const installed = await recordsOf(installation);
      const addon = installedAddon(args, installed);
      const unchanged = !!addon.autoUpdateEnabled === enabled && (!enabled || !addon.isIgnored);
      const state = enabled ? "on" : "off";
      const action = `set_auto_update ${addon.name}: auto-update ${state}${enabled && addon.isIgnored ? ", no longer ignored" : ""}${unchanged ? " (already so, no change)" : ""}`;

      if (args.preview === true) {
        return recordOnlyPreview(installation, action);
      }
      if (unchanged) {
        return { changed: [], note: `${addon.name} already has auto-update ${state}.` };
      }

      const backup = await takeBackup(
        ctx,
        "set_auto_update",
        installation,
        [addon],
        [],
        `set_auto_update ${addon.name} ${state}`,
        SETTINGS_ONLY,
      );
      // A settings change makes no record
      const { byWowUp } = await runChange(
        backup,
        installation,
        installed,
        `Turning auto-update ${state} for ${addon.name}`,
        () => false,
        () => {
          // As My Addons does: auto-update brings notifications along and un-ignores the addon
          addon.autoUpdateEnabled = enabled;
          addon.autoUpdateNotificationsEnabled = enabled;
          if (enabled) {
            addon.isIgnored = false;
          }
          return addonService.saveAddon(addon);
        },
      );
      return { backupId: backup.id, changed: [changedOf("updated", addon)], ...changedByWowUp(byWowUp) };
    },

    set_ignored: async (args, ctx) => {
      if (typeof args.ignored !== "boolean") {
        throw new Error("Pass ignored: true or false.");
      }
      const ignored = args.ignored;
      const installation = await resolveInstall(args);
      const installed = await recordsOf(installation);
      const addon = installedAddon(args, installed);
      const unchanged = !!addon.isIgnored === ignored && (!ignored || !addon.autoUpdateEnabled);
      const action = `set_ignored ${addon.name}: ${ignored ? "ignored" : "not ignored"}${ignored && addon.autoUpdateEnabled ? ", auto-update off" : ""}${unchanged ? " (already so, no change)" : ""}`;

      if (args.preview === true) {
        return recordOnlyPreview(installation, action);
      }
      if (unchanged) {
        return { changed: [], note: `${addon.name} is already ${ignored ? "ignored" : "not ignored"}.` };
      }

      const backup = await takeBackup(
        ctx,
        "set_ignored",
        installation,
        [addon],
        [],
        `set_ignored ${addon.name} ${ignored ? "on" : "off"}`,
        SETTINGS_ONLY,
      );
      // A settings change makes no record
      const { byWowUp } = await runChange(
        backup,
        installation,
        installed,
        `Marking ${addon.name}`,
        () => false,
        () => {
          // As My Addons does: ignoring an addon turns its auto-update off
          addon.isIgnored = ignored;
          if (ignored) {
            addon.autoUpdateEnabled = false;
          }
          return addonService.saveAddon(addon);
        },
      );
      return { backupId: backup.id, changed: [changedOf("updated", addon)], ...changedByWowUp(byWowUp) };
    },

    rescan: async (args, ctx) => {
      const installation = await resolveInstall(args);
      const installed = await recordsOf(installation);

      if (args.preview === true) {
        return recordOnlyPreview(
          installation,
          `rescan ${nameOf(installation)}: re-reads the AddOns folder and re-creates all ${installed.length} addon records with new addonIds (auto-update and ignored carry over by provider and externalId); no folders change`,
        );
      }

      const backup = await takeBackup(
        ctx,
        "rescan",
        installation,
        installed,
        [],
        `rescan ${nameOf(installation)} (${installed.length} addon records)`,
        RECORDS_ONLY,
      );
      ctx.progress(`Rescanning ${nameOf(installation)}`);
      // A rescan re-creates every record of the installation, so every new one is its own
      const { after } = await runChange(
        backup,
        installation,
        installed,
        `Rescanning ${nameOf(installation)}`,
        () => true,
        () => addonService.rescanInstallation(installation).then(() => undefined),
      );

      // What the rescan changed by addon, not by record (every record gets a new id)
      const identity = (a: Addon) =>
        `${(a.providerName ?? "").toLowerCase()}|${a.externalId ?? ""}|${foldersOf(a).map(folderKey).sort().join("/")}`;
      const beforeKeys = new Set(installed.map(identity));
      const afterKeys = new Set(after.map(identity));
      const changed = [
        ...installed.filter((a) => !afterKeys.has(identity(a))).map((a) => changedOf("removed", a)),
        ...after.filter((a) => !beforeKeys.has(identity(a))).map((a) => changedOf("added", a)),
      ];
      return { backupId: backup.id, changed, records: after.length };
    },

    import_addons: async (args, ctx) => {
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (text === "") {
        throw new Error("Pass text: a WowUp export string or its JSON.");
      }
      const installation = await resolveInstall(args);
      let payload: ExportPayload;
      try {
        payload = await brokerService.parseImportString(text);
      } catch (e) {
        throw new Error(`Not a WowUp export string or JSON: ${message(e)}`);
      }
      if (typeof payload !== "object" || payload === null || !Array.isArray(payload.addons)) {
        throw new Error("Not a WowUp export: it has no addons list.");
      }

      const summary = await brokerService.getImportSummary(payload, installation);
      if (summary.errorCode) {
        const missing = summary.errorParams?.missingProviders;
        throw new Error(
          missing
            ? `The import needs providers that are not enabled: ${missing}.`
            : IMPORT_ERRORS[summary.errorCode] ??
              `The import was refused (${summary.errorCode}) for ${getEnumName(WowClientType, installation.clientType)}.`,
        );
      }
      const toAdd = summary.comparisons.filter((c) => c.state === "added");
      const conflicts = summary.comparisons.filter((c) => c.state === "conflict").length;
      const same = summary.comparisons.filter((c) => c.state === "no-change").length;

      // WowUp's import installs each addon's latest file and then its required dependencies, so that is what the
      // preview and backup cover. One that can't be looked up fails the call before any backup; one whose release
      // or dependencies can't be downloaded to learn their folders is left out of the import (skipped, unchanged);
      // one the provider doesn't have installs nothing.
      const installed = await recordsOf(installation);
      const planner = dependencyPlanner(installation, installed, ctx);
      const planned = await Promise.all(
        toAdd.map(async (c) => {
          let result: AddonSearchResult | undefined;
          try {
            result = await providerOf(c.imported.provider_name).getById(c.imported.id, installation);
          } catch (e) {
            throw new Error(
              `Could not look up ${c.imported.provider_name} ${c.imported.id} (${c.imported.name}): ${message(e)}. Nothing was changed.`,
            );
          }
          const file = result ? getLatestFile(result, installation.defaultAddonChannelType) : undefined;
          const name = result?.name ?? c.imported.name;
          const provider = result?.providerName ?? c.imported.provider_name;
          const externalId = result ? String(result.externalId) : c.imported.id;
          let folders: string[] | { error: string } = [];
          let dependencies: Dependency[] = [];
          if (file) {
            const release = {
              provider: c.imported.provider_name,
              externalId: c.imported.id,
              name,
              version: file.version,
              url: file.downloadUrl,
            };
            folders = await batchFolders(async () => {
              const own = await learnFolders(file.folders, release, ctx);
              dependencies = await planner(provider, file.dependencies, [{ provider, externalId }]);
              return own;
            });
          }
          const line: AddonLine = {
            name,
            provider,
            externalId,
            version: file?.version ?? "",
            folders: Array.isArray(folders) ? folders : [],
          };
          return { comparison: c, line, dependencies, error: Array.isArray(folders) ? undefined : folders.error };
        }),
      );
      const kept = planned.filter((p) => p.error === undefined);
      const lines = kept.map((p) => p.line);
      const skipped = planned
        .filter((p) => p.error !== undefined)
        .map((p) => ({ name: p.line.name, provider: p.line.provider, externalId: p.line.externalId, reason: p.error }));
      const folders = uniqueFolders(lines.flatMap((l) => l.folders));
      const allDependencies = uniqueDependencies(kept.flatMap((p) => p.dependencies));
      const written = uniqueFolders([...folders, ...dependencyFolders(allDependencies)]);
      // One that is also imported is in `add`
      const lineKeys = new Set(lines.map((l) => dependencyKey(l.provider, l.externalId)));
      const dependencies = allDependencies.filter(
        (d) =>
          !lineKeys.has(dependencyKey(d.line.provider, d.line.externalId)) &&
          !lineKeys.has(dependencyKey(d.line.provider, d.recordExternalId)),
      );
      const skippedNote =
        skipped.length > 0
          ? `; skipped, the folders their release or a required dependency writes could not be learned: ${skipped.map((s) => `${s.provider} ${s.externalId}`).join(", ")}`
          : "";
      const action = `import_addons: installs ${lines.length} addon(s); ${same} already installed; ${conflicts} conflict(s) left as they are${skippedNote}`;

      if (args.preview === true) {
        const disk = await diskOf(installation);
        const preview: ChangePreview = {
          action,
          installation: nameOf(installation),
          add: lines,
          remove: droppedUnknowns(installed, folders).map((a) => lineOf(a)),
          foldersReplaced: onDisk(written, disk),
          settingsCarryOver: installCarryOver(folders, disk, droppedUnknowns(installed, folders)),
        };
        return withDependencies(preview, dependencies);
      }
      if (lines.length === 0) {
        return { changed: [], ...(skipped.length > 0 ? { skipped } : {}), note: `Nothing to import: ${action}.` };
      }

      const backup = await takeBackup(
        ctx,
        "import_addons",
        installation,
        claimants(installed, written),
        written,
        `import_addons ${listNames(lines.map((l) => `${l.provider} ${l.externalId} ${l.name}`))}`,
      );
      // WowUp installs the summary's "added" entries; the skipped ones are taken out
      const skippedIds = new Set(planned.filter((p) => p.error !== undefined).map((p) => p.comparison.id));
      const toInstall: ImportSummary = {
        ...summary,
        comparisons: summary.comparisons.filter((c) => !skippedIds.has(c.id)),
      };
      const names = new Map(kept.map((p) => [p.comparison.id, p.line.name]));
      const sub = brokerService.addonInstall$.subscribe((evt) =>
        progressFor(ctx, names.get(evt.comparisonId) ?? "addon")(evt.installState, evt.progress),
      );
      // WowUp makes the records itself (their ids aren't known here): the imported addons by provider and externalId,
      // as the import lists them or the provider resolved them, and their dependencies
      const imported = kept.flatMap((p) => [
        p.line,
        { provider: p.comparison.imported.provider_name, externalId: p.comparison.imported.id },
      ]);
      let added: Addon[];
      let byWowUp: Addon[];
      try {
        ({ added, byWowUp } = await runChange(
          backup,
          installation,
          installed,
          "Importing addons",
          madeBy(imported, allDependencies),
          () => brokerService.installImportSummary(toInstall, installation),
        ));
      } finally {
        sub.unsubscribe();
      }

      const failed = lines
        .filter((l) => !added.some((a) => isProvider(a, l.provider, l.externalId) && !!a.installedVersion))
        .map((l) => ({ name: l.name, provider: l.provider, externalId: l.externalId }));
      if (failed.length === lines.length) {
        throw new Error(
          `Importing installed none of the ${lines.length} addon(s). A backup was taken first; undo with rollback backupId "${backup.id}".`,
        );
      }
      return {
        backupId: backup.id,
        // A record WowUp saved before a failed download has no installed version: it is in the backup, not in changed
        changed: addedLines(added.filter((a) => !!a.installedVersion)),
        ...(failed.length > 0
          ? { failed, note: `${failed.length} addon(s) did not install; rollback ${backup.id} undoes the rest.` }
          : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
        ...changedByWowUp(byWowUp),
      };
    },

    export_addons: async (args) => {
      const installation = await resolveInstall(args);
      const payload = await brokerService.getExportPayload(installation);
      return {
        installation: nameOf(installation),
        count: payload.addons.length,
        text: await deps.encodeBase64(JSON.stringify(payload)),
        note: "Ignored addons are left out, as in WowUp's own export.",
      };
    },
  };
}
