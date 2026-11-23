/* eslint-disable */
import { BehaviorSubject } from "rxjs";

import { TestBed } from "@angular/core/testing";

import {
  AGENT_CHANNEL_CALL,
  AGENT_CHANNEL_CONFIGURE,
  AGENT_CHANNEL_PROGRESS,
  AGENT_CHANNEL_RESULT,
} from "../../../common/mirror/agent-contract";
import { ElectronService } from "../../services/electron/electron.service";
import { FileService } from "../../services/files/file.service";
import { DownloadService } from "../../services/download/download.service";
import { PreferenceStorageService } from "../../services/storage/preference-storage.service";
import { SensitiveStorageService } from "../../services/storage/sensitive-storage.service";
import { WowUpService } from "../../services/wowup/wowup.service";
import { WtfService } from "../../services/wtf/wtf.service";
import { AddonBrokerService } from "../../services/addons/addon-broker.service";
import { AddonProviderFactory } from "../../services/addons/addon.provider.factory";
import { AddonService } from "../../services/addons/addon.service";
import { SessionService } from "../../services/session/session.service";
import { WarcraftInstallationService } from "../../services/warcraft/warcraft-installation.service";
import { WarcraftService } from "../../services/warcraft/warcraft.service";
import { AgentBackupService } from "./agent-backup.service";
import { AgentBridgeService } from "./agent-bridge.service";

