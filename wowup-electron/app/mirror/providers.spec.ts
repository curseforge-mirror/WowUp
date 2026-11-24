import { expect } from "chai";

import {
  ADDON_PROVIDER_CURSEFORGE,
  ADDON_PROVIDER_GITHUB,
  ADDON_PROVIDER_WAGO,
  PREF_WAGO_ACCESS_KEY,
} from "../../src/common/constants";
import { AddonProviderConfig } from "../../src/common/models/addon-provider";
import { AddonProviderRegistry, UserProviderState } from "../services/addon-providers/addon-provider-registry";
import { mirrorAllowsProvider } from "./providers";

const CF_KEY = "a-curseforge-key-longer-than-twenty";
const WAGO_KEY = "a-wago-access-key-longer-than-twenty";

function config(cfKey: string): AddonProviderConfig {
  return {
    wowUpHubUrl: "https://hub.test",
    wowUpWebsiteUrl: "https://site.test",
    defaultHttpTimeoutMs: 1000,
    defaultHttpResetTimeoutMs: 1000,
    wowUpHubHttpTimeoutMs: 1000,
    wagoHttpTimeoutMs: 1000,
    featuredAddonsCacheTimeSec: 30,
    wago: { enabled: true },
    curseforge: { enabled: true, apiKey: cfKey, httpTimeoutMs: 1000 },
  };
}

function createRegistry(cfKey: string, secrets: Record<string, string>, userStates: UserProviderState[]) {
  return new AddonProviderRegistry({
    config: config(cfKey),
    fetch: () => Promise.reject(new Error("no network in this test")),
    installId: "install-1",
    platform: "win32",
    getAddonFolderPath: () => "C:/wow/Interface/AddOns",
    listTocFiles: () => Promise.resolve([]),
    parseToc: () => Promise.reject(new Error("no tocs here")),
    getLatestDirUpdateTime: () => Promise.resolve(0),
    newId: () => "new-id",
    getSecret: (key) => secrets[key],
    onSecretChange: () => () => undefined,
    onWagoToken: () => () => undefined,
    onPowerResume: () => () => undefined,
    reloadAd: () => undefined,
    getUserProviderStates: () => userStates,
    log: { info: () => undefined, error: () => undefined },
  });
}

describe("mirrorAllowsProvider", () => {
  const noSecrets = () => undefined;

  it("lets CurseForge run only on the key in the config", () => {
    expect(mirrorAllowsProvider(ADDON_PROVIDER_CURSEFORGE, config(CF_KEY), noSecrets)).to.equal(true);
    expect(mirrorAllowsProvider(ADDON_PROVIDER_CURSEFORGE, config(""), noSecrets)).to.equal(false);
    expect(mirrorAllowsProvider(ADDON_PROVIDER_CURSEFORGE, config("short"), noSecrets)).to.equal(false);
  });

  it("lets Wago run only on a saved personal access key", () => {
    const withKey = (key: string) => (key === PREF_WAGO_ACCESS_KEY ? WAGO_KEY : undefined);

    expect(mirrorAllowsProvider(ADDON_PROVIDER_WAGO, config(""), withKey)).to.equal(true);
    expect(mirrorAllowsProvider(ADDON_PROVIDER_WAGO, config(""), noSecrets)).to.equal(false);
  });

  it("leaves every other provider alone", () => {
    expect(mirrorAllowsProvider(ADDON_PROVIDER_GITHUB, config(""), noSecrets)).to.equal(true);
  });
});

describe("AddonProviderRegistry with the mirror rules", () => {
  let consoleDebug: typeof console.debug;
  beforeEach(() => {
    consoleDebug = console.debug;
    console.debug = () => undefined;
  });
  afterEach(() => {
    console.debug = consoleDebug;
  });

  it("keeps keyless CurseForge and Wago out of scans even when the user turned them on", () => {
    const registry = createRegistry("", {}, [
      { providerName: ADDON_PROVIDER_CURSEFORGE.toLowerCase(), enabled: true },
      { providerName: ADDON_PROVIDER_WAGO.toLowerCase(), enabled: true },
    ]);

    expect(registry.isEnabled(ADDON_PROVIDER_CURSEFORGE)).to.equal(false);
    expect(registry.isEnabled(ADDON_PROVIDER_WAGO)).to.equal(false);
    const enabled = registry.getEnabledProviders().map((p) => p.name);
    expect(enabled).not.to.include(ADDON_PROVIDER_CURSEFORGE);
    expect(enabled).not.to.include(ADDON_PROVIDER_WAGO);
  });

  it("runs them on their keys, still honouring the user's choice", () => {
    const secrets = { [PREF_WAGO_ACCESS_KEY]: WAGO_KEY };

    expect(createRegistry(CF_KEY, secrets, []).isEnabled(ADDON_PROVIDER_CURSEFORGE)).to.equal(true);
    expect(createRegistry(CF_KEY, secrets, []).isEnabled(ADDON_PROVIDER_WAGO)).to.equal(true);
    const turnedOff = createRegistry(CF_KEY, secrets, [
      { providerName: ADDON_PROVIDER_CURSEFORGE.toLowerCase(), enabled: false },
    ]);
    expect(turnedOff.isEnabled(ADDON_PROVIDER_CURSEFORGE)).to.equal(false);
  });
});
