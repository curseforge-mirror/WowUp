import { timingSafeEqual } from "crypto";
import * as http from "http";
import { AddressInfo } from "net";

import { AgentStatus } from "../../../src/common/mirror/agent-contract";
import { CallTool, handleMcpMessage, JsonRpcNotification, JsonRpcResponse } from "./mcp-protocol";

const HOST = "127.0.0.1";
const MCP_PATH = "/mcp";
const MAX_BODY_BYTES = 1024 * 1024;
const ORIGIN_PATTERN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

export interface McpHttpServerOptions {
  /** How often a streamed tools/call emits a progress frame (or keep-alive comment). */
  progressIntervalMs?: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function keyMatches(header: string | undefined, key: string): boolean {
  if (!header || !header.startsWith("Bearer ")) {
    return false;
  }
  const given = Buffer.from(header.slice("Bearer ".length));
  const expected = Buffer.from(key);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(text),
    ...headers,
  });
  res.end(text);
}

function sendText(res: http.ServerResponse, status: number, text: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": "text/plain", ...headers });
  res.end(text);
}

export class McpHttpServer {
  private readonly progressIntervalMs: number;
  private server: http.Server | undefined;
  private current: AgentStatus = { listening: false, url: "" };

  public constructor(options: McpHttpServerOptions = {}) {
    this.progressIntervalMs = options.progressIntervalMs ?? 10000;
  }

  public get status(): AgentStatus {
    return { ...this.current };
  }

  public async start(config: { port: number; key: string }, callTool: CallTool): Promise<AgentStatus> {
    await this.stop();

    const requestedUrl = `http://${HOST}:${config.port}${MCP_PATH}`;
    const server = http.createServer((req, res) => {
      this.handleRequest(req, res, config.key, callTool).catch((e) => {
        if (!res.headersSent) {
          sendJson(res, 500, { jsonrpc: "2.0", id: null, error: { code: -32603, message: String(e) } });
        } else {
          res.end();
        }
      });
    });

    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, HOST, () => {
          server.off("error", reject);
          resolve();
        });
      });
    } catch (e) {
      server.close();
      this.server = undefined;
      this.current = {
        listening: false,
        url: requestedUrl,
        error: e instanceof Error ? e.message : String(e),
      };
      return this.status;
    }

    server.on("error", () => undefined);
    this.server = server;
    const port = (server.address() as AddressInfo).port;
    this.current = { listening: true, url: `http://${HOST}:${port}${MCP_PATH}` };
    return this.status;
  }

  public async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.current = { listening: false, url: this.current.url };
    if (!server) {
      return;
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  }

  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    key: string,
    callTool: CallTool,
  ): Promise<void> {
    const path = (req.url ?? "").split("?")[0];
    if (path !== MCP_PATH) {
      sendText(res, 404, "Not found");
      return;
    }
    if (req.method !== "POST") {
      sendText(res, 405, "Method not allowed", { Allow: "POST" });
      return;
    }
    const origin = req.headers.origin;
    if (origin !== undefined && origin !== "null" && !ORIGIN_PATTERN.test(origin)) {
      sendText(res, 403, "Forbidden origin");
      return;
    }
    if (!keyMatches(req.headers.authorization, key)) {
      sendText(res, 401, "Unauthorized", { "WWW-Authenticate": "Bearer" });
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(await readBody(req));
    } catch {
      sendJson(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }

    if (Array.isArray(message)) {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Batch requests are not supported" },
      });
      return;
    }

    const wantsSse = String(req.headers.accept ?? "").includes("text/event-stream");
    const isToolCall = isRecord(message) && message.method === "tools/call" && message.id !== undefined;
    if (wantsSse && isToolCall) {
      await this.streamToolCall(message, res, callTool);
      return;
    }

    const response = await handleMcpMessage(message, callTool);
    if (response === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    sendJson(res, 200, response);
  }

  private async streamToolCall(message: unknown, res: http.ServerResponse, callTool: CallTool): Promise<void> {
    const params = isRecord(message) && isRecord(message.params) ? message.params : {};
    const meta = isRecord(params._meta) ? params._meta : {};
    const token = meta.progressToken;
    const hasToken = typeof token === "string" || typeof token === "number";

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();

    let closed = false;
    res.on("close", () => {
      closed = true;
    });
    const write = (chunk: string): void => {
      if (!closed && !res.writableEnded) {
        res.write(chunk);
      }
    };
    const writeMessage = (m: JsonRpcNotification | JsonRpcResponse): void =>
      write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);

    // Our own counter keeps `progress` strictly increasing across forwarded and periodic frames.
    let counter = 0;
    let latest = "Working";
    const progressFrame = (text: string): JsonRpcNotification => {
      counter += 1;
      return {
        jsonrpc: "2.0",
        method: "notifications/progress",
        params: { progressToken: token, progress: counter, message: text },
      };
    };

    const timer = setInterval(() => {
      if (hasToken) {
        writeMessage(progressFrame(latest));
      } else {
        write(": keep-alive\n\n");
      }
    }, this.progressIntervalMs);

    try {
      const response = await handleMcpMessage(message, callTool, (n) => {
        const text = isRecord(n.params) && typeof n.params.message === "string" ? n.params.message : latest;
        latest = text;
        writeMessage(progressFrame(text));
      });
      if (response) {
        writeMessage(response);
      }
    } finally {
      clearInterval(timer);
      if (!res.writableEnded) {
        res.end();
      }
    }
  }
}
