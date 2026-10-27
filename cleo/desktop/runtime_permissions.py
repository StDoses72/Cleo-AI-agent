"""Desktop permission choices; values retain each runtime's own semantics."""

from cleo.i18n import tr


def permission_choices(provider_type: str, *, fixed: bool = False, support=None) -> dict:
    """Purpose: Describe session presets using the connected harness's restrictions.

    Input: Provider type, fixed evolution scope and optional native capability report.
    Output: Independent advanced choices and atomic common presets, with rejection reasons.
    """
    CODEX_ACCESS = [
        {"value": "read-only", "label": tr("runtime_permissions.read_only"),
         "description": tr("runtime_permissions.read_only_by_default_operations_beyond_that_scop")},
        {"value": "workspace-write", "label": tr("runtime_permissions.workspace_write"),
         "description": tr("runtime_permissions.writing_to_the_working_directory_is_allowed_by_d")},
        {"value": "full-access", "label": tr("runtime_permissions.full_access"),
         "description": tr("runtime_permissions.allows_writing_outside_the_workspace_and_network")},
    ]
    CODEX_APPROVAL = [
        {"value": "user", "label": tr(
            "projection.manual_approval",
        ), "description": tr("runtime_permissions.you_handle_requests_that_need_confirmation")},
        {"value": "auto_review", "label": tr("projection.automatic_review"),
         "description": tr("runtime_permissions.codex_reviews_operations_needing_approval_and_ma")},
        {"value": "deny_all", "label": tr("runtime_permissions.deny_approval_requests"),
         "description": tr("runtime_permissions.operations_requiring_no_confirmation_continue_re")},
    ]
    CLAUDE_APPROVAL = [
        {"value": "default", "label": tr("projection.manual_approval"),
         "description": tr("runtime_permissions.you_confirm_operations_not_already_allowed_by_cl")},
        {"value": "acceptEdits", "label": tr("runtime_permissions.automatically_allow_edits"),
         "description": tr("runtime_permissions.automatically_allows_file_operations_in_the_work")},
        {"value": "auto", "label": tr("projection.automatic_review"),
         "description": tr("runtime_permissions.claude_reviews_operations_and_allows_or_denies_t")},
        {"value": "dontAsk", "label": tr("runtime_permissions.deny_approval_requests"),
         "description": tr("runtime_permissions.previously_allowed_operations_continue_requests")},
        {"value": "bypassPermissions", "label": tr("runtime_permissions.bypass_standard_approval"),
         "description": tr("runtime_permissions.allows_most_operations_explicit_deny_rules_and_r")},
        {"value": "plan", "label": tr(
            "runtime_permissions.plan_mode",
        ), "description": tr(
            "runtime_permissions.editing_operations_are_not_automatically_approve",
        )},
    ]
    ACP_APPROVAL = [
        {"value": "user", "label": tr(
            "projection.manual_approval",
        ), "description": tr(
            "runtime_permissions.you_choose_among_the_allow_or_deny_options_provi",
        )},
        {"value": "auto_allow", "label": tr("runtime_permissions.automatically_allow_requests"),
         "description": tr("runtime_permissions.automatically_selects_an_allow_option_provided_b")},
        {"value": "deny_all", "label": tr("runtime_permissions.automatically_deny_requests"),
         "description": tr("runtime_permissions.automatically_selects_a_deny_option_cancels_requ")},
    ]

    if fixed:
        return {"access": [], "approval": [], "reason": tr(
            "runtime_permissions.evolution_tasks_use_fixed_permissions",
        )}
    if provider_type == "codex_sdk":
        choices = {"access": CODEX_ACCESS, "approval": CODEX_APPROVAL}
        modes = [
            ("ask", tr("runtime_permissions.request_approval"), "user", "workspace-write"),
            ("review", tr("runtime_permissions.review_for_me"), "auto_review", "workspace-write"),
            ("full", tr("runtime_permissions.full_access"), "deny_all", "full-access"),
        ]
    elif provider_type == "claude_sdk":
        choices = {"access": [], "approval": CLAUDE_APPROVAL}
        modes = [("ask", tr("runtime_permissions.request_approval"), "default", None),
                 ("review", tr("runtime_permissions.review_for_me"), "auto", None),
                 ("full", tr("runtime_permissions.full_access"), "bypassPermissions", None)]
    elif provider_type == "acp":
        return {"access": [], "approval": ACP_APPROVAL,
                "reason": tr("runtime_permissions.this_provider_has_no_unified_permission_presets")}
    else:
        return {"access": [], "approval": [], "reason": tr(
            "runtime_permissions.this_task_uses_the_runtime_backend_s_permission",
        )}
    restrictions = support or {}
    result = {field: [dict(choice, disabledReason=restrictions.get(field, {}).get(choice["value"]))
                      for choice in values] for field, values in choices.items()}
    descriptions = {
        "ask": tr("runtime_permissions.you_approve_operations_beyond_existing_authoriza"),
        "review": tr("runtime_permissions.the_current_harness_reviews_operations_automatic"),
        "full": tr("runtime_permissions.allows_routine_file_command_and_tool_operations"),
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
                        tr("runtime_permissions.the_current_harness_checks_and_applies_your_sele"))
    return result


def validate_permissions(provider_type: str, update: dict) -> None:
    capabilities = permission_choices(provider_type)
    for field in ("access", "approval"):
        choices = capabilities[field]
        if field in update and (not isinstance(update[field], str)
                               or update[field] not in {choice["value"] for choice in choices}):
            raise ValueError(tr(
                "runtime_permissions.unsupported_permission_option_value_value",
                p0=field,
                p1=update[field],
            ))
