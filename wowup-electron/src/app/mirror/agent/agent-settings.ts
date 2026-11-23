import { join } from "path";

export const PREF_AGENT_ENABLED = "mirror_agent_enabled";
export const PREF_AGENT_PORT = "mirror_agent_port";
export const SENSITIVE_AGENT_KEY = "mirror_agent_key";

export const AGENT_SANDBOX_DIR = "agent-sandbox";
export const AGENT_BACKUPS_DIR = "agent-backups";

/** 32 random bytes as base64url */
export function newAgentKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function agentDataPath(appFolder: string, dir: string): string {
  return join(appFolder, dir);
}

export function agentSandboxPath(appFolder: string): string {
  return agentDataPath(appFolder, AGENT_SANDBOX_DIR);
}

export function agentBackupsPath(appFolder: string): string {
  return agentDataPath(appFolder, AGENT_BACKUPS_DIR);
}
