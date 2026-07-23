"""Sixel encoding that preserves transparent pixels."""

from __future__ import annotations

from itertools import groupby

from PIL import Image as PILImage

_DCS = "\x1bP"
_ST = "\x1b\\"
_MAX_COLORS = 255
_TRANSPARENT_INDEX = 255
_ALPHA_DITHER = (
    0,
    128,
    32,
    160,
    192,
    64,
    224,
    96,
    48,
    176,
    16,
    144,
    240,
    112,
    208,
    80,
)


def image_to_transparent_sixels(image: PILImage.Image) -> str:
    """Encode an RGBA image while leaving transparent Sixel pixels untouched."""

    rgba = image.convert("RGBA")
    alpha = rgba.getchannel("A")
    paletted = rgba.convert("RGB").convert(
        "P",
        palette=PILImage.Palette.ADAPTIVE,
        colors=_MAX_COLORS,
    )
    palette_indices = bytearray(paletted.tobytes())
    color_count = max(palette_indices, default=0) + 1
    alpha_values = alpha.tobytes()

    for offset, opacity in enumerate(alpha_values):
        x = offset % rgba.width
        y = offset // rgba.width
        threshold = _ALPHA_DITHER[(y % 4) * 4 + x % 4]
        if opacity <= threshold:
            palette_indices[offset] = _TRANSPARENT_INDEX

    paletted.putdata(palette_indices)
    return "".join(
        (
            _get_header(paletted, color_count),
            _get_body(paletted),
            _ST,
        )
    )


def _get_header(image: PILImage.Image, color_count: int) -> str:
    # P2=1 leaves pixels that are not explicitly painted at their current color.
    sixel_mode = f"{_DCS}0;1;0"
    raster_attributes = f'q"1;1;{image.width};{image.height}'
    palette = image.getpalette() or []
    registers = []
    for color_index in range(color_count):
        offset = color_index * 3
        red, green, blue = palette[offset : offset + 3]
        color = ";".join(
            str(int(channel / 256 * 100)) for channel in (red, green, blue)
        )
        registers.append(f"#{color_index};2;{color}")
    return f"{sixel_mode}{raster_attributes}{''.join(registers)}"


def _get_body(image: PILImage.Image) -> str:
    tokens: list[str] = []
    width = image.width
    pixels = image.tobytes()

    for y in range(image.height):
        row = pixels[y * width : (y + 1) * width]
        sixel_bit = 1 << y % 6
        for color, run in groupby(row):
            count = sum(1 for _ in run)
            if color == _TRANSPARENT_INDEX:
                _append_run(tokens, "?", count)
                continue

            tokens.append(f"#{color}")
            _append_run(tokens, chr(0x3F + sixel_bit), count)
        tokens.append("-" if sixel_bit == 32 else "$")

    return "".join(tokens)


def _append_run(tokens: list[str], character: str, count: int) -> None:
    if count < 3:
        tokens.append(character * count)
    else:
        tokens.append(f"!{count}{character}")
