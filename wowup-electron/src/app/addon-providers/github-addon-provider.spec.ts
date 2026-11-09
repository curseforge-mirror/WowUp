import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { of, throwError } from "rxjs";
import { WowClientType, WowInstallation } from "wowup-lib-core";

import { SensitiveStorageService } from "../services/storage/sensitive-storage.service";
import { GitHubAddonProvider } from "./github-addon-provider";

describe("GitHubAddonProvider", () => {
  let sensitiveStorageService: jasmine.SpyObj<SensitiveStorageService>;
  let provider: GitHubAddonProvider;

  beforeEach(() => {
    sensitiveStorageService = jasmine.createSpyObj<SensitiveStorageService>("SensitiveStorageService", ["getAsync"]);
    provider = new GitHubAddonProvider({} as HttpClient, sensitiveStorageService);
  });

  describe("getDownloadAuth", () => {
    // Regression test for #1520. The asset endpoint returns 200 with a JSON metadata body
    // unless this header is present, and that body gets written to disk as the addon zip.
    it("should send the octet-stream accept header with no personal access token", async () => {
      sensitiveStorageService.getAsync.and.resolveTo("");

      const auth = await provider.getDownloadAuth();

      expect(auth?.headers?.Accept).toEqual("application/octet-stream");
      expect(auth?.headers?.Authorization).toBeUndefined();
    });

    it("should send the octet-stream accept header with a personal access token", async () => {
      sensitiveStorageService.getAsync.and.resolveTo("test-token");

      const auth = await provider.getDownloadAuth();

      expect(auth?.headers?.Accept).toEqual("application/octet-stream");
      expect(auth?.headers?.Authorization).toEqual("Bearer test-token");
    });
  });

  describe("checking for updates", () => {
    const retail = { id: "retail", clientType: WowClientType.Retail } as WowInstallation;
    const classic = { id: "classic", clientType: WowClientType.ClassicEra } as WowInstallation;

    const repository = { owner: { login: "owner", avatar_url: "" }, html_url: "", description: "" };
    const metadataAsset = {
      name: "release.json",
      url: "https://api.github.com/repos/owner/addon/releases/assets/9",
      browser_download_url: "https://github.com/owner/addon/releases/download/v1/release.json",
    };
    const zipAsset = {
      name: "addon-v1.zip",
      content_type: "application/zip",
      url: "https://api.github.com/repos/owner/addon/releases/assets/10",
      browser_download_url: "https://github.com/owner/addon/releases/download/v1/addon-v1.zip",
      created_at: "2026-11-01T00:00:00Z",
    };
    const release = {
      name: "v1",
      body: "",
      draft: false,
      prerelease: false,
      published_at: "2026-11-01T00:00:00Z",
      assets: [metadataAsset, zipAsset],
    };
    const metadata = {
      releases: [
        {
          filename: "addon-v1.zip",
          nolib: false,
          metadata: [
            { flavor: "mainline", interface: 120000 },
            { flavor: "classic", interface: 11507 },
          ],
        },
      ],
    };

    let requests: { url: string; headers: Record<string, string> }[];
    let failFirst: string | undefined;

    beforeEach(() => {
      requests = [];
      failFirst = undefined;
      sensitiveStorageService.getAsync.and.resolveTo("test-token");
      const httpClient = {
        get: (url: string, options: { headers: Record<string, string> }) => {
          requests.push({ url, headers: options.headers });
          if (url === failFirst) {
            failFirst = undefined;
            return throwError(() => new HttpErrorResponse({ status: 500, url }));
          }
          if (url === metadataAsset.url || url === metadataAsset.browser_download_url) return of(metadata);
          if (url.endsWith("/releases")) return of([release]);
          return of(repository);
        },
      } as unknown as HttpClient;
      provider = new GitHubAddonProvider(httpClient, sensitiveStorageService);
    });

    function requestsTo(url: string) {
      return requests.filter((r) => r.url === url);
    }

    it("should read release.json through the API asset endpoint, not the website download link", async () => {
      const result = await provider.getById("owner/addon", retail);

      expect(result?.files?.[0].version).toBe("addon-v1.zip");
      expect(requestsTo(metadataAsset.browser_download_url).length).toBe(0);
      expect(requestsTo(metadataAsset.url).length).toBe(1);
      expect(requestsTo(metadataAsset.url)[0].headers.Accept).toBe("application/octet-stream");
    });

    it("should fetch a repository once when several installations check it", async () => {
      await provider.getAll(retail, ["owner/addon"]);
      await provider.getAll(classic, ["owner/addon"]);

      expect(requestsTo("https://api.github.com/repos/owner/addon").length).toBe(1);
      expect(requestsTo("https://api.github.com/repos/owner/addon/releases").length).toBe(1);
      expect(requestsTo(metadataAsset.url).length).toBe(1);
    });

    it("should not reuse a failed request", async () => {
      failFirst = "https://api.github.com/repos/owner/addon/releases";

      const first = await provider.getAll(retail, ["owner/addon"]);
      const second = await provider.getAll(classic, ["owner/addon"]);

      expect(first.errors.length).toBe(1);
      expect(second.errors.length).toBe(0);
      expect(second.searchResults.length).toBe(1);
      expect(requestsTo("https://api.github.com/repos/owner/addon/releases").length).toBe(2);
    });
  });
});
