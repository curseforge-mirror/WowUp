/* eslint-disable */
import { AddonChannelType, WowClientType } from "wowup-lib-core";

import { createDiscoveryTools } from "./discovery.tools";

describe("discovery tools", () => {
  const install = (id: string, clientType = WowClientType.ClassicEra): any => ({
    id,
    clientType,
    label: id,
    displayName: id,
    location: "C:\\wow" + id,
  });
  const ctx = { progress: () => undefined };
  const addon = (over: any): any => ({
    id: "a1",
    name: "Alpha",
    providerName: "Curse",
    externalId: "1",
    installedVersion: "1.0",
    latestVersion: "1.0",
    installedFolderList: ["Alpha"],
    isIgnored: false,
    autoUpdateEnabled: true,
    gameVersion: ["3.3.5"],
    ...over,
  });

  const make = (over: any = {}) => {
    const addonService = jasmine.createSpyObj("AddonService", [
      "search",
      "getAddons",
      "getAddonByUrl",
      "getFullDescription",
      "getChangelogForSearchResult",
      "getChangelogForAddon",
      "getCategoryPage",
      "getFeaturedAddons",
    ]);
    const deps = {
      addonService,
      installService: {
        getWowInstallationsAsync: async () => [install("i1")],
        getInstallationDisplayName: async (i: any) => i.displayName,
      },
      getSelected: () => undefined,
      getProvider: () => undefined,
      getSecret: async () => undefined,
      fetchJson: async () => [],
      createCurseClient: () => ({}) as any,
      ...over,
    };
    return { addonService, tools: createDiscoveryTools(deps as any) };
  };

  it("registers the ten discovery tools", () => {
    expect(Object.keys(make().tools).sort()).toEqual(
      [
        "browse_category",
        "featured_addons",
        "find_by_url",
        "get_addon_details",
        "get_changelog",
        "get_description",
        "list_addons",
        "list_installations",
        "list_versions",
        "search_addons",
      ].sort(),
    );
  });

  it("list_installations shows the resolved name for a {defaultName} label", async () => {
    const raw = { ...install("i1"), label: "{defaultName}", displayName: "{defaultName}" };
    const { addonService, tools } = make({
      installService: {
        getWowInstallationsAsync: async () => [raw],
        getInstallationDisplayName: async () => "World of Warcraft: Forever",
      },
    });
    addonService.getAddons.and.resolveTo([]);
    const res: any = await tools.list_installations({}, ctx);
    expect(res[0].name).toBe("World of Warcraft: Forever");
    const byName: any = await tools.list_addons({ installation: "World of Warcraft: Forever" }, ctx);
    expect(byName).toEqual([]);
  });

  it("list_addons filters by hasUpdate", async () => {
    const { addonService, tools } = make();
    addonService.getAddons.and.resolveTo([
      addon({ id: "a1", name: "Alpha", latestVersion: "2.0" }),
      addon({ id: "a2", name: "Beta" }),
    ]);
    const res: any = await tools.list_addons({ hasUpdate: true }, ctx);
    expect(res.map((a: any) => a.addonId)).toEqual(["a1"]);
    expect(res[0].latestVersion).toBe("2.0");
    const named: any = await tools.list_addons({ name: "bet" }, ctx);
    expect(named.map((a: any) => a.addonId)).toEqual(["a2"]);
  });

  it("search_addons passes the resolved installation", async () => {
    const installs = [install("i1"), install("i2", WowClientType.Classic)];
    const { addonService, tools } = make({
      installService: {
        getWowInstallationsAsync: async () => installs,
        getInstallationDisplayName: async (i: any) => i.displayName,
      },
    });
    addonService.search.and.resolveTo([
      {
        name: "Found",
        providerName: "Curse",
        externalId: "9",
        author: "me",
        downloadCount: 5,
        summary: "s",
        externalUrl: "u",
        thumbnailUrl: "t",
        files: [
          {
            version: "1",
            channelType: AddonChannelType.Stable,
            folders: [],
            gameVersion: "3.3.5",
            downloadUrl: "d",
            releaseDate: new Date("2024-01-01T00:00:00Z"),
          },
        ],
      },
      { name: "Other", providerName: "GitHub", externalId: "o/r", author: "x", files: [] },
    ]);
    const res: any = await tools.search_addons({ query: "found", installation: "i2", provider: "curse" }, ctx);
    expect(addonService.search).toHaveBeenCalledWith("found", installs[1]);
    expect(res.length).toBe(1);
    expect(res[0].externalId).toBe("9");
    expect(res[0].latestVersion).toBe("1");
  });

  it("get_addon_details includes per-file game versions", async () => {
    const getById = jasmine.createSpy("getById").and.resolveTo({
      name: "Found",
      providerName: "Curse",
      externalId: "9",
      author: "me",
      summary: "s",
      externalUrl: "u",
      thumbnailUrl: "t",
      files: [
        {
          externalId: "f",
          version: "1",
          channelType: AddonChannelType.Stable,
          folders: ["F"],
          gameVersion: "3.3.5",
          gameVersions: ["3.3.5", "3.4.0"],
          downloadUrl: "d",
          releaseDate: new Date("2024-01-01T00:00:00Z"),
        },
      ],
    });
    const { tools } = make({ getProvider: () => ({ getById }) });
    const res: any = await tools.get_addon_details({ provider: "Curse", externalId: "9" }, ctx);
    expect(res.files[0].gameVersions).toEqual(["3.3.5", "3.4.0"]);
    expect(res.files[0].folders).toEqual(["F"]);
    expect(res.files[0].releaseDate).toBe("2024-01-01T00:00:00.000Z");
  });

  it("browse_category rejects unknown names and lists valid ones", async () => {
    const { addonService, tools } = make();
    await expectAsync(tools.browse_category({ category: "nope" }, ctx)).toBeRejectedWithError(
      /Valid categories:.*Combat/,
    );
    addonService.getCategoryPage.and.resolveTo([]);
    await tools.browse_category({ category: "combat" }, ctx);
    expect(addonService.getCategoryPage.calls.mostRecent().args[0]).toBe(11);
  });

  it("list_versions lists the installation's flavor", async () => {
    const getModFiles = jasmine.createSpy("getModFiles").and.resolveTo({ data: { data: [] } });
    const { tools } = make({
      getSecret: async () => "KEY",
      createCurseClient: () => ({ getModFiles, getModFileChangelog: async () => ({}) }),
    });
    await tools.list_versions({ provider: "Curse", externalId: "5" }, ctx);
    expect(getModFiles).toHaveBeenCalledWith({ modId: 5, pageSize: 50, gameVersionTypeId: 67408 });
  });
});
