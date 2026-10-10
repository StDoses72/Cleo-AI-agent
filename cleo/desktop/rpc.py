"""Explicit method table of the desktop JSON-lines protocol.

Every method the Electron shell may call is listed here once, with who calls it:

- ``renderer``: reachable from the renderer through ``allowedMethods`` in
  ``ui/electron/main.mjs`` (the main process may call these too);
- ``main``: called only by the Electron main process (``ui/electron/*.mjs``);
- ``unused``: still served for compatibility, but no client calls it.

``tests/desktop/test_rpc_registry.py`` checks this table against the service and against
the Electron sources, so a method cannot be added or dropped on one side only. Handlers are
the ``DesktopService`` methods of the same name, looked up at call time and called with the
request's parameters unchanged, so argument errors keep their ``TypeError`` text.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Iterable
from dataclasses import dataclass
from typing import Any, Literal

Audience = Literal["renderer", "main", "unused"]
Emit = Callable[[dict[str, Any]], Awaitable[None]]


@dataclass(frozen=True, slots=True)
class RpcMethod:
    name: str
    audience: Audience
    # Streaming methods receive ``emit`` and always reply with a null result.
    streaming: bool = False
    # Handled by the protocol server itself instead of the service.
    server: bool = False


def _methods(audience: Audience, *names: str) -> tuple[RpcMethod, ...]:
    return tuple(RpcMethod(name, audience) for name in names)


DESKTOP_METHODS: tuple[RpcMethod, ...] = (
    # Workspace and projects.
    *_methods("renderer", "load_workspace", "load_memory", "add_project", "remove_project",
              "restore_chat_backups", "reset_workspace"),
    # Threads.
    *_methods("renderer", "load_thread", "create_thread", "delete_thread",
              "open_evolution_thread"),
    # Turns and runs.
    RpcMethod("stream_turn", "renderer", streaming=True),
    *_methods("renderer", "steer_run", "rewind_thread", "cancel_run", "resolve_approval",
              "resolve_question", "get_pending_questions", "undo_changes", "update_runtime",
              "switch_harness"),
    # Timeline.
    *_methods("renderer", "load_timeline", "read_timeline_content", "get_timing"),
    # Settings, catalogs and instructions.
    *_methods("renderer", "get_config_status", "get_config_templates", "get_agent_instructions",
              "save_agent_instructions", "get_model_settings", "get_runtime_catalog",
              "get_productivity_models", "get_local_skills", "get_harness_sync",
              "sync_harness_items"),
    # Model connections (configuration writes).
    *_methods("renderer", "save_model_profile", "save_dream_settings", "check_model_connection",
              "create_model_connection", "select_chat_model", "rename_model_connection",
              "remove_model_connection"),
    # Subscriptions.
    *_methods("renderer", "get_subscription_catalog", "check_subscription",
              "start_subscription_login", "read_subscription_login",
              "cancel_subscription_login"),
    # Memory review.
    *_methods("renderer", "get_memory_review_details", "review_memory_source",
              "get_background_memory_state", "save_background_memory_settings"),
    # Electron main process only: evolution guard, computer use and lifecycle.
    *_methods("main", "is_evolution_thread", "release_runtime", "computer_host",
              "computer_host_stop", "computer_owner", "computer_scope",
              "run_background_memory_review", "cancel_background_memory_review"),
    RpcMethod("shutdown", "main", server=True),
    # No client calls these any more.
    *_methods("unused", "analyze_evolution_request"),
)


def unsupported(name: str) -> ValueError:
    return ValueError(f"unsupported desktop method: {name}")


def wire_error(error: BaseException) -> dict[str, str]:
    """Purpose: Map an exception to the protocol's error object.

    Input: The exception a handler raised. Output: ``{"name", "message"}``; ``name`` is the
    Python class name, which the desktop shell and the characterization snapshots rely on.
    """
    return {"name": type(error).__name__, "message": str(error)}


class RpcRegistry:
    """Look up protocol methods by name and call them on a target service."""

    def __init__(self, methods: Iterable[RpcMethod] = DESKTOP_METHODS) -> None:
        self._methods: dict[str, RpcMethod] = {}
        for method in methods:
            if method.name in self._methods:
                raise ValueError(f"duplicate desktop method: {method.name}")
            self._methods[method.name] = method

    def names(self, audience: Audience | None = None) -> tuple[str, ...]:
        """Purpose: List registered names, optionally only those of one audience."""
        return tuple(name for name, method in self._methods.items()
                     if audience is None or method.audience == audience)

    def resolve(self, name: str) -> RpcMethod:
        """Purpose: Return the method entry. Raises ValueError for unknown names."""
        method = self._methods.get(name)
        if method is None:
            raise unsupported(name)
        return method

    async def dispatch(self, target: Any, name: str, params: dict[str, Any], emit: Emit) -> Any:
        """Purpose: Call ``target.<name>(**params)`` for a registered service method.

        Input: Service, method name, request parameters and the event sink.
        Output: The handler's result (None for streaming methods).
        """
        method = self.resolve(name)
        handler = getattr(target, name, None) if not method.server else None
        if not callable(handler):
            raise unsupported(name)
        if method.streaming:
            await handler(emit=emit, **params)
            return None
        return await handler(**params)
