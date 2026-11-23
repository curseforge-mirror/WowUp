/* eslint-disable */
import { AddonChannelType } from "wowup-lib-core";

import { AgentVersion, listVersions, toSearchResultFile, VersionDeps } from "./versions";

describe("versions", () => {
  const baseDeps = (over: Partial<VersionDeps> = {}): VersionDeps => ({
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
    expect(getModFiles).toHaveBeenCalledWith({ modId: 123, pageSize: 50 });
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
