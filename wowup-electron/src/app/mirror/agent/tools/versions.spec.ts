/* eslint-disable */
import { AddonChannelType, WowClientType } from "wowup-lib-core";

import { AgentVersion, listVersions, toSearchResultFile, VersionDeps } from "./versions";

describe("versions", () => {
  const baseDeps = (over: Partial<VersionDeps> = {}): VersionDeps => ({
    clientType: WowClientType.Retail,
    getSecret: async () => undefined,
    getLatest: async () => undefined,
    ...over,
  });

  it("listVersions maps CurseForge files", async () => {
    const getModFiles = jasmine.createSpy("getModFiles").and.resolveTo({
      statusCode: 200,
      data: {
        data: [
          {
            id: 11,
            displayName: "1.2.0",
            releaseType: 1,
            fileDate: "2024-05-01T10:00:00Z",
            gameVersions: ["3.3.5"],
            downloadUrl: "https://cf/11.zip",
            modules: [{ name: "Foo" }, { name: "Foo_Options" }],
          },
          {
            id: 12,
            displayName: "1.3.0-beta",
            releaseType: 2,
            fileDate: "2024-06-01T10:00:00Z",
            gameVersions: [],
            downloadUrl: "",
            modules: [],
          },
          {
            id: 13,
            displayName: "1.4.0-alpha",
            releaseType: 3,
            fileDate: "2024-07-01T10:00:00Z",
            gameVersions: [],
            downloadUrl: "",
            modules: [],
          },
        ],
      },
    });
    const getModFileChangelog = jasmine
      .createSpy("getModFileChangelog")
      .and.resolveTo({ statusCode: 200, data: { data: "notes" } });
    const createCurseClient = jasmine
      .createSpy("createCurseClient")
      .and.returnValue({ getModFiles, getModFileChangelog });

    const res = await listVersions("Curse", "123", baseDeps({ getSecret: async () => "KEY", createCurseClient }));

    expect(createCurseClient).toHaveBeenCalledWith("KEY");
    expect(getModFiles).toHaveBeenCalledWith({ modId: 123, pageSize: 50, gameVersionTypeId: 517 });
    expect(getModFileChangelog).not.toHaveBeenCalled();
    expect(res.map((v) => v.channel)).toEqual(["stable", "beta", "alpha"]);
    expect(res[0]).toEqual({
      fileId: "11",
      version: "1.2.0",
      releaseDate: "2024-05-01T10:00:00.000Z",
      channel: "stable",
      gameVersions: ["3.3.5"],
      folders: ["Foo", "Foo_Options"],
      downloadUrl: "https://cf/11.zip",
    });
  });

  it("listVersions asks CurseForge for changelogs only when requested", async () => {
    const client = {
      getModFiles: async () => ({
        statusCode: 200,
        data: {
          data: [
            {
              id: 1,
              displayName: "v",
              releaseType: 1,
              fileDate: "2024-01-01",
              gameVersions: [],
              downloadUrl: "",
              modules: [],
            },
          ],
        },
      }),
      getModFileChangelog: jasmine.createSpy("c").and.resolveTo({ statusCode: 200, data: { data: "<p>hi</p>" } }),
    };
    const res = await listVersions(
      "Curse",
      "5",
      baseDeps({ getSecret: async () => "K", createCurseClient: () => client as any, includeChangelog: true }),
    );
    expect(res[0].changelog).toBe("<p>hi</p>");
  });

  it("listVersions needs a CurseForge API key", async () => {
    await expectAsync(listVersions("Curse", "5", baseDeps())).toBeRejectedWithError(
      "CurseForge needs an API key in Options > Addons",
    );
  });

  it("listVersions maps GitHub releases", async () => {
    const fetchJson = jasmine.createSpy("fetchJson").and.resolveTo([
      {
        id: 7,
        tag_name: "v2.0",
        prerelease: false,
        draft: false,
        published_at: "2024-03-01T00:00:00Z",
        body: "changes",
        assets: [
          { name: "src.tar.gz", browser_download_url: "https://gh/src.tar.gz" },
          { name: "Foo-2.0.zip", browser_download_url: "https://gh/Foo-2.0.zip" },
        ],
      },
      {
        id: 6,
        tag_name: "v1.9-rc",
        prerelease: true,
        draft: false,
        published_at: "2024-02-01T00:00:00Z",
        body: "",
        assets: [{ name: "Foo.zip", browser_download_url: "https://gh/Foo.zip" }],
      },
      {
        id: 5,
        tag_name: "v1.0",
        prerelease: false,
        draft: false,
        published_at: "2024-01-01T00:00:00Z",
        body: "",
        assets: [],
      },
    ]);
    const res = await listVersions("GitHub", "owner/repo", baseDeps({ getSecret: async () => "TOKEN", fetchJson }));
    expect(fetchJson).toHaveBeenCalledWith("https://api.github.com/repos/owner/repo/releases?per_page=50", {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer TOKEN",
    });
    expect(res.length).toBe(2);
    expect(res[0]).toEqual({
      fileId: "7",
      version: "v2.0",
      releaseDate: "2024-03-01T00:00:00.000Z",
      channel: "stable",
      gameVersions: [],
      folders: [],
      downloadUrl: "https://gh/Foo-2.0.zip",
      changelog: "changes",
    });
    expect(res[1].channel).toBe("beta");
  });

  it("listVersions asks CurseForge only for the installation's flavor, as WowUp's provider filters it", async () => {
    const files = [
      {
        id: 21,
        displayName: "2.0",
        releaseType: 1,
        fileDate: "2024-05-01",
        gameVersions: [],
        modules: [],
        downloadUrl: "u21",
      },
      {
        id: 22,
        displayName: "2.0-nolib",
        releaseType: 1,
        fileDate: "2024-05-01",
        gameVersions: [],
        modules: [],
        downloadUrl: "u22",
        exposeAsAlternative: true,
      },
      {
        id: 23,
        displayName: "2.0-retail",
        releaseType: 1,
        fileDate: "2024-05-01",
        gameVersions: [],
        modules: [],
        downloadUrl: "u23",
        sortableGameVersions: [{ gameVersionTypeId: 517 }],
      },
    ];
    const getModFiles = jasmine.createSpy("getModFiles").and.resolveTo({ statusCode: 200, data: { data: files } });
    const client = () => ({ getModFiles, getModFileChangelog: async () => ({}) }) as any;
    const typeFor = async (clientType: WowClientType) => {
      getModFiles.calls.reset();
      const res = await listVersions(
        "Curse",
        "7",
        baseDeps({ clientType, getSecret: async () => "K", createCurseClient: client }),
      );
      return { typeId: getModFiles.calls.mostRecent().args[0].gameVersionTypeId, ids: res.map((v) => v.fileId) };
    };
    expect((await typeFor(WowClientType.ClassicEra)).typeId).toBe(67408);
    expect((await typeFor(WowClientType.Classic)).typeId).toBe(79434);
    expect((await typeFor(WowClientType.Anniversary)).typeId).toBe(73246);
    expect((await typeFor(WowClientType.Forever)).typeId).toBe(88568);
    const retail = await typeFor(WowClientType.Retail);
    expect(retail.typeId).toBe(517);
    // alternatives are left out; a file that names its game version types must name this one
    expect(retail.ids).toEqual(["21", "23"]);
    expect((await typeFor(WowClientType.ClassicEra)).ids).toEqual(["21"]);
  });

  describe("GitHub assets", () => {
    const asset = (name: string, id: number) => ({
      name,
      url: `https://api.github.com/repos/o/r/releases/assets/${id}`,
      browser_download_url: `https://github.com/o/r/releases/download/v1/${name}`,
      content_type: name.endsWith(".json") ? "application/json" : "application/zip",
    });
    const release = (id: number, assets: any[], over: any = {}) => ({
      id,
      tag_name: `v${id}`,
      prerelease: false,
      draft: false,
      published_at: `2024-0${id}-01T00:00:00Z`,
      assets,
      ...over,
    });
    const run = (clientType: WowClientType, releases: any[], meta: Record<string, any> = {}) => {
      const fetchJson = jasmine.createSpy("fetchJson").and.callFake(async (url: string) => {
        if (url.includes("/releases?")) {
          return releases;
        }
        if (url in meta) {
          return meta[url];
        }
        throw new Error(`unexpected ${url}`);
      });
      return { fetchJson, result: listVersions("GitHub", "o/r", baseDeps({ clientType, fetchJson })) };
    };

    it("picks the asset named for the installation's flavor, as WowUp's provider does", async () => {
      const releases = [
        release(2, [
          asset("Foo-2.zip", 1),
          asset("Foo-2-nolib.zip", 2),
          asset("Foo-2-classic.zip", 3),
          asset("Foo-2-bcc.zip", 4),
          asset("Foo-2-mists.zip", 5),
          asset("Foo-2-forever.zip", 6),
        ]),
      ];
      const url = async (clientType: WowClientType) => (await run(clientType, releases).result)[0].downloadUrl;
      // the REST asset url, as the provider's downloads use (browser_download_url 404s on private repos)
      expect(await url(WowClientType.Retail)).toBe("https://api.github.com/repos/o/r/releases/assets/1");
      expect(await url(WowClientType.ClassicEra)).toBe("https://api.github.com/repos/o/r/releases/assets/3");
      expect(await url(WowClientType.Anniversary)).toBe("https://api.github.com/repos/o/r/releases/assets/4");
      expect(await url(WowClientType.Classic)).toBe("https://api.github.com/repos/o/r/releases/assets/5");
      expect(await url(WowClientType.Forever)).toBe("https://api.github.com/repos/o/r/releases/assets/6");
    });

    it("reads the BigWigs release.json for the flavor, with the release's own file names", async () => {
      const metaUrl = "https://api.github.com/repos/o/r/releases/assets/9";
      const releases = [release(3, [asset("Foo-3.zip", 1), asset("Foo-3-nolib.zip", 2), asset("release.json", 9)])];
      const meta = {
        [metaUrl]: {
          releases: [
            { filename: "Foo-3-nolib.zip", nolib: true, metadata: [{ flavor: "classic", interface: 11500 }] },
            {
              filename: "Foo-3.zip",
              nolib: false,
              metadata: [
                { flavor: "mainline", interface: 110000 },
                { flavor: "classic", interface: 11500 },
              ],
            },
          ],
        },
      };
      const { fetchJson, result } = run(WowClientType.ClassicEra, releases, meta);
      const res = await result;
      expect(res.map((v) => v.downloadUrl)).toEqual(["https://api.github.com/repos/o/r/releases/assets/1"]);
      expect(fetchJson).toHaveBeenCalledWith(metaUrl, jasmine.objectContaining({ Accept: "application/octet-stream" }));
    });

    it("leaves out releases without an asset for the flavor, and falls back to any asset when none has one", async () => {
      const releases = [release(4, [asset("Foo-4-classic.zip", 1)]), release(3, [asset("Foo-3.zip", 2)])];
      const classic = await run(WowClientType.ClassicEra, releases).result;
      expect(classic.map((v) => v.version)).toEqual(["v4"]);
      const forever = await run(WowClientType.Forever, releases).result;
      expect(forever.map((v) => v.downloadUrl)).toEqual([
        "https://api.github.com/repos/o/r/releases/assets/1",
        "https://api.github.com/repos/o/r/releases/assets/2",
      ]);
    });
  });

  it("listVersions falls back to the latest file for other providers", async () => {
    const getLatest = jasmine.createSpy("getLatest").and.resolveTo({
      externalId: "x",
      providerName: "Wago",
      files: [
        {
          externalId: "f1",
          version: "3",
          channelType: AddonChannelType.Stable,
          folders: ["A"],
          gameVersion: "3.3.5",
          downloadUrl: "https://w/3.zip",
          releaseDate: new Date("2024-01-02T00:00:00Z"),
        },
      ],
    });
    const res = await listVersions("Wago", "x", baseDeps({ getLatest }));
    expect(getLatest).toHaveBeenCalledWith("Wago", "x");
    expect(res.length).toBe(1);
    expect(res[0].fileId).toBe("f1");
    expect(res[0].gameVersions).toEqual(["3.3.5"]);
  });

  it("toSearchResultFile keeps the download url and folders", () => {
    const v: AgentVersion = {
      fileId: "9",
      version: "1.0",
      releaseDate: "2024-01-01T00:00:00.000Z",
      channel: "beta",
      gameVersions: ["3.3.5", "3.4.0"],
      folders: ["A", "B"],
      downloadUrl: "https://x/y.zip",
    };
    const f = toSearchResultFile(v);
    expect(f.downloadUrl).toBe("https://x/y.zip");
    expect(f.folders).toEqual(["A", "B"]);
    expect(f.externalId).toBe("9");
    expect(f.channelType).toBe(AddonChannelType.Beta);
    expect(f.gameVersion).toBe("3.3.5");
    expect(f.releaseDate).toEqual(new Date("2024-01-01T00:00:00.000Z"));
  });
});
