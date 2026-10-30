"""Render the Kinly icon from src-tauri/icons/icon.svg (librsvg via PyGObject) at the sizes Tauri bundles,
plus the multi-size icon.ico Windows needs (Pillow).

usage: python3 scripts/make-icon.py
"""
from pathlib import Path
import gi

gi.require_version("Rsvg", "2.0")
from gi.repository import Rsvg  # noqa: E402
import cairo  # noqa: E402

root = Path(__file__).resolve().parent.parent
icons = root / "src-tauri" / "icons"
handle = Rsvg.Handle.new_from_file(str(icons / "icon.svg"))


def render(size: int, out: Path) -> None:
    surface = cairo.ImageSurface(cairo.FORMAT_ARGB32, size, size)
    ctx = cairo.Context(surface)
    rect = Rsvg.Rectangle()
    rect.x, rect.y, rect.width, rect.height = 0, 0, size, size
    handle.render_document(ctx, rect)
    surface.write_to_png(str(out))


for name, size in [("32x32.png", 32), ("128x128.png", 128), ("128x128@2x.png", 256), ("icon.png", 512)]:
    render(size, icons / name)
render(256, root / "public" / "kinly.png")


def write_ico() -> None:
    """Windows icon (tauri-build embeds it in the .exe resources; NSIS/MSI use it too)."""
    from PIL import Image

    Image.open(icons / "icon.png").convert("RGBA").save(
        icons / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    )


write_ico()
print("icons written to", icons)
