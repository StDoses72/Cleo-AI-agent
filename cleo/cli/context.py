"""Shared CLI context and terminal restoration helpers."""

from __future__ import annotations

import sys
from typing import TextIO

from cleo.cli.console import CleoCLI

cli = CleoCLI()


def clear_terminal_after_tui(stream: TextIO | None = None) -> None:
    """Clear the restored terminal so the shell prompt returns on a clean screen."""
    output = stream or sys.stdout
    if not output.isatty():
        return
    output.write("\x1b[0m\x1b[?25h\x1b[2J\x1b[H")
    output.flush()
