/** Purpose: Stamp the Cleo icon and product metadata into the renamed Electron executable.
 * Input: --exe <Cleo.exe> --icon <cleo.ico> --version <x.y.z>; resedit is resolved from the
 *        current working directory's node_modules so the release build uses its fresh install.
 * Output: The executable rewritten in place with Cleo's icon group and version strings. */
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const { values } = parseArgs({ options: {
  exe: { type: "string" }, icon: { type: "string" }, version: { type: "string" },
} });
if (!values.exe || !values.icon || !values.version) {
  throw new Error("Usage: apply-windows-icon.mjs --exe <path> --icon <path> --version <x.y.z>");
}
const require = createRequire(join(process.cwd(), "package.json"));
const ResEdit = await import(pathToFileURL(require.resolve("resedit")));

const executable = ResEdit.NtExecutable.from(await readFile(values.exe), { ignoreCert: true });
const resources = ResEdit.NtExecutableResource.from(executable);
const icons = ResEdit.Data.IconFile.from(await readFile(values.icon)).icons.map(icon => icon.data);
// Electron's executable keeps its application icon in icon group 1 (en-US).
ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, 1, 1033, icons);

const [major = 0, minor = 0, patch = 0] = values.version.split(/[^0-9]+/).filter(Boolean).map(Number);
const [info] = ResEdit.Resource.VersionInfo.fromEntries(resources.entries);
if (info) {
  const languages = info.getAvailableLanguages();
  for (const language of languages.length ? languages : [{ lang: 1033, codepage: 1200 }]) {
    info.setFileVersion(major, minor, patch, 0, language.lang);
    info.setProductVersion(major, minor, patch, 0, language.lang);
    info.setStringValues(language, {
      ProductName: "Cleo",
      FileDescription: "Cleo",
      InternalName: "Cleo",
      OriginalFilename: "Cleo.exe",
      CompanyName: "Cleo",
      LegalCopyright: "Copyright (c) Cleo contributors",
      FileVersion: values.version,
      ProductVersion: values.version,
    });
  }
  info.outputToResourceEntries(resources.entries);
}
resources.outputResource(executable);
await writeFile(values.exe, Buffer.from(executable.generate()));
console.log(`Applied ${values.icon} and version ${values.version} to ${values.exe}`);
