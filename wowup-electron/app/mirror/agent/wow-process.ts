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
  const out = await exec("ps", ["-A", "-o", "comm="]);
  return out
    .split(/\r?\n/)
    .map((l) => l.trim().split("/").pop() ?? "")
    .filter((n) => n.length > 0);
};

export async function isWowRunning(
  executablePath: string,
  lister: ProcessLister = listRunningProcessNames,
): Promise<boolean> {
  try {
    const wanted = (executablePath.split(/[\\/]/).pop() ?? "").toLowerCase();
    if (wanted.length === 0) {
      return false;
    }
    const names = await lister();
    return names.some((n) => n.toLowerCase() === wanted);
  } catch (e) {
    log.warn("[agent] could not list processes", e);
    return false;
  }
}