describe("AgentBridgeService", () => {
  let service: AgentBridgeService;
  let electron: jasmine.SpyObj<ElectronService>;
  let listener: (evt: unknown, req: unknown) => void;
  let prefs: Record<string, string>;
  let secrets: Record<string, string>;
  let files: jasmine.SpyObj<FileService>;
  let backups: {
    prune: jasmine.Spy;
    list: jasmine.Spy;
    rollback: jasmine.Spy;
    create: jasmine.Spy;
    recordAdded: jasmine.Spy;
  };
  let syncing: BehaviorSubject<boolean>;
  let session: {
    getSelectedWowInstallation: jasmine.Spy;
    notifyAddonsChanged: jasmine.Spy;
    autoUpdateComplete: jasmine.Spy;
  };
  let addonService: any;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    listener({}, { callId: "c1", name, args });
    await new Promise((r) => setTimeout(r, 0));
  };
  const sent = (channel: string): any[][] => electron.send.calls.allArgs().filter((a) => a[0] === channel);

  beforeEach(async () => {
    prefs = {};
    secrets = {};
    backups = {
      prune: jasmine.createSpy("prune").and.resolveTo(0),
      list: jasmine.createSpy("list").and.resolveTo([]),
      rollback: jasmine.createSpy("rollback"),
      create: jasmine.createSpy("create").and.resolveTo({ id: "b1" }),
      recordAdded: jasmine.createSpy("recordAdded").and.resolveTo(undefined),
    };
    syncing = new BehaviorSubject<boolean>(false);
    session = {
      getSelectedWowInstallation: jasmine.createSpy("getSelectedWowInstallation").and.returnValue(undefined),
      notifyAddonsChanged: jasmine.createSpy("notifyAddonsChanged"),
      autoUpdateComplete: jasmine.createSpy("autoUpdateComplete"),
    };
    addonService = { syncing$: syncing.asObservable() };
    files = jasmine.createSpyObj("FileService", {
      removeAll: Promise.resolve(true),
      pathExists: Promise.resolve(true),
    });
    electron = jasmine.createSpyObj<ElectronService>("ElectronService", ["invoke", "on", "send", "off"]);
    electron.invoke.and.resolveTo({ listening: true, url: "http://127.0.0.1:17483/mcp" });
    electron.on.and.callFake(((_c: string, l: any) => {
      listener = l;
    }) as any);
    const prefSpy = {
      getBool: async (k: string) => prefs[k] === "true",
      getAsync: async (k: string) => prefs[k],
      setAsync: async (k: string, v: string) => {
        prefs[k] = v;
      },
    };
    const secretSpy = {
      getAsync: async (k: string) => secrets[k],
      setAsync: async (k: string, v: string) => {
        secrets[k] = v;
      },
    };
    TestBed.configureTestingModule({
      providers: [
        { provide: ElectronService, useValue: electron },
        { provide: PreferenceStorageService, useValue: prefSpy },
        { provide: SensitiveStorageService, useValue: secretSpy },
        { provide: FileService, useValue: files },
        { provide: WowUpService, useValue: { applicationFolderPath: "C:\\data" } },
        { provide: AddonService, useValue: addonService },
        { provide: AddonProviderFactory, useValue: {} },
        { provide: WarcraftInstallationService, useValue: {} },
        { provide: SessionService, useValue: session },
        { provide: DownloadService, useValue: {} },
        { provide: WtfService, useValue: {} },
        { provide: AgentBackupService, useValue: backups },
        { provide: AddonBrokerService, useValue: {} },
        { provide: WarcraftService, useValue: {} },
      ],
    });
    service = TestBed.inject(AgentBridgeService);
    await service.initialize();
  });

  it("bridge runs a registered tool and returns its JSON", async () => {
    service.registerTools({ echo: async (args) => ({ got: args.x }) });
    await call("echo", { x: 1 });
    const res = sent(AGENT_CHANNEL_RESULT)[0][1];
    expect(res.callId).toBe("c1");
    expect(res.result.isError).toBeUndefined();
    expect(JSON.parse(res.result.text)).toEqual({ got: 1 });
  });

  it("bridge turns a thrown error into isError", async () => {
    service.registerTools({
      boom: async () => {
        throw new Error("kaput");
      },
    });
    await call("boom");
    expect(sent(AGENT_CHANNEL_RESULT)[0][1].result).toEqual({ isError: true, text: "kaput" });
  });

  it("bridge reports an unknown tool", async () => {
    await call("nope");
    const res = sent(AGENT_CHANNEL_RESULT)[0][1];
    expect(res.result.isError).toBeTrue();
    expect(res.result.text).toContain("Unknown tool: nope");
  });

  it("bridge forwards progress", async () => {
    service.registerTools({
      slow: async (_a, ctx) => {
        ctx.progress("halfway");
        return 1;
      },
    });
    await call("slow");
    expect(sent(AGENT_CHANNEL_PROGRESS)[0][1]).toEqual({ callId: "c1", message: "halfway" });
  });

  it("initialize clears an existing sandbox", () => {
    expect(files.removeAll).toHaveBeenCalledTimes(1);
  });

  it("initialize leaves a missing sandbox alone and logs nothing", async () => {
    files.pathExists.and.resolveTo(false);
    files.removeAll.calls.reset();
    const errorSpy = spyOn(console, "error");
    await service.initialize();
    expect(files.removeAll).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("initialize prunes backups without waiting for it and survives a failed prune", async () => {
    expect(backups.prune).toHaveBeenCalledTimes(1);

    // a prune that never finishes doesn't hold up configuring main
    backups.prune.and.returnValue(new Promise(() => undefined));
    electron.invoke.calls.reset();
    await expectAsync(service.initialize()).toBeResolved();
    expect(electron.invoke).toHaveBeenCalledWith(AGENT_CHANNEL_CONFIGURE, jasmine.anything());

    backups.prune.and.rejectWith(new Error("disk gone"));
    await expectAsync(service.initialize()).toBeResolved();
    await new Promise((r) => setTimeout(r, 0));
    expect(backups.prune).toHaveBeenCalledTimes(3);
    await call("list_backups");
    expect(JSON.parse(sent(AGENT_CHANNEL_RESULT)[0][1].result.text)).toEqual({ backups: [] });
  });

  it("initialize configures main even when disabled, and enabling generates a key", async () => {
    expect(electron.invoke).toHaveBeenCalledWith(AGENT_CHANNEL_CONFIGURE, jasmine.objectContaining({ enabled: false }));
    expect(electron.on).toHaveBeenCalledWith(AGENT_CHANNEL_CALL, jasmine.any(Function));
    await service.setEnabled(true);
    expect(secrets["mirror_agent_key"].length).toBeGreaterThan(30);
    const last = electron.invoke.calls.mostRecent().args[1];
    expect(last.enabled).toBeTrue();
    expect(last.port).toBe(17483);
  });

  /** Starts a tool call with its own callId and returns a promise for its result */
  const start = (callId: string, name: string, args: Record<string, unknown> = {}) => {
    listener({}, { callId, name, args });
    return new Promise<any>((resolve) => {
      const check = () => {
        const hit = sent(AGENT_CHANNEL_RESULT).find((a) => a[1].callId === callId);
        if (hit) {
          resolve(hit[1].result);
        } else {
          setTimeout(check, 0);
        }
      };
      check();
    });
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const gate = () => {
    let open!: () => void;
    const opened = new Promise<void>((r) => (open = r));
    return { open, opened };
  };

  it("change tools, rollback and check_updates run one at a time", async () => {
    const log: string[] = [];
    const first = gate();
    service.registerTools({
      install_addon: async () => {
        log.push("install start");
        await first.opened;
        log.push("install end");
        return "installed";
      },
      rollback: async () => {
        log.push("rollback");
        return "rolled back";
      },
      check_updates: async () => {
        log.push("check");
        return "checked";
      },
    });
    const a = start("a", "install_addon");
    const b = start("b", "rollback");
    const c = start("c", "check_updates");
    await tick();
    await tick();
    expect(log).toEqual(["install start"]);
    first.open();
    await Promise.all([a, b, c]);
    expect(log).toEqual(["install start", "install end", "rollback", "check"]);

    // a failed change doesn't block the next one
    service.registerTools({
      remove_addon: async () => {
        throw new Error("nope");
      },
    });
    expect((await start("d", "remove_addon")).isError).toBeTrue();
    expect(JSON.parse((await start("e", "rollback")).text)).toBe("rolled back");
  });

  it("read tools don't wait for a running change", async () => {
    const running = gate();
    service.registerTools({
      update_addons: async () => {
        await running.opened;
        return "updated";
      },
      list_addons: async () => "listed",
    });
    const change = start("a", "update_addons");
    expect(JSON.parse((await start("b", "list_addons")).text)).toBe("listed");
    running.open();
    await change;
  });

  it("a change waits until WowUp's update check (sync) is done", async () => {
    syncing.next(true);
    const ran = jasmine.createSpy("set_ignored").and.resolveTo("ok");
    service.registerTools({ set_ignored: ran });
    const call = start("a", "set_ignored");
    await tick();
    await tick();
    expect(ran).not.toHaveBeenCalled();
    expect(sent(AGENT_CHANNEL_PROGRESS).map((a) => a[1].message)).toContain(
      jasmine.stringMatching(/Waiting for WowUp's update check/),
    );
    syncing.next(false);
    await call;
    expect(ran).toHaveBeenCalledTimes(1);
  });

  it("after a change My Addons reloads its list from storage instead of starting a sync", async () => {
    const inst = { id: "i1", label: "Retail", displayName: "Retail", clientType: 1, location: "C:wowWow.exe" };
    const record = { id: "a1", name: "Alpha", installationId: "i1", isIgnored: false, autoUpdateEnabled: true };
    addonService.getAllAddons = async () => [{ ...record }];
    addonService.saveAddon = jasmine.createSpy("saveAddon").and.resolveTo(undefined);
    (TestBed.inject(WarcraftInstallationService) as any).getWowInstallationsAsync = async () => [inst];
    (TestBed.inject(WarcraftInstallationService) as any).getInstallationDisplayName = async (i: any) => i.displayName;
    const result = await start("a", "set_ignored", { addonId: "a1", ignored: true });
    expect(result.isError).toBeUndefined();
    expect(addonService.saveAddon).toHaveBeenCalled();
    expect(session.autoUpdateComplete).toHaveBeenCalled();
    expect(session.notifyAddonsChanged).not.toHaveBeenCalled();
  });
});
