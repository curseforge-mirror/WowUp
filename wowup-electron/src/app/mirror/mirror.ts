import { AddonProvider } from "wowup-lib-core";

import {
  ADDON_PROVIDER_CURSEFORGE,
  ADDON_PROVIDER_WAGO,
  PREF_CF2_API_KEY,
  PREF_WAGO_ACCESS_KEY,
} from "../../common/constants";
import { isValidProviderKey } from "../../common/mirror/provider-keys";
import { AddonProviderConfig } from "../../common/models/addon-provider";
import { SensitiveStorageService } from "../services/storage/sensitive-storage.service";

// Everything the curseforge-mirror fork changes about providers in the renderer lives here (main's half is
// app/mirror/providers.ts), so upstream merges only touch the one-line hooks that call into it:
//  - CurseForge is built into the wago flavor and runs on the user's own API key (Options > Addons). The providers
//    run in main, so the key goes in the config main starts them with, and a new key starts them again.
//  - No ads are ever shown. Wago's public token comes from its ad page, so Wago runs only with a personal access key.

export const MIRROR_CURSEFORGE_PROVIDER = true;
export const MIRROR_ADS_ENABLED = false;

export interface MirrorProviderHooks {
  /** The renderer's stand-ins for main's providers */
  providers: Map<string, AddonProvider>;
  sensitiveStorage: SensitiveStorageService;
  /** Starts main's providers again with a new config (AddonProviderApiService.init) */
  restart: (config: AddonProviderConfig) => Promise<unknown>;
  /** Re-applies the user's saved enabled state */
  restoreState: (provider: AddonProvider) => Promise<void>;
  /** Tells the app a provider changed */
  notify: (provider: AddonProvider) => void;
}

const KEYED_PROVIDERS: Record<string, string> = {
  [ADDON_PROVIDER_CURSEFORGE]: PREF_CF2_API_KEY,
  [ADDON_PROVIDER_WAGO]: PREF_WAGO_ACCESS_KEY,
};

/** The config main's providers last started with */
let startedConfig: AddonProviderConfig | undefined;

function withCurseForgeKey(config: AddonProviderConfig, key: unknown): AddonProviderConfig {
  return {
    ...config,
    curseforge: {
      ...config.curseforge,
      enabled: config.curseforge.enabled || MIRROR_CURSEFORGE_PROVIDER,
      apiKey: isValidProviderKey(key) ? key.trim() : "",
    },
  };
}

/** The config main starts its providers with: this build's, with CurseForge on and on the user's own key */
export async function mirrorProviderConfig(
  sensitiveStorage: SensitiveStorageService,
  config: AddonProviderConfig,
): Promise<AddonProviderConfig> {
  let key: unknown;
  // Runs inside the app initializer, where a throw would stop the app from starting at all
  try {
    key = await sensitiveStorage.getAsync(PREF_CF2_API_KEY);
  } catch (e) {
    console.error("[mirror] failed to read the CurseForge key", e);
  }

  startedConfig = withCurseForgeKey(config, key);
  return startedConfig;
}

async function restartWithCurseForgeKey(key: unknown, hooks: MirrorProviderHooks): Promise<void> {
  if (startedConfig === undefined) {
    return;
  }

  // The options page saves every key on each edit; only a different CurseForge key is worth a restart
  const config = withCurseForgeKey(startedConfig, key);
  if (config.curseforge.apiKey === startedConfig.curseforge.apiKey) {
    return;
  }

  startedConfig = config;
  await hooks.restart(config);
}

async function applyKey(provider: AddonProvider, key: unknown, hooks: MirrorProviderHooks): Promise<void> {
  provider.adRequired = false;

  // A provider without a key can only fail, so it stays off until one is set. Set before anything is awaited: the
  // options page saves Wago's enabled state right after it saves the key.
  const hasKey = isValidProviderKey(key);
  provider.enabled = hasKey;

  if (provider.name === ADDON_PROVIDER_CURSEFORGE) {
    await restartWithCurseForgeKey(key, hooks);
  }

  if (hasKey) {
    await hooks.restoreState(provider);
  }
}

export async function applyMirrorProviderRules(hooks: MirrorProviderHooks): Promise<void> {
  for (const [name, prefKey] of Object.entries(KEYED_PROVIDERS)) {
    const provider = hooks.providers.get(name);
    if (provider === undefined) {
      continue;
    }

    // Runs inside the app initializer, where a throw would stop the app from starting at all
    try {
      await applyKey(provider, await hooks.sensitiveStorage.getAsync(prefKey), hooks);
    } catch (e) {
      provider.enabled = false;
      console.error(`[mirror] failed to apply the ${name} key`, e);
    }
  }

  hooks.sensitiveStorage.change$.subscribe((change) => {
    const name = Object.keys(KEYED_PROVIDERS).find((providerName) => KEYED_PROVIDERS[providerName] === change.key);
    const provider = name === undefined ? undefined : hooks.providers.get(name);
    if (provider === undefined) {
      return;
    }

    applyKey(provider, change.value, hooks)
      .then(() => hooks.notify(provider))
      .catch((e) => console.error(`[mirror] failed to apply the ${provider.name} key`, e));
  });
}
