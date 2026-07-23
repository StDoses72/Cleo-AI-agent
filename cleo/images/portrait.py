"""Rich half-cell fallback generated from the replaceable startup PNG."""

from __future__ import annotations

from pathlib import Path

from rich.style import Style
from rich.text import Text

from cleo.images.startup import load_startup_image

_LARGE_PIXEL_LIMIT = (74, 58)
_COMPACT_PIXEL_LIMIT = (48, 38)
_VISIBLE_ALPHA = 24
_PALETTE_COLORS = 64


def render_startup_art(
    *,
    compact: bool = False,
    image_path: str | Path | None = None,
) -> Text:
    """Render the current startup PNG with two image pixels per terminal cell."""

    image = load_startup_image(image_path)
    if image is None:
        return Text("◇", style="bold #43dff5", no_wrap=True)

    try:
        from PIL import Image as PILImage
    except (ImportError, OSError):
        return Text("◇", style="bold #43dff5", no_wrap=True)

    limit = _COMPACT_PIXEL_LIMIT if compact else _LARGE_PIXEL_LIMIT
    image.thumbnail(limit, PILImage.Resampling.LANCZOS)
    alpha = image.getchannel("A")
    colors = (
        image.convert("RGB")
        .quantize(colors=_PALETTE_COLORS, method=PILImage.Quantize.MEDIANCUT)
        .convert("RGB")
    )

    width, height = image.size
    alpha_pixels = alpha.load()
    color_pixels = colors.load()
    art = Text(no_wrap=True)

    for top_y in range(0, height, 2):
        bottom_y = top_y + 1
        for x in range(width):
            top_visible = alpha_pixels[x, top_y] > _VISIBLE_ALPHA
            bottom_visible = (
                bottom_y < height and alpha_pixels[x, bottom_y] > _VISIBLE_ALPHA
            )

            if not top_visible and not bottom_visible:
                art.append(" ")
                continue
            if not top_visible:
                art.append("▄", style=Style(color=_hex(color_pixels[x, bottom_y])))
                continue
            if not bottom_visible:
                art.append("▀", style=Style(color=_hex(color_pixels[x, top_y])))
                continue

            art.append(
                "▀",
                style=Style(
                    color=_hex(color_pixels[x, top_y]),
                    bgcolor=_hex(color_pixels[x, bottom_y]),
                ),
            )

        if top_y + 2 < height:
            art.append("\n")

    return art


def _hex(color: tuple[int, int, int]) -> str:
    return f"#{color[0]:02x}{color[1]:02x}{color[2]:02x}"
