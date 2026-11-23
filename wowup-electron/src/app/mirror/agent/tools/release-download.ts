import { isAbsolute, join, relative, resolve, sep } from "path";
import { DownloadAuth } from "wowup-lib-core";

import { agentSandboxPath } from "../agent-settings";
import { canonicalProvider } from "./discovery.tools";

/** Folders WowUp's install skips when it copies a release into AddOns */
const IGNORED_FOLDER_NAMES = ["__MACOSX"];

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
 * there). Returns the unzipped folder's path. Only the sandbox is written to.
 */
export async function downloadToSandbox(
  deps: ReleaseDownloadDeps,
  provider: string,
  root: string,
  url: string,
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
): Promise<string[]> {
  probeCount += 1;
  const root = safeName(`folders-${provider}-${externalId}-${version}-${Date.now().toString(36)}-${probeCount}`);
  const folder = resolveScopedPath(agentSandboxPath(deps.applicationFolderPath), root);
  try {
    await downloadToSandbox(deps, provider, root, url);
    const dirs = (await deps.fileService.listDirectories(folder)) ?? [];
    return dirs.filter((d) => !IGNORED_FOLDER_NAMES.includes(d));
  } finally {
    await deps.fileService.remove(folder).catch(() => false);
  }
}
