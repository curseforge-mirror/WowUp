/* eslint-disable @typescript-eslint/require-await */
import { expect } from "chai";

import { AGENT_TOOLS } from "../../../src/common/mirror/agent-contract";
import { handleMcpMessage, JsonRpcNotification, MCP_SUPPORTED_VERSIONS } from "./mcp-protocol";

const noTool = async () => ({ text: "unused" });
const req = (method: string, params?: unknown, id = 1) => ({ jsonrpc: "2.0", id, method, params });

describe("mcp-protocol", () => {
  it("initialize echoes a supported version", async () => {
    const res = await handleMcpMessage(req("initialize", { protocolVersion: "2025-03-26" }), noTool);
    expect((res?.result as any).protocolVersion).to.equal("2025-03-26");
    expect((res?.result as any).capabilities).to.deep.equal({ tools: {} });
    expect((res?.result as any).serverInfo.name).to.equal("wowup");
  });

  it("initialize falls back to the newest version", async () => {
    const res = await handleMcpMessage(req("initialize", { protocolVersion: "1999-01-01" }), noTool);
    expect((res?.result as any).protocolVersion).to.equal(MCP_SUPPORTED_VERSIONS[0]);
  });

  it("notifications get no response", async () => {
    const res = await handleMcpMessage({ jsonrpc: "2.0", method: "notifications/initialized" }, noTool);
    expect(res).to.equal(undefined);
  });

  it("tools/list returns every AGENT_TOOLS entry", async () => {
    const res = await handleMcpMessage(req("tools/list"), noTool);
    const names = (res?.result as any).tools.map((t: any) => t.name);
    expect(names).to.deep.equal(AGENT_TOOLS.map((t) => t.name));
    expect(names.length).to.equal(29);
  });

  it("tools/call wraps the tool text", async () => {
    const res = await handleMcpMessage(req("tools/call", { name: "list_installations", arguments: {} }), async () => ({
      text: "hello",
    }));
    expect(res?.result).to.deep.equal({ content: [{ type: "text", text: "hello" }], isError: false });
  });

  it("tools/call marks tool errors with isError", async () => {
    const res = await handleMcpMessage(req("tools/call", { name: "rollback", arguments: {} }), async () => ({
      text: "bad",
      isError: true,
    }));
    expect((res?.result as any).isError).to.equal(true);
  });

  it("tools/call on an unknown tool is -32602", async () => {
    const res = await handleMcpMessage(req("tools/call", { name: "nope" }), noTool);
    expect(res?.error?.code).to.equal(-32602);
  });

  it("progress carries the client's progressToken", async () => {
    const seen: JsonRpcNotification[] = [];
    const tool = async (_n: string, _a: unknown, p: (m: string) => void) => {
      p("one");
      p("two");
      return { text: "done" };
    };
    await handleMcpMessage(
      req("tools/call", { name: "check_updates", arguments: {}, _meta: { progressToken: "tok" } }),
      tool,
      (n) => seen.push(n),
    );
    expect(seen.map((n) => n.params?.progressToken)).to.deep.equal(["tok", "tok"]);
    expect(seen.map((n) => n.params?.progress)).to.deep.equal([1, 2]);
    expect(seen[0].method).to.equal("notifications/progress");

    const none: JsonRpcNotification[] = [];
    await handleMcpMessage(req("tools/call", { name: "check_updates", arguments: {} }), tool, (n) => none.push(n));
    expect(none).to.have.length(0);
  });

  it("unknown method is -32601", async () => {
    const res = await handleMcpMessage(req("resources/list"), noTool);
    expect(res?.error?.code).to.equal(-32601);
  });

  it("garbage is -32600", async () => {
    expect((await handleMcpMessage("garbage", noTool))?.error?.code).to.equal(-32600);
    expect((await handleMcpMessage(null, noTool))?.error?.code).to.equal(-32600);
  });

  it("tools that change an installed addon take addonId or a provider and externalId", async () => {
    const tool = (name: string) =>
      AGENT_TOOLS.find((t) => t.name === name) as unknown as {
        inputSchema: { required?: string[]; properties: object };
      };
    for (const name of ["remove_addon", "set_auto_update", "set_ignored"]) {
      const schema = tool(name).inputSchema;
      expect(schema.required ?? [], name).to.not.include("addonId");
      expect(Object.keys(schema.properties), name).to.include.members(["addonId", "provider", "externalId"]);
    }
    for (const name of ["replace_addon", "switch_provider"]) {
      const schema = tool(name).inputSchema;
      expect(schema.required ?? [], name).to.not.include("addonId");
      expect(Object.keys(schema.properties), name).to.include.members([
        "addonId",
        "installedProvider",
        "installedExternalId",
      ]);
    }
  });
});
