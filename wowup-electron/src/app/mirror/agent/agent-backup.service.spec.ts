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
  public readonly mtimes = new Map<string, number>();
  /** Entries that are symlinks (WowUp's symlink mode); copying one fails, as fs.copy does across some links */
  public readonly links = new Set<string>();

  public mkdirp(p: string): void {
    let d = normalize(p);
    while (!this.dirs.has(d)) {
      this.dirs.add(d);
      this.mtimes.set(d, Date.now());
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
        if (this.links.has(s)) {
          throw new Error(`EPERM: operation not permitted, copy '${s}'`);
        }
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
      readdir: async (p: string) => {
        const k = normalize(p);
        if (!this.dirs.has(k)) {
          throw new Error(`ENOENT: ${k}`);
        }
        return [...this.dirs, ...this.files.keys()].filter((e) => e !== k && dirname(e) === k).map((e) => basename(e));
      },
      listEntries: async (p: string) => {
        const k = normalize(p);
        if (!this.dirs.has(k)) {
          throw new Error(`ENOENT: ${k}`);
        }
        return [...this.dirs, ...this.files.keys()]
          .filter((e) => e !== k && dirname(e) === k)
          .map((e) => ({ name: basename(e), isDirectory: this.dirs.has(e), isSymbolicLink: this.links.has(e) }));
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
      statFiles: async (paths: string[]) => {
        const out: Record<string, any> = {};
        for (const p of paths) {
          if (!this.exists(p)) {
            throw new Error(`ENOENT: ${p}`);
          }
          out[p] = { mtimeMs: this.mtimes.get(normalize(p)) ?? 0 };
        }
        return out;
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
  let session: { notifyAddonsChanged: jasmine.Spy; autoUpdateComplete: jasmine.Spy };
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
    session = {
      notifyAddonsChanged: jasmine.createSpy("notifyAddonsChanged"),
      autoUpdateComplete: jasmine.createSpy("autoUpdateComplete"),
    };

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
        {
          provide: WarcraftInstallationService,
          useValue: {
            getWowInstallationsAsync: async () => [inst],
            getInstallationDisplayName: async (i: any) =>
              i.label === "{defaultName}" ? "World of Warcraft: Forever" : i.label,
          },
        },
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
    const m = await service.create("install_addon", inst, [foo], ["NewThing"], "install_addon Curse 12345 (Foo) v1.0");

    expect(m.id).toBe("20261123-101500-install_addon");
    expect(m.tool).toBe("install_addon");
    expect(m.summary).toBe("install_addon Curse 12345 (Foo) v1.0");
    expect(m.undo).toBe("rollback 20261123-101500-install_addon");
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
    expect(m2.undo).toBe("rollback 20261123-101500-install_addon-2");
    expect(m2.summary).toBeUndefined();

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
    // My Addons reloads its list from storage; notifyAddonsChanged would start a full sync that writes back the
    // records it read before the rollback
    expect(session.autoUpdateComplete).toHaveBeenCalled();
    expect(session.notifyAddonsChanged).not.toHaveBeenCalled();
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
    // My Addons reloads its list from storage; notifyAddonsChanged would start a full sync that writes back the
    // records it read before the rollback
    expect(session.autoUpdateComplete).toHaveBeenCalled();
    expect(session.notifyAddonsChanged).not.toHaveBeenCalled();
  });

  it("rollback removes folders a later update added to a restored addon", async () => {
    const lib: any = { id: "a-lib", name: "LibShared", installationId: "i1", installedFolderList: ["LibShared"] };
    store.set("a-lib", { ...lib });
    fs.put(join(ADDONS, "LibShared", "lib.lua"), "lib");
    const m = await service.create("update_addons", inst, [foo]);

    // later, an update gives Foo a new folder and a folder another addon also claims
    store.set("a-foo", {
      ...foo,
      installedVersion: "2.0",
      installedFolderList: ["Foo", "Foo_Options", "Foo_New", "LibShared"],
    });
    fs.put(join(ADDONS, "Foo_New", "new.lua"), "new module");
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(fs.exists(join(ADDONS, "Foo_New"))).toBeFalse();
    expect(r.removedFolders).toEqual(["Foo_New"]);
    expect(fs.read(join(BACKUPS, r.safetyBackupId, "addons", "Foo_New", "new.lua"))).toBe("new module");
    expect(store.get("a-foo").installedFolderList).toEqual(["Foo", "Foo_Options"]);
    // still claimed by an addon the rollback doesn't touch
    expect(fs.read(join(ADDONS, "LibShared", "lib.lua"))).toBe("lib");
    expect(store.has("a-lib")).toBeTrue();
    expect(r.removedRecords).toBe(0);
  });

  it("rollback removes a later reinstall that claims the restored folders", async () => {
    const m = await service.create("remove_addon", inst, [foo]);

    // the change removes Foo; later the user reinstalls it from another provider under a new record
    await fs.api().remove(join(ADDONS, "Foo"));
    await fs.api().remove(join(ADDONS, "Foo_Options"));
    store.delete("a-foo");
    const foo2: any = { id: "a-foo2", name: "Foo", installationId: "i1", installedFolderList: ["Foo", "Foo_Extra"] };
    store.set("a-foo2", { ...foo2 });
    fs.put(CORE, "core v9");
    fs.put(join(ADDONS, "Foo_Extra", "x.lua"), "extra");
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(store.has("a-foo2")).toBeFalse();
    expect(store.get("a-foo").installedVersion).toBe("1.0");
    expect([...store.values()].filter((a) => a.installedFolderList.includes("Foo")).length).toBe(1);
    expect(fs.read(CORE)).toBe("core v1");
    expect(fs.read(join(ADDONS, "Foo_Options", "opt.lua"))).toBe("opt v1");
    expect(fs.exists(join(ADDONS, "Foo_Extra"))).toBeFalse();
    expect(r.removedRecords).toBe(1);
    expect(r.restoredRecords).toBe(1);
    expect(r.removedFolders).toEqual(["Foo_Extra"]);

    // the safety backup holds the reinstall, so this rollback can be undone too
    const safety = manifestOf(r.safetyBackupId);
    expect(safety.records.map((a: any) => a.id)).toEqual(["a-foo2"]);
    expect(safety.added.addonIds).toEqual(["a-foo"]);
    expect(fs.read(join(BACKUPS, r.safetyBackupId, "addons", "Foo_Extra", "x.lua"))).toBe("extra");
    jasmine.clock().tick(1000);
    await service.rollback(r.safetyBackupId);
    expect(store.has("a-foo")).toBeFalse();
    expect(store.has("a-foo2")).toBeTrue();
    expect(fs.read(CORE)).toBe("core v9");
    expect(fs.exists(join(ADDONS, "Foo_Options"))).toBeFalse();
  });

  it("rollback leaves alone an addon that a rescan gave a new id", async () => {
    const lib: any = {
      id: "a-lib",
      name: "LibShared",
      installationId: "i1",
      installedVersion: "1.0",
      installedFolderList: ["LibShared"],
    };
    const fooWithLib = { ...foo, installedFolderList: ["Foo", "Foo_Options", "LibShared"] };
    store.set("a-foo", { ...fooWithLib });
    store.set("a-lib", { ...lib });
    fs.put(join(ADDONS, "LibShared", "lib.lua"), "lib v1");
    const m = await service.create("update_addons", inst, [lib]);

    // the change updates LibShared; then a rescan replaces every record with one under a new id
    fs.put(join(ADDONS, "LibShared", "lib.lua"), "lib v2");
    store.clear();
    store.set("r-foo", { ...fooWithLib, id: "r-foo" });
    store.set("r-lib", { ...lib, id: "r-lib", installedVersion: "2.0" });
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(fs.read(join(ADDONS, "LibShared", "lib.lua"))).toBe("lib v1");
    expect(fs.read(CORE)).toBe("core v1");
    expect(fs.read(join(ADDONS, "Foo_Options", "opt.lua"))).toBe("opt v1");
    expect(store.get("r-foo")).toEqual({ ...fooWithLib, id: "r-foo" });
    // the rescanned LibShared record is the same addon as the restored one
    expect(store.has("r-lib")).toBeFalse();
    expect(store.get("a-lib").installedVersion).toBe("1.0");
    expect(r.removedFolders).toEqual([]);
    expect(r.removedRecords).toBe(1);
  });

  it("rollback leaves alone a later addon that bundles a restored folder", async () => {
    const lib: any = {
      id: "a-lib",
      name: "LibShared",
      installationId: "i1",
      installedVersion: "1.0",
      installedFolderList: ["LibShared"],
    };
    store.set("a-lib", { ...lib });
    fs.put(join(ADDONS, "LibShared", "lib.lua"), "lib v1");
    const m = await service.create("update_addons", inst, [lib]);

    fs.put(join(ADDONS, "LibShared", "lib.lua"), "lib v2");
    store.set("a-lib", { ...lib, installedVersion: "2.0" });
    // later the user installs Baz, which bundles LibShared; a record without an id claims it too
    const baz: any = { id: "a-baz", name: "Baz", installationId: "i1", installedFolderList: ["Baz", "LibShared"] };
    store.set("a-baz", { ...baz });
    fs.put(join(ADDONS, "Baz", "baz.lua"), "baz");
    const loose: any = { name: "Loose", installationId: "i1", installedFolderList: ["LibShared"] };
    store.set("loose", { ...loose });
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(fs.read(join(ADDONS, "LibShared", "lib.lua"))).toBe("lib v1");
    expect(fs.read(join(ADDONS, "Baz", "baz.lua"))).toBe("baz");
    expect(store.get("a-baz")).toEqual(baz);
    expect(store.get("loose")).toEqual(loose);
    expect(store.get("a-lib").installedVersion).toBe("1.0");
    expect(r.removedRecords).toBe(0);
    expect(r.removedFolders).toEqual([]);
    expect(manifestOf(r.safetyBackupId).records.map((a: any) => a.id)).toEqual(["a-lib"]);

    // and the rollback itself can be rolled back
    jasmine.clock().tick(1000);
    await expectAsync(service.rollback(r.safetyBackupId)).toBeResolved();
    expect(fs.read(join(ADDONS, "LibShared", "lib.lua"))).toBe("lib v2");
    expect(fs.read(join(ADDONS, "Baz", "baz.lua"))).toBe("baz");
    expect(store.get("a-baz")).toEqual(baz);
  });

  it("rollback leaves alone a standalone addon for a folder a later update gave the restored addon", async () => {
    const m = await service.create("update_addons", inst, [foo]);

    // a later Foo update adds LibX; then the user installs a standalone LibX under its own record
    store.set("a-foo", { ...foo, installedVersion: "2.0", installedFolderList: ["Foo", "Foo_Options", "LibX"] });
    fs.put(join(ADDONS, "LibX", "libx.lua"), "libx");
    const libx: any = { id: "a-libx", name: "LibX", installationId: "i1", installedFolderList: ["LibX"] };
    store.set("a-libx", { ...libx });
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(fs.read(join(ADDONS, "LibX", "libx.lua"))).toBe("libx");
    expect(store.get("a-libx")).toEqual(libx);
    expect(store.get("a-foo").installedFolderList).toEqual(["Foo", "Foo_Options"]);
    expect(r.removedRecords).toBe(0);
    expect(r.removedFolders).toEqual([]);
  });

  it("rollback leaves alone a later standalone record of a folder the restored addon also claims", async () => {
    const fooWithLib = { ...foo, installedFolderList: ["Foo", "Foo_Options", "LibShared"] };
    store.set("a-foo", { ...fooWithLib });
    fs.put(join(ADDONS, "LibShared", "lib.lua"), "lib v1");
    const m = await service.create("update_addons", inst, [fooWithLib]);

    fs.put(join(ADDONS, "LibShared", "lib.lua"), "lib v2");
    store.set("a-foo", { ...fooWithLib, installedVersion: "2.0" });
    const ls: any = { id: "a-ls", name: "LibShared", installationId: "i1", installedFolderList: ["LibShared"] };
    store.set("a-ls", { ...ls });
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(store.get("a-ls")).toEqual(ls);
    expect(store.get("a-foo").installedVersion).toBe("1.0");
    expect(fs.read(join(ADDONS, "LibShared", "lib.lua"))).toBe("lib v1");
    expect(r.removedRecords).toBe(0);
  });

  it("rollback removes a later record that claims only the restored folders, whatever its name", async () => {
    const m = await service.create("remove_addon", inst, [foo]);

    await fs.api().remove(join(ADDONS, "Foo"));
    await fs.api().remove(join(ADDONS, "Foo_Options"));
    store.delete("a-foo");
    const other: any = {
      id: "a-foo3",
      name: "Foo (fork)",
      installationId: "i1",
      installedFolderList: ["Foo", "Foo_Options"],
    };
    store.set("a-foo3", { ...other });
    fs.put(CORE, "core fork");
    fs.put(join(ADDONS, "Foo_Options", "opt.lua"), "opt fork");
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(store.has("a-foo3")).toBeFalse();
    expect(store.get("a-foo").installedVersion).toBe("1.0");
    expect(fs.read(CORE)).toBe("core v1");
    expect(r.removedRecords).toBe(1);
    expect(manifestOf(r.safetyBackupId).records.map((a: any) => a.id)).toEqual(["a-foo3"]);
  });

  it("rollback removes a later reinstall whose shared folder other addons also claim", async () => {
    const fooWithLib = { ...foo, installedFolderList: ["Foo", "Foo_Options", "LibShared"] };
    const ls: any = { id: "a-ls", name: "LibShared", installationId: "i1", installedFolderList: ["LibShared"] };
    store.set("a-foo", { ...fooWithLib });
    store.set("a-ls", { ...ls });
    fs.put(join(ADDONS, "LibShared", "lib.lua"), "lib v1");
    const m = await service.create("remove_addon", inst, [fooWithLib]);

    // the change removes Foo (LibShared stays for a-ls); later the user installs Baz, which bundles LibShared, and
    // reinstalls Foo from another provider under a new name and id
    await fs.api().remove(join(ADDONS, "Foo"));
    await fs.api().remove(join(ADDONS, "Foo_Options"));
    store.delete("a-foo");
    const baz: any = { id: "a-baz", name: "Baz", installationId: "i1", installedFolderList: ["Baz", "LibShared"] };
    store.set("a-baz", { ...baz });
    fs.put(join(ADDONS, "Baz", "baz.lua"), "baz");
    const fork: any = {
      id: "a-fork",
      name: "Foo (fork)",
      providerName: "GitHub",
      externalId: "someone/foo",
      installationId: "i1",
      installedFolderList: ["Foo", "Foo_Options", "LibShared"],
    };
    store.set("a-fork", { ...fork });
    fs.put(CORE, "core fork");
    fs.put(join(ADDONS, "Foo_Options", "opt.lua"), "opt fork");
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(store.has("a-fork")).toBeFalse();
    expect(store.get("a-foo")).toEqual(fooWithLib);
    expect([...store.values()].filter((a) => a.installedFolderList.includes("Foo")).map((a) => a.id)).toEqual([
      "a-foo",
    ]);
    expect(fs.read(CORE)).toBe("core v1");
    expect(fs.read(join(ADDONS, "Foo_Options", "opt.lua"))).toBe("opt v1");
    expect(fs.read(join(ADDONS, "LibShared", "lib.lua"))).toBe("lib v1");
    // the addons that share LibShared are untouched
    expect(store.get("a-ls")).toEqual(ls);
    expect(store.get("a-baz")).toEqual(baz);
    expect(fs.read(join(ADDONS, "Baz", "baz.lua"))).toBe("baz");
    expect(r.removedRecords).toBe(1);
    expect(r.removedFolders).toEqual([]);
    expect(manifestOf(r.safetyBackupId).records.map((a: any) => a.id)).toEqual(["a-fork"]);
    expect(fs.read(join(BACKUPS, r.safetyBackupId, "addons", "Foo", "core.lua"))).toBe("core fork");
  });

  it("rollback removes every later duplicate of a removed addon", async () => {
    const m = await service.create("remove_addon", inst, [foo]);

    // the change removes Foo; later two records from other providers each claim only Foo's folders
    await fs.api().remove(join(ADDONS, "Foo"));
    await fs.api().remove(join(ADDONS, "Foo_Options"));
    store.delete("a-foo");
    const fork: any = {
      id: "a-fork",
      name: "Foo (fork)",
      installationId: "i1",
      installedFolderList: ["Foo", "Foo_Options"],
    };
    const classic: any = {
      id: "a-classic",
      name: "Foo Classic",
      installationId: "i1",
      installedFolderList: ["Foo", "Foo_Options"],
    };
    store.set("a-fork", { ...fork });
    store.set("a-classic", { ...classic });
    fs.put(CORE, "core fork");
    fs.put(join(ADDONS, "Foo_Options", "opt.lua"), "opt fork");
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(store.has("a-fork")).toBeFalse();
    expect(store.has("a-classic")).toBeFalse();
    expect(store.get("a-foo")).toEqual(foo);
    expect([...store.values()].filter((a) => a.installedFolderList.includes("Foo")).map((a) => a.id)).toEqual([
      "a-foo",
    ]);
    expect(fs.read(CORE)).toBe("core v1");
    expect(r.removedRecords).toBe(2);
    expect(r.removedFolders).toEqual([]);
    expect(
      manifestOf(r.safetyBackupId)
        .records.map((a: any) => a.id)
        .sort(),
    ).toEqual(["a-classic", "a-fork"]);
  });

  it("rollback removes a later duplicate that shares its only folder with a same-named reinstall", async () => {
    const m = await service.create("remove_addon", inst, [foo]);

    // later the user reinstalls Foo under its own name with an extra folder, and a fork claims just Foo
    await fs.api().remove(join(ADDONS, "Foo"));
    await fs.api().remove(join(ADDONS, "Foo_Options"));
    store.delete("a-foo");
    const foo2: any = { id: "a-foo2", name: "Foo", installationId: "i1", installedFolderList: ["Foo", "Foo_Extra"] };
    const fork: any = { id: "a-fork", name: "Foo (fork)", installationId: "i1", installedFolderList: ["Foo"] };
    store.set("a-foo2", { ...foo2 });
    store.set("a-fork", { ...fork });
    fs.put(CORE, "core v9");
    fs.put(join(ADDONS, "Foo_Extra", "x.lua"), "extra");
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(store.has("a-foo2")).toBeFalse();
    expect(store.has("a-fork")).toBeFalse();
    expect([...store.values()].filter((a) => a.installedFolderList.includes("Foo")).map((a) => a.id)).toEqual([
      "a-foo",
    ]);
    expect(fs.exists(join(ADDONS, "Foo_Extra"))).toBeFalse();
    expect(r.removedRecords).toBe(2);
    expect(r.removedFolders).toEqual(["Foo_Extra"]);
  });

  it("rollback never removes a folder that existed when the backup was taken", async () => {
    const m = await service.create("update_addons", inst, [foo]);

    // later the record also claims the unclaimed Other folder that was already there
    store.set("a-foo", { ...foo, installedVersion: "2.0", installedFolderList: ["Foo", "Foo_Options", "Other"] });
    jasmine.clock().tick(1000);

    const r = await service.rollback(m.id);

    expect(fs.read(join(ADDONS, "Other", "x.lua"))).toBe("other");
    expect(r.removedFolders).toEqual([]);
    expect(store.get("a-foo").installedFolderList).toEqual(["Foo", "Foo_Options"]);
  });

  it("a records-only backup copies no folders or SavedVariables but notes what was there", async () => {
    const before = fs.ops.length;
    const m = await service.create("rescan", inst, [foo], [], "rescan Retail (1 addon records)", { recordsOnly: true });

    expect(m.recordsOnly).toBeTrue();
    expect(m.records).toEqual([foo]);
    expect(m.folders).toEqual([]);
    expect(m.savedVariables).toEqual([]);
    expect(m.added).toEqual({ addonIds: [], folders: [] });
    expect([...(m.foldersAtBackup ?? [])].sort()).toEqual(["Foo", "Foo_Options", "Other"]);
    expect(m.recordIdsAtBackup).toEqual(["a-foo"]);
    const ops = fs.ops.slice(before);
    expect(ops.some((o) => o.startsWith("copy "))).toBeFalse();
    expect(ops).toEqual([`write ${join(BACKUPS, m.id, "manifest.json")}`]);
  });

  it("rolling back a records-only backup restores records and never removes a folder", async () => {
    const m = await service.create("set_ignored", inst, [foo], [], "set_ignored Foo on", { recordsOnly: true });

    // the change marks Foo ignored; later the user updates it, which adds a folder
    store.set("a-foo", {
      ...foo,
      isIgnored: true,
      installedVersion: "2.0",
      installedFolderList: ["Foo", "Foo_Options", "Foo_New"],
    });
    fs.put(join(ADDONS, "Foo_New", "new.lua"), "new");
    fs.put(CORE, "core v2");
    jasmine.clock().tick(1000);
    fs.ops.length = 0;

    const r = await service.rollback(m.id);

    expect(store.get("a-foo").isIgnored).toBeUndefined();
    expect(store.get("a-foo").installedFolderList).toEqual(["Foo", "Foo_Options"]);
    expect(r.restoredRecords).toBe(1);
    expect(r.removedFolders).toEqual([]);
    expect(r.restoredFolders).toEqual([]);
    expect(r.savedVariables).toBe("none");
    // it holds no folder copies, so it puts no folder back and takes none away
    expect(fs.read(join(ADDONS, "Foo_New", "new.lua"))).toBe("new");
    expect(fs.read(CORE)).toBe("core v2");
    expect(fs.ops.some(isLive)).toBeFalse();
    // and its safety backup is records-only too
    expect(manifestOf(r.safetyBackupId).recordsOnly).toBeTrue();
    expect(manifestOf(r.safetyBackupId).folders).toEqual([]);
  });

  it("rolling back a records-only rescan backup puts the old records back in place of the new ones", async () => {
    const other: any = { id: "a-other", name: "Other", installationId: "i1", installedFolderList: ["Other"] };
    store.set("a-other", { ...other });
    const m = await service.create("rescan", inst, [foo, other], [], "rescan", { recordsOnly: true });

    // the rescan re-creates every record with a new id
    store.clear();
    store.set("n-foo", { ...foo, id: "n-foo" });
    store.set("n-other", { ...other, id: "n-other" });
    jasmine.clock().tick(1000);
    fs.ops.length = 0;

    const r = await service.rollback(m.id);

    expect([...store.keys()].sort()).toEqual(["a-foo", "a-other"]);
    expect(r.removedRecords).toBe(2);
    expect(r.restoredRecords).toBe(2);
    expect(fs.ops.some(isLive)).toBeFalse();
    expect(fs.read(CORE)).toBe("core v1");
  });

  describe("a settings backup (set_auto_update, set_ignored)", () => {
    const SETTINGS = { recordsOnly: true, restoreMode: "settings" as const };
    const curseFoo: any = {
      ...foo,
      providerName: "Curse",
      externalId: "1",
      isIgnored: false,
      autoUpdateEnabled: true,
      autoUpdateNotificationsEnabled: true,
    };
    /** What set_ignored writes */
    const ignoredFoo = (over: any = {}) => ({
      ...curseFoo,
      isIgnored: true,
      autoUpdateEnabled: false,
      ...over,
    });

    beforeEach(() => {
      store.set("a-foo", { ...curseFoo });
    });

    it("notes its restore mode, apart from a rescan's whole-record one", async () => {
      const settings = await service.create("set_ignored", inst, [curseFoo], [], "set_ignored Foo on", SETTINGS);
      expect(settings.recordsOnly).toBeTrue();
      expect(settings.restoreMode).toBe("settings");
      expect(manifestOf(settings.id).restoreMode).toBe("settings");

      const rescan = await service.create("rescan", inst, [curseFoo], [], "rescan", { recordsOnly: true });
      expect(rescan.restoreMode).toBe("records");
    });

    it("rolled back after an update, puts back only the settings and keeps the update", async () => {
      const m = await service.create("set_ignored", inst, [curseFoo], [], "set_ignored Foo on", SETTINGS);
      // the change, then a later update by the user writes a new version and adds a folder
      store.set(
        "a-foo",
        ignoredFoo({ installedVersion: "2.0", installedFolderList: ["Foo", "Foo_Options", "Foo_New"] }),
      );
      fs.put(join(ADDONS, "Foo_New", "new.lua"), "new");
      jasmine.clock().tick(1000);
      fs.ops.length = 0;

      const r = await service.rollback(m.id);

      const now = store.get("a-foo");
      expect(now.isIgnored).toBeFalse();
      expect(now.autoUpdateEnabled).toBeTrue();
      expect(now.autoUpdateNotificationsEnabled).toBeTrue();
      expect(now.installedVersion).toBe("2.0");
      expect(now.installedFolderList).toEqual(["Foo", "Foo_Options", "Foo_New"]);
      expect(r.restoredRecords).toBe(1);
      expect(r.removedRecords).toBe(0);
      expect(r.restoredFolders).toEqual([]);
      expect(r.removedFolders).toEqual([]);
      expect(fs.ops.some(isLive)).toBeFalse();
    });

    it("rolled back after the addon was removed, restores nothing for it and says so", async () => {
      const m = await service.create("set_ignored", inst, [curseFoo], [], "set_ignored Foo on", SETTINGS);
      store.delete("a-foo");
      await fs.api().remove(join(ADDONS, "Foo"));
      await fs.api().remove(join(ADDONS, "Foo_Options"));
      jasmine.clock().tick(1000);

      const r = await service.rollback(m.id);

      // no ghost record claiming folders that are gone
      expect(store.has("a-foo")).toBeFalse();
      expect(store.size).toBe(0);
      expect(r.restoredRecords).toBe(0);
      expect(r.skipped).toEqual([{ name: "Foo", reason: jasmine.stringMatching(/no longer installed/) }]);
    });

    it("rolled back after the addon was replaced, leaves the replacement alone", async () => {
      const m = await service.create("set_auto_update", inst, [curseFoo], [], "set_auto_update Foo off", SETTINGS);
      // later Foo is replaced by another addon that writes the same folders
      store.delete("a-foo");
      const replacement = {
        id: "a-fork",
        name: "Foo Fork",
        providerName: "GitHub",
        externalId: "someone/foo-fork",
        installationId: "i1",
        installedVersion: "9.0",
        installedFolderList: ["Foo", "Foo_Options"],
        isIgnored: true,
        autoUpdateEnabled: false,
      };
      store.set("a-fork", { ...replacement });
      jasmine.clock().tick(1000);

      const r = await service.rollback(m.id);

      expect([...store.keys()]).toEqual(["a-fork"]);
      expect(store.get("a-fork")).toEqual(replacement);
      expect(r.restoredRecords).toBe(0);
      expect(r.removedRecords).toBe(0);
      expect(r.skipped?.map((s) => s.name)).toEqual(["Foo"]);
    });

    it("rolled back after a reinstall or rescan gave the addon a new id, puts the settings on that record", async () => {
      const m = await service.create("set_ignored", inst, [curseFoo], [], "set_ignored Foo on", SETTINGS);
      store.delete("a-foo");
      store.set("n-foo", ignoredFoo({ id: "n-foo", installedVersion: "2.0" }));
      jasmine.clock().tick(1000);

      const r = await service.rollback(m.id);

      expect([...store.keys()]).toEqual(["n-foo"]);
      expect(store.get("n-foo").isIgnored).toBeFalse();
      expect(store.get("n-foo").autoUpdateEnabled).toBeTrue();
      expect(store.get("n-foo").installedVersion).toBe("2.0");
      expect(r.restoredRecords).toBe(1);
      expect(r.skipped).toBeUndefined();
    });

    it("takes a settings safety backup first, so the rollback can be rolled back", async () => {
      const m = await service.create("set_ignored", inst, [curseFoo], [], "set_ignored Foo on", SETTINGS);
      store.set("a-foo", ignoredFoo());
      jasmine.clock().tick(1000);

      const r = await service.rollback(m.id);
      const safety = manifestOf(r.safetyBackupId);
      expect(safety.recordsOnly).toBeTrue();
      expect(safety.restoreMode).toBe("settings");
      expect(safety.records.map((a: any) => [a.id, a.isIgnored])).toEqual([["a-foo", true]]);
      expect(store.get("a-foo").isIgnored).toBeFalse();

      // the user updates Foo in between; rolling the rollback back changes only the settings again
      store.set("a-foo", { ...store.get("a-foo"), installedVersion: "3.0" });
      jasmine.clock().tick(1000);
      await service.rollback(r.safetyBackupId);
      expect(store.get("a-foo").isIgnored).toBeTrue();
      expect(store.get("a-foo").autoUpdateEnabled).toBeFalse();
      expect(store.get("a-foo").installedVersion).toBe("3.0");
    });
  });

  it("a backup of a symlinked addon folder fails with one clear sentence and changes nothing", async () => {
    fs.links.add(normalize(join(ADDONS, "Foo")));
    await expectAsync(service.create("update_addons", inst, [foo])).toBeRejectedWithError(
      "WowUp's symlink mode isn't supported for agent changes yet; nothing was changed.",
    );
    expect(fs.exists(join(BACKUPS, "20261123-101500-update_addons"))).toBeFalse();
    expect(fs.ops.some(isLive)).toBeFalse();

    // any other copy failure still names the backup that failed
    fs.links.clear();
    const copy = fs.api().copy;
    (TestBed.inject(FileService) as any).copy = async (src: string, dest: string) => {
      if (src.endsWith("Foo")) {
        throw new Error("EBUSY: resource busy");
      }
      return copy(src, dest);
    };
    await expectAsync(service.create("update_addons", inst, [foo])).toBeRejectedWithError(
      /Could not take a backup \(update_addons\): EBUSY/,
    );
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
    // folders without a manifest (a crash mid-create) go once they are over a day old
    fs.put(join(BACKUPS, "incomplete-old", "addons", "Foo", "a.lua"), "x");
    fs.mtimes.set(join(BACKUPS, "incomplete-old"), now.getTime() - 2 * DAY);
    fs.put(join(BACKUPS, "incomplete-new", "addons", "Foo", "a.lua"), "x");
    fs.mtimes.set(join(BACKUPS, "incomplete-new"), now.getTime() - 2 * 60 * 60 * 1000);

    expect(await service.prune(now)).toBe(11);
    for (let i = 0; i < 52; i++) {
      expect(fs.exists(join(BACKUPS, `young-${i}`))).toBeTrue();
    }
    for (let i = 0; i < 10; i++) {
      expect(fs.exists(join(BACKUPS, `old-${i}`))).toBeFalse();
    }
    expect(fs.exists(join(BACKUPS, "incomplete-old"))).toBeFalse();
    expect(fs.exists(join(BACKUPS, "incomplete-new"))).toBeTrue();

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
    const b = await service.create("install_addon", inst, [], ["Bar"], "install_addon Curse 99 (Bar) v2");
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
        summary: "install_addon Curse 99 (Bar) v2",
      }),
    );
    expect(list[1].addons).toEqual(["Foo"]);
    expect("summary" in list[1]).toBeFalse();
    expect(list[1].createdAt).toBe(new Date(2026, 10, 23, 10, 15, 0).toISOString());
    expect(list[1].savedVariablesPending).toBeUndefined();
  });

  it("list shows the resolved name for a {defaultName} installation", async () => {
    const raw = { ...inst, label: "{defaultName}", displayName: "{defaultName}" };
    await service.create("update_addons", raw, [foo]);
    const list = await service.list();
    expect(list[0].installation).toBe("World of Warcraft: Forever");
  });

  it("a backup keeps the stored installation name when naming it fails", async () => {
    (TestBed.inject(WarcraftInstallationService) as any).getInstallationDisplayName = async () => {
      throw new Error("no translations yet");
    };
    const m = await service.create("update_addons", { ...inst, displayName: "My Retail" }, [foo]);
    expect(m.installationName).toBe("My Retail");
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
