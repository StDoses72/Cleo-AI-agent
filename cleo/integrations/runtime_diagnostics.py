"""Bounded, credential-redacted diagnostics from local harness processes."""

import os
import re
from pathlib import Path

# Screenshot tool results are base64 encoded and routinely exceed the SDK's 1 MiB default.
CLAUDE_MESSAGE_BUFFER_BYTES = 32 * 1024 * 1024


def diagnostic_text(value: str, *, prompt: str = "", limit: int = 2000) -> str:
    """Purpose: Make runtime error text safe and short enough for the error UI.
    Input: Diagnostic text, optional submitted prompt, and display character limit.
    Output: Text with credentials, prompt echoes and personal paths removed.
    """
    secrets = [prompt] if prompt else []
    secrets.extend(value for key, value in os.environ.items()
                   if re.search(r"KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL", key, re.I) and value)
    for secret in sorted(secrets, key=len, reverse=True):
        value = value.replace(secret, "<redacted>")
    value = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", value)
    value = re.sub(r"(?i)\b(?:Bearer|Basic)\s+[^\s\"',;]+", "Bearer <redacted>", value)
    value = re.sub(
        r"(?i)([\w-]*(?:api[_-]?key|token|secret|password|authorization|cookie)[\w-]*"
        r"[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)",
        r"\1<redacted>", value,
    )
    value = re.sub(r"\b(?:sk-|gh[pousr]_|github_pat_)[\w-]+", "<redacted>", value)
    value = re.sub(r"\beyJ[\w-]+\.[\w-]+\.[\w-]+", "<redacted>", value)
    # URLs can carry proxy credentials, signed queries or login codes.
    value = re.sub(r"https?://[^\s<>\"']+", "<url>", value)
    value = re.sub(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", "<email>", value)
    home = str(Path.home())
    for path in (home, home.replace("\\", "/"), home.replace("\\", "\\\\")):
        value = re.sub(re.escape(path), "<home>", value, flags=re.I)
    value = " ".join(value.split())
    return value[:limit] + ("…" if len(value) > limit else "")


def model_error_text(error: BaseException) -> str:
    """Purpose: Describe a failed model call the same way whatever the client SDK's version.
    Input: The exception a model client raised. HTTP errors from the OpenAI and Anthropic SDKs
    carry the status and the parsed response body.
    Output: "Error code: <status> - <provider's message>" when the body holds the provider's own
    message (SDKs differ in how they print the raw body); otherwise the exception's text.
    Not redacted: pass the result through diagnostic_text before showing it.
    """
    status = getattr(error, "status_code", None)
    body = getattr(error, "body", None)
    if isinstance(status, int) and isinstance(body, dict):
        detail = body.get("error", body)
        message = detail.get("message") if isinstance(detail, dict) else None
        if isinstance(message, str) and message.strip():
            return f"Error code: {status} - {message.strip()}"
    return str(error)


class StderrCapture:
    """Drain a pipe completely while retaining only a bounded diagnostic prefix."""

    def __init__(self) -> None:
        self.data = bytearray()
        self.truncated = False

    async def drain(self, stream) -> None:
        """Purpose: Prevent pipe deadlocks without retaining unbounded stderr.
        Input: An asynchronous subprocess stderr reader.
        Output: At most 16 KiB retained in memory, never written to a log.
        """
        while chunk := await stream.read(8192):
            remaining = 16384 - len(self.data)
            self.data.extend(chunk[:remaining])
            self.truncated |= len(chunk) > remaining

    def text(self, prompt: str = "") -> str:
        """Purpose: Decode only complete diagnostic lines before redaction.
        Input: Optional submitted prompt to remove from diagnostics.
        Output: Redacted diagnostic text; incomplete truncated lines are omitted.
        """
        data = bytes(self.data)
        if self.truncated:
            data = data.rpartition(b"\n")[0]
        text = diagnostic_text(data.decode("utf-8", errors="replace"), prompt=prompt)
        return text + (" [stderr truncated]" if self.truncated else "")
