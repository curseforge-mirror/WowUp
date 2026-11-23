export function claudeCodeCommand(url: string): string {
  return `claude mcp add --transport http wowup ${url}`;
}

/** Claude Desktop starts local commands only, so mcp-remote bridges it to the HTTP address */
export function claudeDesktopConfig(url: string): string {
  return JSON.stringify({ mcpServers: { wowup: { command: "npx", args: ["-y", "mcp-remote", url] } } }, null, 2);
}

export function genericConfig(url: string): string {
  return JSON.stringify({ mcpServers: { wowup: { url } } }, null, 2);
}
