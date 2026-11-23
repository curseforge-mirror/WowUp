import { AGENT_TOOLS, AgentToolResult } from "../../../src/common/mirror/agent-contract";

export type CallTool = (
  name: string,
  args: Record<string, unknown>,
  onProgress: (message: string) => void,
) => Promise<AgentToolResult>;

export const MCP_SUPPORTED_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

let serverVersion = "0.0.0";

/** Set the version reported in `serverInfo` (the main process passes the app version). */
export function setMcpServerVersion(version: string): void {
  serverVersion = version;
}

function ok(id: string | number | null, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export async function handleMcpMessage(
  message: unknown,
  callTool: CallTool,
  onProgress?: (n: JsonRpcNotification) => void,
): Promise<JsonRpcResponse | undefined> {
  if (!isRecord(message) || typeof message.method !== "string") {
    return fail(null, -32600, "Invalid Request");
  }

  const method = message.method;
  const hasId = typeof message.id === "string" || typeof message.id === "number";
  if (method.startsWith("notifications/") || !hasId) {
    // notifications (and any id-less message) never get a response
    return undefined;
  }
  const id = message.id as string | number;
  const params = isRecord(message.params) ? message.params : {};

  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      const protocolVersion =
        typeof requested === "string" && MCP_SUPPORTED_VERSIONS.includes(requested)
          ? requested
          : MCP_SUPPORTED_VERSIONS[0];
      return ok(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "wowup", version: serverVersion },
      });
    }
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, { tools: AGENT_TOOLS });
    case "tools/call": {
      const name = params.name;
      if (typeof name !== "string" || !AGENT_TOOLS.some((t) => t.name === name)) {
        return fail(id, -32602, `Unknown tool: ${String(name)}`);
      }
      const args = isRecord(params.arguments) ? params.arguments : {};
      const meta = isRecord(params._meta) ? params._meta : {};
      const token = meta.progressToken;
      const hasToken = typeof token === "string" || typeof token === "number";
      let progress = 0;
      const report = (text: string): void => {
        if (!hasToken || !onProgress) {
          return;
        }
        progress += 1;
        onProgress({
          jsonrpc: "2.0",
          method: "notifications/progress",
          params: { progressToken: token, progress, message: text },
        });
      };
      try {
        const result = await callTool(name, args, report);
        return ok(id, { content: [{ type: "text", text: result.text }], isError: result.isError === true });
      } catch (e) {
        const text = e instanceof Error ? e.message : String(e);
        return ok(id, { content: [{ type: "text", text }], isError: true });
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}
