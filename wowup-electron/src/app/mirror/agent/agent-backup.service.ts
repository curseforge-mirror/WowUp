import { dirname, isAbsolute, join } from "path";
import { Addon, WowInstallation } from "wowup-lib-core";

import { Injectable } from "@angular/core";

import { AGENT_CHANNEL_WOW_RUNNING } from "../../../common/mirror/agent-contract";
import { ElectronService } from "../../services/electron/electron.service";
import { FileService } from "../../services/files/file.service";
import { SessionService } from "../../services/session/session.service";
import { AddonStorageService } from "../../services/storage/addon-storage.service";
import { WarcraftInstallationService } from "../../services/warcraft/warcraft-installation.service";
import { WarcraftService } from "../../services/warcraft/warcraft.service";
import { WowUpService } from "../../services/wowup/wowup.service";
import { WtfService } from "../../services/wtf/wtf.service";
import { agentBackupsPath } from "./agent-settings";

const MANIFEST_FILE = "manifest.json";
const ADDONS_DIR = "addons";
const WTF_DIR = "wtf";
const ACCOUNT_DIR = "Account";
const SAVED_VARIABLES_DIR = "SavedVariables";
const KEEP_NEWEST = 50;
const KEEP_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;
/** A backup folder without a manifest (a crash mid-create) is deleted once its folder is this old */
const INCOMPLETE_MAX_AGE_MS = DAY_MS;
/** Keeps rollback-of-rollback folder names from growing without bound */
const MAX_TOOL_SLUG = 60;
/** A backup id is a single folder name inside the backups folder */
const BACKUP_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export interface BackupManifest {
  id: string;
  tool: string;
  createdAt: string;
  installationId: string;
  /** The addon records as they were before the change */
  records: Addon[];
  /** Addon folders copied to `addons/<folder>` */
  folders: string[];
  /** SavedVariables files relative to the WTF folder, copied to `wtf/<path>` */
  savedVariables: string[];
  /**
   * What the change added, removed again by rollback. Folders that did not exist when the backup was taken are
   * listed here too: whatever is there after the change was added by it.
   */
  added: { addonIds: string[]; folders: string[]; names?: string[] };
  /** Folders and records were rolled back, SavedVariables wait for WoW to close */
  savedVariablesPending?: boolean;
  installationName?: string;
  /** What the change was, e.g. "install_addon Curse 12345 (DBM) v1.2" */
  summary?: string;
  /** How to undo it: `rollback <id>` */
  undo: string;
  /** Ids of the installation's addon records when the backup was taken; later ones are told apart by this */
  recordIdsAtBackup?: string[];
  /** Entries in the AddOns folder when the backup was taken; rollback never removes one it doesn't restore */
  foldersAtBackup?: string[];
  /** The safety backup taken by the rollback that left SavedVariables pending */
  safetyBackupId?: string;
  /** Only records were backed up (no folders or SavedVariables): rollback restores records and removes no folder */
  recordsOnly?: boolean;
}

export interface RollbackResult {
  safetyBackupId: string;
  restoredFolders: string[];
  removedFolders: string[];
  restoredRecords: number;
  removedRecords: number;
  savedVariables: "restored" | "pending-wow-running" | "none";
}

export type BackupSummary = Pick<BackupManifest, "id" | "tool" | "createdAt" | "installationId"> & {
  installation: string;
  addons: string[];
  savedVariablesPending?: boolean;
  summary?: string;
};

