import * as path from "path";

import { AgentDownloadRequest } from "../../../src/common/mirror/agent-contract";
import { DownloadFileDeps, downloadFile } from "../../services/download/file-download";

/** Whether `folder` is the sandbox itself or lies inside it, compared lexically */
export function isInsideFolder(root: string, folder: string): boolean {
  const back = path.relative(path.resolve(root), path.resolve(folder));
  return back === "" || (back !== ".." && !back.startsWith(".." + path.sep) && !path.isAbsolute(back));
}

/**
 * The agent's release downloads (inspect_addon, install previews, folder lookups). WowUp 2.26 dropped the renderer's
 * download channel and downloads only inside its own installs, so the agent gets this one, which writes nowhere but
 * the agent sandbox and fetches nothing but http(s). Resolves with the saved path, as the old channel did.
 */
export function downloadToSandbox(
  sandboxPath: string,
  request: AgentDownloadRequest,
  deps: DownloadFileDeps,
): Promise<string> {
  if (!isInsideFolder(sandboxPath, request.outputFolder)) {
    return Promise.reject(new Error(`Agent downloads go to the agent sandbox, not ${request.outputFolder}`));
  }
  if (!request.fileName || path.basename(request.fileName) !== request.fileName) {
    return Promise.reject(new Error(`Not a file name: ${request.fileName}`));
  }

  let protocol: string;
  try {
    protocol = new URL(request.url).protocol;
  } catch {
    return Promise.reject(new Error(`Not a url: ${request.url}`));
  }
  if (protocol !== "https:" && protocol !== "http:") {
    return Promise.reject(new Error(`Agent downloads are http(s) only, not ${protocol}`));
  }

  return downloadFile(
    { url: request.url, fileName: request.fileName, outputFolder: request.outputFolder, auth: request.auth },
    deps,
  );
}
