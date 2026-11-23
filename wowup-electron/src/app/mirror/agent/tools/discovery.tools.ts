import { firstValueFrom, Observable } from "rxjs";
import {
  Addon,
  AddonCategory,
  AddonSearchResult,
  AddonSearchResultFile,
  getEnumName,
  SearchByUrlResult,
  WowClientType,
  WowInstallation,
} from "wowup-lib-core";

import {
  ADDON_PROVIDER_CURSEFORGE,
  ADDON_PROVIDER_CURSEFORGEV2,
  ADDON_PROVIDER_GITHUB,
  ADDON_PROVIDER_HUB,
  ADDON_PROVIDER_HUB_LEGACY,
  ADDON_PROVIDER_RAIDERIO,
  ADDON_PROVIDER_TUKUI,
  ADDON_PROVIDER_WAGO,
  ADDON_PROVIDER_WOWINTERFACE,
} from "../../../../common/constants";
import { needsUpdate } from "../../../utils/addon.utils";
import { AgentToolSet } from "../agent-tool";
import { resolveAddon, resolveInstallation } from "../resolve";
import { CurseVersionClient, listVersions } from "./versions";

/** The slice of a provider these tools call. */
export interface DiscoveryProvider {
  getById(addonId: string, installation: WowInstallation): Promise<AddonSearchResult | undefined>;
  getChangelog(installation: WowInstallation, externalId: string, externalReleaseId: string): Promise<string>;
}

export interface DiscoveryDeps {
  addonService: {
    search(query: string, installation: WowInstallation): Promise<AddonSearchResult[]>;
    getAddons(installation: WowInstallation, rescan?: boolean): Promise<Addon[]>;
    getAddonByUrl(url: URL, installation: WowInstallation): Promise<SearchByUrlResult | undefined>;
    getFullDescription(
      installation: WowInstallation,
      providerName: string,
      externalId: string,
      addon?: Addon,
    ): Promise<string>;
    getChangelogForAddon(installation: WowInstallation, addon: Addon): Promise<string>;
    getCategoryPage(category: AddonCategory, installation: WowInstallation): Promise<AddonSearchResult[]>;
    getFeaturedAddons(installation: WowInstallation): Observable<AddonSearchResult[]>;
  };
  installService: { getWowInstallationsAsync(): Promise<WowInstallation[]> };
  /** The installation WowUp currently shows (SessionService). */
  getSelected: () => WowInstallation | undefined;
  getProvider: (name: string) => DiscoveryProvider | undefined;
  getSecret: (key: string) => Promise<string | undefined>;
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
  createCurseClient?: (apiKey: string) => CurseVersionClient;
}

const KNOWN_PROVIDERS = [
  ADDON_PROVIDER_CURSEFORGE,
  ADDON_PROVIDER_CURSEFORGEV2,
  ADDON_PROVIDER_GITHUB,
  ADDON_PROVIDER_HUB,
  ADDON_PROVIDER_HUB_LEGACY,
  ADDON_PROVIDER_RAIDERIO,
  ADDON_PROVIDER_TUKUI,
  ADDON_PROVIDER_WAGO,
  ADDON_PROVIDER_WOWINTERFACE,
];

