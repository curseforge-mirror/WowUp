import { app, BrowserWindow, ipcMain, net } from "electron";
import * as log from "electron-log/main";
import * as path from "path";

import {
  AGENT_CHANNEL_CONFIGURE,
  AGENT_CHANNEL_DOWNLOAD,
  AGENT_CHANNEL_WOW_RUNNING,
  AGENT_SANDBOX_DIR,
  AgentConfig,
  AgentDownloadRequest,
} from "../../../src/common/mirror/agent-contract";
import { downloadToSandbox } from "./agent-download";
import { createRendererRelay, RendererRelay, WINDOW_GONE_TEXT } from "./agent-relay";
import { McpHttpServer } from "./mcp-http-server";
import { setMcpServerVersion } from "./mcp-protocol";
import { isWowRunning } from "./wow-process";

const server = new McpHttpServer();
let relay: RendererRelay | undefined;
let chain: Promise<unknown> = Promise.resolve();
let listeners: { channel: string; l: (e: any, p: any) => void }[] = [];

function dropListeners(): void {
  listeners.forEach(({ channel, l }) => ipcMain.removeListener(channel, l));
  listeners = [];
}

export function initializeAgent(win: BrowserWindow): void {
  setMcpServerVersion(app.getVersion());
  dropListeners();

  const webContents = win.webContents;
  const ipc = {
    on: (channel: string, l: (e: unknown, p: any) => void) => {
      const wrapped = (e: any, p: any) => {
        if (e?.sender === webContents) {
          l(e, p);
        }
      };
      listeners.push({ channel, l: wrapped });
      ipcMain.on(channel, wrapped);
    },
  };
  const current = createRendererRelay(
    {
      send: (channel, payload) => webContents.send(channel, payload),
      isDestroyed: () => win.isDestroyed() || webContents.isDestroyed(),
      once: (_event, cb) => win.once("closed", cb),
    },
    ipc,
  );
  relay = current;

  webContents.on("did-start-loading", () => current.failAll(WINDOW_GONE_TEXT));
  win.once("closed", () => {
    current.failAll(WINDOW_GONE_TEXT);
    if (relay === current) {
      dropListeners();
      chain = chain.then(() => server.stop()).catch((e) => log.error("[agent] stop failed", e));
    }
  });

  ipcMain.removeHandler(AGENT_CHANNEL_CONFIGURE);
  ipcMain.handle(AGENT_CHANNEL_CONFIGURE, (_e, config: AgentConfig) => {
    const run = chain.then(async () => {
      if (config.enabled) {
        return server.start(config, (name, args, onProgress) =>
          relay ? relay(name, args, onProgress) : Promise.resolve({ isError: true, text: WINDOW_GONE_TEXT }),
        );
      }
      await server.stop();
      return server.status;
    });
    chain = run.catch((e) => log.error("[agent] configure failed", e));
    return run;
  });

  ipcMain.removeHandler(AGENT_CHANNEL_WOW_RUNNING);
  ipcMain.handle(AGENT_CHANNEL_WOW_RUNNING, (_e, exe: string) => isWowRunning(exe));

  const sandboxPath = path.join(app.getPath("userData"), AGENT_SANDBOX_DIR);
  ipcMain.removeHandler(AGENT_CHANNEL_DOWNLOAD);
  ipcMain.handle(AGENT_CHANNEL_DOWNLOAD, (e, request: AgentDownloadRequest) => {
    if (e.sender !== webContents) {
      throw new Error("Agent downloads come from WowUp's window only");
    }
    return downloadToSandbox(sandboxPath, request, { net, log });
  });
}
