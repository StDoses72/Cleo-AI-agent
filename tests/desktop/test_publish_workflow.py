"""Exercise the actual workflow scripts with isolated files and simulated GitHub state."""

import hashlib
import io
import json
import os
import subprocess
import tarfile
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import yaml

ROOT = Path(__file__).resolve().parents[2]


def workflow_script(step_name):
    """Return the Python body of a named workflow step for local execution."""
    workflow = yaml.safe_load((ROOT / ".github/workflows/publish-release.yml").read_text())
    step = next(
        item for item in workflow["jobs"]["publish"]["steps"] if item.get("name") == step_name
    )
    return step["run"].split("python - <<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]


class PublishWorkflowTests(unittest.TestCase):
    def test_prerelease_build_matches_its_version_and_commit(self):
        """A successful prerelease build must pass the same commit/version gate."""
        def output(args, **_kwargs):
            if args[:2] == ["gh", "api"]:
                return json.dumps({"name": "Desktop platforms", "conclusion": "success",
                                   "head_sha": "a" * 40, "event": "workflow_dispatch"})
            if args[1] == "rev-parse":
                return "a" * 40
            if args[-1].endswith("ui/package.json"):
                return json.dumps({"version": "0.5.0-beta.1"})
            return '[project]\nversion = "0.5.0-beta.1"\n'

        with patch.dict(os.environ, {"RELEASE_TAG": "v0.5.0-beta.1", "BUILD_RUN": "99",
                                     "GH_REPO": "fixture/repo", "RELEASE_PRERELEASE": "true"}):
            with patch("subprocess.check_output", side_effect=output):
                exec(workflow_script("Verify successful build and matching tag"), {})

    def test_alpha_numbering_requires_prerelease_and_matches_package_version(self):
        def output(args, **_kwargs):
            if args[:2] == ["gh", "api"]:
                return json.dumps({"name": "Desktop platforms", "conclusion": "success",
                                   "head_sha": "a" * 40, "event": "workflow_dispatch"})
            if args[1] == "rev-parse":
                return "a" * 40
            if args[-1].endswith("ui/package.json"):
                return json.dumps({"version": "0.0.1-alpha"})
            return '[project]\nversion = "0.0.1-alpha"\n'

        for prerelease in ("false", "true"):
            with self.subTest(prerelease=prerelease), patch.dict(os.environ, {
                "RELEASE_TAG": "alpha-0.0.1", "BUILD_RUN": "99", "GH_REPO": "fixture/repo",
                "RELEASE_PRERELEASE": prerelease,
            }), patch("subprocess.check_output", side_effect=output) as call:
                script = workflow_script("Verify successful build and matching tag")
                if prerelease == "false":
                    with self.assertRaisesRegex(AssertionError, "pre-releases"):
                        exec(script, {})
                    call.assert_not_called()
                else:
                    exec(script, {})

    def exercise_upload(self, draft, partial=False, conflicting=False, allow_existing=True,
                        metadata_conflict=False, interrupt=False, prerelease=False,
                        incomplete=False, foreign_upload=False, create_lag=False):
        """Retry only missing assets and never overwrite published content or metadata."""
        with tempfile.TemporaryDirectory(prefix="cleo-publish-workflow-") as temporary:
            files = Path(temporary) / "release-files"
            files.mkdir()
            for index in range(14):
                (files / f"asset-{index}").write_bytes(f"verified-{index}".encode())
            (Path(temporary) / "release-notes.md").write_text("Notes")
            release = {"id": 7, "tag_name": "v0.5.0", "name": "Cleo v0.5.0", "body": "Notes",
                       "draft": draft, "prerelease": prerelease, "assets": []}
            if partial or conflicting or incomplete:
                data = (files / "asset-0").read_bytes()
                release["assets"].append({"id": 8, "name": "asset-0", "state": "uploaded",
                                          "size": len(data),
                                          "digest": "sha256:" + hashlib.sha256(data).hexdigest()})
            if incomplete:
                release["assets"][0].update(state="starter", digest=None, uploader={
                    "login": "another-user" if foreign_upload else "github-actions[bot]",
                })
            if conflicting:
                release["assets"][0]["digest"] = "sha256:" + "0" * 64
            if metadata_conflict:
                release["body"] = "Unrelated release"
            mutations = []
            interrupted = False
            created, visibility_reads = not create_lag, 0

            def output(args, **_kwargs):
                nonlocal visibility_reads
                if args[:2] == ["git", "rev-parse"]:
                    return "a" * 40
                if "/actions/runs/" in args[-1]:
                    return json.dumps({"head_sha": "a" * 40})
                if "/assets?" in args[-1]:
                    return json.dumps(release["assets"])
                if not created or visibility_reads:
                    visibility_reads = max(0, visibility_reads - 1)
                    return "[]"
                return json.dumps([release])

            def run(args, **_kwargs):
                nonlocal interrupted, created, visibility_reads
                if args[0] == "git":
                    return
                mutations.append(args)
                if args[1:3] == ["release", "create"]:
                    created, visibility_reads = True, 2
                if args[1:4] == ["api", "--method", "DELETE"]:
                    self.assertEqual(args[-1], "repos/fixture/repo/releases/assets/8")
                    self.assertEqual(release["assets"][0]["state"], "starter")
                    release["assets"].pop(0)
                if args[0] == "curl":
                    self.assertIn("--http1.1", args)
                    self.assertEqual(args[args.index("--max-time") + 1], "600")
                    self.assertEqual(_kwargs.get("timeout"), 630)
                    self.assertNotIn("fixture-token", " ".join(args))
                    self.assertEqual(_kwargs["input"],
                                     'header = "Authorization: Bearer fixture-token"\n')
                    path = Path(args[args.index("--data-binary") + 1].removeprefix("@"))
                    self.assertEqual(args[-1],
                                     f"https://uploads.github.com/repos/fixture/repo/releases/7/assets?name={path.name}")
                    self.assertNotIn(path.name, {asset["name"] for asset in release["assets"]})
                    data = path.read_bytes()
                    release["assets"].append({
                        "name": path.name, "size": len(data), "state": "uploaded",
                        "digest": "sha256:" + hashlib.sha256(data).hexdigest(),
                    })
                    if interrupt and not interrupted:
                        interrupted = True
                        raise subprocess.CalledProcessError(1, args)
                if args[1:3] == ["release", "edit"]:
                    self.assertTrue(release["draft"], "Do not edit published metadata")
                    self.assertIn(f"--latest={str(not prerelease).lower()}", args)
                    release["draft"] = False

            with patch.dict(os.environ, {"RUNNER_TEMP": temporary, "RELEASE_TAG": "v0.5.0",
                                         "GH_REPO": "fixture/repo", "BUILD_RUN": "99",
                                         "GH_TOKEN": "fixture-token",
                                         "RELEASE_TITLE": "Cleo v0.5.0",
                                         "RELEASE_PRERELEASE": str(prerelease).lower(),
                                         "RELEASE_RESUME_PUBLISHED": str(allow_existing).lower()}):
                with (
                    patch("subprocess.check_output", side_effect=output),
                    patch("subprocess.run", side_effect=run),
                    patch("time.sleep"),
                ):
                    script = workflow_script("Upload draft, verify uploaded assets, and publish")
                    if (conflicting or metadata_conflict or foreign_upload
                            or (not draft and not allow_existing)):
                        with self.assertRaises(AssertionError):
                            exec(script, {})
                        self.assertEqual(mutations, [])
                    else:
                        if interrupt:
                            with self.assertRaises(subprocess.CalledProcessError):
                                exec(script, {})
                        exec(script, {})
                        self.assertFalse(release["draft"])
                        self.assertEqual(len(release["assets"]), 14)
                        self.assertEqual(release["body"], "Notes")
                        self.assertEqual(release["name"], "Cleo v0.5.0")

    def test_app_created_source_release_can_receive_verified_packages(self):
        self.exercise_upload(draft=False)

    def test_partial_draft_upload_resumes(self):
        self.exercise_upload(draft=True, partial=True)

    def test_interrupted_actions_upload_removes_only_its_incomplete_placeholder(self):
        self.exercise_upload(draft=True, incomplete=True)

    def test_another_uploaders_incomplete_asset_is_not_deleted(self):
        self.exercise_upload(draft=True, incomplete=True, foreign_upload=True)

    def test_new_draft_can_take_time_to_appear_in_the_release_list(self):
        self.exercise_upload(draft=True, create_lag=True)

    def test_partial_published_upload_resumes(self):
        self.exercise_upload(draft=False, partial=True)

    def test_conflicting_asset_is_rejected_before_mutation(self):
        self.exercise_upload(draft=False, conflicting=True)

    def test_published_release_still_requires_explicit_completion_opt_in(self):
        self.exercise_upload(draft=False, allow_existing=False)

    def test_existing_metadata_must_match_before_upload(self):
        self.exercise_upload(draft=True, metadata_conflict=True)

    def test_network_interruption_resumes_only_missing_assets(self):
        self.exercise_upload(draft=True, interrupt=True)

    def test_prerelease_packages_do_not_become_latest_stable(self):
        self.exercise_upload(draft=True, prerelease=True)

    def exercise_package_verification(self, corrupt=False, alpha=False, invalid_dependencies=None):
        with tempfile.TemporaryDirectory(prefix="cleo-package-verification-") as temporary:
            version = "0.0.1-alpha" if alpha else "0.5.0-beta.1"
            locks = {}
            for name in (
                "requirements.txt", "ui/package-lock.json", "ui/runtime/package-lock.json",
            ):
                path = Path(temporary) / "dependency-locks" / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"resolved dependency fixture")
                locks[name] = hashlib.sha256(path.read_bytes()).hexdigest()
            for target in ("windows-x64", "macos-arm64", "macos-x64", "linux-x64"):
                folder = Path(temporary) / "release-artifacts" / f"desktop-{target}" / "release"
                folder.mkdir(parents=True)
                extension = ".tar.gz" if target == "linux-x64" else ".zip"
                archive = folder / f"Cleo-{target}{extension}"
                prefix = "Cleo.app/Contents/Resources" if target.startswith("macos") else "Cleo"
                resources = prefix if target.startswith("macos") else prefix + "/resources"
                dependencies = {"lock_sha256": dict(locks), "python_packages": {
                    "openai-codex": "0.155.1", "openai-codex-cli-bin": "0.155.1",
                }}
                if target == "windows-x64":
                    if invalid_dependencies == "lock":
                        dependencies["lock_sha256"]["requirements.txt"] = "0" * 64
                    elif invalid_dependencies == "sdk":
                        dependencies["python_packages"]["openai-codex"] = "0.147.0"
                entries = {
                    f"{prefix}/release.json": json.dumps({
                        "version": version, "platform": target,
                    }).encode(),
                    f"{resources}/dependencies.json": json.dumps(dependencies).encode(),
                }
                if target == "linux-x64":
                    with tarfile.open(archive, "w:gz") as bundle:
                        for name, data in entries.items():
                            info = tarfile.TarInfo(name)
                            info.size = len(data)
                            bundle.addfile(info, io.BytesIO(data))
                    deb = folder / "Cleo-linux-x64.deb"
                    deb.write_bytes(b"isolated deb fixture")
                    checksum = hashlib.sha256(deb.read_bytes()).hexdigest()
                    (folder / "Cleo-linux-x64.deb.sha256").write_text(checksum + " " + deb.name)
                else:
                    with zipfile.ZipFile(archive, "w") as bundle:
                        for name, data in entries.items():
                            bundle.writestr(name, data)
                digest = hashlib.sha256(archive.read_bytes()).hexdigest()
                (folder / f"Cleo-{target}.sha256").write_text(digest + " " + archive.name)
                manifest = "release.json" if target == "windows-x64" else f"release-{target}.json"
                (folder / manifest).write_text(json.dumps({"version": version, "platform": target,
                    "archive": archive.name, "bytes": archive.stat().st_size, "sha256": digest}))
                if corrupt and target == "windows-x64":
                    archive.write_bytes(b"corrupt")
            with patch.dict(os.environ, {
                "RUNNER_TEMP": temporary,
                "RELEASE_TAG": "alpha-0.0.1" if alpha else f"v{version}", "RELEASE_NOTES": "Notes",
            }):
                if corrupt or invalid_dependencies:
                    with self.assertRaises(AssertionError):
                        exec(workflow_script("Verify complete packages and checksums"), {})
                else:
                    exec(workflow_script("Verify complete packages and checksums"), {})
                    self.assertEqual(len(list((Path(temporary) / "release-files").iterdir())), 14)

    def test_dependency_drift_blocks_release_even_when_archive_checksums_match(self):
        for kind in ("lock", "sdk"):
            with self.subTest(kind=kind):
                self.exercise_package_verification(invalid_dependencies=kind)

    def test_all_four_platform_packages_keep_version_size_and_hash_checks(self):
        self.exercise_package_verification()

    def test_alpha_packages_keep_version_size_and_hash_checks(self):
        self.exercise_package_verification(alpha=True)

    def test_corrupt_archive_fails_before_upload_stage(self):
        self.exercise_package_verification(corrupt=True)


if __name__ == "__main__":
    unittest.main()
