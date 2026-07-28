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
    """Render the current startup PNG with two image pixels per terminal cell.

    参数:
        compact: 是否使用紧凑像素上限(48x38 而非 74x58);来源:
            cleo/cli/console.py:105 按终端宽度选择。
        image_path: 可选的 PNG 覆盖路径;来源: 测试
            (tests/images/test_terminal.py)注入,生产调用为 None(走
            resolve_startup_image_path)。

    返回:
        rich Text 半块字符画(▀/▄ 上下像素复用一个字符);消费方:
        cleo/cli/console.py 启动画面打印。图片缺失或无 PIL 时返回占位符
        "◇"。
    """

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
    """把 (r, g, b) 元组格式化为 "#rrggbb"。

    参数:
        color: 量化后的 RGB 像素;来源: render_startup_art 内
            color_pixels[x, y]。

    返回: "#rrggbb" 字符串;消费方: render_startup_art 构造 rich Style。
    """
    return f"#{color[0]:02x}{color[1]:02x}{color[2]:02x}"