interface SnapshotOptions {
  tool: string;
  installation: WowInstallation;
  records: Addon[];
  /** Addon folders to copy; ones that don't exist are recorded as added */
  folders: string[];
  /** WTF-relative files to copy instead of the SavedVariables matching `folders` */
  savedVariables?: string[];
  addedIds?: string[];
  addedNames?: string[];
  summary?: string;
  recordsOnly?: boolean;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** yyyyMMdd-HHmmss in local time */
function stamp(d: Date): string {
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isFolderName(name: unknown): name is string {
  return typeof name === "string" && name.trim() !== "" && name !== "." && name !== ".." && !/[\\/:\0]/.test(name);
}

/** Same addon: same provider and external id, or the same name */
function sameAddon(
  a: Pick<Addon, "name" | "providerName" | "externalId">,
  b: Pick<Addon, "name" | "providerName" | "externalId">,
): boolean {
  const name = (n: string | undefined) => (n ?? "").trim().toLowerCase();
  const byProvider =
    !!a.externalId &&
    a.externalId === b.externalId &&
    (a.providerName ?? "").toLowerCase() === (b.providerName ?? "").toLowerCase();
  return byProvider || (name(a.name) !== "" && name(a.name) === name(b.name));
}

function assertFolderName(name: unknown): string {
  if (!isFolderName(name)) {
    throw new Error(`Not an addon folder name: ${JSON.stringify(name)}`);
  }
  return name;
}

function assertBackupId(id: unknown): string {
  if (typeof id !== "string" || !BACKUP_ID.test(id)) {
    throw new Error(`Not a backup id: ${JSON.stringify(id)}. Use list_backups to find ids.`);
  }
  return id;
}

function assertWtfRelative(rel: unknown): string {
  if (
    typeof rel !== "string" ||
    rel === "" ||
    isAbsolute(rel) ||
    /^[a-zA-Z]:/.test(rel) ||
    rel.split(/[\\/]/).some((s) => s === "..")
  ) {
    throw new Error(`Not a WTF-relative path: ${JSON.stringify(rel)}`);
  }
  return rel;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => typeof s === "string");
}

function isManifest(m: unknown): m is BackupManifest {
  const o = m as BackupManifest;
  return (
    typeof o === "object" &&
    o !== null &&
    typeof o.id === "string" &&
    typeof o.tool === "string" &&
    typeof o.createdAt === "string" &&
    !Number.isNaN(Date.parse(o.createdAt)) &&
    typeof o.installationId === "string" &&
    Array.isArray(o.records) &&
    isStringArray(o.folders) &&
    isStringArray(o.savedVariables) &&
    typeof o.added === "object" &&
    o.added !== null &&
    isStringArray(o.added.addonIds) &&
    isStringArray(o.added.folders)
  );
}

function newestFirst(a: BackupManifest, b: BackupManifest): number {
  return Date.parse(b.createdAt) - Date.parse(a.createdAt) || b.id.localeCompare(a.id, undefined, { numeric: true });
}

/**
 * Backups taken before agent changes, and rollback to them.
 * Layout: `<app data>/agent-backups/<id>/` with `manifest.json`, `addons/<folder>/…` and `wtf/<path in WTF>`.
 */
@Injectable({
  providedIn: "root",
})
export class AgentBackupService {
  /** Backups, rollbacks and pruning run one at a time so ids and restores can't interleave */
  private _queue: Promise<unknown> = Promise.resolve();

  public constructor(
    private _fileService: FileService,
    private _addonStorage: AddonStorageService,
    private _warcraftService: WarcraftService,
    private _installationService: WarcraftInstallationService,
    private _wtfService: WtfService,
    private _electronService: ElectronService,
    private _wowUpService: WowUpService,
    private _sessionService: SessionService,
  ) {}

  /**
   * Copy each addon's folders (plus `extraFolders`), its record and the SavedVariables named after those folders.
   * Only copies; the live install is never touched. With `recordsOnly` (for changes that only change records) just
   * the records are kept, with the AddOns entries and record ids there at the time.
   */
  public create(
    tool: string,
    installation: WowInstallation,
    addons: Addon[],
    extraFolders: string[] = [],
    summary?: string,
    options: { recordsOnly?: boolean } = {},
  ): Promise<BackupManifest> {
    return this.exclusive(async () => {
      if (typeof tool !== "string" || tool.trim() === "") {
        throw new Error("A backup needs the name of the tool making the change.");
      }
      const records = this.checkRecords(installation, addons);
      if (options.recordsOnly === true) {
        return await this.snapshot({
          tool,
          installation,
          records,
          folders: [],
          savedVariables: [],
          summary,
          recordsOnly: true,
        });
      }
      const folders = uniqueFolders(
        [...records.flatMap((a) => a.installedFolderList ?? []), ...extraFolders].map((f) => assertFolderName(f)),
      );
      return await this.snapshot({ tool, installation, records, folders, summary });
    });
  }

