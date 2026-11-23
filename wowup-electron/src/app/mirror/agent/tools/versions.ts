import * as cfv2 from "curseforge-v2";
import { AddonChannelType, AddonSearchResult, AddonSearchResultFile } from "wowup-lib-core";

import {
  ADDON_PROVIDER_CURSEFORGE,
  ADDON_PROVIDER_CURSEFORGEV2,
  ADDON_PROVIDER_GITHUB,
  PREF_CF2_API_KEY,
  PREF_GITHUB_PERSONAL_ACCESS_TOKEN,
} from "../../../../common/constants";

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
  /** Reads a sensitive-storage value (CurseForge key, GitHub token). */
  getSecret: (key: string) => Promise<string | undefined>;
  /** Latest-file lookup for providers without a history API (provider.getById). */
  getLatest: (provider: string, externalId: string) => Promise<AddonSearchResult | undefined>;
  includeChangelog?: boolean;
  createCurseClient?: (apiKey: string) => CurseVersionClient;
  fetchJson?: (url: string, headers: Record<string, string>) => Promise<unknown>;
}

const CHANNELS: AgentChannel[] = ["stable", "beta", "alpha"];

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

  const res = await client.getModFiles({ modId, pageSize: 50 });
  const files = res.data?.data ?? [];
  const versions: AgentVersion[] = files.map((f) => ({
    fileId: String(f.id),
    version: f.displayName,
    releaseDate: iso(f.fileDate),
    channel: f.releaseType === 3 ? "alpha" : f.releaseType === 2 ? "beta" : "stable",
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

interface GitHubReleaseLite {
  id: number;
  tag_name: string;
  name?: string;
  prerelease: boolean;
  draft: boolean;
  published_at?: string;
  created_at?: string;
  body?: string;
  assets?: { name: string; browser_download_url: string }[];
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
  const releases = (await fetchJson(
    `https://api.github.com/repos/${externalId}/releases?per_page=50`,
    headers,
  )) as GitHubReleaseLite[];

  const versions: AgentVersion[] = [];
  for (const r of releases) {
    if (r.draft) {
      continue;
    }
    const asset = (r.assets ?? []).find((a) => a.name.toLowerCase().endsWith(".zip"));
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
      downloadUrl: asset.browser_download_url,
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
