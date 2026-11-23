import { join } from "path";
import { Addon, WowInstallation } from "wowup-lib-core";

import { AgentToolSet } from "../agent-tool";
import { parseLuaAssignments } from "../lua-literal";
import { resolveInstallation } from "../resolve";

const BUGGRABBER_FILE = "!BugGrabber.lua";
const DEFAULT_LIMIT = 20;
export const NO_ERRORS_NOTE = "BugGrabber isn't installed or has no saved errors for this installation";

export interface HealthDeps {
  addonService: {
    syncClient(installation: WowInstallation): Promise<void>;
    syncAllClients(): Promise<void>;
    getAllAddonsAvailableForUpdate(installation?: WowInstallation): Promise<Addon[]>;
    findGameVersionMismatches(addons: Addon[]): Promise<{ addon: Addon; installation: WowInstallation }[]>;
  };
  installService: { getWowInstallationsAsync(): Promise<WowInstallation[]> };
  getSelected: () => WowInstallation | undefined;
  wtfService: { getWtfPath(installation: WowInstallation): string };
  fileService: {
    listDirectories(sourcePath: string): Promise<string[]>;
    pathExists(sourcePath: string): Promise<boolean>;
    readFile(sourcePath: string): Promise<string>;
  };
}

function iso(d: Date | string | undefined): string | undefined {
  if (!d) {
    return undefined;
  }
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** The first `Interface/AddOns/<folder>/` in the text, with either slash style. */
export function addonFolderFrom(text: string | undefined): string | undefined {
  const m = /Interface[\\/]+AddOns[\\/]+([^\\/"'\]:]+)[\\/]/i.exec(text ?? "");
  return m ? m[1] : undefined;
}

interface RawError {
  message?: unknown;
  stack?: unknown;
  counter?: unknown;
  time?: unknown;
  session?: unknown;
}

function text(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

export function createHealthTools(deps: HealthDeps): AgentToolSet {
  const { addonService, fileService } = deps;

  const checkOne = async (installation: WowInstallation): Promise<Record<string, unknown>> => {
    const addons = (await addonService.getAllAddonsAvailableForUpdate(installation)) ?? [];
    const mismatches = (await addonService.findGameVersionMismatches(addons)) ?? [];
    return {
      installation: installation.label || installation.displayName,
      installationId: installation.id,
      updates: addons.map((a) => ({
        addonId: a.id,
        name: a.name,
        provider: a.providerName,
        installedVersion: a.installedVersion,
        latestVersion: a.latestVersion,
        releasedAt: iso(a.releasedAt),
      })),
      gameVersionMismatches: mismatches.map((m) => ({
        addonId: m.addon.id,
        name: m.addon.name,
        requiresGameVersion: m.addon.gameVersion ?? [],
      })),
    };
  };

  const readErrors = async (installation: WowInstallation): Promise<RawError[]> => {
    const accounts = join(deps.wtfService.getWtfPath(installation), "Account");
    let folders: string[] = [];
    try {
      folders = (await fileService.listDirectories(accounts)) ?? [];
    } catch {
      return [];
    }
    const errors: RawError[] = [];
    for (const folder of folders) {
      const file = join(folder, "SavedVariables", BUGGRABBER_FILE);
      if (!(await fileService.pathExists(file))) {
        continue;
      }
      const db = parseLuaAssignments(await fileService.readFile(file)).BugGrabberDB as
        | { errors?: Record<string, RawError> }
        | undefined;
      if (db && typeof db.errors === "object" && db.errors !== null) {
        errors.push(...Object.values(db.errors).filter((e) => typeof e === "object" && e !== null));
      }
    }
    return errors;
  };

  return {
    check_updates: async (args, ctx) => {
      const installs = await deps.installService.getWowInstallationsAsync();
      const all = args.all === true;
      let targets: WowInstallation[];
      if (all) {
        await addonService.syncAllClients();
        targets = installs;
      } else {
        targets = [resolveInstallation(args.installation, installs, deps.getSelected())];
      }
      const results: Record<string, unknown>[] = [];
      for (const installation of targets) {
        ctx.progress(`Checking ${installation.label || installation.displayName}`);
        if (!all) {
          await addonService.syncClient(installation);
        }
        results.push(await checkOne(installation));
      }
      return { installations: results };
    },

    get_addon_errors: async (args) => {
      const installs = await deps.installService.getWowInstallationsAsync();
      const installation = resolveInstallation(args.installation, installs, deps.getSelected());
      const limit =
        typeof args.limit === "number" && Number.isFinite(args.limit) && args.limit > 0
          ? Math.floor(args.limit)
          : DEFAULT_LIMIT;
      const contains = typeof args.contains === "string" ? args.contains.trim().toLowerCase() : "";

      const raw = await readErrors(installation);
      if (raw.length === 0) {
        return { errors: [], note: NO_ERRORS_NOTE };
      }

      const rows = raw
        .map((e) => ({
          message: text(e.message),
          counter: e.counter,
          time: text(e.time),
          session: e.session,
          stack: text(e.stack),
        }))
        .filter((e) => !contains || `${e.message}\n${e.stack}`.toLowerCase().includes(contains))
        .sort(
          (a, b) =>
            (a.time === b.time ? 0 : a.time < b.time ? 1 : -1) || (Number(b.session) || 0) - (Number(a.session) || 0),
        )
        .slice(0, limit);

      return {
        errors: rows.map((e) => ({ ...e, addon: addonFolderFrom(e.message) ?? addonFolderFrom(e.stack) })),
      };
    },
  };
}
