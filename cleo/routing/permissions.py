"""User-owned execution presets shared by desktop and routed workers."""

PRESET_LABELS = {"ask": "请求批准", "review": "帮我审批", "full": "完全访问"}
NATIVE_PRESETS = {
    "codex_sdk": {
        "ask": {"sandbox": "workspace-write", "approval_mode": "user"},
        "review": {"sandbox": "workspace-write", "approval_mode": "auto_review"},
        "full": {"sandbox": "full-access", "approval_mode": "deny_all"},
    },
    "claude_sdk": {
        "ask": {"approval_mode": "default"},
        "review": {"approval_mode": "auto"},
        "full": {"approval_mode": "bypassPermissions"},
    },
}


def native_permissions(backend, preset, support=None):
    """Purpose: Map an explicit user preset without inventing backend capabilities.

    Input: Harness type, semantic preset and cached native restrictions.
    Output: Native session options; raises when no supported equivalent exists.
    """
    options = NATIVE_PRESETS.get(backend, {}).get(preset)
    if options is None:
        raise ValueError(f"{backend} 不支持统一权限档位 {PRESET_LABELS.get(preset, preset)}")
    for field, value in options.items():
        category = "access" if field == "sandbox" else "approval"
        reason = (support or {}).get(category, {}).get(value)
        if reason:
            raise ValueError(f"{backend} 权限不可用：{reason}")
    return dict(options)


def routing_preset(policy, manifest):
    """Purpose: Keep a running delegation on the host's captured user authorization.

    Input: Routing policy and parent manifest. Output: Explicit preset or inherit.
    """
    from cleo.routing.models import execution_mode

    if execution_mode(policy, manifest) != "auto":
        return "inherit"
    if manifest.get("routing_permission_run_id") is not None:
        return manifest.get("routing_permission_preset")
    return policy.permission_preset
