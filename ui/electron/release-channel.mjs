import { dirname, join } from "node:path";
import { desktopDataHome } from "./platform.mjs";

export const alphaTagPattern = /^alpha-((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const versionTagPattern = /^v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;

export function versionForReleaseTag(tag) {
  const alpha = alphaTagPattern.exec(tag);
  return alpha ? `${alpha[1]}-alpha` : versionTagPattern.exec(tag)?.[1] ?? null;
}

export function releaseTagForVersion(version) {
  const normalized = versionForReleaseTag(version);
  if (!normalized) throw new Error(`Invalid release version: ${version}`);
  return normalized.endsWith("-alpha") ? `alpha-${normalized.slice(0, -6)}` : `v${normalized}`;
}

/** Experimental installations retain their own data and selected program. Explicit paths still win. */
export function configureReleaseChannel(app, environment = process.env, argv = process.argv) {
  const alpha = app.getVersion().endsWith("-alpha");
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
