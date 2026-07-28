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
    """Encode an RGBA image while leaving transparent Sixel pixels untouched.

    参数:
        image: 待编码图像(任意 mode,内部转 RGBA);来源:
            cleo/images/sixel_renderable.py:44 传入缩放后的 pil_image,测试
            tests/images/test_terminal.py:170 传入合成图。

    返回:
        完整 Sixel 序列字符串(DCS ... ST);透明像素经 4x4 Bayer 抖动
        (_ALPHA_DITHER)映射到 _TRANSPARENT_INDEX 并编码为 "?" 空 sixel,
        配合 header 的 P2=1 保留终端原背景。消费方: sixel_renderable.Image
        .__rich_console__ 作为控制段 yield 给终端。
    """

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
    """构造 Sixel 头部: DCS 引入、raster attributes 与调色板寄存器定义。

    参数:
        image: 已量化到 "P" mode 的图像;来源: image_to_transparent_sixels。
        color_count: 实际使用的调色板颜色数;来源: 同上(最大索引 + 1)。

    返回: 头部字符串;消费方: image_to_transparent_sixels 拼接输出。
    """
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
    """构造 Sixel 数据体: 逐行按颜色 RLE 编码,透明索引输出 "?" 空 sixel。

    参数:
        image: 已量化到 "P" mode 的图像;来源: image_to_transparent_sixels。

    返回: 数据体字符串("-" 换 sixel 行 / "$" 回车);消费方:
    image_to_transparent_sixels 拼接输出。
    """
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
    """向 token 列表追加一段重复字符,>=3 时用 Sixel RLE("!count char")。

    参数:
        tokens: 输出 token 列表(就地修改);来源: _get_body 的累加器。
        character: 要重复的 sixel 字符;来源: _get_body。
        count: 重复次数;来源: _get_body 的 groupby run 长度。

    返回: None。
    """
    if count < 3:
        tokens.append(character * count)
    else:
        tokens.append(f"!{count}{character}")
