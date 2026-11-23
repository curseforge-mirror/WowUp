export function claudeCodeCommand(url: string, key: string): string {
  return `claude mcp add --transport http wowup ${url} --header "Authorization: Bearer ${key}"`;
}

export function claudeDesktopConfig(url: string, key: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        wowup: { command: "npx", args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${key}`] },
      },
    },
    null,
    2,
  );
}

export function genericConfig(url: string, key: string): string {
  return JSON.stringify({ mcpServers: { wowup: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
}
