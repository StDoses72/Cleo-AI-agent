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
CLAUDE_APPROVAL = [
    {"value": "default", "label": "人工审批",
     "description": "由你确认未被 Claude 规则允许的操作。"},
    {"value": "acceptEdits", "label": "自动允许编辑",
     "description": "自动允许工作目录中的文件操作；其他请求仍需确认。"},
    {"value": "auto", "label": "自动审查",
     "description": "由 Claude 审查并允许或拒绝操作；需要当前客户端和模型支持。"},
    {"value": "dontAsk", "label": "拒绝审批请求",
     "description": "已允许的操作继续运行，需要确认的请求会被拒绝。"},
    {"value": "bypassPermissions", "label": "跳过常规审批",
     "description": "允许大多数操作；明确的拒绝规则和必须人工确认的请求仍然生效。"},
    {"value": "plan", "label": "规划模式", "description": "编辑操作不会自动批准。"},
]
ACP_APPROVAL = [
    {"value": "user", "label": "人工审批", "description": "由你选择服务提供的允许或拒绝选项。"},
    {"value": "auto_allow", "label": "自动允许请求",
     "description": "自动选择服务提供的允许选项；不改变服务自身的文件访问限制。"},
    {"value": "deny_all", "label": "自动拒绝请求",
     "description": "自动选择拒绝选项；服务没有提供拒绝选项时取消请求。"},
]


def permission_choices(provider_type: str, *, fixed: bool = False, support=None) -> dict:
    """Purpose: Describe session presets using the connected harness's restrictions.

    Input: Provider type, fixed evolution scope and optional native capability report.
    Output: Independent advanced choices and atomic common presets, with rejection reasons.
    """
    if fixed:
        return {"access": [], "approval": [], "reason": "进化任务使用固定权限。"}
    if provider_type == "codex_sdk":
        choices = {"access": CODEX_ACCESS, "approval": CODEX_APPROVAL}
        modes = [
            ("ask", "请求批准", "user", "workspace-write"),
            ("review", "帮我审批", "auto_review", "workspace-write"),
            ("full", "完全访问", "deny_all", "full-access"),
        ]
    elif provider_type == "claude_sdk":
        choices = {"access": [], "approval": CLAUDE_APPROVAL}
        modes = [("ask", "请求批准", "default", None),
                 ("review", "帮我审批", "auto", None),
                 ("full", "完全访问", "bypassPermissions", None)]
    elif provider_type == "acp":
        return {"access": [], "approval": ACP_APPROVAL,
                "reason": "此服务不提供统一权限档位，请使用高级审批设置。"}
    else:
        return {"access": [], "approval": [], "reason": "此任务使用运行后端的权限配置。"}
    restrictions = support or {}
    result = {field: [dict(choice, disabledReason=restrictions.get(field, {}).get(choice["value"]))
                      for choice in values] for field, values in choices.items()}
    descriptions = {
        "ask": "由你批准超出已有授权范围的操作。",
        "review": "由当前 harness 自动审查操作；可能允许、拒绝或请求你确认。",
        "full": "允许常规文件、命令和工具操作，无需逐项确认；服务强制规则仍生效。",
    }
    result["presets"] = []
    for value, label, approval, access in modes:
        update = {"approval": approval, **({"access": access} if access else {})}
        reason = next((restrictions.get(field, {}).get(option)
                       for field, option in update.items()
                       if restrictions.get(field, {}).get(option)), None)
        result["presets"].append({"value": value, "label": label,
                                  "description": descriptions[value], "update": update,
                                  "disabledReason": reason})
    result["reason"] = (restrictions.get("reason") or
                        "选择后由当前 harness 检查并生效，仅影响此会话。")
    return result


def validate_permissions(provider_type: str, update: dict) -> None:
    capabilities = permission_choices(provider_type)
    for field in ("access", "approval"):
        choices = capabilities[field]
        if field in update and (not isinstance(update[field], str)
                               or update[field] not in {choice["value"] for choice in choices}):
            raise ValueError(f"不支持的权限选项：{field}={update[field]}")
