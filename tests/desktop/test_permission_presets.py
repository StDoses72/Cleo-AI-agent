"""Session permission presentation must retain native semantics and restrictions."""

from cleo.desktop.runtime_permissions import permission_choices


def test_native_restrictions_disable_presets_without_granting_fallback_access():
    choices = permission_choices("codex_sdk", support={
        "access": {"full-access": "Managed workspace only"},
        "approval": {"auto_review": "Reviewer disabled"},
    })
    presets = {item["value"]: item for item in choices["presets"]}
    assert presets["full"]["disabledReason"] == "Managed workspace only"
    assert presets["review"]["disabledReason"] == "Reviewer disabled"
    assert presets["ask"]["disabledReason"] is None
    assert presets["ask"]["update"] == {"access": "workspace-write", "approval": "user"}
    assert permission_choices("codex_sdk", fixed=True)["approval"] == []


def test_claude_presets_never_claim_to_supply_a_codex_sandbox():
    presets = permission_choices("claude_sdk")["presets"]
    assert [p["update"] for p in presets] == [
        {"approval": "default"}, {"approval": "auto"}, {"approval": "bypassPermissions"},
    ]
    assert "presets" not in permission_choices("acp")
