import { Addon, getEnumName, WowClientType, WowInstallation } from "wowup-lib-core";

/** What the tools need to show installation names the way the UI does ("{defaultName}" labels become real names) */
export interface InstallationNameDeps {
  installService: {
    getWowInstallationsAsync(): Promise<WowInstallation[]>;
    getInstallationDisplayName(installation: WowInstallation): Promise<string>;
  };
  getSelected: () => WowInstallation | undefined;
}

/** Set `displayName` to the name the UI shows, since a stored label can be the raw "{defaultName}" template */
export async function nameInstallations(
  installService: InstallationNameDeps["installService"],
  installs: WowInstallation[],
): Promise<WowInstallation[]> {
  for (const i of installs) {
    i.displayName = await installService.getInstallationDisplayName(i);
  }
  return installs;
}

/** All installations, named for display */
export async function loadInstallations(deps: InstallationNameDeps): Promise<WowInstallation[]> {
  return nameInstallations(deps.installService, await deps.installService.getWowInstallationsAsync());
}

export async function resolveInstallationFor(deps: InstallationNameDeps, arg: unknown): Promise<WowInstallation> {
  const installs = await loadInstallations(deps);
  const selected = deps.getSelected();
  if (selected) {
    await nameInstallations(deps.installService, [selected]);
  }
  return resolveInstallation(arg, installs, selected);
}

function describe(i: WowInstallation): string {
  return `${i.id} (${i.displayName || i.label}, ${getEnumName(WowClientType, i.clientType)})`;
}

function list(items: WowInstallation[]): string {
  return items.map(describe).join("; ");
}

export function resolveInstallation(
  arg: unknown,
  installs: WowInstallation[],
  selected?: WowInstallation,
): WowInstallation {
  if (arg === undefined || arg === null || arg === "") {
    if (installs.length === 1) {
      return installs[0];
    }
    if (selected) {
      return selected;
    }
    if (installs.length === 0) {
      throw new Error("WowUp has no installations.");
    }
    throw new Error(`Several installations exist; pass \`installation\`. Choices: ${list(installs)}`);
  }

  const text = String(arg).trim();
  const lower = text.toLowerCase();

  const byId = installs.filter((i) => i.id === text);
  if (byId.length === 1) {
    return byId[0];
  }

  const byName = installs.filter(
    (i) => (i.displayName ?? "").toLowerCase() === lower || (i.label ?? "").toLowerCase() === lower,
  );
  if (byName.length === 1) {
    return byName[0];
  }
  if (byName.length > 1) {
    throw new Error(`"${text}" matches several installations: ${list(byName)}`);
  }

  const byType = installs.filter((i) => (getEnumName(WowClientType, i.clientType) ?? "").toLowerCase() === lower);
  if (byType.length === 1) {
    return byType[0];
  }
  if (byType.length > 1) {
    throw new Error(`"${text}" matches several installations: ${list(byType)}`);
  }

  throw new Error(`No installation matches "${text}". Choices: ${list(installs)}`);
}

export function resolveAddon(
  args: { addonId?: string; provider?: string; externalId?: string; name?: string },
  installed: Addon[],
): Addon {
  if (args.addonId) {
    const addon = installed.find((a) => a.id === args.addonId);
    if (!addon) {
      throw new Error(`No installed addon with id "${args.addonId}". Use list_addons to find ids.`);
    }
    return addon;
  }

  if (args.provider && args.externalId) {
    const provider = args.provider.toLowerCase();
    const addon = installed.find(
      (a) =>
        a.externalId === args.externalId &&
        ((a.providerName ?? "").toLowerCase() === provider ||
          (a.externalIds ?? []).some((e) => e.providerName.toLowerCase() === provider && e.id === args.externalId)),
    );
    if (!addon) {
      throw new Error(`No installed addon from ${args.provider} with externalId "${args.externalId}".`);
    }
    return addon;
  }

  const name = (args.name ?? "").toLowerCase();
  const matches = installed.filter((a) => name !== "" && a.name.toLowerCase().includes(name));
  const close = matches.slice(0, 10).map((a) => `${a.id} (${a.name}, ${a.providerName})`);
  throw new Error(
    "Pass addonId, or provider and externalId; names are not accepted." +
      (close.length > 0 ? ` Closest matches: ${close.join("; ")}` : ""),
  );
}
