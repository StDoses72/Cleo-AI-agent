import { dirname, join } from "node:path";
import { desktopDataHome } from "./platform.mjs";

/** The GitHub repository that publishes official Cleo releases. */
export const RELEASE_REPOSITORY = "StDoses72/Cleo-AI-agent";

export const alphaTagPattern = /^alpha-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const versionTagPattern = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

/** Input: a package or build version. Output: whether it belongs to the alpha channel. */
export function isAlphaVersion(version) {
  return typeof version === "string" && version.endsWith("-alpha");
}

/** Input: whether the alpha channel runs. Output: the AppUserModelID Windows groups its windows, pins and shortcuts by. */
export function appUserModelId(alpha) {
  return alpha ? "ai.cleo.desktop.alpha" : "ai.cleo.desktop";
}

export function versionForReleaseTag(tag) {
  const alpha = alphaTagPattern.exec(tag);
  return alpha ? `${alpha[1]}-alpha` : versionTagPattern.exec(tag)?.[1] ?? null;
}

export function releaseTagForVersion(version) {
  const normalized = versionForReleaseTag(version);
  if (!normalized) throw new Error(`Invalid release version: ${version}`);
  return isAlphaVersion(normalized) ? `alpha-${normalized.slice(0, -6)}` : `v${normalized}`;
}

/** Experimental installations retain their own data and selected program. Explicit paths still win. */
export function configureReleaseChannel(app, environment = process.env, argv = process.argv) {
  const alpha = isAlphaVersion(app.getVersion());
  app.setName(alpha ? "Cleo Alpha" : "Cleo");
  if (alpha && app.isPackaged) {
    if (!argv.some(value => value === "--user-data-dir" || value.startsWith("--user-data-dir="))) {
      app.setPath("userData", join(app.getPath("appData"), "Cleo Alpha"));
    }
    if (!environment.CLEO_HOME) {
      const normal = desktopDataHome({ platform: process.platform, environment,
        home: app.getPath("home"), userData: app.getPath("userData") });
      environment.CLEO_HOME = join(dirname(normal), "Cleo Alpha");
    }
  }
  return alpha;
}
