"""Which memories a turn was given.

Before each productivity turn the harness service injects the project's preferences into the
prompt and records their ids (with a short excerpt) as one session event of this type. The
desktop timeline shows them on that turn; memory consolidation skips the event, so injected
preferences never come back as new evidence.
"""

MEMORY_CONTEXT_EVENT = "cleo/memory_context"
