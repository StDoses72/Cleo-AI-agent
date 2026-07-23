from io import StringIO

from PIL import Image as PILImage
from rich.console import Console
from rich.text import Text

from cleo.cli.console import CleoCLI
from cleo.images.portrait import render_startup_art
from cleo.images.sixel_encoder import image_to_transparent_sixels
from cleo.images.startup import (
    load_startup_image,
    resolve_startup_image_path,
    startup_image_height,
)


def test_cli_renders_startup_portrait_once_on_a_color_terminal(monkeypatch) -> None:
    output = StringIO()
    console = Console(
        file=output,
        color_system="truecolor",
        force_terminal=True,
        width=120,
    )
    cli = CleoCLI(console)
    monkeypatch.setattr("cleo.cli.console.build_startup_image", lambda **_: None)

    cli.render_startup_splash("local-123456789", "cleo", model="gpt-test")
    cli.render_startup_splash("local-second", "other", model="another-model")

    rendered = output.getvalue()
    assert rendered.count("CLEO // COLD START") == 1
    assert "C L E O" in rendered
    assert "local-123456789" in rendered
    assert "gpt-test" in rendered
    assert "local-second" not in rendered


def test_startup_portrait_has_large_and_compact_terminal_sizes() -> None:
    large_lines = render_startup_art().plain.splitlines()
    compact_lines = render_startup_art(compact=True).plain.splitlines()

    assert 1 <= len(large_lines) <= 29
    assert 1 <= len(compact_lines) <= 19
    assert max(map(len, large_lines)) <= 74
    assert max(map(len, compact_lines)) <= 48


def test_startup_portrait_is_generated_from_the_selected_png(
    tmp_path,
    monkeypatch,
) -> None:
    red_path = tmp_path / "red.png"
    blue_path = tmp_path / "blue.png"
    PILImage.new("RGBA", (8, 8), (255, 0, 0, 255)).save(red_path)
    PILImage.new("RGBA", (8, 8), (0, 0, 255, 255)).save(blue_path)

    monkeypatch.setenv("CLEO_STARTUP_IMAGE_PATH", str(red_path))
    red = render_startup_art()
    monkeypatch.setenv("CLEO_STARTUP_IMAGE_PATH", str(blue_path))
    blue = render_startup_art()

    assert resolve_startup_image_path() == blue_path.resolve()
    assert "#ff0000" in str(red.spans[0].style)
    assert "#0000ff" in str(blue.spans[0].style)
    assert red != blue


def test_startup_image_uses_cleo_home_override(tmp_path, monkeypatch) -> None:
    user_image = tmp_path / "assets" / "startup.png"
    user_image.parent.mkdir()
    PILImage.new("RGBA", (4, 4), (0, 255, 255, 255)).save(user_image)
    monkeypatch.delenv("CLEO_STARTUP_IMAGE_PATH", raising=False)
    monkeypatch.setenv("CLEO_HOME", str(tmp_path))

    assert resolve_startup_image_path() == user_image.resolve()


def test_startup_image_autocrop_ignores_tiny_detached_marks(tmp_path) -> None:
    image_path = tmp_path / "character.png"
    image = PILImage.new("RGBA", (100, 100), (0, 0, 0, 0))
    for x in range(55, 95):
        for y in range(5, 85):
            image.putpixel((x, y), (255, 255, 255, 255))
    for x in range(2, 6):
        for y in range(95, 98):
            image.putpixel((x, y), (255, 255, 255, 255))
    image.save(image_path)

    cropped = load_startup_image(image_path)

    assert cropped is not None
    assert cropped.width < 60
    assert cropped.height < 90


def test_fully_transparent_startup_image_uses_safe_fallback(tmp_path) -> None:
    image_path = tmp_path / "empty.png"
    PILImage.new("RGBA", (16, 16), (0, 0, 0, 0)).save(image_path)

    assert load_startup_image(image_path) is None
    assert render_startup_art(image_path=image_path).plain == "◇"


def test_cli_prefers_native_terminal_image_when_available(monkeypatch) -> None:
    output = StringIO()
    console = Console(
        file=output,
        color_system="truecolor",
        force_terminal=True,
        width=120,
        height=40,
    )
    cli = CleoCLI(console)
    requested: list[int] = []

    def fake_startup_image(*, height: int) -> Text:
        requested.append(height)
        return Text("NATIVE TERMINAL IMAGE")

    monkeypatch.setattr("cleo.cli.console.build_startup_image", fake_startup_image)

    cli.render_startup_splash("local-123456789", "cleo", model="gpt-test")

    rendered = output.getvalue()
    assert requested == [34]
    assert "NATIVE TERMINAL IMAGE" in rendered
    assert "CLEO // COLD START" in rendered
    assert "MEMORY" in rendered
    assert "local-123456789" in rendered
    assert "gpt-test" in rendered
    assert "Ready before you asked." not in rendered


def test_startup_native_image_height_stays_inside_viewport() -> None:
    assert startup_image_height(10) == 6
    assert startup_image_height(30) == 25
    assert startup_image_height(50) == 34


def test_sixel_encoder_keeps_transparent_pixels_unpainted() -> None:
    image = PILImage.new("RGBA", (2, 1), (0, 0, 0, 0))
    image.putpixel((1, 0), (255, 0, 0, 255))

    sixels = image_to_transparent_sixels(image)

    assert sixels.startswith('\x1bP0;1;0q"1;1;2;1')
    assert "?" in sixels
    assert "#255" not in sixels
    assert sixels.endswith("\x1b\\")
