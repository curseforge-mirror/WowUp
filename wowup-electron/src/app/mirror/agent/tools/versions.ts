import * as cfv2 from "curseforge-v2";
import {
  AddonChannelType,
  AddonSearchResult,
  AddonSearchResultFile,
  getWowClientGroupForType,
  WowClientGroup,
  WowClientType,
} from "wowup-lib-core";

import {
  ADDON_PROVIDER_CURSEFORGE,
  ADDON_PROVIDER_CURSEFORGEV2,
  ADDON_PROVIDER_GITHUB,
  PREF_CF2_API_KEY,
  PREF_GITHUB_PERSONAL_ACCESS_TOKEN,
} from "../../../../common/constants";
import {
  anyAsset,
  assetByName,
  assetFromMetadata,
  assetUrl,
  GitHubAssetLite,
  GitHubReleaseLite,
  metadataAsset,
  ReleaseMeta,
} from "./github-assets";
import { createLimiter } from "./limiter";

export type AgentChannel = "stable" | "beta" | "alpha";

export interface AgentVersion {
  fileId: string;
  version: string;
  releaseDate: string;
  channel: AgentChannel;
  gameVersions: string[];
  folders: string[];
  downloadUrl: string;
  changelog?: string;
}

/** The slice of the CurseForge client that listVersions uses. */
export interface CurseVersionClient {
  getModFiles(req: cfv2.CF2GetModFilesRequest): Promise<{ data?: cfv2.CF2GetModFilesResponse }>;
  getModFileChangelog(modId: number, fileId: number): Promise<{ data?: cfv2.CF2GetModFileChangelogResponse }>;
}

export interface VersionDeps {
  /** The installation's game client: versions are listed for its flavor, as WowUp's providers pick files */
  clientType: WowClientType;
  /** Reads a sensitive-storage value (CurseForge key, GitHub token). */
  getSecret: (key: string) => Promise<string | undefined>;
  /** Latest-file lookup for providers without a history API (provider.getById). */
  getLatest: (provider: string, externalId: string) => Promise<AddonSearchResult | undefined>;
  includeChangelog?: boolean;
  createCurseClient?: (apiKey: string) => CurseVersionClient;
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
}

const CHANNELS: AgentChannel[] = ["stable", "beta", "alpha"];

/** GitHub releases whose release.json is read (newest first); older ones go by their file names */
const GITHUB_METADATA_RELEASES = 10;
const GITHUB_METADATA_AT_ONCE = 3;

/** As CurseAddonProvider.getCFGameVersionType: the CurseForge game version type of a client */
export function curseGameVersionTypeId(clientType: WowClientType): number {
  switch (getWowClientGroupForType(clientType)) {
    case WowClientGroup.Cata:
      return cfv2.CF2WowGameVersionType.Cata;
    case WowClientGroup.WOTLK:
      return cfv2.CF2WowGameVersionType.WOTLK;
    case WowClientGroup.BurningCrusade:
      return cfv2.CF2WowGameVersionType.BurningCrusade;
    case WowClientGroup.Classic:
      return cfv2.CF2WowGameVersionType.Classic;
    case WowClientGroup.Mists:
      return cfv2.CF2WowGameVersionType.Mists;
    case WowClientGroup.Forever:
      return cfv2.CF2WowGameVersionType.Forever;
    case WowClientGroup.Retail:
    default:
      return cfv2.CF2WowGameVersionType.Retail;
  }
}

function channelFromType(type: AddonChannelType): AgentChannel {
  return CHANNELS[type] ?? "stable";
}

function iso(value: Date | string | undefined): string {
  const d = value instanceof Date ? value : new Date(value ?? "");
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}

export function toSearchResultFile(v: AgentVersion): AddonSearchResultFile {
  return {
    externalId: v.fileId,
    channelType: CHANNELS.indexOf(v.channel) as AddonChannelType,
    version: v.version,
    folders: v.folders,
    gameVersion: v.gameVersions[0] ?? "",
    gameVersions: v.gameVersions,
    downloadUrl: v.downloadUrl,
    releaseDate: new Date(v.releaseDate),
    changelog: v.changelog,
  };
}

async function defaultFetchJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers });
  if (!response.ok) {
    throw new Error(`GitHub answered ${response.status} ${response.statusText} for ${url}`);
  }
  return response.json();
}

