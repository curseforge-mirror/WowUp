import { BehaviorSubject, Observable } from "rxjs";

import { Injectable } from "@angular/core";

import {
  AGENT_CHANNEL_CALL,
  AGENT_CHANNEL_CONFIGURE,
  AGENT_CHANNEL_PROGRESS,
  AGENT_CHANNEL_RESULT,
  AGENT_DEFAULT_PORT,
  AgentCallRequest,
  AgentCallResponse,
  AgentConfig,
  AgentProgress,
  AgentStatus,
  AgentToolResult,
} from "../../../common/mirror/agent-contract";
import { AddonProviderFactory } from "../../services/addons/addon.provider.factory";
import { AddonService } from "../../services/addons/addon.service";
import { ElectronService } from "../../services/electron/electron.service";
import { FileService } from "../../services/files/file.service";
import { SessionService } from "../../services/session/session.service";
import { PreferenceStorageService } from "../../services/storage/preference-storage.service";
import { SensitiveStorageService } from "../../services/storage/sensitive-storage.service";
import { WarcraftInstallationService } from "../../services/warcraft/warcraft-installation.service";
import { WowUpService } from "../../services/wowup/wowup.service";
import {
  agentSandboxPath,
  newAgentKey,
  PREF_AGENT_ENABLED,
  PREF_AGENT_PORT,
  SENSITIVE_AGENT_KEY,
} from "./agent-settings";
import { AgentToolHandler, AgentToolSet } from "./agent-tool";
import { createDiscoveryTools, DiscoveryProvider } from "./tools/discovery.tools";

@Injectable({
  providedIn: "root",
})
export class AgentBridgeService {
  private readonly _tools = new Map<string, AgentToolHandler>();
  private readonly _statusSrc = new BehaviorSubject<AgentStatus>({ listening: false, url: "" });
  private _listening = false;

  public readonly status$: Observable<AgentStatus> = this._statusSrc.asObservable();

  public constructor(
    private _electronService: ElectronService,
    private _preferenceStorage: PreferenceStorageService,
    private _sensitiveStorage: SensitiveStorageService,
    private _fileService: FileService,
    private _wowUpService: WowUpService,
    private _addonService: AddonService,
    private _addonProviderFactory: AddonProviderFactory,
    private _warcraftInstallationService: WarcraftInstallationService,
    private _sessionService: SessionService,
  ) {}

  public registerTools(tools: AgentToolSet): void {
    Object.entries(tools).forEach(([name, handler]) => this._tools.set(name, handler));
  }

  public async initialize(): Promise<void> {
    this.registerTools(
      createDiscoveryTools({
        addonService: this._addonService,
        installService: this._warcraftInstallationService,
        getSelected: () => this._sessionService.getSelectedWowInstallation(),
        getProvider: (name) => this._addonProviderFactory.getProvider<DiscoveryProvider>(name),
        getSecret: (key) => this._sensitiveStorage.getAsync(key),
      }),
    );

    if (!this._listening) {
      this._listening = true;
      this._electronService.on(AGENT_CHANNEL_CALL, (_evt, req: AgentCallRequest) => {
        void this.handleCall(req);
      });
    }

    try {
      await this._fileService.removeAll(agentSandboxPath(this._wowUpService.applicationFolderPath));
    } catch (e) {
      console.error("Agent sandbox cleanup failed", e);
    }

    try {
      await this.configure(await this.getConfig());
    } catch (e) {
      console.error("Agent configure failed", e);
    }
  }

  public async getConfig(): Promise<AgentConfig> {
    const enabled = await this._preferenceStorage.getBool(PREF_AGENT_ENABLED);
    const port = Number(await this._preferenceStorage.getAsync(PREF_AGENT_PORT));
    let key = await this._sensitiveStorage.getAsync(SENSITIVE_AGENT_KEY);
    if (enabled && !key) {
      key = newAgentKey();
      await this._sensitiveStorage.setAsync(SENSITIVE_AGENT_KEY, key);
    }
    return { enabled, port: Number.isInteger(port) && port > 0 ? port : AGENT_DEFAULT_PORT, key: key ?? "" };
  }

  public async setEnabled(enabled: boolean): Promise<AgentStatus> {
    await this._preferenceStorage.setAsync(PREF_AGENT_ENABLED, enabled ? "true" : "false");
    return this.configure(await this.getConfig());
  }

  public async setPort(port: number): Promise<AgentStatus> {
    await this._preferenceStorage.setAsync(PREF_AGENT_PORT, port.toString());
    return this.configure(await this.getConfig());
  }

  public async regenerateKey(): Promise<AgentStatus> {
    await this._sensitiveStorage.setAsync(SENSITIVE_AGENT_KEY, newAgentKey());
    return this.configure(await this.getConfig());
  }

  private async configure(config: AgentConfig): Promise<AgentStatus> {
    const status = await this._electronService.invoke<AgentStatus>(AGENT_CHANNEL_CONFIGURE, config);
    this._statusSrc.next(status);
    return status;
  }

  private async handleCall(req: AgentCallRequest): Promise<void> {
    const result = await this.runTool(req);
    const response: AgentCallResponse = { callId: req.callId, result };
    this._electronService.send(AGENT_CHANNEL_RESULT, response);
  }

  private async runTool(req: AgentCallRequest): Promise<AgentToolResult> {
    const handler = this._tools.get(req.name);
    if (!handler) {
      return { isError: true, text: `Unknown tool: ${req.name}` };
    }
    try {
      const value = await handler(req.args ?? {}, {
        progress: (message: string) => {
          const progress: AgentProgress = { callId: req.callId, message };
          this._electronService.send(AGENT_CHANNEL_PROGRESS, progress);
        },
      });
      return { text: JSON.stringify(value, null, 2) ?? "null" };
    } catch (e) {
      return { isError: true, text: e instanceof Error ? e.message : String(e) };
    }
  }
}
