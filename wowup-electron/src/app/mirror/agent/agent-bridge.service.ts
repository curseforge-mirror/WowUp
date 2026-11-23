import { BehaviorSubject, filter, firstValueFrom, Observable } from "rxjs";

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
import { AddonBrokerService } from "../../services/addons/addon-broker.service";
import { AddonProviderFactory } from "../../services/addons/addon.provider.factory";
import { AddonService } from "../../services/addons/addon.service";
import { ElectronService } from "../../services/electron/electron.service";
import { FileService } from "../../services/files/file.service";
import { DownloadService } from "../../services/download/download.service";
import { SessionService } from "../../services/session/session.service";
import { PreferenceStorageService } from "../../services/storage/preference-storage.service";
import { SensitiveStorageService } from "../../services/storage/sensitive-storage.service";
import { WtfService } from "../../services/wtf/wtf.service";
import { WarcraftInstallationService } from "../../services/warcraft/warcraft-installation.service";
import { WarcraftService } from "../../services/warcraft/warcraft.service";
import { WowUpService } from "../../services/wowup/wowup.service";
import { AgentBackupService } from "./agent-backup.service";
import {
  agentSandboxPath,
  newAgentKey,
  PREF_AGENT_ENABLED,
  PREF_AGENT_PORT,
  SENSITIVE_AGENT_KEY,
} from "./agent-settings";
import { AgentToolContext, AgentToolHandler, AgentToolSet } from "./agent-tool";
import { ChangeProvider, createChangeTools } from "./tools/change.tools";
import { createDiscoveryTools, DiscoveryProvider } from "./tools/discovery.tools";
import { createHealthTools } from "./tools/health.tools";
import { createInspectTools, InspectProvider } from "./tools/inspect.tools";
import { createRecoveryTools } from "./tools/recovery.tools";

/**
 * Tools that change addons or WowUp's addon records run one at a time: a change works out what it added by comparing
 * the records before and after it, which only holds when nothing else changes them meanwhile.
 */
const SERIAL_TOOLS = new Set([
  "install_addon",
  "update_addons",
  "remove_addon",
  "replace_addon",
  "switch_provider",
  "set_auto_update",
  "set_ignored",
  "rescan",
  "import_addons",
  "rollback",
  "check_updates",
]);

@Injectable({
  providedIn: "root",
})
export class AgentBridgeService {
  private readonly _tools = new Map<string, AgentToolHandler>();
  private readonly _statusSrc = new BehaviorSubject<AgentStatus>({ listening: false, url: "" });
  private _listening = false;
  /** The serial tools' queue, and how many calls are in it */
  private _serial: Promise<unknown> = Promise.resolve();
  private _serialCount = 0;

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
    private _downloadService: DownloadService,
    private _wtfService: WtfService,
    private _backupService: AgentBackupService,
    private _addonBrokerService: AddonBrokerService,
    private _warcraftService: WarcraftService,
  ) {}

  public registerTools(tools: AgentToolSet): void {
    Object.entries(tools).forEach(([name, handler]) =>
      this._tools.set(name, SERIAL_TOOLS.has(name) ? this.serial(handler) : handler),
    );
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

    this.registerTools(
      createInspectTools({
        applicationFolderPath: this._wowUpService.applicationFolderPath,
        fileService: this._fileService,
        downloadService: this._downloadService,
        addonService: this._addonService,
        installService: this._warcraftInstallationService,
        getSelected: () => this._sessionService.getSelectedWowInstallation(),
        getProvider: (name) => this._addonProviderFactory.getProvider<InspectProvider>(name),
        getSecret: (key) => this._sensitiveStorage.getAsync(key),
      }),
    );

    this.registerTools(
      createHealthTools({
        addonService: this._addonService,
        installService: this._warcraftInstallationService,
        getSelected: () => this._sessionService.getSelectedWowInstallation(),
        wtfService: this._wtfService,
        fileService: this._fileService,
      }),
    );

    this.registerTools(
      createChangeTools({
        applicationFolderPath: this._wowUpService.applicationFolderPath,
        fileService: this._fileService,
        downloadService: this._downloadService,
        addonService: this._addonService,
        brokerService: this._addonBrokerService,
        backupService: this._backupService,
        installService: this._warcraftInstallationService,
        getSelected: () => this._sessionService.getSelectedWowInstallation(),
        getProvider: (name) => this._addonProviderFactory.getProvider<ChangeProvider>(name),
        listAddonFolders: async (installation) => {
          const addonsPath = this._warcraftService.getAddonFolderPath(installation);
          return (await this._fileService.pathExists(addonsPath)) ? this._fileService.readdir(addonsPath) : [];
        },
        encodeBase64: (text) => this._electronService.invoke<string>("base64-encode", text),
        notifyChanged: () => this.reloadMyAddons(),
        getSecret: (key) => this._sensitiveStorage.getAsync(key),
        whenIdle: (ctx) => this.whenSyncIdle(ctx),
      }),
    );

    this.registerTools(createRecoveryTools({ backupService: this._backupService }));

    if (!this._listening) {
      this._listening = true;
      this._electronService.on(AGENT_CHANNEL_CALL, (_evt, req: AgentCallRequest) => {
        void this.handleCall(req);
      });
    }

    try {
      const sandbox = agentSandboxPath(this._wowUpService.applicationFolderPath);
      // A missing sandbox is already clear; deleting it would only log an error
      if (await this._fileService.pathExists(sandbox)) {
        await this._fileService.removeAll(sandbox);
      }
    } catch (e) {
      console.error("Agent sandbox cleanup failed", e);
    }

    // Not awaited: deleting old backups never delays the MCP server starting
    this._backupService.prune().catch((e) => console.error("Agent backup prune failed", e));

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

  /**
   * My Addons reloads its list from storage on this (its only listener). notifyAddonsChanged would make it run a
   * full update check instead, which writes back the records it read when it started, undoing a rollback, removal
   * or pin that lands meanwhile.
   */
  private reloadMyAddons(): void {
    this._sessionService.autoUpdateComplete();
  }

  /** Runs the handler after every serial call queued before it, once WowUp's update check isn't running */
  private serial(handler: AgentToolHandler): AgentToolHandler {
    return (args, ctx) => {
      if (this._serialCount > 0) {
        ctx.progress("Waiting for the agent change before this one to finish");
      }
      this._serialCount += 1;
      const run = this._serial.then(async () => {
        await this.whenSyncIdle(ctx);
        return handler(args, ctx);
      });
      const settle = () => {
        this._serialCount -= 1;
      };
      this._serial = run.then(settle, settle);
      return run;
    };
  }

  /** Resolves once WowUp isn't syncing (checking every installation for updates), whose end rewrites addon records */
  private async whenSyncIdle(ctx: AgentToolContext): Promise<void> {
    const syncing$ = this._addonService.syncing$;
    if (await firstValueFrom(syncing$)) {
      ctx.progress("Waiting for WowUp's update check to finish");
      await firstValueFrom(syncing$.pipe(filter((syncing) => !syncing)));
    }
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
