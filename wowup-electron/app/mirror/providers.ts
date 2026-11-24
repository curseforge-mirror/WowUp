import { ADDON_PROVIDER_CURSEFORGE, ADDON_PROVIDER_WAGO, PREF_WAGO_ACCESS_KEY } from "../../src/common/constants";
import { isValidProviderKey } from "../../src/common/mirror/provider-keys";
import { AddonProviderConfig } from "../../src/common/models/addon-provider";

// curseforge-mirror: main's half of the provider rules; the renderer's half is src/app/mirror/mirror.ts.
//  - CurseForge is built into the wago flavor. Its key is the user's own, which the renderer puts in the config it
//    starts main's providers with (and restarts them with when the key changes).
//  - Wago runs only on a personal access key: its public token comes from its ad page, which never loads here.

/** Main's scans fingerprint folders for CurseForge too, as the overwolf flavor does */
export const MIRROR_CURSEFORGE_PROVIDER = true;

/**
 * Whether a provider has what the fork needs to run it: CurseForge and Wago need a key and stay off without one,
 * whatever the user chose. A keyless CurseForge can only fail, and a keyless Wago would wait out every request for
 * an ad page token. Main's scans and installs only use the providers this lets through.
 */
export function mirrorAllowsProvider(
  providerName: string,
  config: AddonProviderConfig,
  getSecret: (key: string) => unknown,
): boolean {
  switch (providerName) {
    case ADDON_PROVIDER_CURSEFORGE:
      return isValidProviderKey(config.curseforge.apiKey);
    case ADDON_PROVIDER_WAGO:
      return isValidProviderKey(getSecret(PREF_WAGO_ACCESS_KEY));
    default:
      return true;
  }
}