  /** Note the addons a change installed, so rollback removes their records and folders */
  public recordAdded(id: string, added: Addon[]): Promise<void> {
    return this.exclusive(async () => {
      const manifest = await this.readManifest(assertBackupId(id));
      const addonIds = [...manifest.added.addonIds];
      const names = [...(manifest.added.names ?? [])];
      const folders = [...manifest.added.folders];
      for (const addon of added) {
        if (addon.installationId && addon.installationId !== manifest.installationId) {
          throw new Error(`${addon.name} belongs to another installation than backup ${manifest.id}.`);
        }
        if (addon.id) {
          addonIds.push(addon.id);
        }
        if (addon.name) {
          names.push(addon.name);
        }
        folders.push(...(addon.installedFolderList ?? []).map((f) => assertFolderName(f)));
      }
      manifest.added = { addonIds: unique(addonIds), folders: uniqueFolders(folders), names: unique(names) };
      await this.writeManifest(manifest);
    });
  }

  /** Newest first */
  public async list(): Promise<BackupSummary[]> {
    const manifests = await this.readAll();
    return manifests.map((m) => {
      const summary: BackupSummary = {
        id: m.id,
        tool: m.tool,
        createdAt: m.createdAt,
        installationId: m.installationId,
        installation: m.installationName || m.installationId,
        addons: unique([...m.records.map((r) => r.name), ...(m.added.names ?? [])].filter((n) => !!n)),
      };
      if (m.summary) {
        summary.summary = m.summary;
      }
      if (m.savedVariablesPending) {
        summary.savedVariablesPending = true;
      }
      return summary;
    });
  }

  /**
   * Put the backed-up state back: safety backup of the current state, remove what the change added, restore
   * folders and records, then SavedVariables (or leave them pending while WoW runs; a later call finishes them).
   */
  public rollback(id: string): Promise<RollbackResult> {
    return this.exclusive(async () => {
      const manifest = await this.readManifest(assertBackupId(id));
      await this.checkBackupContents(manifest);
      const installation = await this.findInstallation(manifest);
      if (manifest.savedVariablesPending) {
        return await this.finishSavedVariables(manifest, installation);
      }
      return await this.restore(manifest, installation);
    });
  }

  /** Delete backups that are both outside the newest 50 and older than 30 days; returns how many were deleted */
  public prune(now = new Date()): Promise<number> {
    return this.exclusive(async () => {
      const manifests = await this.readAll();
      let removed = 0;
      for (const [index, manifest] of manifests.entries()) {
        const age = now.getTime() - Date.parse(manifest.createdAt);
        if (index < KEEP_NEWEST || age < KEEP_DAYS * DAY_MS) {
          continue;
        }
        try {
          await this._fileService.remove(join(this.root, manifest.id));
          removed += 1;
        } catch (e) {
          console.error(`[agent-backup] could not prune ${manifest.id}`, e);
        }
      }
      return removed + (await this.pruneIncomplete(now));
    });
  }

  /** Folders with no manifest.json at all, by the folder's modified time; an unreadable manifest is left alone */
  private async pruneIncomplete(now: Date): Promise<number> {
    if (!(await this._fileService.pathExists(this.root))) {
      return 0;
    }
    let removed = 0;
    for (const name of await this._fileService.listDirectories(this.root)) {
      const dir = join(this.root, name);
      try {
        if (await this._fileService.pathExists(join(dir, MANIFEST_FILE))) {
          continue;
        }
        const modified = (await this._fileService.statFiles([dir]))[dir]?.mtimeMs;
        if (typeof modified === "number" && now.getTime() - modified > INCOMPLETE_MAX_AGE_MS) {
          await this._fileService.remove(dir);
          removed += 1;
        }
      } catch (e) {
        console.error(`[agent-backup] could not prune incomplete backup ${name}`, e);
      }
    }
    return removed;
  }

