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
});
