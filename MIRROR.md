# curseforge-mirror/WowUp

WowUp with the CurseForge provider back, no ads and no tracking. It follows upstream WowUp releases.

## What's different

Every fork change is listed here. Upstream files only carry small hooks, so merges stay cheap.

| Change | Where |
| :--- | :--- |
| CurseForge provider built into the normal (wago) flavor, running on your own API key: Options > Addons > CurseForge API Key. Off until a key is set. | `wowup-electron/src/app/mirror/mirror.ts`, `curse-addon-provider.ts` (`setApiKey`), the options addon section template |
| No ad space is ever requested. Wago's public token comes from its ad page, so Wago runs only with a personal Wago access key (Options > Addons). | `mirror.ts` (`MIRROR_ADS_ENABLED`), `session.service.ts` |
| The main process cancels requests to ad, consent and telemetry hosts. | `wowup-electron/app/mirror/block-ads.ts` |
| The app updates from this repo's GitHub releases. Remote bundle updates are off and the shell trusts only our bundle key (`mirror-2026-a`). | `wowup-shell/scripts/set-flavor.js`, `scripts/build-shell.js`, `src/bundle-keys.ts` |
| Installers are unsigned (no WowUp LLC publisher pin), so Windows warns on first install. | `electron-build/electron-builder.json`, `electron-build/sign-windows.js` |

Keys never go in git or in builds. The app stores them in `%APPDATA%\WowUp\sensitive.json`, a plain JSON file.

## Taking an upstream release

```bash
git fetch upstream
git checkout master && git merge --ff-only upstream/master && git push origin master
git checkout mirror && git merge master && git push origin mirror
```

Conflicts, if any, land on the hook lines listed above. Keep both sides.

## Building locally

```bash
export BUNDLE_SIGNING_KEY="$(cat ~/.wowup-mirror/bundle-signing-key.pem)" BUNDLE_SIGNING_KEY_ID=mirror-2026-a
cd wowup-lib && npm install && npm run build
cd ../wowup-shell && npm install
cd ../wowup-electron && npm install && npm run build:prod
cd ../wowup-shell && npm run electron:publish:never   # installers land in wowup-shell/release/
```

Builds rewrite `wowup-electron/app/env/environment.ts` and `wowup-shell/package.json`. Don't commit those changes.

## Releasing

Run the **Mirror release (Windows)** workflow from the Actions tab. It drafts a release for the version in
`wowup-electron/package.json`. Publish the draft and installed apps pick it up.

The workflow needs the `BUNDLE_SIGNING_KEY` (PEM) and `BUNDLE_SIGNING_KEY_ID` (`mirror-2026-a`) secrets. The private
key also lives in `~/.wowup-mirror/`. If it's ever lost, generate a new one with
`node wowup-shell/scripts/generate-bundle-key.mts <id> <file>`, swap it into `bundle-keys.ts` and ship a release.
Installers carry both the shell and the bundle, so nothing is stranded.
