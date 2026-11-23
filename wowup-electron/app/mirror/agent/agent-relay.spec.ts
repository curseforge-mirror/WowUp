import { expect } from "chai";

import {
  AGENT_CHANNEL_CALL,
  AGENT_CHANNEL_PROGRESS,
  AGENT_CHANNEL_RESULT,
} from "../../../src/common/mirror/agent-contract";
import { createRendererRelay, RELAY_TIMEOUT_MS } from "./agent-relay";

function setup(options?: { timeoutMs?: number }) {
  const sent: { channel: string; payload: any }[] = [];
  const listeners: Record<string, (e: unknown, p: any) => void> = {};
  let onDestroyed: () => void = () => undefined;
  const target = {
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
    isDestroyed: () => false,
    once: (_e: "destroyed", cb: () => void) => {
      onDestroyed = cb;
    },
  };
  const ipc = { on: (channel: string, l: (e: unknown, p: any) => void) => (listeners[channel] = l) };
  const relay = createRendererRelay(target, ipc, options);
  return { sent, listeners, relay, destroy: () => onDestroyed() };
}

describe("agent relay", () => {
  it("relay resolves the matching callId only", async () => {
    const { sent, listeners, relay } = setup();
    const a = relay("a", { x: 1 }, () => undefined);
    const b = relay("b", {}, () => undefined);
    expect(sent.map((s) => s.channel)).to.deep.equal([AGENT_CHANNEL_CALL, AGENT_CHANNEL_CALL]);
    expect(sent[0].payload.name).to.equal("a");
    const [idA, idB] = sent.map((s) => s.payload.callId);
    expect(idA).to.not.equal(idB);
    listeners[AGENT_CHANNEL_RESULT]({}, { callId: idB, result: { text: "B" } });
    expect(await b).to.deep.equal({ text: "B" });
    listeners[AGENT_CHANNEL_RESULT]({}, { callId: "unknown", result: { text: "?" } });
    listeners[AGENT_CHANNEL_RESULT]({}, { callId: idA, result: { text: "A" } });
    expect(await a).to.deep.equal({ text: "A" });
  });

  it("relay forwards progress to the right call", async () => {
    const { sent, listeners, relay } = setup();
    const pa: string[] = [];
    const pb: string[] = [];
    const a = relay("a", {}, (m) => pa.push(m));
    void relay("b", {}, (m) => pb.push(m));
    listeners[AGENT_CHANNEL_PROGRESS]({}, { callId: sent[0].payload.callId, message: "half" });
    expect(pa).to.deep.equal(["half"]);
    expect(pb).to.deep.equal([]);
    listeners[AGENT_CHANNEL_RESULT]({}, { callId: sent[0].payload.callId, result: { text: "ok" } });
    await a;
  });

  it("relay fails pending calls when the window goes away", async () => {
    const { relay, destroy } = setup();
    const a = relay("a", {}, () => undefined);
    destroy();
    expect(await a).to.deep.equal({ isError: true, text: "WowUp's window went away; try again" });
  });

  it("relay fails immediately when the window is already destroyed", async () => {
    const target = { send: () => undefined, isDestroyed: () => true, once: () => undefined };
    const relay = createRendererRelay(target, { on: () => undefined });
    expect((await relay("a", {}, () => undefined)).isError).to.equal(true);
  });

  it("relay gives up on a call WowUp doesn't answer within 30 minutes", async () => {
    expect(RELAY_TIMEOUT_MS).to.equal(30 * 60 * 1000);
    const { sent, listeners, relay } = setup({ timeoutMs: 20 });
    const res = await relay("update_addons", {}, () => undefined);
    expect(res.isError).to.equal(true);
    expect(res.text).to.match(/did not answer.*list_backups/);

    // a late answer is dropped
    listeners[AGENT_CHANNEL_RESULT]({}, { callId: sent[0].payload.callId, result: { text: "late" } });

    // an answered call isn't failed later
    const answered = relay("list_addons", {}, () => undefined);
    listeners[AGENT_CHANNEL_RESULT]({}, { callId: sent[1].payload.callId, result: { text: "ok" } });
    expect(await answered).to.deep.equal({ text: "ok" });
    await new Promise((r) => setTimeout(r, 40));
  });
});
