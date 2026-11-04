import { AddonProvider } from "wowup-lib-core";

import {
  ADDON_PROVIDER_CURSEFORGE,
  ADDON_PROVIDER_WAGO,
  PREF_CF2_API_KEY,
  PREF_WAGO_ACCESS_KEY,
} from "../../common/constants";
import { CurseAddonProvider } from "../addon-providers/curse-addon-provider";
import { SensitiveStorageService } from "../services/storage/sensitive-storage.service";

// Everything the curseforge-mirror fork changes about providers lives here, so upstream merges only touch the
// one-line hooks that call into it:
//  - CurseForge is built into the wago flavor and runs on the user's own API key (Options > Addons).
//  - No ads are ever shown. Wago's public token comes from its ad page, so Wago runs only with a personal access key.

export const MIRROR_CURSEFORGE_PROVIDER = true;
export const MIRROR_ADS_ENABLED = false;

export interface MirrorProviderHooks {
  providers: Map<string, AddonProvider>;
  sensitiveStorage: SensitiveStorageService;
  /** Re-applies the user's saved enabled state */
  restoreState: (provider: AddonProvider) => Promise<void>;
  /** Tells the app a provider changed */
  notify: (provider: AddonProvider) => void;
}

const KEYED_PROVIDERS: Record<string, string> = {
  [ADDON_PROVIDER_CURSEFORGE]: PREF_CF2_API_KEY,
  [ADDON_PROVIDER_WAGO]: PREF_WAGO_ACCESS_KEY,
};

function isValidKey(key: unknown): key is string {
  return typeof key === "string" && key.trim().length > 20;
}

async function applyKey(provider: AddonProvider, key: unknown, hooks: MirrorProviderHooks): Promise<void> {
  provider.adRequired = false;
  if (provider instanceof CurseAddonProvider) {
    provider.setApiKey(isValidKey(key) ? key.trim() : "");
  }

  // A provider without a key can only fail, so it stays off until one is set
  if (!isValidKey(key)) {
    provider.enabled = false;
    return;
  }

  provider.enabled = true;
  await hooks.restoreState(provider);
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
