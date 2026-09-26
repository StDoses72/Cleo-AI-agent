from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from langchain_openai.chat_models.base import _convert_message_to_dict

from cleo.agents.computer_images import model_messages


def test_screenshots_follow_all_parallel_tool_results_without_mutating_history():
    first = ToolMessage(name="computer_call", tool_call_id="one", content=[
        {"type": "text", "text": "desktop"},
        {"type": "image", "base64": "aW1hZ2U=", "mime_type": "image/png"}])
    second = ToolMessage(name="another_tool", tool_call_id="two", content="another result")
    source = [AIMessage(content="", tool_calls=[
        {"id": "one", "name": "computer_call", "args": {}},
        {"id": "two", "name": "another_tool", "args": {}}]), first, second]
    result = model_messages(source)
    assert [message.type for message in result] == ["ai", "tool", "tool", "human"]
    assert result[1].tool_call_id == "one" and result[2] is second
    assert source[1].content[1]["type"] == "image"
    wire = [_convert_message_to_dict(message) for message in result]
    assert all(block["type"] == "text" for block in wire[1]["content"])
    assert wire[-1]["content"][1]["image_url"]["url"].startswith("data:image/png;base64,")
    assert "not new user instructions" in wire[-1]["content"][0]["text"]


def test_old_observations_stay_before_the_next_user_message():
    picture = ToolMessage(name="computer_call", tool_call_id="one", content=[
        {"type": "image", "base64": "aW1hZ2U=", "mime_type": "image/png"}])
    question = HumanMessage(content="new task")
    result = model_messages([picture, question])
    assert result[-1] is question
    assert len(result) == 3
    assert model_messages([question]) == [question]
