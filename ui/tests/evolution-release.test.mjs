import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { run } from "../electron/evolution-tools.mjs";

// Execute the builder's real checksum assignments, without downloads or packaging.
const checksumProbe = `
$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($env:CLEO_BUILDER, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw 'Release script has syntax errors.' }
foreach ($definition in $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst]
}, $false)) {
    . ([scriptblock]::Create($definition.Extent.Text))
}
# Reproduce a host where module discovery cannot supply Get-FileHash.
$PSModuleAutoLoadingPreference = 'None'
$electronArchive = $wheelPath = $archivePath = $env:CLEO_HASH_INPUT
$assignments = $ast.FindAll({ param($node)
    $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and
    $node.Left.Extent.Text -in @('$actualHash', '$actualElectronHash', '$hash')
}, $true)
if ($assignments.Count -ne 3) { throw 'Expected all three package checksum sites.' }
foreach ($assignment in $assignments) {
    . ([scriptblock]::Create($assignment.Extent.Text))
}
[Console]::WriteLine($actualHash)
[Console]::WriteLine($actualElectronHash)
[Console]::WriteLine($hash)
`;

test("release checksums work without module autoloading and reject missing files", {
  skip: process.platform !== "win32",
}, async (t) => {
  const parent = resolve(tmpdir());
  const root = await mkdtemp(join(parent, "cleo-release-hash-test-"));
  t.after(async () => {
    assert.equal(dirname(root), parent);
    await rm(root, { recursive: true, force: true });
  });
  const builder = fileURLToPath(new URL("../../scripts/build-release.ps1", import.meta.url));
  const input = join(root, "校验 [literal].bin");
  const probe = join(root, "probe.ps1");
  await writeFile(probe, checksumProbe);
  const options = { env: { ...process.env, CLEO_BUILDER: builder, CLEO_HASH_INPUT: input } };
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", probe];
  for (const content of [Buffer.alloc(0), Buffer.from("abc"), await readFile(process.execPath)]) {
    await writeFile(input, content);
    const expected = createHash("sha256").update(content).digest("hex");
    const result = await run("powershell.exe", args, options);
    assert.deepEqual(result.toLowerCase().split(/\r?\n/), [expected, expected, expected]);
  }
  await rm(input);
  await assert.rejects(run("powershell.exe", args, options));
});
