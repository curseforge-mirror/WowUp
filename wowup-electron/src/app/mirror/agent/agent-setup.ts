export function claudeCodeCommand(url: string, key: string): string {
  return `claude mcp add --transport http wowup ${url} --header "Authorization: Bearer ${key}"`;
}

/**
 * mcp-remote's documented form for Claude Desktop: on Windows it doesn't keep an argument containing a space in one
 * piece, so the header argument has none and mcp-remote fills in "Bearer <key>" from env
 */
export function claudeDesktopConfig(url: string, key: string): string {
  return JSON.stringify(
    {
      mcpServers: {
        wowup: {
          command: "npx",
          args: ["-y", "mcp-remote", url, "--header", "Authorization:${AUTH_HEADER}"],
          env: { AUTH_HEADER: `Bearer ${key}` },
        },
      },
    },
    null,
    2,
  );
}

export function genericConfig(url: string, key: string): string {
  return JSON.stringify({ mcpServers: { wowup: { url, headers: { Authorization: `Bearer ${key}` } } } }, null, 2);
}
