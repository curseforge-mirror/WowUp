import { isAbsolute, join, relative, resolve, sep } from "path";
import { DownloadAuth } from "wowup-lib-core";

import { delayMs } from "../../../utils/time.utils";
import { agentSandboxPath } from "../agent-settings";
import { canonicalProvider } from "./discovery.tools";

/** Folders WowUp's install skips when it copies a release into AddOns */
const IGNORED_FOLDER_NAMES = ["__MACOSX"];

/** As WowUp's installer (addon-install.service.ts): a failed download is retried 3 times, after 1, 2 and 4 seconds */
export const DOWNLOAD_RETRIES = 3;

/** How many releases are downloaded at once to learn their folders */
export const FOLDER_DOWNLOADS_AT_ONCE = 3;

export interface ReleaseDownloadDeps {
  applicationFolderPath: string;
  fileService: {
    createDirectory(directoryPath: string): Promise<boolean>;
    pathExists(sourcePath: string): Promise<boolean>;
    remove(sourcePath: string): Promise<boolean>;
    unzipFile(zipFilePath: string, outputFolder: string): Promise<string>;
  };
  downloadService: {
    downloadZipFile(options: {
      auth?: DownloadAuth;
      fileName: string;
      outputFolder: string;
      url: string;
    }): Promise<string>;
  };
  getProvider: (name: string) => { getDownloadAuth?(): Promise<DownloadAuth | undefined> } | undefined;
  /** Waits between download retries (tests pass one that doesn't wait) */
  delay?: (ms: number) => Promise<void>;
}

export interface ReleaseFolderDeps extends ReleaseDownloadDeps {
  fileService: ReleaseDownloadDeps["fileService"] & {
    listDirectories(sourcePath: string): Promise<string[]>;
  };
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

export function safeName(text: string): string {
  return text.replace(/[^A-Za-z0-9._-]+/g, "_");
}

/**
 * Download a release zip with the provider's download auth and unzip it to `<sandbox>/<root>` (replacing what was
 * there). A failed download is retried as WowUp's installer does. Returns the unzipped folder's path. Only the sandbox
 * is written to.
 */
export async function downloadToSandbox(
  deps: ReleaseDownloadDeps,
  provider: string,
  root: string,
  url: string,
  onRetry?: (retry: number, waitMs: number, error: unknown) => void,
): Promise<string> {
  if (!url) {
    throw new Error("This release has no download URL (the provider does not allow direct downloads).");
  }
  const { fileService } = deps;
  const sandboxBase = agentSandboxPath(deps.applicationFolderPath);
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
  const delay = deps.delay ?? delayMs;
  let saved: string;
  for (let retry = 0; ; retry++) {
    try {
      saved = await deps.downloadService.downloadZipFile({ auth, fileName: zipName, outputFolder: sandboxBase, url });
      break;
    } catch (e) {
      if (retry === DOWNLOAD_RETRIES) {
        throw e;
      }
      const waitMs = 1000 * Math.pow(2, retry);
      onRetry?.(retry + 1, waitMs, e);
      await delay(waitMs);
    }
  }
  try {
    await fileService.unzipFile(saved || zipPath, folder);
  } finally {
    await fileService.remove(saved || zipPath).catch(() => false);
  }
  return folder;
}

let probeCount = 0;

/**
 * The top-level folders a release writes into AddOns, for providers that don't list them before download: downloads
 * it to the sandbox, reads its top-level directories (as WowUp's install does, minus `__MACOSX`), then deletes the
 * sandbox copy.
 */
export async function releaseFolders(
  deps: ReleaseFolderDeps,
  provider: string,
  externalId: string,
  version: string,
  url: string,
  onRetry?: (retry: number, waitMs: number, error: unknown) => void,
): Promise<string[]> {
  probeCount += 1;
  const root = safeName(`folders-${provider}-${externalId}-${version}-${Date.now().toString(36)}-${probeCount}`);
  const folder = resolveScopedPath(agentSandboxPath(deps.applicationFolderPath), root);
  try {
    await downloadToSandbox(deps, provider, root, url, onRetry);
    const dirs = (await deps.fileService.listDirectories(folder)) ?? [];
    return dirs.filter((d) => !IGNORED_FOLDER_NAMES.includes(d));
  } finally {
    await deps.fileService.remove(folder).catch(() => false);
  }
}
