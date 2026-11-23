/* eslint-disable @typescript-eslint/require-await */
import { expect } from "chai";

import { isWowRunning } from "./wow-process";

describe("wow process", () => {
  it("isWowRunning matches the executable name case-insensitively", async () => {
    const list = async () => ["explorer.exe", "WOW.exe", "chrome.exe"];
    expect(await isWowRunning("C:\\Games\\World of Warcraft\\_retail_\\Wow.EXE", list)).to.equal(true);
    expect(await isWowRunning("C:\\Games\\WoWClassic.exe", list)).to.equal(false);
  });

  it("isWowRunning assumes WoW is running when the process list fails", async () => {
    const list = async () => {
      throw new Error("boom");
    };
    expect(await isWowRunning("Wow.exe", list)).to.equal(true);
  });

  it("isWowRunning finds a macOS app bundle by its inner binary", async () => {
    // ps -A -o comm= lists each binary's full path, the bundle's inner one for an app
    const list = async () => [
      "/sbin/launchd",
      "/Applications/World of Warcraft/_retail_/World of Warcraft.app/Contents/MacOS/World of Warcraft",
    ];
    const retail = "/Applications/World of Warcraft/_retail_/World of Warcraft.app";
    expect(await isWowRunning(retail, list)).to.equal(true);
    expect(await isWowRunning(`${retail}/`, list)).to.equal(true);
    expect(
      await isWowRunning("/Applications/World of Warcraft/_classic_/World of Warcraft Classic.app", list),
    ).to.equal(false);

    // an inner binary named differently from its bundle still counts
    const renamed = async () => ["/Games/Wow/_classic_era_/WoW Classic.app/Contents/MacOS/World of Warcraft Classic"];
    expect(await isWowRunning("/Games/Wow/_classic_era_/WoW Classic.app", renamed)).to.equal(true);
  });
});
