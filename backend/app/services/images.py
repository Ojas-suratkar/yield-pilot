"""Pictures people upload (a logo, a profile photo), always re-drawn on the server: never stored as sent, so no scripts, no
metadata (a phone photo's location goes) and no oversized files."""

import base64
import io
import re

from fastapi import HTTPException

_DATA_URL = re.compile(r"^data:image/(png|jpe?g|webp|gif);base64,([A-Za-z0-9+/=]+)$")
MAX_BASE64 = 1_500_000  # about 1 MB of image
MAX_PIXELS = 40_000_000  # a "decompression bomb" (a small file that opens enormous) is refused


def redraw(data_url: str, size: int, what: str, square: bool = False) -> str:
    """A browser's data: URL re-drawn as a PNG at most `size` pixels wide (cropped to the centre square for a profile photo)."""
    m = _DATA_URL.match(data_url.strip())
    if not m or len(m.group(2)) > MAX_BASE64:
        raise HTTPException(422, f"Use a PNG, JPEG or WebP image under 1 MB for the {what}.")
    from PIL import Image, ImageOps

    try:
        img = Image.open(io.BytesIO(base64.b64decode(m.group(2))))
        if img.width * img.height > MAX_PIXELS:
            raise ValueError("too large")
        img = ImageOps.exif_transpose(img).convert("RGBA")  # a phone photo the right way up
        if square:
            img = ImageOps.fit(img, (size, size), Image.Resampling.LANCZOS)
        else:
            img.thumbnail((size, size))
        out = io.BytesIO()
        img.save(out, "PNG", optimize=True)
    except Exception:
        raise HTTPException(422, f"That image couldn't be read. Try a PNG or JPEG for the {what}.")
    return "data:image/png;base64," + base64.b64encode(out.getvalue()).decode()
