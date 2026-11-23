/* eslint-disable */
import { Addon, WowClientType, WowInstallation } from "wowup-lib-core";

import { resolveAddon, resolveInstallation, resolveInstallationFor } from "./resolve";

const inst = (id: string, label: string, clientType: WowClientType): WowInstallation =>
  ({ id, label, displayName: label, clientType, location: "", selected: false }) as WowInstallation;

describe("resolve", () => {
  const installs = [
    inst("a1", "Main", WowClientType.Retail),
    inst("a2", "Main", WowClientType.ClassicEra),
    inst("a3", "Ascension", WowClientType.Forever),
  ];

  it("resolve rejects ambiguous names", () => {
    expect(() => resolveInstallation("main", installs)).toThrowError(/several installations.*a1.*a2/);
    expect(() => resolveInstallation("zzz", installs)).toThrowError(/Choices: .*a3/);
  });

  it("resolve finds an installation by client type", () => {
    expect(resolveInstallation("forever", installs).id).toBe("a3");
    expect(resolveInstallation("a2", installs).id).toBe("a2");
    expect(resolveInstallation("ascension", installs).id).toBe("a3");
  });

  it("resolveInstallationFor matches the rendered display name of a {defaultName} label", async () => {
    const raw = inst("a9", "{defaultName}", WowClientType.Forever);
    const deps = {
      installService: {
        getWowInstallationsAsync: async () => [raw, inst("a1", "Main", WowClientType.Retail)],
        getInstallationDisplayName: async (i: WowInstallation) =>
          i.label === "{defaultName}" ? "World of Warcraft: Forever" : i.label,
      },
      getSelected: () => undefined,
    };
    expect((await resolveInstallationFor(deps, "World of Warcraft: Forever")).id).toBe("a9");
    await expectAsync(resolveInstallationFor(deps, "nope")).toBeRejectedWithError(/World of Warcraft: Forever/);
  });

  it("resolve refuses a bare addon name and lists matches", () => {
    const addons = [
      { id: "x1", name: "Details", providerName: "Curse", externalId: "1" },
      { id: "x2", name: "Details Plus", providerName: "GitHub", externalId: "2" },
    ] as Addon[];
    expect(() => resolveAddon({ name: "details" } as any, addons)).toThrowError(/x1.*x2/);
    expect(resolveAddon({ addonId: "x2" }, addons).name).toBe("Details Plus");
    expect(resolveAddon({ provider: "curse", externalId: "1" }, addons).id).toBe("x1");
  });
});
