"""Pure session-content rules shared by foreground and background workflows."""

def has_meaningful_content(content: object) -> bool:
    """Return whether a persisted user message contains actual input."""
    if isinstance(content, str):
        return bool(content.strip())
    if isinstance(content, dict):
        return any(has_meaningful_content(value) for value in content.values())
    if isinstance(content, (list, tuple, set)):
        return any(has_meaningful_content(value) for value in content)
    return content is not None and bool(content)


def has_user_interaction(events: list[dict[str, object]]) -> bool:
    """Return whether the session includes at least one non-empty user turn."""
    return any(
        event.get("type") == "user_message" and has_meaningful_content(event.get("content"))
        for event in events
    )
