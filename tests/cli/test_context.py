from __future__ import annotations

from io import StringIO

from cleo.cli.context import clear_terminal_after_tui


class TTYBuffer(StringIO):
    def isatty(self) -> bool:
        return True


def test_clear_terminal_after_tui_restores_cursor_and_clears_screen() -> None:
    output = TTYBuffer()

    clear_terminal_after_tui(output)

    assert output.getvalue() == "\x1b[0m\x1b[?25h\x1b[2J\x1b[H"
