// curseforge-mirror: shared by the renderer's provider rules (src/app/mirror/mirror.ts) and main's
// (app/mirror/providers.ts), so both sides agree on when a provider has a key.

/** A key worth running a provider on. Anything shorter is a cleared or half-typed field, as Wago checks too. */
export function isValidProviderKey(key: unknown): key is string {
  return typeof key === "string" && key.trim().length > 20;
}
