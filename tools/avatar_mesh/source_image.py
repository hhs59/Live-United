"""Source image validation and optional EXIF normalization for avatar packages."""

from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
import hashlib

from backend.avatar_vision import get_image_dimensions, validate_image_signature

try:
    from PIL import Image, ImageOps
except ImportError:  # Pillow is optional for callers that only need raw validation.
    Image = None
    ImageOps = None


@dataclass(frozen=True)
class SourceImage:
    path: Path
    data: bytes
    mime_type: str
    width: int
    height: int
    sha256: str


def _normalize_with_pillow(data: bytes, mime_type: str) -> tuple[bytes, tuple[int, int]] | None:
    """Reject animated files and normalize non-default EXIF orientation.

    The original bytes are retained when orientation is already normal. This
    keeps ordinary provider assets byte-for-byte stable while still making a
    rotated JPEG/PNG safe for the browser package. Returning ``None`` means
    Pillow is unavailable or the lightweight header path should be used.
    """

    if Image is None or ImageOps is None:
        return None

    try:
        with Image.open(BytesIO(data)) as image:
            if getattr(image, "is_animated", False) or int(getattr(image, "n_frames", 1)) > 1:
                raise ValueError("Animated or multi-frame avatar images are not supported.")

            orientation = int(image.getexif().get(274, 1) or 1)
            if orientation == 1:
                return None

            normalized = ImageOps.exif_transpose(image)
            output = BytesIO()
            if mime_type == "image/jpeg":
                if normalized.mode not in {"RGB", "L"}:
                    normalized = normalized.convert("RGB")
                normalized.save(output, format="JPEG", quality=95, optimize=True)
            else:
                normalized.save(output, format="PNG", optimize=True)
            normalized_bytes = output.getvalue()
            return normalized_bytes, (
                int(normalized.width),
                int(normalized.height),
            )
    except ValueError:
        raise
    except Exception:
        # Header validation remains useful for minimal test fixtures and for
        # installations that have a decoder but cannot parse a particular
        # metadata segment. The backend/browser perform their own decode check.
        return None


def _has_apng_animation(data: bytes) -> bool:
    """Detect an APNG animation without requiring Pillow."""

    return data.startswith(b"\x89PNG\r\n\x1a\n") and b"acTL" in data


def read_source_image(path: Path, *, max_bytes: int = 8 * 1024 * 1024,
                      minimum_short_side: int = 512) -> SourceImage:
    path = Path(path).expanduser().resolve()
    if not path.is_file():
        raise ValueError(f"Avatar source image does not exist: {path}")
    data = path.read_bytes()
    if len(data) > max_bytes:
        raise ValueError("Avatar source image is larger than 8 MiB.")

    suffix = path.suffix.lower()
    mime_type = "image/png" if suffix == ".png" else "image/jpeg" if suffix in {".jpg", ".jpeg"} else ""
    mime_type = validate_image_signature(data, mime_type)
    if _has_apng_animation(data):
        raise ValueError("Animated or multi-frame avatar images are not supported.")

    normalized = _normalize_with_pillow(data, mime_type)
    if normalized is not None:
        data, dimensions = normalized
    else:
        dimensions = get_image_dimensions(data, mime_type)
    if len(data) > max_bytes:
        raise ValueError("Avatar source image is larger than 8 MiB after EXIF normalization.")
    if not dimensions or dimensions[0] < 1 or dimensions[1] < 1:
        raise ValueError("Avatar source image dimensions could not be read.")
    width, height = dimensions
    if min(width, height) < minimum_short_side:
        raise ValueError(f"Avatar source image must be at least {minimum_short_side}px on its shortest side.")

    return SourceImage(
        path=path,
        data=data,
        mime_type=mime_type,
        width=width,
        height=height,
        sha256=hashlib.sha256(data).hexdigest(),
    )
