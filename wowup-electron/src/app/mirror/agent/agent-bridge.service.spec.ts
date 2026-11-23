/* eslint-disable */
import { TestBed } from "@angular/core/testing";

import {
  AGENT_CHANNEL_CALL,
  AGENT_CHANNEL_CONFIGURE,
  AGENT_CHANNEL_PROGRESS,
  AGENT_CHANNEL_RESULT,
} from "../../../common/mirror/agent-contract";
import { ElectronService } from "../../services/electron/electron.service";
import { FileService } from "../../services/files/file.service";
import { PreferenceStorageService } from "../../services/storage/preference-storage.service";
import { SensitiveStorageService } from "../../services/storage/sensitive-storage.service";
import { WowUpService } from "../../services/wowup/wowup.service";
import { AgentBridgeService } from "./agent-bridge.service";

describe("AgentBridgeService", () => {
  let service: AgentBridgeService;
  let electron: jasmine.SpyObj<ElectronService>;
  let listener: (evt: unknown, req: unknown) => void;
  let prefs: Record<string, string>;
  let secrets: Record<string, string>;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    listener({}, { callId: "c1", name, args });
    await new Promise((r) => setTimeout(r, 0));
  };
  const sent = (channel: string): any[][] => electron.send.calls.allArgs().filter((a) => a[0] === channel);

  beforeEach(async () => {
    prefs = {};
    secrets = {};
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
        { provide: FileService, useValue: jasmine.createSpyObj("FileService", { removeAll: Promise.resolve(true) }) },
        { provide: WowUpService, useValue: { applicationFolderPath: "C:\\data" } },
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

  it("initialize configures main even when disabled, and enabling generates a key", async () => {
    expect(electron.invoke).toHaveBeenCalledWith(AGENT_CHANNEL_CONFIGURE, jasmine.objectContaining({ enabled: false }));
    expect(electron.on).toHaveBeenCalledWith(AGENT_CHANNEL_CALL, jasmine.any(Function));
    await service.setEnabled(true);
    expect(secrets["mirror_agent_key"].length).toBeGreaterThan(30);
    const last = electron.invoke.calls.mostRecent().args[1];
    expect(last.enabled).toBeTrue();
    expect(last.port).toBe(17483);
  });
});
