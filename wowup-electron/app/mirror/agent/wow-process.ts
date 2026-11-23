import { execFile } from "child_process";
import * as log from "electron-log/main";

export type ProcessLister = () => Promise<string[]>;

function exec(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (err, stdout) =>
      err ? reject(err) : resolve(stdout),
    );
  });
}

export const listRunningProcessNames: ProcessLister = async () => {
  if (process.platform === "win32") {
    const out = await exec("tasklist", ["/FO", "CSV", "/NH"]);
    return out
      .split(/\r?\n/)
      .map((line) => /^"([^"]*)"/.exec(line)?.[1] ?? "")
      .filter((n) => n.length > 0);
  }
  // Each process's binary, as a full path on macOS (kept whole, so an app bundle can be told by its path)
  const out = await exec("ps", ["-A", "-o", "comm="]);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((n) => n.length > 0);
};

/**
 * Whether the installation's game is running, by its executable's name. On macOS the installation points at the app
 * bundle ("World of Warcraft.app") while the process is its inner binary
 * (".../World of Warcraft.app/Contents/MacOS/World of Warcraft"), so both are matched.
 */
export async function isWowRunning(
  executablePath: string,
  lister: ProcessLister = listRunningProcessNames,
): Promise<boolean> {
  try {
    const base = (
      executablePath
        .replace(/[\\/]+$/, "")
        .split(/[\\/]/)
        .pop() ?? ""
    ).toLowerCase();
    if (base.length === 0) {
      return false;
    }
    const bundle = base.endsWith(".app") ? base : undefined;
    const wanted = bundle ? base.slice(0, -".app".length) : base;
    const names = await lister();
    return names.some((n) => {
      const lower = n.toLowerCase();
      const name = lower.split(/[\\/]/).pop() ?? "";
      return name === wanted || (bundle !== undefined && lower.includes(`/${bundle}/contents/macos/`));
    });
  } catch (e) {
    log.warn("[agent] could not list processes; assuming WoW is running, SavedVariables will wait", e);
    return true;
  }
}
