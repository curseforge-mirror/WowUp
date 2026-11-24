import { expect } from "chai";
import { SourceRemovedAddonError, WowClientType, WowInstallation } from "wowup-lib-core";

import { PREF_GITHUB_PERSONAL_ACCESS_TOKEN } from "../../../src/common/constants";
import { GitHubFetchRepositoryError, GitHubLimitError } from "../../../src/common/errors";
import { HttpClient } from "../network/http-client";
import { GitHubAddonProvider } from "./github-addon-provider";

const silentLog = { info: () => undefined };
const installation = { id: "inst-1", clientType: WowClientType.Retail } as WowInstallation;

function createProvider(respond: (url: string, init: RequestInit) => Response, pat = "") {
  const requests: { url: string; init: RequestInit }[] = [];
  const http = new HttpClient({
    fetch: (url, init) => {
      requests.push({ url, init });
      return Promise.resolve(respond(url, init));
    },
    log: silentLog,
  });
  const provider = new GitHubAddonProvider(http, (key) =>
    key === PREF_GITHUB_PERSONAL_ACCESS_TOKEN ? pat : undefined,
  );
  return { provider, requests };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

describe("GitHubAddonProvider", () => {
  let consoleError: typeof console.error;
  beforeEach(() => {
    consoleError = console.error;
    console.error = () => undefined;
  });
  afterEach(() => {
    console.error = consoleError;
  });

  describe("getDownloadAuth", () => {
    // Regression test for #1520. The asset endpoint returns 200 with a JSON metadata body
    // unless this header is present, and that body gets written to disk as the addon zip.
    it("sends the octet-stream accept header with no personal access token", async () => {
      const { provider } = createProvider(() => new Response("{}"));

      const auth = await provider.getDownloadAuth();

      expect(auth?.headers?.Accept).to.equal("application/octet-stream");
      expect(auth?.headers?.Authorization).to.equal(undefined);
    });

    it("sends the octet-stream accept header with a personal access token", async () => {
      const { provider } = createProvider(() => new Response("{}"), "test-token");

      const auth = await provider.getDownloadAuth();

      expect(auth?.headers?.Accept).to.equal("application/octet-stream");
      expect(auth?.headers?.Authorization).to.equal("Bearer test-token");
    });
  });

  describe("api errors", () => {
    it("turns an exhausted rate limit into GitHubLimitError", async () => {
      const { provider } = createProvider(
        () =>
          new Response("{}", {
            status: 403,
            headers: {
              "x-ratelimit-limit": "60",
              "x-ratelimit-used": "60",
              "x-ratelimit-remaining": "0",
              "x-ratelimit-reset": "1700000000",
            },
          }),
      );

      const error = await rejectionOf(provider.getById("owner/repo", installation));

      expect(error).to.be.instanceOf(GitHubLimitError);
      expect((error as GitHubLimitError).rateLimitMax).to.equal(60);
      expect((error as GitHubLimitError).rateLimitReset).to.equal(1700000000);
    });

    it("turns a missing repository into SourceRemovedAddonError", async () => {
      const { provider } = createProvider(() => new Response("{}", { status: 404 }));

      const error = await rejectionOf(provider.getById("owner/repo", installation));

      expect(error).to.be.instanceOf(SourceRemovedAddonError);
    });

    it("wraps other failures in GitHubFetchRepositoryError", async () => {
      const { provider } = createProvider(() => new Response("{}", { status: 500 }));

      const error = await rejectionOf(provider.getById("owner/repo", installation));

      expect(error).to.be.instanceOf(GitHubFetchRepositoryError);
    });

    it("sends the personal access token to the api", async () => {
      const { provider, requests } = createProvider(() => new Response("{}", { status: 404 }), "test-token");

      await rejectionOf(provider.getById("owner/repo", installation));

      expect((requests[0].init.headers as Record<string, string>).Authorization).to.equal("Bearer test-token");
    });
  });

  describe("checking for updates", () => {
    const retail = { id: "retail", clientType: WowClientType.Retail } as WowInstallation;
    const classic = { id: "classic", clientType: WowClientType.ClassicEra } as WowInstallation;

    const repositoryUrl = "https://api.github.com/repos/owner/addon";
    const releasesUrl = `${repositoryUrl}/releases`;
    const repository = { owner: { login: "owner", avatar_url: "" }, html_url: "", description: "" };
    const metadataAsset = {
      name: "release.json",
      url: `${repositoryUrl}/releases/assets/9`,
      browser_download_url: "https://github.com/owner/addon/releases/download/v1/release.json",
    };
    const zipAsset = {
      name: "addon-v1.zip",
      content_type: "application/zip",
      url: `${repositoryUrl}/releases/assets/10`,
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

    let failFirst: string | undefined;
    let consoleLog: typeof console.log;
    beforeEach(() => {
      consoleLog = console.log;
      console.log = () => undefined;
    });
    afterEach(() => {
      console.log = consoleLog;
    });

    function createUpdateProvider() {
      failFirst = undefined;
      return createProvider((url) => {
        if (url === failFirst) {
          failFirst = undefined;
          return new Response("{}", { status: 500 });
        }
        if (url === metadataAsset.url || url === metadataAsset.browser_download_url) {
          return Response.json(metadata);
        }
        if (url === releasesUrl) {
          return Response.json([release]);
        }
        return Response.json(repository);
      }, "test-token");
    }

    function requestsTo(requests: { url: string; init: RequestInit }[], url: string) {
      return requests.filter((r) => r.url === url);
    }

    it("reads release.json through the api asset endpoint, not the website download link", async () => {
      const { provider, requests } = createUpdateProvider();

      const result = await provider.getById("owner/addon", retail);

      expect(result?.files?.[0].version).to.equal("addon-v1.zip");
      expect(requestsTo(requests, metadataAsset.browser_download_url).length).to.equal(0);
      expect(requestsTo(requests, metadataAsset.url).length).to.equal(1);
      const headers = requestsTo(requests, metadataAsset.url)[0].init.headers as Record<string, string>;
      expect(headers.Accept).to.equal("application/octet-stream");
    });

    it("fetches a repository once when several installations check it", async () => {
      const { provider, requests } = createUpdateProvider();

      await provider.getAll(retail, ["owner/addon"]);
      await provider.getAll(classic, ["owner/addon"]);

      expect(requestsTo(requests, repositoryUrl).length).to.equal(1);
      expect(requestsTo(requests, releasesUrl).length).to.equal(1);
      expect(requestsTo(requests, metadataAsset.url).length).to.equal(1);
    });

    it("does not reuse a failed request", async () => {
      const { provider, requests } = createUpdateProvider();
      failFirst = releasesUrl;

      const first = await provider.getAll(retail, ["owner/addon"]);
      const second = await provider.getAll(classic, ["owner/addon"]);

      expect(first.errors.length).to.equal(1);
      expect(second.errors.length).to.equal(0);
      expect(second.searchResults.length).to.equal(1);
      expect(requestsTo(requests, releasesUrl).length).to.equal(2);
    });

    it("checks 8 repositories at a time", async () => {
      let inFlight = 0;
      let maxInFlight = 0;
      const http = new HttpClient({
        fetch: async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          inFlight--;
          return new Response("{}", { status: 404 });
        },
        log: silentLog,
      });
      const provider = new GitHubAddonProvider(http, () => undefined);
      const ids = Array.from({ length: 20 }, (_, i) => `owner/addon-${i}`);

      await provider.getAll(retail, ids);

      expect(maxInFlight).to.equal(8);
    });
  });
});
