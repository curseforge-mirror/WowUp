/* eslint-disable */
import { join } from "path";
import { of, Subject } from "rxjs";
import { AddonChannelType, WowClientType } from "wowup-lib-core";

import { AddonInstallState } from "../../../models/wowup/addon-install-state";
import { createChangeTools } from "./change.tools";

describe("change tools", () => {
  const INSTALL: any = {
    id: "i1",
    label: "Classic",
    displayName: "Classic",
    clientType: WowClientType.ClassicEra,
    defaultAddonChannelType: AddonChannelType.Stable,
    defaultAutoUpdate: false,
    location: "C:\\wow\\Wow.exe",
  };

  const rec = (over: any): any => ({
    id: "a1",
    name: "Alpha",
    providerName: "Curse",
    externalId: "1",
    installedVersion: "1.0",
    latestVersion: "1.0",
    installedFolderList: ["Alpha"],
    isIgnored: false,
    autoUpdateEnabled: true,
    installationId: "i1",
    externalIds: [],
    ...over,
  });

  const file = (over: any): any => ({
    externalId: "f2",
    version: "26.11.11",
    folders: ["TipTac", "TipTacOptions"],
    channelType: AddonChannelType.Stable,
    releaseDate: new Date("2026-11-11T00:00:00Z"),
    downloadUrl: "https://example.test/f2.zip",
    gameVersion: "1.15.0",
    ...over,
  });

  const searchResult = (over: any = {}): any => ({
    name: "TipTac Reborn",
    providerName: "Curse",
    externalId: "12345",
    files: [file({})],
    ...over,
  });

  /** Alpha's release r2 (2.0), listing its folders */
  const alphaRelease = (folders = ["Alpha"]): any =>
    searchResult({
      name: "Alpha",
      externalId: "1",
      files: [file({ externalId: "r2", version: "2.0", folders, downloadUrl: "https://example.test/r2.zip" })],
    });

  const make = (
    opts: {
      records?: any[];
      disk?: string[];
      result?: any;
      results?: Record<string, any>;
      /** download url → the top-level directories its zip unpacks to */
      zips?: Record<string, string[]>;
      mismatched?: string[];
    } = {},
  ) => {
    let records: any[] = (opts.records ?? []).map((r) => ({ ...r }));
    const zips = opts.zips ?? {};
    const log: string[] = [];
    let newIds = 0;
    const upsert = (a: any) => {
      records = [...records.filter((r) => r.id !== a.id), { ...a }];
    };
    const resultFor = (externalId: string) => opts.results?.[externalId] ?? opts.result ?? searchResult();

    const addonService = {
      getAllAddons: jasmine.createSpy("getAllAddons").and.callFake(async () => records.map((r) => ({ ...r }))),
      getAddons: jasmine.createSpy("getAddons").and.callFake(async () => records.map((r) => ({ ...r }))),
      getAddon: jasmine
        .createSpy("getAddon")
        .and.callFake((externalId: string, providerName: string, installation: any, targetFile?: any) => {
          const r = resultFor(externalId);
          const f = targetFile ?? r.files[0];
          newIds += 1;
          return of({
            id: `new${newIds}`,
            name: r.name,
            providerName,
            externalId,
            latestVersion: f.version,
            externalLatestReleaseId: f.externalId,
            downloadUrl: f.downloadUrl,
            installationId: installation.id,
            installedFolderList: [],
            isIgnored: false,
            autoUpdateEnabled: true,
            __folders: f.folders,
          });
        }),
      saveAddon: jasmine.createSpy("saveAddon").and.callFake(async (a: any) => {
        log.push(`save:${a.id}`);
        upsert(a);
      }),
      installAddon: jasmine.createSpy("installAddon").and.callFake(async (a: any, onUpdate?: any) => {
        log.push(`install:${a.id}`);
        onUpdate?.(AddonInstallState.Downloading, 25);
        a.installedVersion = a.latestVersion;
        a.installedFolderList = a.__folders?.length ? a.__folders : zips[a.downloadUrl];
        a.isIgnored = false;
        upsert(a);
        onUpdate?.(AddonInstallState.Complete, 100);
      }),
      updateAddon: jasmine.createSpy("updateAddon").and.callFake(async (a: any) => {
        log.push(`update:${a.id}`);
        a.installedVersion = a.latestVersion;
        upsert(a);
      }),
      removeAddon: jasmine.createSpy("removeAddon").and.callFake(async (a: any) => {
        log.push(`remove:${a.id}`);
        records = records.filter((r) => r.id !== a.id);
      }),
      setProvider: jasmine
        .createSpy("setProvider")
        .and.callFake(async (a: any, externalId: string, provider: string) => {
          log.push(`setProvider:${a.id}`);
          records = records.filter((r) => r.id !== a.id);
          upsert({ ...a, id: "switched", providerName: provider, externalId });
        }),
      rescanInstallation: jasmine.createSpy("rescanInstallation").and.callFake(async () => {
        log.push("rescan");
        records = records.map((r) => ({ ...r, id: `${r.id}-scanned` }));
        return records.map((r) => ({ ...r }));
      }),
      findGameVersionMismatches: jasmine
        .createSpy("findGameVersionMismatches")
        .and.callFake(async (addons: any[]) =>
          addons
            .filter((a) => (opts.mismatched ?? []).includes(a.id))
            .map((addon) => ({ addon, installation: { ...INSTALL, gameVersion: "1.15.0" } })),
        ),
    };
    const zipOf: Record<string, string> = {};
    const unzipped: Record<string, string[]> = {};
    const downloadService = {
      downloadZipFile: jasmine.createSpy("downloadZipFile").and.callFake(async (o: any) => {
        if (!(o.url in zips)) {
          throw new Error(`unexpected download ${o.url}`);
        }
        const zip = `${o.outputFolder}/${o.fileName}`;
        zipOf[zip] = o.url;
        return zip;
      }),
    };
    const fileService = {
      createDirectory: jasmine.createSpy("createDirectory").and.resolveTo(true),
      pathExists: jasmine.createSpy("pathExists").and.resolveTo(false),
      remove: jasmine.createSpy("remove").and.callFake(async (p: string) => {
        log.push(`sandbox-remove:${p}`);
        delete unzipped[p];
        return true;
      }),
      unzipFile: jasmine.createSpy("unzipFile").and.callFake(async (zip: string, out: string) => {
        unzipped[out] = zips[zipOf[zip]];
        return out;
      }),
      listDirectories: jasmine.createSpy("listDirectories").and.callFake(async (p: string) => unzipped[p] ?? []),
    };
    const backupService = {
      create: jasmine.createSpy("create").and.callFake(async () => {
        log.push("backup");
        return { id: "b1" };
      }),
      recordAdded: jasmine.createSpy("recordAdded").and.callFake(async () => {
        log.push("recordAdded");
      }),
    };
    const brokerService = {
      addonInstall$: new Subject<any>(),
      getExportPayload: jasmine
        .createSpy("getExportPayload")
        .and.resolveTo({ client_type: "ClassicEra", addons: [{ id: "1", name: "Alpha", provider_name: "Curse" }] }),
      parseImportString: jasmine.createSpy("parseImportString").and.callFake(async (text: string) => JSON.parse(text)),
      getImportSummary: jasmine.createSpy("getImportSummary").and.callFake(async (payload: any) => ({
        addedCt: payload.addons.length,
        noChangeCt: 0,
        conflictCt: 0,
        comparisons: payload.addons.map((a: any, i: number) => ({ id: `c${i}`, imported: a, state: "added" })),
      })),
      installImportSummary: jasmine.createSpy("installImportSummary").and.resolveTo(undefined),
    };
    const provider = {
      getById: jasmine.createSpy("getById").and.callFake(async (externalId: string) => resultFor(externalId)),
      getDownloadAuth: async () => undefined,
    };
    const deps = {
      applicationFolderPath: "C:/data",
      fileService,
      downloadService,
      addonService,
      brokerService,
      backupService,
      installService: { getWowInstallationsAsync: async () => [INSTALL] },
      getSelected: () => undefined,
      getProvider: () => provider,
      listAddonFolders: async () => opts.disk ?? [],
      encodeBase64: async (text: string) => `b64(${text})`,
      getSecret: async () => undefined,
    };
    const ctx = { progress: jasmine.createSpy("progress") };
    return {
      tools: createChangeTools(deps as any),
      addonService,
      backupService,
      brokerService,
      provider,
      fileService,
      downloadService,
      ctx,
      log,
      records: () => records,
      sandboxLeft: () => Object.keys(unzipped),
    };
  };

  const mutators = (m: ReturnType<typeof make>) => [
    m.backupService.create,
    m.backupService.recordAdded,
    m.addonService.saveAddon,
    m.addonService.installAddon,
    m.addonService.updateAddon,
    m.addonService.removeAddon,
    m.addonService.setProvider,
    m.addonService.rescanInstallation,
    m.brokerService.installImportSummary,
  ];

  it("registers the ten change tools", () => {
    expect(Object.keys(make().tools).sort()).toEqual(
      [
        "export_addons",
        "import_addons",
        "install_addon",
        "remove_addon",
        "replace_addon",
        "rescan",
        "set_auto_update",
        "set_ignored",
        "switch_provider",
        "update_addons",
      ].sort(),
    );
  });

  it("preview changes nothing", async () => {
    const m = make({
      records: [
        rec({ id: "u1", name: "TipTac", providerName: "Unknown", externalId: "", installedFolderList: ["TipTac"] }),
        rec({
          id: "a1",
          name: "Alpha",
          latestVersion: "2.0",
          externalLatestReleaseId: "r2",
          externalIds: [{ providerName: "Wago", id: "w1" }],
        }),
      ],
      disk: ["TipTac", "Alpha"],
      results: { "1": alphaRelease() },
    });

    const preview: any = await m.tools.install_addon({ provider: "curse", externalId: "12345", preview: true }, m.ctx);
    expect(preview.action).toContain("install_addon");
    expect(preview.installation).toBe("Classic");
    expect(preview.add).toEqual([
      {
        name: "TipTac Reborn",
        provider: "Curse",
        externalId: "12345",
        version: "26.11.11",
        folders: ["TipTac", "TipTacOptions"],
      },
    ]);
    expect(preview.remove.map((l: any) => l.name)).toEqual(["TipTac"]);
    expect(preview.foldersReplaced).toEqual(["TipTac"]);
    // overwrites TipTac (on disk, and the Unknown record's), adds TipTacOptions
    expect(preview.settingsCarryOver).toBe("partial");

    const json = JSON.stringify({
      client_type: "ClassicEra",
      addons: [{ id: "12345", name: "TipTac", provider_name: "Curse" }],
    });
    await m.tools.update_addons({ all: true, preview: true }, m.ctx);
    await m.tools.remove_addon({ addonId: "a1", preview: true }, m.ctx);
    await m.tools.replace_addon({ addonId: "a1", provider: "Curse", externalId: "12345", preview: true }, m.ctx);
    await m.tools.switch_provider({ addonId: "a1", provider: "Wago", preview: true }, m.ctx);
    await m.tools.set_auto_update({ addonId: "a1", enabled: false, preview: true }, m.ctx);
    await m.tools.set_ignored({ addonId: "a1", ignored: true, preview: true }, m.ctx);
    await m.tools.rescan({ preview: true }, m.ctx);
    const imported: any = await m.tools.import_addons({ text: json, preview: true }, m.ctx);
    expect(imported.add.map((l: any) => l.externalId)).toEqual(["12345"]);

    mutators(m).forEach((spy) => expect(spy).not.toHaveBeenCalled());
    expect(m.addonService.getAddon).not.toHaveBeenCalled();
  });

  it("install_addon backs up then installs", async () => {
    const unknown = rec({
      id: "u1",
      name: "TipTac",
      providerName: "Unknown",
      externalId: "",
      installedFolderList: ["TipTac"],
    });
    const m = make({ records: [unknown, rec({ id: "r2", name: "Other", installedFolderList: ["Other"] })] });

    const out: any = await m.tools.install_addon({ provider: "Curse", externalId: "12345" }, m.ctx);

    expect(m.backupService.create).toHaveBeenCalledOnceWith(
      "install_addon",
      INSTALL,
      [jasmine.objectContaining({ id: "u1" })],
      ["TipTac", "TipTacOptions"],
      "install_addon Curse 12345 TipTac Reborn v26.11.11",
    );
    expect(m.log.indexOf("backup")).toBeLessThan(m.log.indexOf("install:new1"));
    const [, , , targetFile] = m.addonService.getAddon.calls.mostRecent().args;
    expect(targetFile.version).toBe("26.11.11");
    expect(m.backupService.recordAdded).toHaveBeenCalledOnceWith("b1", [jasmine.objectContaining({ id: "new1" })]);
    expect(m.ctx.progress).toHaveBeenCalledWith("Downloading TipTac Reborn 25%");
    expect(out).toEqual({
      backupId: "b1",
      changed: [
        {
          change: "added",
          addonId: "new1",
          name: "TipTac Reborn",
          provider: "Curse",
          externalId: "12345",
          version: "26.11.11",
        },
      ],
    });
  });

  it("install_addon with a version pins it", async () => {
    const result = searchResult({
      providerName: "Wago",
      externalId: "w9",
      files: [
        file({ externalId: "f2", version: "26.11.11" }),
        file({ externalId: "f1", version: "26.10.01", releaseDate: new Date("2026-10-01T00:00:00Z") }),
      ],
    });
    const m = make({ result });

    const out: any = await m.tools.install_addon({ provider: "Wago", externalId: "w9", version: "26.10.01" }, m.ctx);

    const [, , , targetFile] = m.addonService.getAddon.calls.mostRecent().args;
    expect(targetFile.externalId).toBe("f1");
    expect(targetFile.version).toBe("26.10.01");
    const saved = m.records().find((r) => r.id === "new1");
    expect(saved.isIgnored).toBeTrue();
    expect(m.log.indexOf("install:new1")).toBeLessThan(m.log.lastIndexOf("save:new1"));
    expect(out.changed[0].version).toBe("26.10.01");

    // a fileId picks the same file
    const again = make({ result });
    await again.tools.install_addon({ provider: "Wago", externalId: "w9", version: "f1" }, again.ctx);
    expect(again.addonService.getAddon.calls.mostRecent().args[3].externalId).toBe("f1");

    await expectAsync(
      make({ result }).tools.install_addon({ provider: "Wago", externalId: "w9", version: "9.9" }, m.ctx),
    ).toBeRejectedWithError(/9\.9.*26\.11\.11/);
  });

  it("install_addon refuses an already-installed addon", async () => {
    const m = make({ records: [rec({ id: "t1", name: "TipTac Reborn", externalId: "12345" })] });
    await expectAsync(m.tools.install_addon({ provider: "curse", externalId: "12345" }, m.ctx)).toBeRejectedWithError(
      /already installed.*t1.*update_addons.*replace_addon/,
    );
    mutators(m).forEach((spy) => expect(spy).not.toHaveBeenCalled());
  });

  it("replace preview flags folder changes", async () => {
    const old = rec({ id: "a1", name: "A", installedFolderList: ["A", "A_Options"] });
    const preview = async (folders: string[]) => {
      const m = make({
        records: [old],
        disk: ["A", "A_Options"],
        result: searchResult({ name: "B", externalId: "77", files: [file({ folders })] }),
      });
      return (await m.tools.replace_addon(
        { addonId: "a1", provider: "Curse", externalId: "77", preview: true },
        m.ctx,
      )) as any;
    };

    const partial = await preview(["A"]);
    expect(partial.settingsCarryOver).toBe("partial");
    expect(partial.remove).toEqual([
      { name: "A", provider: "Curse", externalId: "1", version: "1.0", folders: ["A", "A_Options"] },
    ]);
    expect(partial.add.map((l: any) => l.folders)).toEqual([["A"]]);
    expect(partial.foldersReplaced).toEqual(["A", "A_Options"]);

    expect((await preview(["B"])).settingsCarryOver).toBeFalse();
    expect((await preview(["A_Options", "A"])).settingsCarryOver).toBeTrue();
  });

  it("replace_addon removes then installs and records what it added", async () => {
    const old = rec({ id: "a1", name: "A", installedFolderList: ["A", "A_Options"] });
    const m = make({
      records: [old],
      result: searchResult({ name: "B", externalId: "77", files: [file({ version: "2.0", folders: ["B"] })] }),
    });

    const out: any = await m.tools.replace_addon({ addonId: "a1", provider: "Curse", externalId: "77" }, m.ctx);

    expect(m.backupService.create).toHaveBeenCalledOnceWith(
      "replace_addon",
      INSTALL,
      [jasmine.objectContaining({ id: "a1" })],
      ["B"],
      jasmine.stringMatching(/replace_addon .*A.*B/),
    );
    expect(m.addonService.removeAddon).toHaveBeenCalledOnceWith(jasmine.objectContaining({ id: "a1" }), false, true);
    const order = ["backup", "remove:a1", "install:new1", "recordAdded"].map((s) => m.log.indexOf(s));
    expect(order.every((i) => i >= 0)).toBeTrue();
    expect([...order].sort((x, y) => x - y)).toEqual(order);
    expect(m.backupService.recordAdded).toHaveBeenCalledOnceWith("b1", [
      jasmine.objectContaining({ id: "new1", installedFolderList: ["B"] }),
    ]);
    expect(out.backupId).toBe("b1");
    expect(out.changed.map((c: any) => `${c.change} ${c.name} ${c.version}`)).toEqual(["removed A 1.0", "added B 2.0"]);
  });

  it("update_addons all only touches addons with updates", async () => {
    const m = make({
      records: [
        rec({ id: "a1", name: "Alpha", latestVersion: "2.0", externalLatestReleaseId: "r2" }),
        rec({ id: "a2", name: "Beta", installedFolderList: ["Beta"] }),
        rec({ id: "a3", name: "Gamma", latestVersion: "2.0", isIgnored: true, installedFolderList: ["Gamma"] }),
      ],
      results: { "1": alphaRelease() },
    });

    const out: any = await m.tools.update_addons({ all: true }, m.ctx);

    expect(m.addonService.updateAddon).toHaveBeenCalledTimes(1);
    expect(m.addonService.updateAddon.calls.mostRecent().args[0].id).toBe("a1");
    expect(m.backupService.create).toHaveBeenCalledOnceWith(
      "update_addons",
      INSTALL,
      [jasmine.objectContaining({ id: "a1" })],
      ["Alpha"],
      jasmine.stringMatching(/Alpha/),
    );
    expect(m.log.indexOf("backup")).toBeLessThan(m.log.indexOf("update:a1"));
    expect(m.backupService.recordAdded).not.toHaveBeenCalled();
    expect(out.backupId).toBe("b1");
    expect(out.changed).toEqual([
      { change: "updated", addonId: "a1", name: "Alpha", provider: "Curse", externalId: "1", version: "2.0" },
    ]);
  });

  it("switch_provider only moves to a provider the addon is known on", async () => {
    const m = make({
      records: [
        rec({
          id: "a1",
          externalIds: [
            { providerName: "Curse", id: "1" },
            { providerName: "Wago", id: "w1" },
          ],
        }),
      ],
    });
    await expectAsync(m.tools.switch_provider({ addonId: "a1", provider: "GitHub" }, m.ctx)).toBeRejectedWithError(
      /GitHub.*Curse.*Wago/,
    );
    expect(m.backupService.create).not.toHaveBeenCalled();

    const out: any = await m.tools.switch_provider({ addonId: "a1", provider: "wago" }, m.ctx);
    expect(m.addonService.setProvider).toHaveBeenCalledOnceWith(
      jasmine.objectContaining({ id: "a1" }),
      "w1",
      "Wago",
      INSTALL,
    );
    expect(m.log.indexOf("backup")).toBeLessThan(m.log.indexOf("setProvider:a1"));
    expect(m.backupService.recordAdded).toHaveBeenCalledOnceWith("b1", [jasmine.objectContaining({ id: "switched" })]);
    expect(out.backupId).toBe("b1");
  });

  it("a failure after the backup names the backup id", async () => {
    const m = make();
    m.addonService.installAddon.and.rejectWith(new Error("download failed"));
    await expectAsync(m.tools.install_addon({ provider: "Curse", externalId: "12345" }, m.ctx)).toBeRejectedWithError(
      /download failed.*b1/,
    );
    // the record saved before the install still goes into the backup, so rollback removes it
    expect(m.backupService.recordAdded).toHaveBeenCalledOnceWith("b1", [jasmine.objectContaining({ id: "new1" })]);

    // when noting that record fails as well, the error says both and doesn't promise a clean rollback
    const both = make();
    both.addonService.installAddon.and.rejectWith(new Error("download failed"));
    both.backupService.recordAdded.and.rejectWith(new Error("manifest locked"));
    await expectAsync(
      both.tools.install_addon({ provider: "Curse", externalId: "12345" }, both.ctx),
    ).toBeRejectedWithError(/download failed.*manifest locked.*may leave/);
  });

  it("a provider that lists no folders is downloaded to learn them", async () => {
    const wagoFile = file({ externalId: "wf", version: "3.0", folders: [], downloadUrl: "https://wago.test/tt.zip" });
    const unknown = rec({
      id: "u1",
      name: "TipTac",
      providerName: "Unknown",
      externalId: "",
      installedFolderList: ["TipTac"],
    });
    const opts = {
      records: [unknown, rec({ id: "r2", name: "Other", installedFolderList: ["Other"] })],
      disk: ["TipTac", "Other"],
      result: searchResult({ providerName: "Wago", externalId: "w9", files: [wagoFile] }),
      zips: { "https://wago.test/tt.zip": ["TipTac", "__MACOSX"] },
    };

    const p = make(opts);
    const preview: any = await p.tools.install_addon({ provider: "Wago", externalId: "w9", preview: true }, p.ctx);
    expect(preview.add[0].folders).toEqual(["TipTac"]);
    expect(preview.remove.map((l: any) => l.name)).toEqual(["TipTac"]);
    expect(preview.foldersReplaced).toEqual(["TipTac"]);
    expect(preview.settingsCarryOver).toBeTrue();
    expect(p.downloadService.downloadZipFile).toHaveBeenCalledOnceWith(
      jasmine.objectContaining({ url: "https://wago.test/tt.zip", outputFolder: join("C:/data", "agent-sandbox") }),
    );
    expect(p.sandboxLeft()).toEqual([]);
    expect(p.backupService.create).not.toHaveBeenCalled();
    expect(p.addonService.installAddon).not.toHaveBeenCalled();

    const m = make(opts);
    await m.tools.install_addon({ provider: "Wago", externalId: "w9" }, m.ctx);
    expect(m.backupService.create).toHaveBeenCalledOnceWith(
      "install_addon",
      INSTALL,
      [jasmine.objectContaining({ id: "u1" })],
      ["TipTac"],
      jasmine.any(String),
    );
    expect(m.log.findIndex((l) => l.startsWith("sandbox-remove:"))).toBeLessThan(m.log.indexOf("backup"));

    // a download that fails stops the change before any backup
    const broken = make({ ...opts, zips: {} });
    await expectAsync(
      broken.tools.install_addon({ provider: "Wago", externalId: "w9" }, broken.ctx),
    ).toBeRejectedWithError(/Could not download .*Nothing was changed/);
    mutators(broken).forEach((spy) => expect(spy).not.toHaveBeenCalled());

    // switching Curse -> Wago keeps the folders once Wago's download shows them
    const s = make({
      records: [rec({ id: "a1", installedFolderList: ["Alpha"], externalIds: [{ providerName: "Wago", id: "w1" }] })],
      disk: ["Alpha"],
      result: searchResult({
        name: "Alpha",
        providerName: "Wago",
        externalId: "w1",
        files: [file({ folders: [], downloadUrl: "https://wago.test/alpha.zip" })],
      }),
      zips: { "https://wago.test/alpha.zip": ["Alpha"] },
    });
    const switched: any = await s.tools.switch_provider({ addonId: "a1", provider: "Wago", preview: true }, s.ctx);
    expect(switched.add[0].folders).toEqual(["Alpha"]);
    expect(switched.settingsCarryOver).toBeTrue();

    // and an import line learns them the same way
    const i = make(opts);
    const json = JSON.stringify({
      client_type: "ClassicEra",
      addons: [{ id: "w9", name: "TipTac", provider_name: "Wago" }],
    });
    const imported: any = await i.tools.import_addons({ text: json, preview: true }, i.ctx);
    expect(imported.add[0].folders).toEqual(["TipTac"]);
  });

  it("update_addons learns the folders of a release that lists none", async () => {
    const m = make({
      records: [
        rec({
          id: "a1",
          name: "Alpha",
          providerName: "Wago",
          externalId: "w1",
          installedFolderList: ["Alpha", "Alpha_Old"],
          latestVersion: "2.0",
          downloadUrl: "https://wago.test/alpha2.zip",
        }),
      ],
      disk: ["Alpha", "Alpha_Old"],
      result: searchResult({ name: "Alpha", providerName: "Wago", externalId: "w1", files: [file({ folders: [] })] }),
      zips: { "https://wago.test/alpha2.zip": ["Alpha", "Alpha_New"] },
    });

    const preview: any = await m.tools.update_addons({ addonIds: ["a1"], preview: true }, m.ctx);
    expect(preview.add[0].folders).toEqual(["Alpha", "Alpha_New"]);
    expect(preview.foldersReplaced).toEqual(["Alpha", "Alpha_Old"]);
    expect(preview.settingsCarryOver).toBe("partial");

    await m.tools.update_addons({ addonIds: ["a1"] }, m.ctx);
    expect(m.backupService.create.calls.mostRecent().args[3]).toEqual(["Alpha", "Alpha_New"]);
  });

  it("update_addons checks the game version the update is built for", async () => {
    const records = [
      rec({ id: "a1", name: "Alpha", latestVersion: "2.0", externalLatestReleaseId: "r2", gameVersion: ["2.5.1"] }),
      rec({ id: "a2", name: "Beta", externalId: "2", latestVersion: "2.0", externalLatestReleaseId: "r2" }),
    ];
    const results = { "1": alphaRelease(), "2": alphaRelease(["Beta"]) };

    const all = make({ records, results, mismatched: ["a1"] });
    const preview: any = await all.tools.update_addons({ all: true, preview: true }, all.ctx);
    expect(preview.add.map((l: any) => l.name)).toEqual(["Beta"]);
    expect(preview.action).toMatch(/skipped for their game version.*Alpha/);
    const out: any = await all.tools.update_addons({ all: true }, all.ctx);
    expect(all.addonService.findGameVersionMismatches).toHaveBeenCalledWith(jasmine.any(Array), true);
    expect(all.addonService.updateAddon.calls.allArgs().map((a: any[]) => a[0].id)).toEqual(["a2"]);
    expect(out.changed.map((c: any) => c.addonId)).toEqual(["a2"]);
    expect(out.skipped).toEqual([
      { addonId: "a1", name: "Alpha", reason: jasmine.stringMatching(/2\.5\.1.*1\.15\.0.*addonIds/) },
    ]);

    const named = make({ records, results, mismatched: ["a1"] });
    const namedPreview: any = await named.tools.update_addons({ addonIds: ["a1"], preview: true }, named.ctx);
    expect(namedPreview.action).toMatch(/warning: Alpha .*game version/);
    const forced: any = await named.tools.update_addons({ addonIds: ["a1"] }, named.ctx);
    expect(named.addonService.updateAddon.calls.allArgs().map((a: any[]) => a[0].id)).toEqual(["a1"]);
    expect(forced.warnings).toEqual([jasmine.stringMatching(/Alpha .*2\.5\.1.*updated anyway/)]);
  });
});
