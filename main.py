"""Backward-compatible script entry point for Cleo."""

from cleo.cli.application import amain, main

__all__ = ["amain", "main"]


if __name__ == "__main__":
    main()