async function curseVersions(externalId: string, deps: VersionDeps): Promise<AgentVersion[]> {
  const apiKey = await deps.getSecret(PREF_CF2_API_KEY);
  if (!apiKey) {
    throw new Error("CurseForge needs an API key in Options > Addons");
  }
  const modId = Number(externalId);
  if (!Number.isInteger(modId)) {
    throw new Error(`"${externalId}" is not a CurseForge project id.`);
  }
  const client = deps.createCurseClient
    ? deps.createCurseClient(apiKey)
    : (new cfv2.CFV2Client({ apiKey }) as unknown as CurseVersionClient);

  // Only the installation's flavor, and as CurseAddonProvider.getLatestFiles: no alternative files, and a file that
  // names its game version types must name this one
  const gameVersionTypeId = curseGameVersionTypeId(deps.clientType);
  const res = await client.getModFiles({ modId, pageSize: 50, gameVersionTypeId });
  const files = (res.data?.data ?? []).filter(
    (f) =>
      f.exposeAsAlternative !== true &&
      (!Array.isArray(f.sortableGameVersions) ||
        f.sortableGameVersions.length === 0 ||
        f.sortableGameVersions.some((v) => v.gameVersionTypeId === gameVersionTypeId)),
  );
  const versions: AgentVersion[] = files.map((f) => ({
    fileId: String(f.id),
    version: f.displayName,
    releaseDate: iso(f.fileDate),
    channel: Number(f.releaseType) === 3 ? "alpha" : Number(f.releaseType) === 2 ? "beta" : "stable",
    gameVersions: f.gameVersions ?? [],
    folders: (f.modules ?? []).map((m) => m.name),
    downloadUrl: f.downloadUrl ?? "",
  }));

  if (deps.includeChangelog) {
    await Promise.all(
      versions.map(async (v) => {
        try {
          const c = await client.getModFileChangelog(modId, Number(v.fileId));
          if (c.data?.data) {
            v.changelog = c.data.data;
          }
        } catch (e) {
          console.error("Agent changelog fetch failed", e);
        }
      }),
    );
  }
  return versions;
}

async function githubVersions(externalId: string, deps: VersionDeps): Promise<AgentVersion[]> {
  if (!/^[^/\s]+\/[^/\s]+$/.test(externalId)) {
    throw new Error(`GitHub externalId must look like owner/repo, got "${externalId}".`);
  }
  const headers: Record<string, string> = { Accept: "application/vnd.github+json" };
  const token = await deps.getSecret(PREF_GITHUB_PERSONAL_ACCESS_TOKEN);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const releases = (
    (await fetchJson(`https://api.github.com/repos/${externalId}/releases?per_page=50`, headers)) as GitHubReleaseLite[]
  ).filter((r) => !r.draft);

  // The zip WowUp's provider would install for the installation: release.json first (for the newest releases that
  // have one), then the flavor in the file name
  const metaSlot = createLimiter(GITHUB_METADATA_AT_ONCE);
  const withMeta = releases
    .map((r) => ({ r, file: metadataAsset(r) }))
    .filter((m): m is { r: GitHubReleaseLite; file: GitHubAssetLite } => !!m.file)
    .slice(0, GITHUB_METADATA_RELEASES);
  const metaOf = new Map<number, ReleaseMeta | undefined>(
    await Promise.all(
      withMeta.map(async ({ r, file }) => {
        try {
          const meta = await metaSlot(() =>
            fetchJson(assetUrl(file), { ...headers, Accept: "application/octet-stream" }),
          );
          return [r.id, meta as ReleaseMeta] as const;
        } catch (e) {
          console.error(`Agent could not read ${externalId} ${r.tag_name} release.json`, e);
          return [r.id, undefined] as const;
        }
      }),
    ),
  );
  let picked = releases.map(
    (r) => [r, assetFromMetadata(r, deps.clientType, metaOf.get(r.id)) ?? assetByName(r, deps.clientType)] as const,
  );
  if (!picked.some(([, asset]) => !!asset)) {
    // As the provider: with no zip for the flavor anywhere, any zip of the release
    picked = releases.map((r) => [r, anyAsset(r)] as const);
  }

  const versions: AgentVersion[] = [];
  for (const [r, asset] of picked) {
    if (!asset) {
      continue;
    }
    const v: AgentVersion = {
      fileId: String(r.id),
      version: r.tag_name,
      releaseDate: iso(r.published_at ?? r.created_at),
      channel: r.prerelease ? "beta" : "stable",
      gameVersions: [],
      folders: [],
      downloadUrl: assetUrl(asset),
    };
    if (r.body) {
      v.changelog = r.body;
    }
    versions.push(v);
  }
  return versions;
}

async function latestVersions(provider: string, externalId: string, deps: VersionDeps): Promise<AgentVersion[]> {
  const result = await deps.getLatest(provider, externalId);
  return (result?.files ?? []).map((f) => ({
    fileId: f.externalId ?? f.version,
    version: f.version,
    releaseDate: iso(f.releaseDate),
    channel: channelFromType(f.channelType),
    gameVersions: f.gameVersions ?? (f.gameVersion ? [f.gameVersion] : []),
    folders: f.folders ?? [],
    downloadUrl: f.downloadUrl,
    ...(f.changelog ? { changelog: f.changelog } : {}),
  }));
}

export async function listVersions(provider: string, externalId: string, deps: VersionDeps): Promise<AgentVersion[]> {
  const name = provider.toLowerCase();
  if (name === ADDON_PROVIDER_CURSEFORGE.toLowerCase() || name === ADDON_PROVIDER_CURSEFORGEV2.toLowerCase()) {
    return curseVersions(externalId, deps);
  }
  if (name === ADDON_PROVIDER_GITHUB.toLowerCase()) {
    return githubVersions(externalId, deps);
  }
  return latestVersions(provider, externalId, deps);
}