/** Case-insensitive provider name to the app's exact name ("curseforge" is accepted for Curse). */
export function canonicalProvider(name: string): string {
  const lower = name.trim().toLowerCase();
  if (lower === "curseforge") {
    return ADDON_PROVIDER_CURSEFORGE;
  }
  return KNOWN_PROVIDERS.find((p) => p.toLowerCase() === lower) ?? name.trim();
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

function iso(d: Date | string | undefined): string | undefined {
  if (!d) {
    return undefined;
  }
  const date = d instanceof Date ? d : new Date(d);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function sameProvider(a: string | undefined, filter: string | undefined): boolean {
  return !filter || (a ?? "").toLowerCase() === canonicalProvider(filter).toLowerCase();
}

function trimFile(f: AddonSearchResultFile): Record<string, unknown> {
  return {
    fileId: f.externalId,
    version: f.version,
    channel: ["stable", "beta", "alpha"][f.channelType] ?? "stable",
    releaseDate: iso(f.releaseDate),
    gameVersions: f.gameVersions ?? (f.gameVersion ? [f.gameVersion] : []),
    folders: f.folders ?? [],
    downloadUrl: f.downloadUrl,
  };
}

function latestFile(r: AddonSearchResult): AddonSearchResultFile | undefined {
  const files = r.files ?? [];
  return files.find((f) => Number(f.channelType) === 0) ?? files[0];
}

function trimResult(r: AddonSearchResult): Record<string, unknown> {
  const latest = latestFile(r);
  return {
    name: r.name,
    provider: r.providerName,
    externalId: r.externalId,
    author: r.author,
    downloadCount: r.downloadCount,
    summary: r.summary,
    url: r.externalUrl,
    latestVersion: latest?.version,
    latestReleaseDate: iso(latest?.releaseDate),
  };
}

function trimInstalled(a: Addon): Record<string, unknown> {
  return {
    addonId: a.id,
    name: a.name,
    provider: a.providerName,
    externalId: a.externalId,
    installedVersion: a.installedVersion,
    latestVersion: a.latestVersion,
    hasUpdate: needsUpdate(a),
    folders: a.installedFolderList ?? [],
    autoUpdate: a.autoUpdateEnabled,
    ignored: a.isIgnored,
    gameVersions: a.gameVersion ?? [],
  };
}

function categoryNames(): string[] {
  return Object.keys(AddonCategory).filter((k) => Number.isNaN(Number(k)) && k !== "Unknown");
}

function parseCategory(arg: string): AddonCategory {
  const lower = arg.toLowerCase();
  const byName = categoryNames().find((n) => n.toLowerCase() === lower);
  if (byName) {
    return (AddonCategory as unknown as Record<string, number>)[byName] as AddonCategory;
  }
  const n = Number(arg);
  if (Number.isInteger(n) && n > 0 && getEnumName(AddonCategory, n)) {
    return n as AddonCategory;
  }
  throw new Error(`Unknown category "${arg}". Valid categories: ${categoryNames().join(", ")}`);
}

export function createDiscoveryTools(deps: DiscoveryDeps): AgentToolSet {
  const { addonService } = deps;

  const resolveInstall = async (args: Record<string, unknown>): Promise<WowInstallation> =>
    resolveInstallation(args.installation, await deps.installService.getWowInstallationsAsync(), deps.getSelected());

  const providerOf = (name: string): DiscoveryProvider => {
    const provider = deps.getProvider(canonicalProvider(name));
    if (!provider) {
      throw new Error(`Provider "${name}" is not available (disabled or unknown).`);
    }
    return provider;
  };

  /** addonId (installed) or provider + externalId (any addon). */
  const target = async (
    args: Record<string, unknown>,
    installation: WowInstallation,
  ): Promise<{ provider: string; externalId: string; addon?: Addon }> => {
    const addonId = str(args, "addonId");
    const provider = str(args, "provider");
    const externalId = str(args, "externalId");
    if (addonId) {
      const addon = resolveAddon({ addonId }, (await addonService.getAddons(installation)) ?? []);
      return { provider: addon.providerName ?? "", externalId: addon.externalId ?? "", addon };
    }
    if (provider && externalId) {
      return { provider: canonicalProvider(provider), externalId };
    }
    throw new Error("Pass addonId, or provider and externalId.");
  };

  return {
    list_installations: async () => {
      const installs = await deps.installService.getWowInstallationsAsync();
      const selected = deps.getSelected();
      return Promise.all(
        installs.map(async (i) => ({
          id: i.id,
          name: i.label || i.displayName,
          clientType: getEnumName(WowClientType, i.clientType),
          path: i.location,
          addonCount: ((await addonService.getAddons(i)) ?? []).length,
          selected: selected?.id === i.id,
        })),
      );
    },

    list_addons: async (args) => {
      const installation = await resolveInstall(args);
      const name = str(args, "name")?.toLowerCase();
      const provider = str(args, "provider");
      let addons = (await addonService.getAddons(installation)) ?? [];
      if (name) {
        addons = addons.filter((a) => a.name.toLowerCase().includes(name));
      }
      if (provider) {
        addons = addons.filter((a) => sameProvider(a.providerName, provider));
      }
      if (typeof args.hasUpdate === "boolean") {
        addons = addons.filter((a) => needsUpdate(a) === args.hasUpdate);
      }
      if (typeof args.ignored === "boolean") {
        addons = addons.filter((a) => !!a.isIgnored === args.ignored);
      }
      if (typeof args.autoUpdate === "boolean") {
        addons = addons.filter((a) => !!a.autoUpdateEnabled === args.autoUpdate);
      }
      return addons.map(trimInstalled);
    },

    search_addons: async (args) => {
      const query = str(args, "query");
      if (!query) {
        throw new Error("`query` is required.");
      }
      const installation = await resolveInstall(args);
      const provider = str(args, "provider");
      const results = (await addonService.search(query, installation)) ?? [];
      return results.filter((r) => sameProvider(r.providerName, provider)).map(trimResult);
    },

    get_addon_details: async (args) => {
      const installation = await resolveInstall(args);
      const t = await target(args, installation);
      const result = await providerOf(t.provider).getById(t.externalId, installation);
      if (!result) {
        throw new Error(`${t.provider} has no addon with externalId "${t.externalId}".`);
      }
      return {
        ...trimResult(result),
        thumbnailUrl: result.thumbnailUrl,
        releasedAt: iso(result.releasedAt),
        fundingLinks: result.fundingLinks,
        files: (result.files ?? []).map(trimFile),
        installed: t.addon ? trimInstalled(t.addon) : undefined,
      };
    },

    get_changelog: async (args) => {
      const installation = await resolveInstall(args);
      const t = await target(args, installation);
      const version = str(args, "version");
      if (t.addon && !version) {
        return { changelog: await addonService.getChangelogForAddon(installation, t.addon) };
      }
      const provider = providerOf(t.provider);
      const result = await provider.getById(t.externalId, installation);
      if (!result) {
        throw new Error(`${t.provider} has no addon with externalId "${t.externalId}".`);
      }
      const files = result.files ?? [];
      const file = version ? files.find((f) => f.externalId === version || f.version === version) : latestFile(result);
      if (!file) {
        throw new Error(
          version
            ? `Version "${version}" is not among the latest files; use list_versions with includeChangelog.`
            : "The provider lists no files for this addon.",
        );
      }
      return {
        version: file.version,
        changelog: await provider.getChangelog(installation, t.externalId, file.externalId ?? ""),
      };
    },

    get_description: async (args) => {
      const installation = await resolveInstall(args);
      const t = await target(args, installation);
      return { description: await addonService.getFullDescription(installation, t.provider, t.externalId, t.addon) };
    },

    find_by_url: async (args) => {
      const raw = str(args, "url");
      if (!raw) {
        throw new Error("`url` is required.");
      }
      let url: URL;
      try {
        url = new URL(raw);
      } catch {
        throw new Error(`"${raw}" is not a valid URL.`);
      }
      const installation = await resolveInstall(args);
      const found = await addonService.getAddonByUrl(url, installation);
      if (!found?.searchResult) {
        const why = (found?.errors ?? []).map((e) => e.message).join("; ");
        throw new Error(`No provider recognised ${raw}${why ? `: ${why}` : "."}`);
      }
      return { ...trimResult(found.searchResult), files: (found.searchResult.files ?? []).map(trimFile) };
    },

    browse_category: async (args) => {
      const category = parseCategory(str(args, "category") ?? "");
      const installation = await resolveInstall(args);
      const provider = str(args, "provider");
      const page = typeof args.page === "number" ? args.page : 1;
      // Providers return one page per call; there is no paging parameter to pass on.
      if (page > 1) {
        return [];
      }
      const results = (await addonService.getCategoryPage(category, installation)) ?? [];
      return results.filter((r) => sameProvider(r.providerName, provider)).map(trimResult);
    },

    featured_addons: async (args) => {
      const installation = await resolveInstall(args);
      const provider = str(args, "provider");
      const results = (await firstValueFrom(addonService.getFeaturedAddons(installation))) ?? [];
      return results.filter((r) => sameProvider(r.providerName, provider)).map(trimResult);
    },

    list_versions: async (args) => {
      const installation = await resolveInstall(args);
      const t = await target(args, installation);
      return listVersions(t.provider, t.externalId, {
        getSecret: deps.getSecret,
        getLatest: (provider, externalId) => providerOf(provider).getById(externalId, installation),
        includeChangelog: args.includeChangelog === true,
        fetchJson: deps.fetchJson,
        createCurseClient: deps.createCurseClient,
      });
    },
  };
}
