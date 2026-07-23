"""Shared terminal context for Cleo's interactive entry points."""

from cleo.cli.console import CleoCLI

cli = CleoCLI()


def clear_screen() -> None:
    cli.clear()
