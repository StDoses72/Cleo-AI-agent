"""A package must not inherit libraries or search paths from its build host."""

import importlib.util
import subprocess
from pathlib import Path

import pytest

spec = importlib.util.spec_from_file_location(
    "build_release", Path(__file__).resolve().parents[2] / "scripts/build-release.py",
)
builder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(builder)


@pytest.fixture
def binary(tmp_path):
    path = tmp_path / "Cleo.app/Contents/Resources/python/_rust.abi3.so"
    path.parent.mkdir(parents=True)
    path.write_bytes(bytes.fromhex("cffaedfe") + b"fixture")
    (path.parent / "data.txt").write_text("not Mach-O")
    return tmp_path / "Cleo.app", path


@pytest.mark.parametrize("command,field,dependency", [
    ("LC_LOAD_DYLIB", "name", "/usr/local/opt/openssl@3/lib/libssl.3.dylib"),
    ("LC_LOAD_WEAK_DYLIB", "name", "/opt/homebrew/lib/libcrypto.3.dylib"),
])
def test_external_libraries_and_search_paths_fail_even_when_present(
    binary, monkeypatch, command, field, dependency,
):
    bundle, path = binary

    def otool(args, **kwargs):
        assert list(map(str, args)) == ["otool", "-l", str(path)]
        return f"{path}:\nLoad command 0\n cmd {command}\n {field} {dependency} (offset 24)\n"

    monkeypatch.setattr(builder.subprocess, "check_output", otool)
    with pytest.raises(ValueError, match="Non-portable macOS dependency") as error:
        builder.prepare_macos_libraries(bundle)
    assert dependency in str(error.value)


def test_system_libraries_and_bundle_relative_paths_are_allowed(binary, monkeypatch):
    bundle, path = binary
    output = f"{path}:\n" + "\n".join(
        f"Load command {i}\n cmd {cmd}\n {field} {name} (offset 24)"
        for i, (cmd, field, name) in enumerate([
            ("LC_LOAD_DYLIB", "name", "/usr/lib/libSystem.B.dylib"),
            ("LC_LOAD_DYLIB", "name", "/System/Library/Frameworks/Security.framework/Security"),
            ("LC_LOAD_DYLIB", "name", "@rpath/libpython3.12.dylib"),
            ("LC_RPATH", "path", "@loader_path/../lib"),
            ("LC_RPATH", "path", "@executable_path/../Frameworks"),
            # A dylib's own identifier is not a library that it loads.
            ("LC_ID_DYLIB", "name", "/build/libself.dylib"),
        ])
    )
    monkeypatch.setattr(builder.subprocess, "check_output", lambda *a, **kw: output)
    builder.prepare_macos_libraries(bundle)


def test_native_inspection_failure_does_not_pass(binary, monkeypatch):
    def fail(*args, **kwargs):
        raise subprocess.CalledProcessError(1, "otool")

    monkeypatch.setattr(builder.subprocess, "check_output", fail)
    with pytest.raises(subprocess.CalledProcessError):
        builder.prepare_macos_libraries(binary[0])


def test_unused_build_rpaths_are_removed_once_before_signing(binary, monkeypatch):
    bundle, path = binary
    rpath = "/Users/runner/work/Pillow/Pillow/build/deps/darwin/lib"
    # Universal binaries can repeat the same path for each architecture.
    output = f" cmd LC_RPATH\n path {rpath} (offset 12)\n" * 2
    monkeypatch.setattr(builder.subprocess, "check_output", lambda *a, **kw: output)
    calls = []
    monkeypatch.setattr(builder, "run", lambda *args, **kw: calls.append((args, kw)))
    builder.prepare_macos_libraries(bundle)
    assert calls == [
        (("install_name_tool", "-delete_rpath", rpath, path), {"cwd": bundle}),
        (("codesign", "--force", "--sign", "-", path), {"cwd": bundle}),
    ]
