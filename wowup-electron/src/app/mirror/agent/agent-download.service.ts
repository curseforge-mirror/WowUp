import { Injectable } from "@angular/core";
import { DownloadAuth } from "wowup-lib-core";

import { AGENT_CHANNEL_DOWNLOAD, AgentDownloadRequest } from "../../../common/mirror/agent-contract";
import { ElectronService } from "../../services/electron/electron.service";

/**
 * The agent's release downloads, into its sandbox. Stands in for the renderer DownloadService that WowUp 2.26
 * removed (installs download in main now); main writes nowhere but the sandbox (app/mirror/agent/agent-download.ts).
 */
@Injectable({
  providedIn: "root",
})
export class AgentDownloadService {
  public constructor(private _electronService: ElectronService) {}

  /** Downloads `url` into `outputFolder` under a unique name and resolves with the saved path */
  public downloadZipFile(options: {
    auth?: DownloadAuth;
    fileName: string;
    outputFolder: string;
    url: string;
  }): Promise<string> {
    const request: AgentDownloadRequest = {
      url: options.url,
      fileName: options.fileName,
      outputFolder: options.outputFolder,
      auth: options.auth,
    };
    return this._electronService.invoke<string>(AGENT_CHANNEL_DOWNLOAD, request);
  }
}
