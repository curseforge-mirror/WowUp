import { randomUUID } from "crypto";

import {
  AGENT_CHANNEL_CALL,
  AGENT_CHANNEL_PROGRESS,
  AGENT_CHANNEL_RESULT,
  AgentCallRequest,
  AgentCallResponse,
  AgentProgress,
  AgentToolResult,
} from "../../../src/common/mirror/agent-contract";
import { CallTool } from "./mcp-protocol";

export interface RelayTarget {
  send(channel: string, payload: unknown): void;
  isDestroyed(): boolean;
  once(event: "destroyed", cb: () => void): void;
}

export interface RelayIpc {
  on(channel: string, l: (e: unknown, p: any) => void): void;
}

export type RendererRelay = CallTool & { failAll(reason: string): void };

export const WINDOW_GONE_TEXT = "WowUp's window went away; try again";

interface Pending {
  resolve: (r: AgentToolResult) => void;
  onProgress: (message: string) => void;
}

export function createRendererRelay(target: RelayTarget, ipc: RelayIpc): RendererRelay {
  const pending = new Map<string, Pending>();

  const failAll = (reason: string): void => {
    const all = [...pending.values()];
    pending.clear();
    all.forEach((p) => p.resolve({ isError: true, text: reason }));
  };

  ipc.on(AGENT_CHANNEL_RESULT, (_e, response: AgentCallResponse) => {
    const p = response && pending.get(response.callId);
    if (!p) {
      return;
    }
    pending.delete(response.callId);
    p.resolve(response.result);
  });

  ipc.on(AGENT_CHANNEL_PROGRESS, (_e, progress: AgentProgress) => {
    pending.get(progress?.callId)?.onProgress(progress.message);
  });

  target.once("destroyed", () => failAll(WINDOW_GONE_TEXT));

  const relay = ((name, args, onProgress) => {
    if (target.isDestroyed()) {
      return Promise.resolve({ isError: true, text: WINDOW_GONE_TEXT });
    }
    const callId = randomUUID();
    return new Promise<AgentToolResult>((resolve) => {
      pending.set(callId, { resolve, onProgress });
      const request: AgentCallRequest = { callId, name, args };
      try {
        target.send(AGENT_CHANNEL_CALL, request);
      } catch {
        pending.delete(callId);
        resolve({ isError: true, text: WINDOW_GONE_TEXT });
      }
    });
  }) as RendererRelay;
  relay.failAll = failAll;
  return relay;
}
