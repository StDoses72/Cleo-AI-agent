"""Load and render the replaceable PNG used by Cleo's startup splash."""

from __future__ import annotations

import math
import os
from collections import deque
from pathlib import Path
from typing import Any

PACKAGED_STARTUP_IMAGE_PATH = Path(__file__).with_name("assets") / "cleo-startup.png"
# Kept as a compatibility alias for callers that imported the old constant.
STARTUP_IMAGE_PATH = PACKAGED_STARTUP_IMAGE_PATH

_IMAGE_MODE_ENV = "CLEO_STARTUP_IMAGE"
_IMAGE_PATH_ENV = "CLEO_STARTUP_IMAGE_PATH"
_USER_IMAGE_RELATIVE_PATH = Path("assets") / "startup.png"
_ALPHA_THRESHOLD = 8
_COMPONENT_PREVIEW_LIMIT = 256


def resolve_startup_image_path() -> Path:
    """Resolve the user override or packaged startup PNG.

    A path explicitly selected with ``CLEO_STARTUP_IMAGE_PATH`` wins. Standalone
    installations can replace ``<CLEO_HOME>/assets/startup.png`` without editing
    the installed Python package. Source checkouts fall back to the packaged PNG.
    """

    override = os.environ.get(_IMAGE_PATH_ENV)
    if override:
        candidate = Path(override).expanduser()
        if not candidate.is_absolute():
            candidate = Path.cwd() / candidate
        return candidate.resolve()

    cleo_home = os.environ.get("CLEO_HOME")
    if cleo_home:
        user_image = Path(cleo_home).expanduser() / _USER_IMAGE_RELATIVE_PATH
        if user_image.is_file():
            return user_image.resolve()

    return PACKAGED_STARTUP_IMAGE_PATH


def load_startup_image(path: str | Path | None = None) -> Any | None:
    """Load a PNG and crop transparent padding without image-specific coordinates."""

    try:
        from PIL import Image as PILImage
        from PIL import ImageOps
    except (ImportError, OSError):
        return None

    source_path = Path(path) if path is not None else resolve_startup_image_path()
    try:
        with PILImage.open(source_path) as source:
            image = ImageOps.exif_transpose(source).convert("RGBA")
            if image.width < 1 or image.height < 1:
                return None
            if image.getchannel("A").getbbox() is None:
                return None
            content_bbox = _visible_content_bbox(image)
            if content_bbox is not None:
                image = image.crop(content_bbox)
            return image.copy()
    except (OSError, ValueError):
        return None


def _visible_content_bbox(image: Any) -> tuple[int, int, int, int] | None:
    """Find meaningful alpha content while ignoring tiny detached marks.

    The analysis runs on a small alpha preview. Components that are negligible
    relative to the main artwork are discarded, which removes stray pixels and
    detached generator marks without encoding assumptions about a specific
    character, canvas size, or composition.
    """

    try:
        from PIL import Image as PILImage
    except (ImportError, OSError):
        return None

    alpha = image.getchannel("A")
    if alpha.getbbox() is None:
        return None

    preview = alpha.copy()
    preview.thumbnail(
        (_COMPONENT_PREVIEW_LIMIT, _COMPONENT_PREVIEW_LIMIT),
        PILImage.Resampling.BOX,
    )
    width, height = preview.size
    pixels = preview.tobytes()
    visited = bytearray(width * height)
    components: list[tuple[int, tuple[int, int, int, int]]] = []

    for start in range(width * height):
        if visited[start] or pixels[start] <= _ALPHA_THRESHOLD:
            continue

        visited[start] = 1
        pending: deque[int] = deque((start,))
        area = 0
        min_x = max_x = start % width
        min_y = max_y = start // width

        while pending:
            offset = pending.popleft()
            x = offset % width
            y = offset // width
            area += 1
            min_x = min(min_x, x)
            max_x = max(max_x, x)
            min_y = min(min_y, y)
            max_y = max(max_y, y)

            for neighbor_y in range(max(0, y - 1), min(height, y + 2)):
                row_offset = neighbor_y * width
                for neighbor_x in range(max(0, x - 1), min(width, x + 2)):
                    neighbor = row_offset + neighbor_x
                    if visited[neighbor] or pixels[neighbor] <= _ALPHA_THRESHOLD:
                        continue
                    visited[neighbor] = 1
                    pending.append(neighbor)

        components.append((area, (min_x, min_y, max_x + 1, max_y + 1)))

    if not components:
        return alpha.getbbox()

    largest_area = max(area for area, _ in components)
    minimum_area = max(1, int(largest_area * 0.01))
    retained = [bbox for area, bbox in components if area >= minimum_area]
    left = min(bbox[0] for bbox in retained)
    top = min(bbox[1] for bbox in retained)
    right = max(bbox[2] for bbox in retained)
    bottom = max(bbox[3] for bbox in retained)

    padding = max(1, round(max(width, height) * 0.01))
    left = max(0, left - padding)
    top = max(0, top - padding)
    right = min(width, right + padding)
    bottom = min(height, bottom + padding)

    scale_x = image.width / width
    scale_y = image.height / height
    return (
        max(0, math.floor(left * scale_x)),
        max(0, math.floor(top * scale_y)),
        min(image.width, math.ceil(right * scale_x)),
        min(image.height, math.ceil(bottom * scale_y)),
    )


def startup_image_height(terminal_height: int) -> int:
    """Choose a detailed image height that remains shorter than the viewport."""

    return max(6, min(34, terminal_height - 5))


def build_startup_image(*, height: int) -> Any | None:
    """Return a native terminal image, or ``None`` for the pixel-art fallback.

    ``textual-image`` queries the terminal and selects Sixel or Kitty graphics when
    available. Set ``CLEO_STARTUP_IMAGE=sixel`` to force Sixel, ``tgp`` to force
    Kitty's protocol, or ``pixels``/``off`` to skip native image rendering.
    """

    mode = os.environ.get(_IMAGE_MODE_ENV, "auto").strip().lower()
    if mode in {"off", "pixels"}:
        return None

    try:
        from textual_image.renderable import (
            HalfcellImage,
            SixelImage,
            TGPImage,
            UnicodeImage,
        )
        from textual_image.renderable import (
            Image as AutoImage,
        )
    except (ImportError, OSError):
        return None

    if mode == "sixel":
        image_type = SixelImage
    elif mode == "tgp":
        image_type = TGPImage
    elif mode == "auto":
        image_type = AutoImage
        if image_type in {HalfcellImage, UnicodeImage}:
            return None
    else:
        return None

    if image_type is SixelImage:
        from cleo.images.sixel_renderable import Image as TransparentSixelImage

        image_type = TransparentSixelImage

    image = load_startup_image()
    if image is None:
        return None

    try:
        return image_type(image, width="auto", height=height)
    except (OSError, ValueError):
        return None