  private get root(): string {
    return agentBackupsPath(this._wowUpService.applicationFolderPath);
  }

  private exclusive<T>(work: () => Promise<T>): Promise<T> {
    const run = this._queue.then(work);
    this._queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private checkRecords(installation: WowInstallation, addons: Addon[]): Addon[] {
    const byId = new Map<string, Addon>();
    for (const addon of addons) {
      if (!addon.id) {
        throw new Error(`${addon.name} has no id, so its record can't be backed up.`);
      }
      if (addon.installationId !== installation.id) {
        throw new Error(
          `${addon.name} belongs to another installation than ${installation.displayName || installation.id}.`,
        );
      }
      byId.set(addon.id, JSON.parse(JSON.stringify(addon)) as Addon);
    }
    return [...byId.values()];
  }

  private async snapshot(o: SnapshotOptions): Promise<BackupManifest> {
    const now = new Date();
    const id = await this.newId(now, o.tool);
    const dir = join(this.root, id);
    await this._fileService.createDirectory(dir);

    try {
      const addonsPath = this._warcraftService.getAddonFolderPath(o.installation);
      // readdir: every entry by name, symlinks included and never resolved, so a dangling link can't fail it
      const foldersAtBackup = (await this._fileService.pathExists(addonsPath))
        ? await this._fileService.readdir(addonsPath)
        : [];
      const copied: string[] = [];
      const absent: string[] = [];
      for (const folder of o.folders) {
        const live = join(addonsPath, folder);
        if (!(await this._fileService.pathExists(live))) {
          absent.push(folder);
          continue;
        }
        await this._fileService.copy(live, join(dir, ADDONS_DIR, folder));
        copied.push(folder);
      }

      const wtfPath = this._wtfService.getWtfPath(o.installation);
      const candidates = o.savedVariables ?? (await this.findSavedVariables(wtfPath, o.folders));
      const savedVariables: string[] = [];
      for (const rel of candidates) {
        const live = join(wtfPath, rel);
        if (!(await this._fileService.pathExists(live))) {
          continue;
        }
        const dest = join(dir, WTF_DIR, rel);
        await this._fileService.createDirectory(dirname(dest));
        await this._fileService.copy(live, dest);
        savedVariables.push(rel);
      }

      const recordIdsAtBackup = (await this._addonStorage.getAllForInstallationIdAsync(o.installation.id))
        .map((a) => a.id)
        .filter((addonId) => !!addonId);

      const manifest: BackupManifest = {
        id,
        tool: o.tool,
        createdAt: now.toISOString(),
        installationId: o.installation.id,
        installationName: await this.nameOf(o.installation),
        records: o.records,
        folders: copied,
        savedVariables,
        added: { addonIds: o.addedIds ?? [], folders: absent },
        undo: `rollback ${id}`,
        recordIdsAtBackup,
        foldersAtBackup,
      };
      if (o.summary) {
        manifest.summary = o.summary;
      }
      if (o.recordsOnly) {
        manifest.recordsOnly = true;
      }
      if (o.addedNames && o.addedNames.length > 0) {
        manifest.added.names = o.addedNames;
      }
      // Written last: a folder without a manifest is an incomplete backup and is never listed or restored
      await this.writeManifest(manifest);
      return manifest;
    } catch (e) {
      try {
        await this._fileService.remove(dir);
      } catch (cleanup) {
        console.error(`[agent-backup] could not remove incomplete backup ${id}`, cleanup);
      }
      throw new Error(`Could not take a backup (${o.tool}): ${message(e)}`);
    }
  }

  /** The name the UI shows (a stored label can be the "{defaultName}" template), else the stored one */
  private async nameOf(installation: WowInstallation): Promise<string> {
    try {
      return await this._installationService.getInstallationDisplayName(installation);
    } catch (e) {
      console.warn(`[agent-backup] could not name installation ${installation.id}`, e);
      return installation.displayName || installation.label || installation.id;
    }
  }

  private async newId(now: Date, tool: string): Promise<string> {
    const slug =
      tool
        .replace(/[^A-Za-z0-9_.-]/g, "_")
        .slice(0, MAX_TOOL_SLUG)
        .replace(/\.+$/, "") || "change";
    const base = `${stamp(now)}-${slug}`;
    let id = base;
    for (let n = 2; await this._fileService.pathExists(join(this.root, id)); n++) {
      id = `${base}-${n}`;
    }
    return id;
  }

  /**
   * SavedVariables whose base name (without `.lua`) is one of the folders, ignoring case, plus their `.lua.bak`,
   * from `Account/<acct>/SavedVariables/` and `Account/<acct>/<realm>/<character>/SavedVariables/`.
   */
  private async findSavedVariables(wtfPath: string, folders: string[]): Promise<string[]> {
    const names = new Set(folders.map(folderKey));
    const accountsPath = join(wtfPath, ACCOUNT_DIR);
    if (names.size === 0 || !(await this._fileService.pathExists(accountsPath))) {
      return [];
    }

    const svDirs: string[] = [];
    for (const account of await this._fileService.listDirectories(accountsPath, true)) {
      const accountRel = join(ACCOUNT_DIR, account);
      svDirs.push(join(accountRel, SAVED_VARIABLES_DIR));
      for (const realm of await this._fileService.listDirectories(join(wtfPath, accountRel), true)) {
        if (folderKey(realm) === folderKey(SAVED_VARIABLES_DIR)) {
          continue;
        }
        for (const character of await this._fileService.listDirectories(join(wtfPath, accountRel, realm), true)) {
          svDirs.push(join(accountRel, realm, character, SAVED_VARIABLES_DIR));
        }
      }
    }

    const found: string[] = [];
    for (const rel of svDirs) {
      for (const file of await this._fileService.listFiles(join(wtfPath, rel), "*")) {
        const lower = file.toLowerCase();
        const base = lower.endsWith(".lua.bak")
          ? lower.slice(0, -".lua.bak".length)
          : lower.endsWith(".lua")
            ? lower.slice(0, -".lua".length)
            : undefined;
        if (base !== undefined && names.has(base)) {
          found.push(join(rel, file));
        }
      }
    }
    return found;
  }

  private async readAll(): Promise<BackupManifest[]> {
    if (!(await this._fileService.pathExists(this.root))) {
      return [];
    }
    const manifests: BackupManifest[] = [];
    for (const name of await this._fileService.listDirectories(this.root)) {
      if (!BACKUP_ID.test(name)) {
        continue;
      }
      try {
        const m: unknown = JSON.parse(await this._fileService.readFile(join(this.root, name, MANIFEST_FILE)));
        if (isManifest(m) && m.id === name) {
          manifests.push(m);
        }
      } catch {
        // no manifest yet (incomplete backup) or unreadable: not a backup we can list or prune
      }
    }
    return manifests.sort(newestFirst);
  }

  private async readManifest(id: string): Promise<BackupManifest> {
    const file = join(this.root, id, MANIFEST_FILE);
    if (!(await this._fileService.pathExists(file))) {
      throw new Error(`No backup with id "${id}". Use list_backups to find ids.`);
    }
    let m: unknown;
    try {
      m = JSON.parse(await this._fileService.readFile(file));
    } catch (e) {
      throw new Error(`Backup ${id} has an unreadable manifest: ${message(e)}`);
    }
    if (!isManifest(m) || m.id !== id) {
      throw new Error(`Backup ${id} has an invalid manifest.`);
    }
    return m;
  }

  private async writeManifest(manifest: BackupManifest): Promise<void> {
    await this._fileService.writeFile(join(this.root, manifest.id, MANIFEST_FILE), JSON.stringify(manifest, null, 2));
  }

  /** Everything a rollback would restore must be present and in scope before anything is changed */
  private async checkBackupContents(manifest: BackupManifest): Promise<void> {
    const dir = join(this.root, manifest.id);
    manifest.added.folders.forEach((f) => assertFolderName(f));
    for (const record of manifest.records) {
      if (typeof record?.id !== "string" || record.id === "") {
        throw new Error(`Backup ${manifest.id} holds an addon record without an id; nothing was changed.`);
      }
    }
    for (const folder of manifest.folders) {
      if (!(await this._fileService.pathExists(join(dir, ADDONS_DIR, assertFolderName(folder))))) {
        throw new Error(`Backup ${manifest.id} is missing its copy of ${folder}; nothing was changed.`);
      }
    }
    for (const rel of manifest.savedVariables) {
      if (!(await this._fileService.pathExists(join(dir, WTF_DIR, assertWtfRelative(rel))))) {
        throw new Error(`Backup ${manifest.id} is missing its copy of ${rel}; nothing was changed.`);
      }
    }
  }

  private async findInstallation(manifest: BackupManifest): Promise<WowInstallation> {
    const installs = await this._installationService.getWowInstallationsAsync();
    const installation = installs.find((i) => i.id === manifest.installationId);
    if (!installation) {
      throw new Error(
        `The installation of backup ${manifest.id} (${manifest.installationName || manifest.installationId}) is no longer in WowUp.`,
      );
    }
    return installation;
  }

  private async restore(manifest: BackupManifest, installation: WowInstallation): Promise<RollbackResult> {
    const addonsPath = this._warcraftService.getAddonFolderPath(installation);
    const dir = join(this.root, manifest.id);
    const current = await this._addonStorage.getAllForInstallationIdAsync(installation.id);
    const currentById = new Map(current.filter((a) => !!a.id).map((a) => [a.id, a]));

    const restoreIds = new Set(manifest.records.map((r) => r.id));
    const addedIds = new Set(manifest.added.addonIds);
    const knownIds = new Set(manifest.recordIdsAtBackup ?? current.map((a) => a.id));
    const restoreKeys = new Set(manifest.folders.map(folderKey));
    const existedKeys = new Set((manifest.foldersAtBackup ?? []).map(folderKey));
    const foldersOf = (a: Addon) => (a.installedFolderList ?? []).filter(isFolderName);
    const restoredNow = current.filter((a) => !!a.id && restoreIds.has(a.id));

    // A record made after the backup is a reinstall of what the backup holds or the change added when it is the
    // same addon, or when the folders it alone claims are all the backup's or the change's (at least one, every
    // name well-formed). A folder another record also claims is shared, so it says nothing either way. Anything
    // else (a rescan's re-created record of another addon, a later addon bundling a shared folder, a standalone
    // library next to an addon that bundles it) is left alone with its folders.
    const reinstallKeys = new Set([...restoreKeys, ...manifest.added.folders.map(folderKey)]);
    const changedAddons: Array<Pick<Addon, "name" | "providerName" | "externalId">> = [
      ...manifest.records,
      ...(manifest.added.names ?? []).map((name) => ({ name })),
    ];
    const isChangedAddon = (a: Addon) => changedAddons.some((c) => sameAddon(a, c));
    /** The folders a record claims, once each, or undefined when it claims none or any name is malformed */
    const claimedKeys = (a: Addon): string[] | undefined => {
      const list = a.installedFolderList ?? [];
      return list.length > 0 && list.every(isFolderName) ? [...new Set(list.map(folderKey))] : undefined;
    };
    // Later records that may be reinstalls (the same addon, or claiming nothing but the backup's or the change's
    // folders) don't make a folder shared for one another: otherwise two later duplicates of a removed addon would
    // each see the other's claim and both stay. One of them that stays anyway has every folder it claims also
    // claimed by a record that is counted.
    const maybeReinstalls = new Set(
      current.filter(
        (a) =>
          !!a.id &&
          !restoreIds.has(a.id) &&
          !addedIds.has(a.id) &&
          !knownIds.has(a.id) &&
          (isChangedAddon(a) || (claimedKeys(a)?.every((k) => reinstallKeys.has(k)) ?? false)),
      ),
    );
    const claimers = new Map<string, Addon[]>();
    for (const a of current) {
      for (const k of new Set(foldersOf(a).map(folderKey))) {
        claimers.set(k, [...(claimers.get(k) ?? []), a]);
      }
    }
    const isReinstall = (a: Addon) => {
      if (isChangedAddon(a)) {
        return true;
      }
      const own = (claimedKeys(a) ?? []).filter(
        (k) => !(claimers.get(k) ?? []).some((o) => o !== a && !maybeReinstalls.has(o)),
      );
      return own.length > 0 && own.every((k) => reinstallKeys.has(k));
    };

    // Records to remove: what the change added, and later reinstalls (otherwise the reinstall and the restored
    // record would both claim the restored folders, and updating or removing the reinstall would overwrite or
    // delete them)
    const removeRecords = current.filter(
      (a) => !!a.id && !restoreIds.has(a.id) && (addedIds.has(a.id) || (!knownIds.has(a.id) && isReinstall(a))),
    );
    const touched = [...restoredNow, ...removeRecords];
    const touchedIds = new Set(touched.map((a) => a.id));
    const keptKeys = new Set(
      current.filter((a) => !a.id || !touchedIds.has(a.id)).flatMap((a) => foldersOf(a).map(folderKey)),
    );
    // Folders to remove: what the change added and what the touched records claim now (a later update may have
    // added folders). Never one being restored, one an addon this rollback doesn't touch still claims, or one
    // that already existed when the backup was taken (it can't be put back, so it isn't taken away). A records-only
    // backup removes none: its change wrote no folders, and without copies of the rest, taking away a folder a later
    // update added would leave that addon half updated.
    const removable = manifest.recordsOnly ? [] : [...manifest.added.folders, ...touched.flatMap(foldersOf)];
    const removeFolders = uniqueFolders(removable).filter((f) => {
      const k = folderKey(f);
      return !restoreKeys.has(k) && !keptKeys.has(k) && !existedKeys.has(k);
    });
    const missingRecords = manifest.records.filter((r) => !currentById.has(r.id));

    // 1. Safety backup of everything this rollback touches, so the rollback can be rolled back
    const safety = await this.snapshot({
      tool: `rollback-${manifest.id}`,
      installation,
      records: touched,
      folders: [...manifest.folders, ...removeFolders],
      addedIds: missingRecords.map((r) => r.id),
      addedNames: missingRecords.map((r) => r.name),
      summary: `State before rolling back ${manifest.id}`,
      recordsOnly: manifest.recordsOnly,
    });

    const restoredFolders: string[] = [];
    const removedFolders: string[] = [];
    let restoredRecords = 0;
    let removedRecords = 0;
    try {
      // 2. Remove what the change added
      for (const addon of removeRecords) {
        await this._addonStorage.removeAsync(addon);
        removedRecords += 1;
      }
      for (const folder of removeFolders) {
        const live = join(addonsPath, folder);
        if (await this._fileService.pathExists(live)) {
          await this._fileService.remove(live);
          removedFolders.push(folder);
        }
      }

      // 3. Restore folders and records
      for (const folder of manifest.folders) {
        const live = join(addonsPath, folder);
        if (await this._fileService.pathExists(live)) {
          await this._fileService.remove(live);
        }
        await this._fileService.copy(join(dir, ADDONS_DIR, folder), live);
        restoredFolders.push(folder);
      }
      for (const record of manifest.records) {
        await this._addonStorage.setAsync(record.id, record);
        restoredRecords += 1;
      }
    } catch (e) {
      throw new Error(
        `Rollback of ${manifest.id} stopped partway: ${message(e)}. ` +
          `The state before this rollback is in backup ${safety.id}; roll back to it to return there.`,
      );
    } finally {
      if (restoredFolders.length + removedFolders.length + restoredRecords + removedRecords > 0) {
        // My Addons reloads its list from storage on this. notifyAddonsChanged would start a full update check,
        // which writes back the records it read before this rollback.
        this._sessionService.autoUpdateComplete();
      }
    }

    // 4. SavedVariables
    let savedVariables: RollbackResult["savedVariables"] = "none";
    if (manifest.savedVariables.length > 0) {
      savedVariables = (await this.isWowRunning(installation))
        ? await this.markSavedVariablesPending(manifest, safety.id)
        : await this.restoreSavedVariables(manifest, installation, safety.id);
    }

    return {
      safetyBackupId: safety.id,
      restoredFolders,
      removedFolders,
      restoredRecords,
      removedRecords,
      savedVariables,
    };
  }

  /** Folders and records were rolled back earlier; only the SavedVariables are left */
  private async finishSavedVariables(manifest: BackupManifest, installation: WowInstallation): Promise<RollbackResult> {
    const result: RollbackResult = {
      safetyBackupId: manifest.safetyBackupId ?? "",
      restoredFolders: [],
      removedFolders: [],
      restoredRecords: 0,
      removedRecords: 0,
      savedVariables: "pending-wow-running",
    };
    if (await this.isWowRunning(installation)) {
      return result;
    }

    // WoW rewrote these on logout; keep them before overwriting
    const safety = await this.snapshot({
      tool: `rollback-${manifest.id}`,
      installation,
      records: [],
      folders: [],
      savedVariables: manifest.savedVariables,
      summary: `SavedVariables before finishing the rollback of ${manifest.id}`,
    });
    result.safetyBackupId = safety.id;
    result.savedVariables = await this.restoreSavedVariables(manifest, installation, safety.id);
    return result;
  }

  private async markSavedVariablesPending(
    manifest: BackupManifest,
    safetyBackupId: string,
  ): Promise<"pending-wow-running"> {
    manifest.savedVariablesPending = true;
    manifest.safetyBackupId = safetyBackupId;
    await this.writeManifest(manifest);
    return "pending-wow-running";
  }

  private async restoreSavedVariables(
    manifest: BackupManifest,
    installation: WowInstallation,
    safetyBackupId: string,
  ): Promise<"restored"> {
    const wtfPath = this._wtfService.getWtfPath(installation);
    const dir = join(this.root, manifest.id);
    try {
      for (const rel of manifest.savedVariables) {
        const live = join(wtfPath, rel);
        await this._fileService.createDirectory(dirname(live));
        await this._fileService.copy(join(dir, WTF_DIR, rel), live);
      }
    } catch (e) {
      // Leave only the SavedVariables to retry; folders and records are done
      try {
        await this.markSavedVariablesPending(manifest, safetyBackupId);
      } catch (writeError) {
        console.error(`[agent-backup] could not mark ${manifest.id} pending`, writeError);
      }
      throw new Error(
        `Rollback of ${manifest.id} restored folders and records but not all SavedVariables: ${message(e)}. ` +
          `Run rollback ${manifest.id} again to retry them; the files from before are in backup ${safetyBackupId}.`,
      );
    }
    if (manifest.savedVariablesPending || manifest.safetyBackupId) {
      delete manifest.savedVariablesPending;
      delete manifest.safetyBackupId;
      await this.writeManifest(manifest);
    }
    return "restored";
  }

  /** Only an explicit "not running" lets SavedVariables be written; an error counts as running */
  private async isWowRunning(installation: WowInstallation): Promise<boolean> {
    try {
      return (await this._electronService.invoke<boolean>(AGENT_CHANNEL_WOW_RUNNING, installation.location)) !== false;
    } catch (e) {
      console.error("[agent-backup] could not tell whether WoW is running", e);
      return true;
    }
  }
}
