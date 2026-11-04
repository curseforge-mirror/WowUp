import { BundlePublicKeys } from "../contract/bundle-manifest";

/**
 * Public keys whose signed bundle manifests the shell accepts, by key id. Keep the current key and the
 * next one here so the signing key can rotate without a shell release. Generate a key pair with
 * `node scripts/generate-bundle-key.mts <key-id> <private-key-file>`, which prints the entry to add.
 * Signatures aren't checked until bundle loading lands.
 */
export const BUNDLE_PUBLIC_KEYS: BundlePublicKeys = {
  // curseforge-mirror signing key; WowUp's keys are dropped so the shell never loads a stock bundle
  "mirror-2026-a":
    "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA7pm1qGBCjTPGdtcagMWx8ORZZp297fR9e8UzcjqeHUE=\n-----END PUBLIC KEY-----\n",
};
