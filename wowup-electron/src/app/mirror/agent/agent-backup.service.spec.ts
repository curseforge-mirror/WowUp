/* eslint-disable */
import { TestBed } from "@angular/core/testing";
import { basename, dirname, join, normalize, sep } from "path";

import { AGENT_CHANNEL_WOW_RUNNING } from "../../../common/mirror/agent-contract";
import { ElectronService } from "../../services/electron/electron.service";
import { FileService } from "../../services/files/file.service";
import { SessionService } from "../../services/session/session.service";
import { AddonStorageService } from "../../services/storage/addon-storage.service";
import { WarcraftInstallationService } from "../../services/warcraft/warcraft-installation.service";
import { WarcraftService } from "../../services/warcraft/warcraft.service";
import { WowUpService } from "../../services/wowup/wowup.service";
import { WtfService } from "../../services/wtf/wtf.service";
import { AgentBackupService } from "./agent-backup.service";

/** In-memory file system with the same failure modes as WowUp's file IPC (copyFile needs the parent folder). */
class FakeFs {
  public readonly files = new Map<string, string>();
  public readonly dirs = new Set<string>();
  public readonly ops: string[] = [];

  public mkdirp(p: string): void {
    let d = normalize(p);
    while (!this.dirs.has(d)) {
      this.dirs.add(d);
      const up = dirname(d);
      if (up === d) {
        break;
      }
      d = up;
    }
  }

  public put(p: string, content: string): void {
    this.mkdirp(dirname(p));
    this.files.set(normalize(p), content);
  }

  public read(p: string): string | undefined {
    return this.files.get(normalize(p));
  }

  public exists(p: string): boolean {
    const k = normalize(p);
    return this.files.has(k) || this.dirs.has(k);
  }

  public json(p: string): any {
    return JSON.parse(this.read(p) ?? "null");
  }

  private under(p: string, root: string): boolean {
    return p.startsWith(root + sep);
  }

  public api() {
    return {
      pathExists: async (p: string) => this.exists(p),
      createDirectory: async (p: string) => {
        this.mkdirp(p);
        return true;
      },
      copy: async (src: string, dest: string) => {
        const s = normalize(src);
        const d = normalize(dest);
        this.ops.push(`copy ${s} -> ${d}`);
        if (this.dirs.has(s)) {
          this.mkdirp(d);
          for (const dir of [...this.dirs]) {
            if (this.under(dir, s)) {
              this.mkdirp(d + dir.slice(s.length));
            }
          }
          for (const [f, c] of [...this.files]) {
            if (this.under(f, s)) {
              this.files.set(d + f.slice(s.length), c);
            }
          }
        } else if (this.files.has(s)) {
          if (!this.dirs.has(dirname(d))) {
            throw new Error(`ENOENT: no such directory ${dirname(d)}`);
          }
          this.files.set(d, this.files.get(s)!);
        } else {
          throw new Error(`ENOENT: ${s}`);
        }
        return dest;
      },
      remove: async (p: string) => {
        const k = normalize(p);
        this.ops.push(`remove ${k}`);
        if (this.files.delete(k)) {
          return true;
        }
        if (!this.dirs.has(k)) {
          throw new Error(`ENOENT: ${k}`);
        }
        this.dirs.delete(k);
        for (const dir of [...this.dirs]) {
          if (this.under(dir, k)) {
            this.dirs.delete(dir);
          }
        }
        for (const f of [...this.files.keys()]) {
          if (this.under(f, k)) {
            this.files.delete(f);
          }
        }
        return true;
      },
      listDirectories: async (p: string) => {
        const k = normalize(p);
        if (!this.dirs.has(k)) {
          throw new Error(`ENOENT: ${k}`);
        }
        return [...this.dirs].filter((d) => d !== k && dirname(d) === k).map((d) => basename(d));
      },
      listFiles: async (p: string) => {
        const k = normalize(p);
        if (!this.dirs.has(k)) {
          return [];
        }
        return [...this.files.keys()].filter((f) => dirname(f) === k).map((f) => basename(f));
      },
      writeFile: async (p: string, contents: string) => {
        const k = normalize(p);
        this.ops.push(`write ${k}`);
        if (!this.dirs.has(dirname(k))) {
          throw new Error(`ENOENT: no such directory ${dirname(k)}`);
        }
        this.files.set(k, contents);
        return p;
      },
      readFile: async (p: string) => {
        const c = this.files.get(normalize(p));
        if (c === undefined) {
          throw new Error(`ENOENT: ${p}`);
        }
        return c;
      },
    };
  }
}

