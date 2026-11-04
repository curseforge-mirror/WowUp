import { app, session, Session } from "electron";
import * as log from "electron-log/main";

// curseforge-mirror: no ad, consent or telemetry request leaves the app, whatever session or page makes it. The
// code paths that would ask for them are already off (src/app/mirror/mirror.ts); this is the backstop.
const BLOCKED_URLS = [
  // Wago's ad page, which is also what hands out its public api token. The api itself is /api/external.
  "*://addons.wago.io/wowup_ad*",
  "*://*.nitropay.com/*",
  "*://*.overwolf.com/*",
  "*://*.doubleclick.net/*",
  "*://*.googlesyndication.com/*",
  "*://*.googleadservices.com/*",
  "*://*.googletagservices.com/*",
  "*://*.googletagmanager.com/*",
  "*://*.google-analytics.com/*",
  "*://fundingchoicesmessages.google.com/*",
  "*://*.amazon-adsystem.com/*",
  "*://*.adnxs.com/*",
  "*://*.pubmatic.com/*",
  "*://*.rubiconproject.com/*",
  "*://*.criteo.com/*",
  "*://*.quantserve.com/*",
  "*://*.quantcast.com/*",
  "*://*.consensu.org/*",
  "*://*.applicationinsights.azure.com/*",
  "*://dc.services.visualstudio.com/*",
  "*://js.monitor.azure.com/*",
];

const blockedHosts = new Set<string>();

function blockIn(target: Session): void {
  target.webRequest.onBeforeRequest({ urls: BLOCKED_URLS }, (details, callback) => {
    const host = new URL(details.url).host;
    if (!blockedHosts.has(host)) {
      blockedHosts.add(host);
      log.info(`[mirror] blocking requests to ${host}`);
    }
    callback({ cancel: true });
  });
}

export function blockAds(): void {
  app.on("session-created", blockIn);
  app
    .whenReady()
    .then(() => blockIn(session.defaultSession))
    .catch((e) => log.error("[mirror] failed to install the ad blocklist", e));
}
