import { WowClientType } from "wowup-lib-core";

/**
 * Which zip of a GitHub release WowUp installs for a game client. GitHubAddonProvider keeps these rules private, so
 * they are repeated here, rule for rule: the BigWigs packager's release.json first, then the flavor in the file name,
 * skipping -nolib builds and non-zip assets.
 */

export interface GitHubAssetLite {
  name: string;
  /** The REST asset url; WowUp downloads it with Accept: application/octet-stream (it works for private repos too) */
  url?: string;
  browser_download_url: string;
  content_type?: string;
}

export interface GitHubReleaseLite {
  id: number;
  tag_name: string;
  name?: string;
  prerelease: boolean;
  draft: boolean;
  published_at?: string;
  created_at?: string;
  body?: string;
  assets?: GitHubAssetLite[];
}

export type MetadataFlavor = "bcc" | "classic" | "mainline" | "wrath" | "cata" | "mists" | "forever";

/** The BigWigs packager's release.json */
export interface ReleaseMeta {
  releases: Array<{ filename: string; nolib: boolean; metadata: Array<{ flavor: MetadataFlavor; interface: number }> }>;
}

export const RELEASE_METADATA_FILE = "release.json";

const ZIP_TYPES = ["application/zip", "application/x-zip-compressed"];
const OCTET_STREAM = "application/octet-stream";

export function isZipAsset(asset: GitHubAssetLite): boolean {
  if (asset.content_type === undefined) {
    // Not from the API (no content type given): go by the name
    return asset.name.toLowerCase().endsWith(".zip");
  }
  return (
    ZIP_TYPES.includes(asset.content_type) ||
    (asset.content_type === OCTET_STREAM && asset.browser_download_url.endsWith(".zip"))
  );
}

function isNotNoLib(asset: GitHubAssetLite): boolean {
  return asset.name.toLowerCase().indexOf("-nolib") === -1;
}

const NAMED = {
  classic: /[-_](classic|vanilla)\.zip$/i,
  bcc: /[-_](bc|bcc|tbc)\.zip$/i,
  wrath: /[-_](wrath|wotlkc)\.zip$/i,
  cata: /[-_](cata)\.zip$/i,
  mists: /[-_](mists)\.zip$/i,
  forever: /[-_](forever|camelot)\.zip$/i,
};

/** The provider's isValidClientType: the flavor a file name carries */
export function nameMatchesClient(clientType: WowClientType | undefined, asset: GitHubAssetLite): boolean {
  const is = (k: keyof typeof NAMED) => NAMED[k].test(asset.name);
  switch (clientType) {
    case WowClientType.Retail:
    case WowClientType.RetailPtr:
    case WowClientType.RetailXPtr:
    case WowClientType.Beta:
      return !is("classic") && !is("bcc") && !is("wrath") && !is("cata") && !is("forever");
    case WowClientType.ClassicEra:
    case WowClientType.ClassicEraPtr:
      return is("classic");
    case WowClientType.Classic:
    case WowClientType.ClassicPtr:
      return is("mists");
    case WowClientType.Forever:
    case WowClientType.ClassicBeta:
      return is("forever");
    case WowClientType.Anniversary:
      return is("bcc");
    default:
      return false;
  }
}

/** The provider's getMetadataTargetFlavor */
export function metadataFlavor(clientType: WowClientType | undefined): MetadataFlavor | undefined {
  switch (clientType) {
    case WowClientType.Classic:
    case WowClientType.ClassicPtr:
      return "mists";
    case WowClientType.Anniversary:
      return "bcc";
    case WowClientType.ClassicEra:
    case WowClientType.ClassicEraPtr:
      return "classic";
    case WowClientType.Beta:
    case WowClientType.Retail:
    case WowClientType.RetailPtr:
    case WowClientType.RetailXPtr:
      return "mainline";
    case WowClientType.Forever:
    case WowClientType.ClassicBeta:
      return "forever";
    default:
      return undefined;
  }
}

export function metadataAsset(release: GitHubReleaseLite): GitHubAssetLite | undefined {
  return (release.assets ?? []).find((a) => a.name === RELEASE_METADATA_FILE);
}

/** The provider's getValidAssetFromMetadata: the zip release.json names for the flavor, not a nolib build */
export function assetFromMetadata(
  release: GitHubReleaseLite,
  clientType: WowClientType | undefined,
  meta: ReleaseMeta | undefined,
): GitHubAssetLite | undefined {
  const flavor = metadataFlavor(clientType);
  const target = (meta?.releases ?? []).find(
    (r) => r.nolib === false && (r.metadata ?? []).some((m) => m.flavor === flavor),
  );
  if (!flavor || !target) {
    return undefined;
  }
  return (release.assets ?? []).find((a) => isZipAsset(a) && a.name === target.filename);
}

/** The provider's getValidAsset: the first zip named for the flavor */
export function assetByName(
  release: GitHubReleaseLite,
  clientType: WowClientType | undefined,
): GitHubAssetLite | undefined {
  return (release.assets ?? []).find((a) => isNotNoLib(a) && isZipAsset(a) && nameMatchesClient(clientType, a));
}

/** The provider's getValidAssetForAny: what it falls back to when no release has a zip for the flavor */
export function anyAsset(release: GitHubReleaseLite): GitHubAssetLite | undefined {
  return (release.assets ?? []).find((a) => isNotNoLib(a) && isZipAsset(a));
}

/** The url WowUp downloads an asset from */
export function assetUrl(asset: GitHubAssetLite): string {
  return asset.url || asset.browser_download_url;
}
