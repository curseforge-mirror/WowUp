import { claudeCodeCommand, claudeDesktopConfig, genericConfig } from "./agent-setup";

describe("agent-setup", () => {
  const url = "http://127.0.0.1:17483/mcp";
  const key = "abc_DEF-123";

  it("setup strings carry the url and key", () => {
    expect(claudeCodeCommand(url, key)).toBe(
      `claude mcp add --transport http wowup ${url} --header "Authorization: Bearer ${key}"`,
    );
    expect(JSON.parse(claudeDesktopConfig(url, key))).toEqual({
      mcpServers: {
        wowup: { command: "npx", args: ["-y", "mcp-remote", url, "--header", `Authorization: Bearer ${key}`] },
      },
    });
    expect(JSON.parse(genericConfig(url, key))).toEqual({
      mcpServers: { wowup: { url, headers: { Authorization: `Bearer ${key}` } } },
    });
    expect(genericConfig(url, key)).toContain('\n  "mcpServers"');
  });
});
