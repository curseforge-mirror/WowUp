import { expect } from "chai";
import { EventEmitter } from "events";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

import type { Net } from "electron";

import { DownloadFileDeps } from "../../services/download/file-download";
import { downloadToSandbox, isInsideFolder } from "./agent-download";

const silentLog = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

async function rejectionOf(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a rejection");
}

describe("agent downloads", () => {
  let sandbox: string;
  let requested: string[];
  let deps: DownloadFileDeps;

  beforeEach(async () => {
    sandbox = await fsp.mkdtemp(path.join(os.tmpdir(), "agent-sandbox-"));
    requested = [];
    deps = {
      // Fails the moment it is sent, which is enough to show the request got through
      net: {
        request: (options: { url: string }) => {
          requested.push(options.url);
          const request = Object.assign(new EventEmitter(), {
            setHeader: () => undefined,
            abort: () => undefined,
            end: () => setImmediate(() => request.emit("error", new Error("offline"))),
          });
          return request;
        },
      } as unknown as Pick<Net, "request">,
      log: silentLog,
      createWriteStream: () => ({ write: () => true, end: (cb) => cb?.(), on: () => undefined }),
    };
  });

  afterEach(async () => {
    await fsp.rm(sandbox, { recursive: true, force: true });
  });

  it("knows what is inside a folder", () => {
    expect(isInsideFolder(sandbox, sandbox)).to.equal(true);
    expect(isInsideFolder(sandbox, path.join(sandbox, "a", "b"))).to.equal(true);
    expect(isInsideFolder(sandbox, path.join(sandbox, "..", "elsewhere"))).to.equal(false);
    expect(isInsideFolder(sandbox, path.dirname(sandbox))).to.equal(false);
    expect(isInsideFolder(path.join(sandbox, "a"), path.join(sandbox, "ab"))).to.equal(false);
  });

  it("downloads into the sandbox", async () => {
    const error = await rejectionOf(
      downloadToSandbox(
        sandbox,
        { url: "https://example.test/addon.zip", fileName: "addon.zip", outputFolder: path.join(sandbox, "x") },
        deps,
      ),
    );

    expect(error.message).to.contain("offline");
    expect(requested).to.deep.equal(["https://example.test/addon.zip"]);
  });

  it("writes nowhere but the sandbox", async () => {
    const outside = path.join(sandbox, "..", "AddOns");

    const error = await rejectionOf(
      downloadToSandbox(sandbox, { url: "https://example.test/a.zip", fileName: "a.zip", outputFolder: outside }, deps),
    );

    expect(error.message).to.contain("agent sandbox");
    expect(requested).to.deep.equal([]);
  });

  it("refuses a file name that is a path", async () => {
    const error = await rejectionOf(
      downloadToSandbox(
        sandbox,
        { url: "https://example.test/a.zip", fileName: "../../a.zip", outputFolder: sandbox },
        deps,
      ),
    );

    expect(error.message).to.contain("Not a file name");
    expect(requested).to.deep.equal([]);
  });

  it("fetches http(s) only", async () => {
    const error = await rejectionOf(
      downloadToSandbox(sandbox, { url: "file:///C:/secret.zip", fileName: "a.zip", outputFolder: sandbox }, deps),
    );

    expect(error.message).to.contain("http(s) only");
    expect(requested).to.deep.equal([]);
  });
});
