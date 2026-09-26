import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { configureReleaseChannel, releaseTagForVersion, versionForReleaseTag } from "../electron/release-channel.mjs";

test("alpha tags have their own numbering and round-trip to package versions", () => {
  assert.equal(versionForReleaseTag("alpha-0.0.1"), "0.0.1-alpha");
  assert.equal(releaseTagForVersion("0.0.1-alpha"), "alpha-0.0.1");
  assert.equal(versionForReleaseTag("v0.4.8"), "0.4.8");
  assert.equal(releaseTagForVersion("0.4.8"), "v0.4.8");
  for (const tag of ["alpha-01.0.1", "alpha-0.0.1/other", "alpha-latest"]) assert.equal(versionForReleaseTag(tag), null);
});

test("alpha startup isolates the profile and core data while preserving explicit paths", () => {
  const paths = { home: join(process.cwd(), "home"), appData: join(process.cwd(), "appData"), userData: join(process.cwd(), "Cleo") };
  const app = { isPackaged: true, getVersion: () => "0.0.1-alpha", getPath: name => paths[name],
    setName: value => { app.name = value; }, setPath: (name, value) => { paths[name] = value; } };
  const environment = {};
  assert.equal(configureReleaseChannel(app, environment, []), true);
  assert.equal(app.name, "Cleo Alpha");
  assert.equal(paths.userData, join(paths.appData, "Cleo Alpha"));
  assert.equal(environment.CLEO_HOME.endsWith("Cleo Alpha"), true);
  const explicit = { CLEO_HOME: join(process.cwd(), "chosen-data") };
  paths.userData = join(process.cwd(), "chosen-profile");
  configureReleaseChannel(app, explicit, ["--user-data-dir=" + paths.userData]);
  assert.equal(paths.userData, join(process.cwd(), "chosen-profile"));
  assert.equal(explicit.CLEO_HOME, join(process.cwd(), "chosen-data"));
  app.getVersion = () => "0.4.8";
  assert.equal(configureReleaseChannel(app, explicit, []), false);
  assert.equal(paths.userData, join(process.cwd(), "chosen-profile"));
});
