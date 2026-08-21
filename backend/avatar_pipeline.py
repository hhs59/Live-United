"""Cached one-time avatar geometry preparation.

This boundary is deliberately separate from Gemini Live. It receives one
provider image, asks Gemini Vision at most once for an uncached image hash, and
stores only validated normalized geometry on disk.
"""

import hashlib
import json
import os
import tempfile
import threading
from pathlib import Path
from typing import Any

from .avatar_vision import (
    AVATAR_OBSERVATION_VERSION,
    AvatarVisionError,
    analyze_avatar_image,
    get_avatar_vision_model,
    validate_canonical_avatar_geometry,
    validate_image_dimensions,
    validate_image_signature,
)


AVATAR_PREPARATION_VERSION = 1
_PREPARATION_LOCK = threading.Lock()


def _source_hash(image_bytes: bytes) -> str:
    return hashlib.sha256(image_bytes).hexdigest()


def _cache_path(cache_dir: Path, source_hash: str) -> Path:
    return cache_dir / f"{source_hash}.json"


def _read_cached_geometry(cache_path: Path, source_hash: str) -> dict[str, Any] | None:
    if cache_path.name != f"{source_hash}.json":
        return None
    try:
        payload = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(payload, dict):
        return None
    if payload.get("version") != AVATAR_PREPARATION_VERSION:
        return None
    if payload.get("analysisVersion") != AVATAR_OBSERVATION_VERSION:
        return None
    if payload.get("sourceHash") != source_hash:
        return None
    try:
        return validate_canonical_avatar_geometry(payload.get("geometry"))
    except AvatarVisionError:
        return None


def _write_cached_geometry(cache_path: Path, source_hash: str, geometry: dict[str, Any]) -> None:
    payload = {
        "version": AVATAR_PREPARATION_VERSION,
        "analysisVersion": AVATAR_OBSERVATION_VERSION,
        "sourceHash": source_hash,
        "geometry": geometry,
    }
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            dir=cache_path.parent,
            prefix=f".{source_hash}.",
            suffix=".tmp",
            delete=False,
        ) as temporary:
            temporary_path = Path(temporary.name)
            json.dump(payload, temporary, ensure_ascii=False, separators=(",", ":"))
            temporary.flush()
            os.fsync(temporary.fileno())
        temporary_path.replace(cache_path)
        temporary_path = None
    finally:
        if temporary_path is not None:
            try:
                temporary_path.unlink()
            except FileNotFoundError:
                pass


def prepare_avatar(
    client: Any,
    image_bytes: bytes,
    mime_type: str,
    *,
    cache_dir: Path,
    model_name: str | None = None,
) -> dict[str, Any]:
    """Prepare one image and return a versioned cached geometry envelope."""

    normalized_mime = validate_image_signature(image_bytes, mime_type)
    image_bytes = bytes(image_bytes)
    validate_image_dimensions(image_bytes, normalized_mime)
    source_hash = _source_hash(image_bytes)
    cache_dir = Path(cache_dir)
    cache_path = _cache_path(cache_dir, source_hash)

    # Holding this one local process lock across the model call is intentional:
    # two simultaneous requests for the same image must not spend two calls.
    with _PREPARATION_LOCK:
        cached_geometry = _read_cached_geometry(cache_path, source_hash)
        if cached_geometry is not None:
            return {
                "version": AVATAR_PREPARATION_VERSION,
                "analysisVersion": AVATAR_OBSERVATION_VERSION,
                "sourceHash": source_hash,
                "cacheHit": True,
                "geometry": cached_geometry,
            }

        selected_model = model_name or get_avatar_vision_model()
        geometry = analyze_avatar_image(
            client,
            image_bytes,
            normalized_mime,
            model_name=selected_model,
        )
        # Revalidate before writing in case the model adapter is replaced in a
        # test or future integration.
        geometry = validate_canonical_avatar_geometry(geometry)
        _write_cached_geometry(cache_path, source_hash, geometry)
        return {
            "version": AVATAR_PREPARATION_VERSION,
            "analysisVersion": AVATAR_OBSERVATION_VERSION,
            "sourceHash": source_hash,
            "cacheHit": False,
            "geometry": geometry,
        }
