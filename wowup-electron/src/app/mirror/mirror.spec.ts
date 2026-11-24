import { Subject } from "rxjs";
import { AddonProvider } from "wowup-lib-core";

import {
  ADDON_PROVIDER_CURSEFORGE,
  ADDON_PROVIDER_WAGO,
  PREF_CF2_API_KEY,
  PREF_WAGO_ACCESS_KEY,
} from "../../common/constants";
import { AddonProviderConfig } from "../../common/models/addon-provider";
import { StorageChangeEvent } from "../services/storage/storage.service";
import { SensitiveStorageService } from "../services/storage/sensitive-storage.service";
import { applyMirrorProviderRules, MirrorProviderHooks, mirrorProviderConfig } from "./mirror";

const CF_KEY = "a-curseforge-key-longer-than-twenty";
const WAGO_KEY = "a-wago-access-key-longer-than-twenty";

const buildConfig: AddonProviderConfig = {
  wowUpHubUrl: "https://hub.test",
  wowUpWebsiteUrl: "https://site.test",
  defaultHttpTimeoutMs: 1000,
  defaultHttpResetTimeoutMs: 1000,
  wowUpHubHttpTimeoutMs: 1000,
  wagoHttpTimeoutMs: 1000,
  featuredAddonsCacheTimeSec: 30,
  wago: { enabled: true },
  curseforge: { enabled: false, apiKey: "", httpTimeoutMs: 1000 },
};

describe("mirror provider rules", () => {
  let secrets: Record<string, unknown>;
  let change$: Subject<StorageChangeEvent>;
  let sensitiveStorage: SensitiveStorageService;
  let providers: Map<string, AddonProvider>;
  let hooks: MirrorProviderHooks;
  let restarts: AddonProviderConfig[];
  let restored: string[];
  let notified: string[];

  function standIn(name: string): AddonProvider {
    return { name, enabled: true, adRequired: true } as AddonProvider;
  }

  beforeEach(() => {
    secrets = {};
    change$ = new Subject<StorageChangeEvent>();
    sensitiveStorage = {
      getAsync: (key: string) => Promise.resolve(secrets[key]),
      change$: change$.asObservable(),
    } as unknown as SensitiveStorageService;
    providers = new Map([
      [ADDON_PROVIDER_WAGO, standIn(ADDON_PROVIDER_WAGO)],
      [ADDON_PROVIDER_CURSEFORGE, standIn(ADDON_PROVIDER_CURSEFORGE)],
    ]);
    restarts = [];
    restored = [];
    notified = [];
    hooks = {
      providers,
      sensitiveStorage,
      restart: (config) => {
        restarts.push(config);
        return Promise.resolve();
      },
      restoreState: (provider) => {
        restored.push(provider.name);
        return Promise.resolve();
      },
      notify: (provider) => notified.push(provider.name),
    };
  });

  async function saveKey(key: string, value: unknown): Promise<void> {
    change$.next({ key, value });
    // The rules apply a key off the change event; let their promises settle
    await new Promise((resolve) => setTimeout(resolve));
  }

  it("should start main's CurseForge on the user's own key", async () => {
    secrets[PREF_CF2_API_KEY] = `  ${CF_KEY} `;

    const config = await mirrorProviderConfig(sensitiveStorage, buildConfig);

    expect(config.curseforge).toEqual({ enabled: true, apiKey: CF_KEY, httpTimeoutMs: 1000 });
    expect(config.wowUpHubUrl).toBe(buildConfig.wowUpHubUrl);
  });

  it("should start main's CurseForge with no key when none is saved", async () => {
    secrets[PREF_CF2_API_KEY] = "too-short";

    const config = await mirrorProviderConfig(sensitiveStorage, {
      ...buildConfig,
      curseforge: { ...buildConfig.curseforge, apiKey: "a-build-time-key-longer-than-twenty" },
    });

    expect(config.curseforge.enabled).toBeTrue();
    expect(config.curseforge.apiKey).toBe("");
  });

  it("should keep providers without a key off and never ask for an ad", async () => {
    await mirrorProviderConfig(sensitiveStorage, buildConfig);

    await applyMirrorProviderRules(hooks);

    for (const provider of providers.values()) {
      expect(provider.enabled).withContext(provider.name).toBeFalse();
      expect(provider.adRequired).withContext(provider.name).toBeFalse();
    }
    expect(restored).toEqual([]);
    expect(restarts).toEqual([]);
  });

  it("should turn on providers with a key and restore the user's choice", async () => {
    secrets[PREF_CF2_API_KEY] = CF_KEY;
    secrets[PREF_WAGO_ACCESS_KEY] = WAGO_KEY;
    await mirrorProviderConfig(sensitiveStorage, buildConfig);

    await applyMirrorProviderRules(hooks);

    expect(providers.get(ADDON_PROVIDER_CURSEFORGE)?.enabled).toBeTrue();
    expect(providers.get(ADDON_PROVIDER_WAGO)?.enabled).toBeTrue();
    expect(restored).toEqual([ADDON_PROVIDER_CURSEFORGE, ADDON_PROVIDER_WAGO]);
    // Main already started on this key
    expect(restarts).toEqual([]);
  });

  it("should restart main's providers once for each new CurseForge key", async () => {
    await mirrorProviderConfig(sensitiveStorage, buildConfig);
    await applyMirrorProviderRules(hooks);

    await saveKey(PREF_CF2_API_KEY, CF_KEY);
    // The options page saves every field on each edit
    await saveKey(PREF_CF2_API_KEY, CF_KEY);

    expect(restarts.length).toBe(1);
    expect(restarts[0].curseforge).toEqual({ enabled: true, apiKey: CF_KEY, httpTimeoutMs: 1000 });
    expect(providers.get(ADDON_PROVIDER_CURSEFORGE)?.enabled).toBeTrue();
    expect(notified).toEqual([ADDON_PROVIDER_CURSEFORGE, ADDON_PROVIDER_CURSEFORGE]);

    await saveKey(PREF_CF2_API_KEY, "");

    expect(restarts.length).toBe(2);
    expect(restarts[1].curseforge.apiKey).toBe("");
    expect(providers.get(ADDON_PROVIDER_CURSEFORGE)?.enabled).toBeFalse();
  });

  it("should turn Wago on when its access key is saved, without restarting main", async () => {
    await mirrorProviderConfig(sensitiveStorage, buildConfig);
    await applyMirrorProviderRules(hooks);

    await saveKey(PREF_WAGO_ACCESS_KEY, WAGO_KEY);

    expect(providers.get(ADDON_PROVIDER_WAGO)?.enabled).toBeTrue();
    expect(providers.get(ADDON_PROVIDER_WAGO)?.adRequired).toBeFalse();
    expect(restarts).toEqual([]);
    expect(notified).toEqual([ADDON_PROVIDER_WAGO]);
  });
});
