"""Isolated checks using the installed runtime; no pytest or live agent connection needed."""
import asyncio
import json
import tempfile
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from cleo.desktop.evolution_planning import plan_request
from cleo.desktop.service import DesktopService
from cleo.integrations.harnesses.claude import ClaudeProvider


async def check(root):
    """Exercise native skill setup, draft discovery and source-grounded assumption output."""
    captured = []

    class Client:
        def __init__(self, *, options):
            captured.append(options)

        async def connect(self):
            pass

        async def disconnect(self):
            pass

    with patch("cleo.integrations.harnesses.claude.ClaudeSDKClient", Client):
        provider = ClaudeProvider(default_model="fixture")
        session = await provider.create_session(str(root))
        await provider.close(session.id)
    assert captured[0].setting_sources == ["user", "project"]
    assert captured[0].cwd == str(root)
    # No forced Skill call, no narrowed tool list; native restrictions govern automatic use.
    assert captured[0].allowed_tools == []
    service = DesktopService.__new__(DesktopService)
    service._productivity_provider = lambda _: SimpleNamespace(type="claude_sdk", enabled=True)
    path = root / ".claude/skills/grilling/SKILL.md"
    path.parent.mkdir(parents=True)
    path.write_text("---\nname: grilling\n---\nReview the plan.", encoding="utf-8")
    (root / ".git").mkdir()
    with (
        patch("pathlib.Path.home", return_value=root / "home"),
        patch.dict("os.environ", {"CLAUDE_CONFIG_DIR": str(root / "home/.claude")}),
    ):
        skills = await service.get_local_skills(provider="alias", project_path=str(root))
    assert [s["command"] for s in skills] == ["/grilling"]
    source = root / "ui/src/Button.tsx"
    source.parent.mkdir(parents=True)
    source.write_text("<button />", encoding="utf-8")
    calls = []

    async def complete(instructions, prompt):
        calls.append((instructions, prompt))
        return json.dumps({"paths": ["ui/src/Button.tsx"]} if len(calls) == 1 else {
            "intent": "change", "answer": "假设：放在当前侧栏。", "cases": [{
                "title": "entry", "requirement": "move", "current": "static", "trigger": "open",
                "expectation": "sidebar", "references": [{"path": "ui/src/Button.tsx", "line": 1}],
            }],
        })

    result = await plan_request(root, "move", complete)
    assert result["answer"] == "假设：放在当前侧栏。"
    assert result["cases"][0]["method"] == "manual"
    assert "集中在一次" in calls[1][0]
    assert "不要再次返回 clarification" in calls[1][0]


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="cleo-iteration-check-") as temporary:
        asyncio.run(check(Path(temporary)))
    print("PASS: native Claude skill setup, draft discovery, planner assumptions (isolated mocks)")
