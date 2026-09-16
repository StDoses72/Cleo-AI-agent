"""Desktop permission choices; values retain each runtime's own semantics."""

CODEX_ACCESS = [
    {"value": "read-only", "label": "只读",
     "description": "默认只读，超出范围的操作由审批策略决定。"},
    {"value": "workspace-write", "label": "工作区可写",
     "description": "默认允许写入工作目录，额外访问由审批策略决定。"},
    {"value": "full-access", "label": "完全访问",
     "description": "允许写入工作区外的文件并联网；审批与外部服务授权仍单独处理。"},
]
CODEX_APPROVAL = [
    {"value": "user", "label": "人工审批", "description": "由你处理需要确认的请求。"},
    {"value": "auto_review", "label": "自动审查",
     "description": "由 Codex 审查需要批准的操作，可能允许或拒绝；必要的外部授权仍需确认。"},
    {"value": "deny_all", "label": "拒绝审批请求",
     "description": "无需确认即可执行的操作继续运行，需要审批的请求会被拒绝。"},
]


def permission_choices(provider_type: str, *, fixed: bool = False) -> dict:
    if fixed:
        return {"access": [], "approval": [], "reason": "进化任务使用固定权限。"}
    if provider_type == "codex_sdk":
        return {"access": CODEX_ACCESS, "approval": CODEX_APPROVAL}
    return {"access": [], "approval": [], "reason": "此任务使用运行后端的权限配置。"}


def validate_permissions(provider_type: str, update: dict) -> None:
    if provider_type != "codex_sdk":
        # Other adapters validate their own native modes, never Codex sandbox values.
        return
    for field, choices in (("access", CODEX_ACCESS), ("approval", CODEX_APPROVAL)):
        if field in update and (not isinstance(update[field], str)
                               or update[field] not in {choice["value"] for choice in choices}):
            raise ValueError(f"不支持的权限选项：{field}={update[field]}")
