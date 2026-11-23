/* eslint-disable */
import { join } from "path";

import { createInspectTools, resolveScopedPath } from "./inspect.tools";

describe("inspect tools", () => {
  const APP = "C:\\data";
  const ctx = { progress: () => undefined };
  const ROOT = "GitHub-own_repo-v2";
  let files: Record<string, string>;
  let links: Record<string, string>;

  const make = (over: any = {}) => {
    const fileService = {
      unzipFile: jasmine.createSpy("unzipFile").and.callFake(async (_zip: string, out: string) => {
        files[join(out, "Alpha", "Alpha.toc")] = "## Interface: 30300\n## Title: Alpha\n## Version: 1.2\nmain.lua\n";
        files[join(out, "Alpha", "main.lua")] = "print('hi')\n";
        return out;
      }),
      listEntries: async (dir: string) => {
        const prefix = real(dir) + "\\";
        const names = new Map<string, boolean>();
        Object.keys(files)
          .filter((p) => p.startsWith(prefix))
          .forEach((p) => {
            const rest = p.slice(prefix.length).split("\\");
            names.set(rest[0], names.get(rest[0]) || rest.length > 1);
          });
        return [...names].map(([name, isDirectory]) => ({ name, isDirectory, isSymbolicLink: false }));
      },
      readFile: async (orig: string) => {
        const p = Object.entries(links).reduce(
          (acc, [from, to]) => (acc.startsWith(from + "\\") ? to + acc.slice(from.length) : acc),
          orig,
        );
        if (!(p in files)) {
          throw new Error("ENOENT " + p);
        }
        return files[p];
      },
      pathExists: async (p: string) =>
        Object.keys(files).some((k) => k === (links[p] ?? p) || k.startsWith((links[p] ?? p) + "\\")),
      remove: jasmine.createSpy("remove").and.callFake(async (p: string) => {
        Object.keys(files)
          .filter((k) => k === p || k.startsWith(p + "\\"))
          .forEach((k) => delete files[k]);
        return true;
      }),
      createDirectory: async () => true,
      statFiles: async (paths: string[]) => {
        const out: any = {};
        paths.forEach((p) => (out[p] = { size: files[p]?.length ?? 0 }));
        return out;
      },
    };
    const downloadService = {
      downloadZipFile: jasmine
        .createSpy("downloadZipFile")
        .and.callFake(async (o: any) => join(o.outputFolder, o.fileName)),
    };
    const addon: any = {
      id: "a1",
      name: "Alpha",
      providerName: "Curse",
      externalId: "1",
      installationId: "i1",
      downloadUrl: "https://x/latest.zip",
      installedVersion: "1.0",
      installedFolderList: ["Alpha"],
    };
    const deps = {
      applicationFolderPath: APP,
      fileService,
      downloadService,
      addonService: {
        getAddons: async () => [addon],
        getInstallBasePath: () => "C:\\wow\\AddOns",
      },
      installService: { getWowInstallationsAsync: async () => [{ id: "i1", label: "i1", displayName: "i1" }] },
      getSelected: () => undefined,
      getProvider: () => ({
        getById: async () => ({ files: [] }),
        getDownloadAuth: async () => ({ headers: { a: "b" } }),
      }),
      getSecret: async () => undefined,
      fetchJson: async () => [
        {
          id: 7,
          tag_name: "v2",
          prerelease: false,
          draft: false,
          assets: [{ name: "a.zip", browser_download_url: "https://gh/a.zip" }],
        },
      ],
      ...over,
    };
    return { tools: createInspectTools(deps as any), fileService, downloadService, addon };
  };

  const fetchGh = (tools: any) => tools.fetch_release({ provider: "GitHub", externalId: "own/repo" }, ctx);
  const real = (orig: string): string =>
    Object.entries(links).reduce(
      (acc, [from, to]) => (acc === from || acc.startsWith(from + "\\") ? to + acc.slice(from.length) : acc),
      orig,
    );
  const sandbox = (...parts: string[]) => join(APP, "agent-sandbox", ROOT, ...parts);

  beforeEach(() => {
    files = {};
    links = {};
  });

  it("registers the five inspection tools", () => {
    expect(Object.keys(make().tools).sort()).toEqual([
      "fetch_release",
      "list_files",
      "read_file",
      "read_toc",
      "search_files",
    ]);
  });

  it("fetch_release downloads into the sandbox folder name", async () => {
    const { tools, downloadService, fileService } = make();
    const res: any = await fetchGh(tools);
    expect(res.root).toBe(ROOT);
    expect(res.path).toBe(sandbox());
    expect(downloadService.downloadZipFile).toHaveBeenCalledWith(
      jasmine.objectContaining({ url: "https://gh/a.zip", outputFolder: join(APP, "agent-sandbox") }),
    );
    expect(fileService.unzipFile).toHaveBeenCalled();
    expect(res.files).toContain("Alpha/main.lua");
    expect(fileService.remove).toHaveBeenCalled();
  });

  it("fetch_release downloads an installed addon's latest release", async () => {
    const { tools, downloadService } = make();
    const res: any = await tools.fetch_release({ addonId: "a1" }, ctx);
    expect(downloadService.downloadZipFile).toHaveBeenCalledWith(
      jasmine.objectContaining({ url: "https://x/latest.zip" }),
    );
    expect(res.root).toContain("Curse-1-");
  });

  it("read_file pages long files", async () => {
    const { tools } = make();
    await fetchGh(tools);
    files[sandbox("big.txt")] = Array.from({ length: 1000 }, (_, i) => "line" + (i + 1)).join("\n");
    const first: any = await tools.read_file({ root: ROOT, path: "big.txt" }, ctx);
    expect(first.totalLines).toBe(1000);
    expect(first.text.split("\n").length).toBe(400);
    expect(first.nextLine).toBe(401);
    const last: any = await tools.read_file({ root: ROOT, path: "big.txt", startLine: 991, maxLines: 50 }, ctx);
    expect(last.text.split("\n")[0]).toBe("line991");
    expect(last.nextLine).toBeUndefined();
  });

  it("read_file truncates very long lines", async () => {
    const { tools } = make();
    await fetchGh(tools);
    files[sandbox("long.lua")] = "x".repeat(5000);
    const res: any = await tools.read_file({ root: ROOT, path: "long.lua" }, ctx);
    expect(res.text.length).toBeLessThan(2100);
    expect(res.text).toContain("truncated");
  });

  it("search_files caps matches", async () => {
    const { tools } = make();
    await fetchGh(tools);
    files[sandbox("many.lua")] = Array.from({ length: 500 }, () => "needle").join("\n");
    files[sandbox("pic.png")] = "needle";
    const res: any = await tools.search_files({ root: ROOT, pattern: "needle" }, ctx);
    expect(res.matches.length).toBe(200);
    expect(res.truncated).toBeTrue();
    expect(res.matches[0]).toMatch(/^many\.lua:1: needle$/);
    expect(res.matches.some((m: string) => m.startsWith("pic.png"))).toBeFalse();
    const hi: any = await tools.search_files({ root: ROOT, pattern: "pr.nt\\(", regex: true }, ctx);
    expect(hi.matches[0]).toContain("Alpha/main.lua:1");
  });

  it("inspection paths cannot escape their root", async () => {
    const base = join(APP, "agent-sandbox", "r");
    expect(() => resolveScopedPath(base, "..\\..\\WTF")).toThrow();
    expect(() => resolveScopedPath(base, "C:\\")).toThrow();
    expect(() => resolveScopedPath(base, "/etc/passwd")).toThrow();
    expect(resolveScopedPath(base, "a/b.lua")).toBe(join(base, "a", "b.lua"));
    const { tools } = make();
    await expectAsync(tools.read_file({ root: "..", path: "x" }, ctx)).toBeRejected();
    await expectAsync(tools.read_file({ root: "addon:a1", path: "Other\\x.lua" }, ctx)).toBeRejected();
    await expectAsync(tools.read_file({ root: "addon:a1", path: "Alpha\\..\\..\\x.lua" }, ctx)).toBeRejected();
  });

  it("list_files lists an installed addon's folders", async () => {
    const { tools } = make();
    expect(await tools.list_files({ root: "addon:a1" }, ctx)).toEqual({ files: ["Alpha"] });
  });

  it("read_toc returns interface and version lines", async () => {
    const { tools } = make();
    await fetchGh(tools);
    const res: any = await tools.read_toc({ root: ROOT, folder: "Alpha" }, ctx);
    expect(res).toEqual([
      { folder: "Alpha", file: "Alpha.toc", fields: { Interface: "30300", Title: "Alpha", Version: "1.2" } },
    ]);
  });

  it("inspects an installed addon whose folder is a symlink", async () => {
    const { tools } = make();
    links["C:\\wow\\AddOns\\Alpha"] = "D:\\elsewhere\\Alpha";
    files["D:\\elsewhere\\Alpha\\Alpha.toc"] = "## Interface: 30300\n";
    files["D:\\elsewhere\\Alpha\\sub\\x.lua"] = "needle\n";
    const toc: any = await tools.read_toc({ addonId: "a1" }, ctx);
    expect(toc).toEqual([{ folder: "Alpha", file: "Alpha.toc", fields: { Interface: "30300" } }]);
    const listed: any = await tools.list_files({ root: "addon:a1", path: "Alpha" }, ctx);
    expect(listed.files).toEqual(["Alpha/Alpha.toc", "Alpha/sub/x.lua"]);
  });

  it("read_toc reads an installed addon's TOC", async () => {
    const { tools } = make();
    files["C:\\wow\\AddOns\\Alpha\\Alpha_Mainline.toc"] = "## Interface: 110000\n";
    const res: any = await tools.read_toc({ addonId: "a1" }, ctx);
    expect(res).toEqual([{ folder: "Alpha", file: "Alpha_Mainline.toc", fields: { Interface: "110000" } }]);
  });
});
