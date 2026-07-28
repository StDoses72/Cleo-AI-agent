"""Rich renderable for Sixel images with transparent backgrounds."""

from __future__ import annotations

from rich.console import Console, ConsoleOptions, RenderResult
from rich.control import Control
from rich.segment import ControlType, Segment
from textual_image._terminal import get_cell_size
from textual_image.renderable.sixel import Image as SixelImage

from cleo.images.sixel_encoder import image_to_transparent_sixels

_NULL_CONTROL = [(ControlType.CURSOR_FORWARD, 0)]


class Image(SixelImage):
    """Render RGBA pixels without painting the terminal background.

    继承 textual_image 的 SixelImage,仅替换编码器为保留透明的
    image_to_transparent_sixels。实例化方: cleo/images/startup.py:202
    (build_startup_image 在 Sixel 模式下选用);消费方:
    cleo/cli/console.py 将其作为 renderable 打印启动画面。
    """

    def __rich_console__(
        self,
        console: Console,
        options: ConsoleOptions,
    ) -> RenderResult:
        """Rich 渲染协议: 预留空行、回退光标后输出透明 Sixel 序列。

        参数:
            console / options: 由 rich Console.print 在渲染时注入;来源:
                cleo/cli/console.py 打印启动画面。

        返回:
            yield Segment/Control 序列(RenderResult);先铺 cell_height 行
            空白占位,再 save cursor(\x1b7)、上移、输出 Sixel、restore
            cursor(\x1b8)。消费方: rich 渲染管线。
        """
        terminal_sizes = get_cell_size()
        cell_width, cell_height = self._render_size.get_cell_size(
            options.max_width,
            options.max_height,
            terminal_sizes,
        )
        pixel_width, pixel_height = self._render_size.get_pixel_size(
            options.max_width,
            options.max_height,
            terminal_sizes,
        )

        for _ in range(cell_height):
            yield Segment(" " * cell_width + "\n")

        yield Segment("\x1b7", control=_NULL_CONTROL)
        yield Control.move(0, -cell_height)

        scaled_image = self._image_data.scaled(pixel_width, pixel_height)
        yield Segment(
            image_to_transparent_sixels(scaled_image.pil_image),
            control=_NULL_CONTROL,
        )
        yield Segment("\x1b8", control=_NULL_CONTROL)
