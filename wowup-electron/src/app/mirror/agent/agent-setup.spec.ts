import { claudeCodeCommand, claudeDesktopConfig, genericConfig } from "./agent-setup";

describe("agent-setup", () => {
  const url = "http://127.0.0.1:17483/mcp";

  it("setup strings carry the url and no key", () => {
    expect(claudeCodeCommand(url)).toBe(`claude mcp add --transport http wowup ${url}`);
    expect(JSON.parse(claudeDesktopConfig(url))).toEqual({
      mcpServers: { wowup: { command: "npx", args: ["-y", "mcp-remote", url] } },
    });
    expect(JSON.parse(genericConfig(url))).toEqual({ mcpServers: { wowup: { url } } });
    expect(genericConfig(url)).toBe(JSON.stringify({ mcpServers: { wowup: { url } } }, null, 2));
  });
});
