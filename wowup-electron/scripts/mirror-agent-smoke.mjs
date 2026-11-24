// Smoke test client for WowUp's agent control (MCP over streamable HTTP), with no dependencies.
// Runs initialize, notifications/initialized and tools/list, then optionally one tools/call.
//
//   node scripts/mirror-agent-smoke.mjs <url> [toolName] [jsonArgs | @args.json]
//
//   node scripts/mirror-agent-smoke.mjs http://127.0.0.1:17483/mcp
//   node scripts/mirror-agent-smoke.mjs http://127.0.0.1:17483/mcp search_addons '{"query":"tiptac"}'
//
// The url is shown in Options -> Addons -> Let AI agents control WowUp (MCP). Tool calls ask for an
// SSE stream and send a progress token, so progress messages print as they arrive. Exits 1 on any failure,
// including a tool result with isError: true.

import { readFileSync } from "node:fs";

const PROTOCOL_VERSION = "2025-06-18";
const [url, toolName, rawArgs] = process.argv.slice(2);

if (!url) {
  console.error("Usage: node scripts/mirror-agent-smoke.mjs <url> [toolName] [jsonArgs | @args.json]");
  process.exit(2);
}

let nextId = 1;
let sessionId;
let negotiatedVersion;

function parseArgs(text) {
  if (text === undefined || text === "") {
    return {};
  }
  const json = text.startsWith("@") ? readFileSync(text.slice(1), "utf8") : text;
  const args = JSON.parse(json);
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return args;
}

function headers() {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) {
    h["Mcp-Session-Id"] = sessionId;
  }
  if (negotiatedVersion) {
    h["MCP-Protocol-Version"] = negotiatedVersion;
  }
  return h;
}

function printProgress(message) {
  const p = message.params ?? {};
  const total = p.total !== undefined ? `/${p.total}` : "";
  console.log(`  progress ${p.progress}${total}: ${p.message ?? ""}`);
}

/** Yields each JSON-RPC message of an SSE body (`data:` lines of one event joined by newlines). */
async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  const flush = function* () {
    if (data.length > 0) {
      const text = data.join("\n");
      data = [];
      yield JSON.parse(text);
    }
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline;
    while ((newline = buffer.search(/\r?\n/)) !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + (buffer[newline] === "\r" ? 2 : 1));
      if (line === "") {
        yield* flush();
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""));
      }
      // event:, id:, retry: and ":" comments (keep-alives) carry nothing we need
    }
  }
  yield* flush();
}

/** Sends one JSON-RPC message. Requests resolve to their response; notifications resolve to undefined. */
async function rpc(method, params, isNotification = false) {
  const message = { jsonrpc: "2.0", method };
  if (params !== undefined) {
    message.params = params;
  }
  const id = isNotification ? undefined : nextId++;
  if (id !== undefined) {
    message.id = id;
  }

  const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(message) });
  sessionId = res.headers.get("mcp-session-id") ?? sessionId;
  if (!res.ok) {
    throw new Error(`${method}: HTTP ${res.status} ${res.statusText} ${await res.text()}`.trim());
  }
  if (isNotification) {
    await res.body?.cancel();
    return undefined;
  }

  const type = res.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) {
    for await (const m of readSse(res.body)) {
      if (m.method === "notifications/progress") {
        printProgress(m);
      } else if (m.id === id) {
        return m;
      } else if (m.method) {
        console.log(`  notification ${m.method}`);
      }
    }
    throw new Error(`${method}: the event stream ended without a response`);
  }
  if (type.includes("application/json")) {
    return await res.json();
  }
  throw new Error(`${method}: unexpected content type "${type}"`);
}

function unwrap(method, response) {
  if (response.error) {
    throw new Error(`${method}: JSON-RPC error ${response.error.code}: ${response.error.message}`);
  }
  return response.result;
}

function printText(text) {
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

async function main() {
  const args = parseArgs(rawArgs);

  const init = unwrap(
    "initialize",
    await rpc("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "mirror-agent-smoke", version: "1.0.0" },
    }),
  );
  negotiatedVersion = init.protocolVersion;
  console.log(
    `initialize OK: ${init.serverInfo?.name} ${init.serverInfo?.version}, protocol ${init.protocolVersion}` +
      (sessionId ? `, session ${sessionId}` : ""),
  );

  await rpc("notifications/initialized", undefined, true);

  const { tools } = unwrap("tools/list", await rpc("tools/list", {}));
  console.log(`tools/list: ${tools.length} tools`);
  console.log(`  ${tools.map((t) => t.name).join(", ")}`);

  if (!toolName) {
    return 0;
  }

  console.log(`tools/call ${toolName} ${JSON.stringify(args)}`);
  const started = Date.now();
  const result = unwrap(
    "tools/call",
    await rpc("tools/call", { name: toolName, arguments: args, _meta: { progressToken: `smoke-${Date.now()}` } }),
  );
  console.log(`result (${Date.now() - started} ms${result.isError ? ", isError" : ""}):`);
  for (const item of result.content ?? []) {
    if (item.type === "text") {
      printText(item.text);
    } else {
      console.log(`[${item.type} content]`);
    }
  }
  return result.isError ? 1 : 0;
}

// exitCode rather than process.exit(): exiting while fetch's sockets close trips a libuv assertion on Windows
main().then(
  (code) => {
    process.exitCode = code;
  },
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);
