import { expect } from "chai";
import * as http from "http";
import { AddressInfo } from "net";

import { McpHttpServer } from "./mcp-http-server";

const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({ jsonrpc: "2.0", id, method, params });

function post(port: number, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const h: Record<string, string> = { "Content-Type": "application/json", ...headers };
  return fetch(`http://127.0.0.1:${port}/mcp`, { method: "POST", headers: h, body: JSON.stringify(body) });
}

function parseFrames(text: string): { event?: string; data?: any; comment?: string }[] {
  return text
    .split("\n\n")
    .filter((f) => f.trim().length > 0)
    .map((f) => {
      if (f.startsWith(":")) {
        return { comment: f.slice(1).trim() };
      }
      const event = /^event: (.*)$/m.exec(f)?.[1];
      const data = /^data: (.*)$/m.exec(f)?.[1];
      return { event, data: data ? JSON.parse(data) : undefined };
    });
}

const slowTool = async (_n: string, _a: Record<string, unknown>, onProgress: (m: string) => void) => {
  onProgress("working");
  await new Promise((r) => setTimeout(r, 70));
  return { text: "done" };
};

describe("McpHttpServer", () => {
  const servers: McpHttpServer[] = [];
  const make = (progressIntervalMs?: number): McpHttpServer => {
    const s = new McpHttpServer(progressIntervalMs === undefined ? {} : { progressIntervalMs });
    servers.push(s);
    return s;
  };
  const portOf = (s: McpHttpServer): number => Number(new URL(s.status.url).port);

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.stop()));
  });

  it("ignores any Authorization header", async () => {
    const s = make();
    await s.start({ port: 0 }, slowTool);
    expect((await post(portOf(s), rpc("ping"))).status).to.equal(200);
    expect((await post(portOf(s), rpc("ping"), { Authorization: "Basic bm9wZQ==" })).status).to.equal(200);
  });

  it("rejects a foreign Origin with 403", async () => {
    const s = make();
    await s.start({ port: 0 }, slowTool);
    expect((await post(portOf(s), rpc("ping"), { Origin: "http://evil.example" })).status).to.equal(403);
    expect((await post(portOf(s), rpc("ping"), { Origin: "http://localhost:3000" })).status).to.equal(200);
    expect((await post(portOf(s), rpc("ping"), { Origin: "null" })).status).to.equal(200);
  });

  it("answers GET with 405 and other paths with 404", async () => {
    const s = make();
    await s.start({ port: 0 }, slowTool);
    const get = await fetch(`http://127.0.0.1:${portOf(s)}/mcp`);
    expect(get.status).to.equal(405);
    const other = await fetch(`http://127.0.0.1:${portOf(s)}/other`, {
      method: "POST",
    });
    expect(other.status).to.equal(404);
  });

  it("answers initialize as JSON", async () => {
    const s = make();
    await s.start({ port: 0 }, slowTool);
    const res = await post(portOf(s), rpc("initialize", { protocolVersion: "2025-06-18" }), {
      Accept: "application/json, text/event-stream",
    });
    expect(res.status).to.equal(200);
    expect(res.headers.get("content-type")).to.contain("application/json");
    const body: any = await res.json();
    expect(body.result.serverInfo.name).to.equal("wowup");
  });

  it("answers a batch with -32600", async () => {
    const s = make();
    await s.start({ port: 0 }, slowTool);
    const body: any = await (await post(portOf(s), [rpc("ping")])).json();
    expect(body.error.code).to.equal(-32600);
  });

  it("streams progress then the result over SSE", async () => {
    const s = make(20);
    await s.start({ port: 0 }, slowTool);
    const res = await post(
      portOf(s),
      rpc("tools/call", { name: "list_installations", arguments: {}, _meta: { progressToken: "t1" } }),
      { Accept: "application/json, text/event-stream" },
    );
    expect(res.headers.get("content-type")).to.contain("text/event-stream");
    const frames = parseFrames(await res.text());
    const progress = frames.filter((f) => f.data?.method === "notifications/progress");
    expect(progress.length).to.be.at.least(2);
    const values = progress.map((f) => f.data.params.progress);
    expect(values).to.deep.equal([...values].sort((a, b) => a - b));
    expect(new Set(values).size).to.equal(values.length);
    expect(progress.every((f) => f.event === "message" && f.data.params.progressToken === "t1")).to.equal(true);
    const last = frames[frames.length - 1];
    expect(last.data.id).to.equal(1);
    expect(last.data.result.content[0].text).to.equal("done");
  });

  it("sends keep-alive comments instead of progress without a token", async () => {
    const s = make(20);
    await s.start({ port: 0 }, slowTool);
    const res = await post(portOf(s), rpc("tools/call", { name: "list_installations", arguments: {} }), {
      Accept: "text/event-stream",
    });
    const frames = parseFrames(await res.text());
    expect(frames.filter((f) => f.comment === "keep-alive").length).to.be.at.least(2);
    expect(frames.some((f) => f.data?.method === "notifications/progress")).to.equal(false);
    expect(frames[frames.length - 1].data.result.content[0].text).to.equal("done");
  });

  it("answers tools/call as JSON without an SSE Accept", async () => {
    const s = make(20);
    await s.start({ port: 0 }, slowTool);
    const res = await post(portOf(s), rpc("tools/call", { name: "list_installations", arguments: {} }));
    expect(res.headers.get("content-type")).to.contain("application/json");
    expect((await res.json()).result.content[0].text).to.equal("done");
  });

  it("answers notifications with 202", async () => {
    const s = make();
    await s.start({ port: 0 }, slowTool);
    const res = await post(portOf(s), rpc("notifications/initialized", undefined, undefined));
    expect(res.status).to.equal(202);
  });

  it("start reports EADDRINUSE and can start again on another port", async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, "127.0.0.1", r));
    const busy = (blocker.address() as AddressInfo).port;
    try {
      const s = make();
      const failed = await s.start({ port: busy }, slowTool);
      expect(failed.listening).to.equal(false);
      expect(failed.error).to.contain("EADDRINUSE");
      expect(failed.url).to.equal(`http://127.0.0.1:${busy}/mcp`);
      const ok = await s.start({ port: 0 }, slowTool);
      expect(ok.listening).to.equal(true);
      expect(ok.url).to.match(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      expect((await post(portOf(s), rpc("ping"))).status).to.equal(200);
    } finally {
      await new Promise((r) => blocker.close(r));
    }
  });

  it("start while running restarts on the new config", async () => {
    const s = make();
    await s.start({ port: 0 }, slowTool);
    await s.start({ port: 0 }, slowTool);
    expect((await post(portOf(s), rpc("ping"))).status).to.equal(200);
    expect(s.status.listening).to.equal(true);
  });

  it("stop closes the port", async () => {
    const s = make();
    await s.start({ port: 0 }, slowTool);
    const port = portOf(s);
    await s.stop();
    expect(s.status.listening).to.equal(false);
    let failed = false;
    try {
      await post(port, rpc("ping"));
    } catch {
      failed = true;
    }
    expect(failed).to.equal(true);
  });
});
