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

  it("resolveInstallationFor takes WowUp's named list as it is and the selected installation from it", async () => {
    // getWowInstallationsAsync names each installation already ({defaultName} labels become real names)
    const named = { ...inst("a9", "{defaultName}", WowClientType.Forever), displayName: "World of Warcraft: Forever" };
    const getInstallationDisplayName = jasmine.createSpy("getInstallationDisplayName");
    // the session's copy can still carry the template
    let selected: WowInstallation | undefined = { ...named, displayName: "{defaultName}" };
    const deps = {
      installService: {
        getWowInstallationsAsync: async () => [named, inst("a1", "Main", WowClientType.Retail)],
        getInstallationDisplayName,
      },
      getSelected: () => selected,
    };
    expect((await resolveInstallationFor(deps, "World of Warcraft: Forever")).id).toBe("a9");
    await expectAsync(resolveInstallationFor(deps, "nope")).toBeRejectedWithError(/World of Warcraft: Forever/);
    const byDefault = await resolveInstallationFor(deps, undefined);
    expect(byDefault.id).toBe("a9");
    expect(byDefault.displayName).toBe("World of Warcraft: Forever");
    expect(getInstallationDisplayName).not.toHaveBeenCalled();

    // a selected installation missing from the list is named, keeping its stored name when naming fails
    selected = inst("gone", "Old", WowClientType.Retail);
    getInstallationDisplayName.and.rejectWith(new Error("no translations yet"));
    expect((await resolveInstallationFor(deps, undefined)).displayName).toBe("Old");
    getInstallationDisplayName.and.resolveTo("Renamed");
    expect((await resolveInstallationFor(deps, undefined)).displayName).toBe("Renamed");
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
