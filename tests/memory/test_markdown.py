import pytest

from cleo.memory.markdown import Edit, apply_edits, parse_memory

BASE = "# 用户偏好\n- 默认中文解释。\n- 每次修改后列出变更文件。\n"


def test_replace_preserves_unrelated_text_and_noop_is_exact():
    assert apply_edits(BASE, []) == BASE
    result = apply_edits(BASE, [Edit(old="默认中文解释。", new="默认英文解释。")])
    assert result == BASE.replace("默认中文解释。", "默认英文解释。")


def test_conflict_repair_removes_only_old_value():
    text = BASE + "- 默认英文解释。\n"
    result = apply_edits(text, [Edit(old="默认英文解释。", new="")])
    assert result == BASE
    assert apply_edits(result, []) == result


def test_batch_checks_final_budget_and_rejects_stale_target():
    limit = len(BASE)
    assert apply_edits(BASE, [Edit(old="默认中文解释。", new="更短。")], limit=limit)
    with pytest.raises(ValueError, match="budget"):
        apply_edits(BASE, [Edit(new="x")], limit=limit)
    with pytest.raises(ValueError, match="exactly one"):
        apply_edits(BASE, [Edit(old="不存在。", new="English")])


def test_exact_boundary_includes_chinese_and_newlines():
    assert apply_edits(BASE, [], limit=len(BASE)) == BASE
    with pytest.raises(ValueError, match="budget"):
        apply_edits(BASE, [], limit=len(BASE) - 1)


def test_facts_and_unknown_sections_require_migration():
    with pytest.raises(ValueError, match="migration"):
        parse_memory("# Project Memory\n## Facts\n- Tests passed.\n")
    with pytest.raises(ValueError):
        apply_edits(BASE, [Edit(new="Preference\n## Facts\n- secret")])


def test_empty_memory_and_duplicate_add():
    assert apply_edits("", []) == ""
    result = apply_edits("", [Edit(new="中文解释。")])
    assert parse_memory(result).preferences == ["中文解释。"]
    assert apply_edits(result, [Edit(new="中文解释。")]) == result


def test_batch_may_temporarily_exceed_entry_limit():
    text = "# User Preferences\n" + "".join(f"- Preference {i}\n" for i in range(30))
    result = apply_edits(text, [Edit(new="New preference"), Edit(old="Preference 0")])
    assert len(parse_memory(result).preferences) == 30
