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
    """Render RGBA pixels without painting the terminal background."""

    def __rich_console__(
        self,
        console: Console,
        options: ConsoleOptions,
    ) -> RenderResult:
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