describe("AgentBackupService", () => {
  const ROOT = join("C:", "wow", "_retail_");
  const EXE = join(ROOT, "Wow.exe");
  const ADDONS = join(ROOT, "Interface", "AddOns");
  const WTF = join(ROOT, "WTF");
  const ACC_SV = join(WTF, "Account", "ACC", "SavedVariables");
  const CHAR_SV = join(WTF, "Account", "ACC", "Realm", "Char", "SavedVariables");
  const DATA = join("C:", "data");
  const BACKUPS = join(DATA, "agent-backups");
  const CORE = join(ADDONS, "Foo", "core.lua");
  const ACC_FOO = join(ACC_SV, "Foo.lua");
  const CHAR_FOO = join(CHAR_SV, "Foo.lua");

  const inst: any = { id: "i1", label: "Retail", displayName: "Retail", location: EXE, clientType: 1 };
  const foo: any = {
    id: "a-foo",
    name: "Foo",
    installationId: "i1",
    installedVersion: "1.0",
    installedFolderList: ["Foo", "Foo_Options"],
  };

  let fs: FakeFs;
  let store: Map<string, any>;
  let wowRunning: boolean;
  let electron: { invoke: jasmine.Spy };
  let session: { notifyAddonsChanged: jasmine.Spy };
  let service: AgentBackupService;

  const isLive = (op: string) =>
    op.startsWith(`remove ${ROOT}`) || (op.startsWith("copy ") && op.split(" -> ")[1].startsWith(ROOT));
  const manifestOf = (id: string) => fs.json(join(BACKUPS, id, "manifest.json"));

  beforeEach(() => {
    jasmine.clock().install();
    jasmine.clock().mockDate(new Date(2026, 10, 23, 10, 15, 0));

    fs = new FakeFs();
    fs.put(join(ADDONS, "Foo", "Foo.toc"), "toc v1");
    fs.put(CORE, "core v1");
    fs.put(join(ADDONS, "Foo_Options", "opt.lua"), "opt v1");
    fs.put(join(ADDONS, "Other", "x.lua"), "other");
    fs.put(ACC_FOO, "acct foo");
    fs.put(join(ACC_SV, "Foo.lua.bak"), "acct foo bak");
    fs.put(join(ACC_SV, "foo_options.lua"), "acct opts");
    fs.put(join(ACC_SV, "Other.lua"), "other sv");
    fs.put(join(ACC_SV, "FooBar.lua"), "foobar sv");
    fs.put(join(WTF, "Account", "ACC", "bindings-cache.wtf"), "binds");
    fs.put(join(WTF, "Account", "ACC", "Realm", "Char", "config-cache.wtf"), "cfg");
    fs.put(CHAR_FOO, "char foo");
    fs.mkdirp(DATA);

    store = new Map([["a-foo", { ...foo }]]);
    wowRunning = false;
    electron = {
      invoke: jasmine.createSpy("invoke").and.callFake(async (channel: string) => {
        if (channel === AGENT_CHANNEL_WOW_RUNNING) {
          return wowRunning;
        }
        throw new Error(`unexpected channel ${channel}`);
      }),
    };
    session = { notifyAddonsChanged: jasmine.createSpy("notifyAddonsChanged") };

    TestBed.configureTestingModule({
      providers: [
        { provide: FileService, useValue: fs.api() },
        {
          provide: AddonStorageService,
          useValue: {
            setAsync: async (key: string, value: any) => {
              store.set(key, JSON.parse(JSON.stringify(value)));
            },
            removeAsync: async (addon: any) => {
              store.delete(addon.id);
            },
            getAllForInstallationIdAsync: async (id: string) =>
              [...store.values()].filter((a) => a.installationId === id).map((a) => JSON.parse(JSON.stringify(a))),
          },
        },
        {
          provide: WarcraftService,
          useValue: { getAddonFolderPath: (i: any) => join(dirname(i.location), "Interface", "AddOns") },
        },
        { provide: WarcraftInstallationService, useValue: { getWowInstallationsAsync: async () => [inst] } },
        { provide: WtfService, useValue: { getWtfPath: (i: any) => join(dirname(i.location), "WTF") } },
        { provide: ElectronService, useValue: electron },
        { provide: WowUpService, useValue: { applicationFolderPath: DATA } },
        { provide: SessionService, useValue: session },
      ],
    });
    service = TestBed.inject(AgentBackupService);
  });

  afterEach(() => {
    jasmine.clock().uninstall();
  });

  it("create copies folders, records and matching SavedVariables", async () => {
    const before = new Map(fs.files);
    const m = await service.create("install_addon", inst, [foo], ["NewThing"]);

    expect(m.id).toBe("20261123-101500-install_addon");
    expect(m.tool).toBe("install_addon");
    expect(m.createdAt).toBe(new Date(2026, 10, 23, 10, 15, 0).toISOString());
    expect(m.installationId).toBe("i1");
    expect(m.records).toEqual([foo]);
    expect(m.folders).toEqual(["Foo", "Foo_Options"]);
    expect(m.added.addonIds).toEqual([]);
    expect(m.added.folders).toEqual(["NewThing"]);
    expect([...m.savedVariables].sort()).toEqual(
      [
        join("Account", "ACC", "SavedVariables", "Foo.lua"),
        join("Account", "ACC", "SavedVariables", "Foo.lua.bak"),
        join("Account", "ACC", "SavedVariables", "foo_options.lua"),
        join("Account", "ACC", "Realm", "Char", "SavedVariables", "Foo.lua"),
      ].sort(),
    );

    const dir = join(BACKUPS, m.id);
    expect(fs.read(join(dir, "addons", "Foo", "core.lua"))).toBe("core v1");
    expect(fs.read(join(dir, "addons", "Foo", "Foo.toc"))).toBe("toc v1");
    expect(fs.read(join(dir, "addons", "Foo_Options", "opt.lua"))).toBe("opt v1");
    expect(fs.exists(join(dir, "addons", "Other"))).toBeFalse();
    expect(fs.exists(join(dir, "addons", "NewThing"))).toBeFalse();
    expect(fs.read(join(dir, "wtf", "Account", "ACC", "SavedVariables", "Foo.lua"))).toBe("acct foo");
    expect(fs.read(join(dir, "wtf", "Account", "ACC", "SavedVariables", "Foo.lua.bak"))).toBe("acct foo bak");
    expect(fs.read(join(dir, "wtf", "Account", "ACC", "SavedVariables", "foo_options.lua"))).toBe("acct opts");
    expect(fs.read(join(dir, "wtf", "Account", "ACC", "Realm", "Char", "SavedVariables", "Foo.lua"))).toBe("char foo");
    expect(fs.exists(join(dir, "wtf", "Account", "ACC", "SavedVariables", "Other.lua"))).toBeFalse();
    expect(fs.exists(join(dir, "wtf", "Account", "ACC", "SavedVariables", "FooBar.lua"))).toBeFalse();
    expect(fs.json(join(dir, "manifest.json"))).toEqual(JSON.parse(JSON.stringify(m)));

    // only copies into the backup folder; the live install is untouched
    for (const [k, v] of before) {
      expect(fs.files.get(k)).toBe(v);
    }
    expect(fs.ops.some((o) => o.startsWith("remove"))).toBeFalse();
    expect(fs.ops.some(isLive)).toBeFalse();

    // two changes in one second get distinct ids
    const m2 = await service.create("install_addon", inst, [foo]);
    expect(m2.id).toBe("20261123-101500-install_addon-2");

    // no WTF folder means no SavedVariables, not an error
    await fs.api().remove(WTF);
    const m3 = await service.create("install_addon", inst, [foo]);
    expect(m3.id).toBe("20261123-101500-install_addon-3");
    expect(m3.savedVariables).toEqual([]);
    expect(m3.folders).toEqual(["Foo", "Foo_Options"]);
  });

  it("rollback restores folders and records", async () => {
    const m = await service.create("update_addons", inst, [foo]);

    // the change: an update rewrites Foo, drops Foo_Options, bumps the record; the game rewrites settings
    fs.put(CORE, "core v2");
    fs.put(join(ADDONS, "Foo", "new.lua"), "new v2");
    await fs.api().remove(join(ADDONS, "Foo_Options"));
    store.set("a-foo", { ...foo, installedVersion: "2.0" });
    fs.put(ACC_FOO, "acct foo v2");
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(fs.read(CORE)).toBe("core v1");
    expect(fs.exists(join(ADDONS, "Foo", "new.lua"))).toBeFalse();
    expect(fs.read(join(ADDONS, "Foo_Options", "opt.lua"))).toBe("opt v1");
    expect(fs.read(join(ADDONS, "Other", "x.lua"))).toBe("other");
    expect(store.get("a-foo").installedVersion).toBe("1.0");
    expect(fs.read(ACC_FOO)).toBe("acct foo");
    expect(electron.invoke).toHaveBeenCalledWith(AGENT_CHANNEL_WOW_RUNNING, EXE);
    expect(r.restoredFolders).toEqual(["Foo", "Foo_Options"]);
    expect(r.removedFolders).toEqual([]);
    expect(r.restoredRecords).toBe(1);
    expect(r.removedRecords).toBe(0);
    expect(r.savedVariables).toBe("restored");
    expect(session.notifyAddonsChanged).toHaveBeenCalled();
  });

  it("rollback removes folders the change added", async () => {
    const bar: any = {
      id: "a-bar",
      name: "Bar",
      installationId: "i1",
      installedFolderList: ["Bar", "Bar_Config"],
    };
    const m = await service.create("install_addon", inst, [], ["Bar"]);

    // the change installs Bar
    fs.put(join(ADDONS, "Bar", "bar.lua"), "bar");
    fs.put(join(ADDONS, "Bar_Config", "c.lua"), "c");
    store.set("a-bar", { ...bar });
    await service.recordAdded(m.id, [bar]);

    const saved = manifestOf(m.id);
    expect(saved.added.addonIds).toEqual(["a-bar"]);
    expect([...saved.added.folders].sort()).toEqual(["Bar", "Bar_Config"]);

    jasmine.clock().tick(1000);
    const r = await service.rollback(m.id);

    expect(fs.exists(join(ADDONS, "Bar"))).toBeFalse();
    expect(fs.exists(join(ADDONS, "Bar_Config"))).toBeFalse();
    expect(fs.read(CORE)).toBe("core v1");
    expect(store.has("a-bar")).toBeFalse();
    expect(store.has("a-foo")).toBeTrue();
    expect([...r.removedFolders].sort()).toEqual(["Bar", "Bar_Config"]);
    expect(r.restoredFolders).toEqual([]);
    expect(r.removedRecords).toBe(1);
    expect(r.restoredRecords).toBe(0);
    expect(r.savedVariables).toBe("none");
    expect(session.notifyAddonsChanged).toHaveBeenCalled();
  });

  it("rollback takes a safety backup first", async () => {
    const m = await service.create("update_addons", inst, [foo]);
    fs.put(CORE, "core v2");
    store.set("a-foo", { ...foo, installedVersion: "2.0" });
    fs.put(ACC_FOO, "acct foo v2");
    jasmine.clock().tick(1000);
    fs.ops.length = 0;

    const r = await service.rollback(m.id);

    expect(r.safetyBackupId).toBe("20261123-101501-rollback-20261123-101500-update_addons");
    const safety = manifestOf(r.safetyBackupId);
    expect(safety.tool).toBe(`rollback-${m.id}`);
    expect(safety.records.length).toBe(1);
    expect(safety.records[0].installedVersion).toBe("2.0");
    expect(fs.read(join(BACKUPS, r.safetyBackupId, "addons", "Foo", "core.lua"))).toBe("core v2");
    expect(fs.read(join(BACKUPS, r.safetyBackupId, "wtf", "Account", "ACC", "SavedVariables", "Foo.lua"))).toBe(
      "acct foo v2",
    );

    // the safety backup is complete before anything live is touched
    const safetyWritten = fs.ops.indexOf(`write ${join(BACKUPS, r.safetyBackupId, "manifest.json")}`);
    const firstLive = fs.ops.findIndex(isLive);
    expect(safetyWritten).toBeGreaterThanOrEqual(0);
    expect(firstLive).toBeGreaterThan(safetyWritten);
    expect(fs.read(CORE)).toBe("core v1");

    // so the rollback itself can be rolled back
    jasmine.clock().tick(1000);
    await service.rollback(r.safetyBackupId);
    expect(fs.read(CORE)).toBe("core v2");
    expect(store.get("a-foo").installedVersion).toBe("2.0");
    expect(fs.read(ACC_FOO)).toBe("acct foo v2");
  });

  it("rollback leaves SavedVariables pending while WoW runs and finishes them later", async () => {
    const m = await service.create("update_addons", inst, [foo]);
    fs.put(CORE, "core v2");
    fs.put(ACC_FOO, "acct foo v2");
    store.set("a-foo", { ...foo, installedVersion: "2.0" });
    wowRunning = true;
    jasmine.clock().tick(1000);

    const r1 = await service.rollback(m.id);

    expect(r1.savedVariables).toBe("pending-wow-running");
    expect(electron.invoke).toHaveBeenCalledWith(AGENT_CHANNEL_WOW_RUNNING, EXE);
    expect(fs.read(CORE)).toBe("core v1");
    expect(store.get("a-foo").installedVersion).toBe("1.0");
    expect(fs.read(ACC_FOO)).toBe("acct foo v2");
    expect(manifestOf(m.id).savedVariablesPending).toBeTrue();
    expect((await service.list()).find((b) => b.id === m.id)?.savedVariablesPending).toBeTrue();

    // still running: nothing changes and no new backup is taken
    const count = (await service.list()).length;
    jasmine.clock().tick(1000);
    const again = await service.rollback(m.id);
    expect(again.savedVariables).toBe("pending-wow-running");
    expect(again.safetyBackupId).toBe(r1.safetyBackupId);
    expect((await service.list()).length).toBe(count);

    // WoW writes its files on logout and the user edits the addon; then WoW closes
    fs.put(ACC_FOO, "acct foo v3");
    fs.put(CORE, "core v3 by user");
    wowRunning = false;
    jasmine.clock().tick(1000);

    const r2 = await service.rollback(m.id);

    expect(r2.savedVariables).toBe("restored");
    expect(r2.restoredFolders).toEqual([]);
    expect(r2.removedFolders).toEqual([]);
    expect(r2.restoredRecords).toBe(0);
    expect(r2.removedRecords).toBe(0);
    expect(fs.read(ACC_FOO)).toBe("acct foo");
    expect(fs.read(CHAR_FOO)).toBe("char foo");
    expect(fs.read(CORE)).toBe("core v3 by user");
    expect(manifestOf(m.id).savedVariablesPending).toBeUndefined();

    // the finishing pass backs up only the SavedVariables it overwrites
    expect(r2.safetyBackupId).not.toBe(r1.safetyBackupId);
    const svSafety = manifestOf(r2.safetyBackupId);
    expect(svSafety.folders).toEqual([]);
    expect(svSafety.records).toEqual([]);
    expect(fs.exists(join(BACKUPS, r2.safetyBackupId, "addons"))).toBeFalse();
    expect(fs.read(join(BACKUPS, r2.safetyBackupId, "wtf", "Account", "ACC", "SavedVariables", "Foo.lua"))).toBe(
      "acct foo v3",
    );
  });

  it("prune keeps the newest 50 and anything younger than 30 days", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const now = new Date("2026-11-23T12:00:00Z");
    const seed = (id: string, daysAgo: number) =>
      fs.put(
        join(BACKUPS, id, "manifest.json"),
        JSON.stringify({
          id,
          tool: "t",
          createdAt: new Date(now.getTime() - daysAgo * DAY).toISOString(),
          installationId: "i1",
          records: [],
          folders: [],
          savedVariables: [],
          added: { addonIds: [], folders: [] },
        }),
      );

    // 52 young backups (past the newest 50 but under 30 days) and 10 old ones
    for (let i = 0; i < 52; i++) {
      seed(`young-${i}`, i * 0.5);
    }
    for (let i = 0; i < 10; i++) {
      seed(`old-${i}`, 40 + i);
    }
    fs.put(join(BACKUPS, "incomplete", "addons", "Foo", "a.lua"), "x");

    expect(await service.prune(now)).toBe(10);
    for (let i = 0; i < 52; i++) {
      expect(fs.exists(join(BACKUPS, `young-${i}`))).toBeTrue();
    }
    for (let i = 0; i < 10; i++) {
      expect(fs.exists(join(BACKUPS, `old-${i}`))).toBeFalse();
    }
    expect(fs.exists(join(BACKUPS, "incomplete"))).toBeTrue();

    // 5 young and 55 old: the newest 50 keep 45 old ones
    await fs.api().remove(BACKUPS);
    for (let i = 0; i < 5; i++) {
      seed(`young-${i}`, i);
    }
    for (let i = 0; i < 55; i++) {
      seed(`old-${i}`, 31 + i);
    }

    expect(await service.prune(now)).toBe(10);
    for (let i = 0; i < 45; i++) {
      expect(fs.exists(join(BACKUPS, `old-${i}`))).toBeTrue();
    }
    for (let i = 45; i < 55; i++) {
      expect(fs.exists(join(BACKUPS, `old-${i}`))).toBeFalse();
    }
    expect((await service.list()).length).toBe(50);
  });

  it("list returns backups newest first with their addon names", async () => {
    expect(await service.list()).toEqual([]);

    const a = await service.create("update_addons", inst, [foo]);
    jasmine.clock().tick(1000);
    const b = await service.create("install_addon", inst, [], ["Bar"]);
    await service.recordAdded(b.id, [
      { id: "a-bar", name: "Bar", installationId: "i1", installedFolderList: ["Bar"] } as any,
    ]);

    const list = await service.list();
    expect(list.map((x) => x.id)).toEqual([b.id, a.id]);
    expect(list[0]).toEqual(
      jasmine.objectContaining({
        id: b.id,
        tool: "install_addon",
        installationId: "i1",
        installation: "Retail",
        addons: ["Bar"],
      }),
    );
    expect(list[1].addons).toEqual(["Foo"]);
    expect(list[1].createdAt).toBe(new Date(2026, 10, 23, 10, 15, 0).toISOString());
    expect(list[1].savedVariablesPending).toBeUndefined();
  });

  it("refuses backup ids and folder names that leave their folder", async () => {
    await expectAsync(service.rollback(join("..", "..", "Windows"))).toBeRejectedWithError(/backup id/i);
    await expectAsync(service.rollback("..")).toBeRejectedWithError(/backup id/i);
    await expectAsync(service.rollback("20990101-000000-nope")).toBeRejectedWithError(/No backup/);
    await expectAsync(service.create("install_addon", inst, [], [join("..", "Windows")])).toBeRejectedWithError(
      /folder name/i,
    );
    await expectAsync(
      service.create("install_addon", inst, [{ ...foo, installationId: "other" }]),
    ).toBeRejectedWithError(/installation/i);
    expect(fs.exists(BACKUPS)).toBeFalse();
  });
});
