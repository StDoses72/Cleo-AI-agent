"""What a harness can do, declared by its provider class.

Each provider class lists its ``capabilities``; the desktop service derives the runtime
profile (``editable`` turns, ``supportsQuestions``, ``steerMode``, fast mode) and its
guards from them instead of comparing harness type names.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Any


class Capability(StrEnum):
    # Edit an earlier user message and resend from there.
    REWIND = "rewind"
    # Accept extra instructions while a turn is running.
    NATIVE_STEER = "native_steer"
    # Ask the user structured questions during a turn.
    QUESTIONS = "questions"
    # Route tool approvals to the user.
    USER_APPROVALS = "user_approvals"
    # Choose between the default and the fast service tier.
    SERVICE_TIER = "service_tier"
    FORK = "fork"
    # Read sessions created outside Cleo.
    NATIVE_HISTORY = "native_history"
    COMPACT = "compact"


# Provider methods a capability requires; the test suite checks both directions.
REQUIRED_METHODS: dict[Capability, tuple[str, ...]] = {
    Capability.REWIND: ("rewind",),
    Capability.NATIVE_STEER: ("steer",),
    Capability.QUESTIONS: ("enable_questions", "resolve_question", "pending_questions"),
    Capability.USER_APPROVALS: ("enable_user_approvals", "resolve_approval"),
    Capability.SERVICE_TIER: ("update_session_options",),
    Capability.FORK: ("fork_session",),
    Capability.NATIVE_HISTORY: ("read_native_session",),
    Capability.COMPACT: ("compact_session",),
}


def capabilities_of(provider: Any) -> frozenset[Capability]:
    """Purpose: The capabilities a provider (instance or class) declares; none if absent."""
    return frozenset(getattr(provider, "capabilities", ()))
