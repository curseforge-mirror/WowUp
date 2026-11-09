/* eslint-disable @typescript-eslint/no-unsafe-argument */
import * as cfv2 from "curseforge-v2";
import { AddonDependencyType, AddonSearchResult, WowClientType, WowInstallation } from "wowup-lib-core";

import { NO_SEARCH_RESULTS_ERROR } from "../../common/constants";
import { CachingService } from "../services/caching/caching-service";
import { NetworkService } from "../services/network/network.service";
import { TocService } from "../services/toc/toc.service";
import { CurseAddonProvider } from "./curse-addon-provider";

describe("CurseAddonProvider", () => {
  let provider: CurseAddonProvider;

  function createFile(dependencies: cfv2.CF2FileDependency[]): cfv2.CF2File {
    return {
      id: 5001,
      displayName: "1.2.0",
      downloadUrl: "https://example.test/baganator.zip",
      fileDate: "2026-09-01T00:00:00Z",
      releaseType: cfv2.CF2FileReleaseType.Release,
      gameVersions: ["11.2.0"],
      modules: [{ name: "Baganator", fingerprint: 1 }],
      dependencies,
    } as unknown as cfv2.CF2File;
  }

  function createAddon(): cfv2.CF2Addon {
    return {
      id: 1001,
      name: "Baganator",
      summary: "",
      downloadCount: 100,
      authors: [{ name: "plusmouse" }],
      screenshots: [],
      links: { websiteUrl: "https://example.test/baganator" },
    } as unknown as cfv2.CF2Addon;
  }

  /** getAddonSearchResult is the single place every lookup (getById, search, featured) maps CF files through. */
  function toSearchResult(file: cfv2.CF2File): AddonSearchResult | undefined {
    return (provider as any).getAddonSearchResult(createAddon(), [file]);
  }

  beforeEach(() => {
    const networkService = jasmine.createSpyObj<NetworkService>("NetworkService", ["getCircuitBreaker"]);
    networkService.getCircuitBreaker.and.returnValue({} as any);

    provider = new CurseAddonProvider({} as CachingService, networkService, {} as TocService);
  });

  describe("dependency mapping", () => {
    it("should map each CurseForge relation type onto a WowUp dependency type", () => {
      const file = createFile([
        { modId: 1, fileId: 0, relationType: cfv2.CF2FileRelationType.RequiredDependency },
        { modId: 2, fileId: 0, relationType: cfv2.CF2FileRelationType.OptionalDependency },
        { modId: 3, fileId: 0, relationType: cfv2.CF2FileRelationType.EmbeddedLibrary },
        { modId: 4, fileId: 0, relationType: cfv2.CF2FileRelationType.Tool },
        { modId: 5, fileId: 0, relationType: cfv2.CF2FileRelationType.Incompatible },
        { modId: 6, fileId: 0, relationType: cfv2.CF2FileRelationType.Include },
      ]);

      const result = toSearchResult(file);

      expect(result?.files?.[0].dependencies).toEqual([
        { externalAddonId: "1", type: AddonDependencyType.Required },
        { externalAddonId: "2", type: AddonDependencyType.Optional },
        { externalAddonId: "3", type: AddonDependencyType.Embedded },
        { externalAddonId: "4", type: AddonDependencyType.Other },
        { externalAddonId: "5", type: AddonDependencyType.Other },
        { externalAddonId: "6", type: AddonDependencyType.Other },
      ]);
    });

    it("should leave the dependency list empty when the file has none", () => {
      const result = toSearchResult(createFile([]));

      expect(result?.files?.[0].dependencies).toEqual([]);
    });

    it("should keep the search result itself intact", () => {
      const result = toSearchResult(
        createFile([{ modId: 2002, fileId: 0, relationType: cfv2.CF2FileRelationType.RequiredDependency }]),
      );

      expect(result).toEqual(
        jasmine.objectContaining({
          externalId: "1001",
          name: "Baganator",
          providerName: provider.name,
        }),
      );
      expect(result?.files?.[0]).toEqual(
        jasmine.objectContaining({
          externalId: "5001",
          version: "1.2.0",
          folders: ["Baganator"],
        }),
      );
    });
  });

  describe("install from a CurseForge link", () => {
    const FOREVER = 88568;
    const installation = { clientType: WowClientType.Forever } as WowInstallation;
    const url = new URL("https://www.curseforge.com/wow/addons/forever-quest-mark");

    function listing(id: number, slug: string): cfv2.CF2Addon {
      const file = {
        ...createFile([]),
        id: id * 10,
        sortableGameVersions: [{ gameVersionTypeId: FOREVER }],
      } as unknown as cfv2.CF2File;
      return { ...createAddon(), id, slug, name: slug, latestFiles: [file] } as unknown as cfv2.CF2Addon;
    }

    // A first page of 50 "forever" add-ons that doesn't contain the one in the link, as the live API returns.
    const firstPageForForever = Array.from({ length: 50 }, (_, i) => listing(2000 + i, `forever-other-${i}`));
    const target = listing(1702963, "forever-quest-mark");

    let requests: cfv2.CF2SearchModsParams[];

    function stubSearch(answer: (params: Record<string, unknown>) => cfv2.CF2Addon[]): void {
      requests = [];
      (provider as any)._circuitBreaker = { fire: (action: () => unknown) => action() };
      (provider as any)._cf2Client = {
        searchMods: (params: cfv2.CF2SearchModsParams) => {
          requests.push(params);
          return Promise.resolve({ statusCode: 200, data: { data: answer(params as Record<string, unknown>) } });
        },
      };
    }

    it("should find an add-on whose first slug word matches thousands of others", async () => {
      stubSearch((params) => (params.slug === "forever-quest-mark" ? [target] : firstPageForForever));

      const result = await provider.searchByUrl(url, installation);

      expect(result?.searchResult?.externalId).toBe("1702963");
    });

    it("should fall back to the word search when the slug lookup returns nothing", async () => {
      stubSearch((params) => (params.slug ? [] : [...firstPageForForever, target]));

      const result = await provider.searchByUrl(url, installation);

      expect(result?.searchResult?.externalId).toBe("1702963");
      expect(requests.some((r) => r.searchFilter === "forever")).toBeTrue();
    });

    it("should still report no results when neither lookup finds the slug", async () => {
      stubSearch(() => firstPageForForever);

      await expectAsync(provider.searchByUrl(url, installation)).toBeRejectedWithError(NO_SEARCH_RESULTS_ERROR);
    });
  });
});
