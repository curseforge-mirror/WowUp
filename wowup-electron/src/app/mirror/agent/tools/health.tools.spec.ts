/* eslint-disable */
import { join } from "path";

import { createHealthTools } from "./health.tools";

const FILE = [
  "BugGrabberDB = {",
  '\t["errors"] = {',
  '\t\t{ ["message"] = "old thing", ["counter"] = 1, ["time"] = "2026/11/01 09:00:00", ["session"] = 1, ["stack"] = "x", ["locals"] = "secret" },',
  '\t\t{ ["message"] = "Interface\\\\AddOns\\\\Foo\\\\a.lua:1: bad", ["counter"] = 3, ["time"] = "2026/11/02 09:00:00", ["session"] = 2, ["stack"] = "s", ["locals"] = "Playername" },',
  '\t\t{ ["message"] = "oops", ["counter"] = 2, ["time"] = "2026/11/02 10:00:00", ["session"] = 2, ["stack"] = "[string \\"@Interface/AddOns/Sorted/Data.lua\\"]:12: oops" },',
  "\t},",
  "}",
].join("\n");

describe("health tools", () => {
  const ctx = () => ({ progress: jasmine.createSpy("progress") });
  const inst = (id: string) => ({ id, label: id, displayName: id, clientType: 1 });
  const WTF = join("C:", "wow", "WTF");
  const ACC = join(WTF, "Account", "ACC");
  const BG = join(ACC, "SavedVariables", "!BugGrabber.lua");

  const make = (over: any = {}) => {
    const installs = [inst("i1"), inst("i2")];
    const addon = {
      id: "a1",
      name: "Alpha",
      providerName: "Curse",
      installedVersion: "1.0",
      latestVersion: "1.1",
      releasedAt: new Date("2026-11-01T00:00:00Z"),
    };
    const deps: any = {
      addonService: {
        syncClient: jasmine.createSpy("syncClient").and.resolveTo(),
        syncAllClients: jasmine.createSpy("syncAllClients").and.resolveTo(),
        getAllAddonsAvailableForUpdate: jasmine.createSpy("upd").and.resolveTo([addon]),
        findGameVersionMismatches: jasmine
          .createSpy("mm")
          .and.resolveTo([{ addon, installation: { gameVersion: "x" } }]),
      },
      installService: { getWowInstallationsAsync: async () => installs },
      getSelected: () => undefined,
      wtfService: { getWtfPath: () => WTF },
      fileService: {
        listDirectories: async () => [ACC],
        pathExists: async (p: string) => p === BG,
        readFile: async () => FILE,
      },
      ...over,
    };
    return { deps, tools: createHealthTools(deps) };
  };

  it("check_updates reports one installation", async () => {
    const { deps, tools } = make();
    const c = ctx();
    const out: any = await tools.check_updates({ installation: "i1" }, c);
    expect(deps.addonService.syncClient).toHaveBeenCalledTimes(1);
    expect(deps.addonService.syncAllClients).not.toHaveBeenCalled();
    expect(c.progress).toHaveBeenCalledTimes(1);
    expect(out.installations.length).toBe(1);
    const r = out.installations[0];
    expect(r.updates[0]).toEqual({
      addonId: "a1",
      name: "Alpha",
      provider: "Curse",
      installedVersion: "1.0",
      latestVersion: "1.1",
      releasedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(r.gameVersionMismatches[0].name).toBe("Alpha");
  });

  it("check_updates with all syncs once and covers every installation", async () => {
    const { deps, tools } = make();
    const c = ctx();
    const out: any = await tools.check_updates({ all: true }, c);
    expect(deps.addonService.syncAllClients).toHaveBeenCalledTimes(1);
    expect(deps.addonService.syncClient).not.toHaveBeenCalled();
    expect(out.installations.length).toBe(2);
    expect(c.progress).toHaveBeenCalledTimes(2);
  });

  it("get_addon_errors names the addon folder, newest first, without locals", async () => {
    const { tools } = make();
    const out: any = await tools.get_addon_errors({ installation: "i1" }, ctx());
    expect(out.errors.map((e: any) => e.message)).toEqual([
      "oops",
      "Interface\\AddOns\\Foo\\a.lua:1: bad",
      "old thing",
    ]);
    expect(out.errors[0].addon).toBe("Sorted");
    expect(out.errors[1].addon).toBe("Foo");
    expect(out.errors[2].addon).toBeUndefined();
    expect(JSON.stringify(out)).not.toContain("Playername");
    expect(out.errors[0].counter).toBe(2);
  });

  it("get_addon_errors honours limit and contains", async () => {
    const { tools } = make();
    expect(((await tools.get_addon_errors({ installation: "i1", limit: 1 }, ctx())) as any).errors.length).toBe(1);
    const out: any = await tools.get_addon_errors({ installation: "i1", contains: "SORTED/data" }, ctx());
    expect(out.errors.length).toBe(1);
  });

  it("get_addon_errors reports a missing BugGrabber file", async () => {
    const { tools } = make({
      fileService: { listDirectories: async () => [], pathExists: async () => false, readFile: async () => "" },
    });
    const out: any = await tools.get_addon_errors({ installation: "i1" }, ctx());
    expect(out).toEqual({
      errors: [],
      note: "BugGrabber isn't installed or has no saved errors for this installation",
    });
  });
});
