"""One-time Gemini vision analysis for provider avatar images.

This module owns the remote setup-time analysis boundary. It returns validated
geometry only; it never participates in Gemini Live audio or frame rendering.
"""

import json
import math
import os
import struct
from typing import Any

from google.genai import types

from .prompts import AVATAR_ANALYSIS_PROMPT


DEFAULT_AVATAR_VISION_MODEL = "gemini-3.1-flash-lite"
AVATAR_VISION_MODEL = DEFAULT_AVATAR_VISION_MODEL
MAX_AVATAR_IMAGE_BYTES = 8 * 1024 * 1024
MIN_AVATAR_IMAGE_SIDE = 512
ALLOWED_AVATAR_MIME_TYPES = frozenset({"image/png", "image/jpeg"})
AVATAR_OBSERVATION_VERSION = 2

AVATAR_OBSERVATION_SCHEMA = {
    "type": "object",
    "properties": {
        "character_box": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "head_box": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "torso_box": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "neck_point": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "root_point": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "face_box": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "mouth_box": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "left_eye_box": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "right_eye_box": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "nose_box": {
            "type": ["array", "null"],
            "items": {"type": "integer"},
        },
        "chin_y": {"type": ["integer", "null"]},
        "orientation": {
            "type": "string",
            "enum": ["frontal", "near_frontal", "profile", "unknown"],
        },
        "single_character": {"type": ["boolean", "null"]},
        "head_visible": {"type": ["boolean", "null"]},
        "torso_visible": {"type": ["boolean", "null"]},
        "mouth_visible": {"type": "boolean"},
        "mouth_occluded": {"type": "boolean"},
        "confidence": {"type": "number"},
    },
    "required": [
        "character_box",
        "head_box",
        "torso_box",
        "neck_point",
        "root_point",
        "face_box",
        "mouth_box",
        "left_eye_box",
        "right_eye_box",
        "nose_box",
        "chin_y",
        "orientation",
        "single_character",
        "head_visible",
        "torso_visible",
        "mouth_visible",
        "mouth_occluded",
        "confidence",
    ],
}

_OPTIONAL_BOX_FIELDS = ("left_eye_box", "right_eye_box", "nose_box")
_ALLOWED_ORIENTATIONS = frozenset({"frontal", "near_frontal"})


class AvatarVisionError(ValueError):
    """Expected invalid or unusable model output."""


class AvatarVisionUnavailableError(RuntimeError):
    """The remote model cannot be reached or is not configured."""


class AvatarVisionQuotaError(RuntimeError):
    """The remote model rejected the request because of quota/rate limits."""


def get_avatar_vision_model() -> str:
    """Return the configured model after the server has loaded `.env`."""

    return os.environ.get("AVATAR_VISION_MODEL", DEFAULT_AVATAR_VISION_MODEL).strip() \
        or DEFAULT_AVATAR_VISION_MODEL


def normalize_mime_type(mime_type: str) -> str:
    """Normalize a Content-Type value to its supported media type."""

    if not isinstance(mime_type, str):
        return ""
    return mime_type.split(";", 1)[0].strip().lower()


def validate_image_signature(image_bytes: bytes, mime_type: str) -> str:
    """Validate supported MIME type and magic bytes, returning normalized MIME."""

    normalized_mime = normalize_mime_type(mime_type)
    if normalized_mime not in ALLOWED_AVATAR_MIME_TYPES:
        raise AvatarVisionError("Unsupported avatar image MIME type.")
    if not isinstance(image_bytes, (bytes, bytearray, memoryview)):
        raise AvatarVisionError("Avatar image body must be binary data.")

    data = bytes(image_bytes)
    if not data:
        raise AvatarVisionError("Avatar image body is empty.")
    if len(data) > MAX_AVATAR_IMAGE_BYTES:
        raise AvatarVisionError("Avatar image is too large.")

    if normalized_mime == "image/png":
        valid_signature = data.startswith(b"\x89PNG\r\n\x1a\n")
    else:
        valid_signature = data.startswith(b"\xff\xd8\xff")

    if not valid_signature:
        raise AvatarVisionError("Avatar image signature does not match its MIME type.")
    return normalized_mime


def get_image_dimensions(image_bytes: bytes, mime_type: str) -> tuple[int, int]:
    """Read dimensions from a supported PNG/JPEG header without decoding pixels."""

    normalized_mime = normalize_mime_type(mime_type)
    data = bytes(image_bytes) if isinstance(image_bytes, (bytes, bytearray, memoryview)) else b""
    if normalized_mime == "image/png":
        if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
            raise AvatarVisionError("PNG dimensions are unavailable.")
        width, height = struct.unpack(">II", data[16:24])
    elif normalized_mime == "image/jpeg":
        width, height = _get_jpeg_dimensions(data)
    else:
        raise AvatarVisionError("Unsupported avatar image MIME type.")

    if width < 1 or height < 1:
        raise AvatarVisionError("Avatar image dimensions are invalid.")
    return width, height


def _get_jpeg_dimensions(data: bytes) -> tuple[int, int]:
    """Find a JPEG Start Of Frame marker using only the container headers."""

    if len(data) < 4 or not data.startswith(b"\xff\xd8\xff"):
        raise AvatarVisionError("JPEG dimensions are unavailable.")

    # SOF markers that carry sample precision, height, and width. DHT/DQT and
    # restart markers do not carry image dimensions and are skipped below.
    sof_markers = {
        *range(0xC0, 0xC4),
        *range(0xC5, 0xC8),
        *range(0xC9, 0xCC),
        *range(0xCD, 0xD0),
    }
    offset = 2
    while offset < len(data):
        while offset < len(data) and data[offset] == 0xFF:
            offset += 1
        if offset >= len(data):
            break
        marker = data[offset]
        offset += 1
        if marker == 0x00:
            continue
        if marker in {0xD8, 0xD9}:
            continue
        if 0xD0 <= marker <= 0xD7 or marker == 0x01:
            continue
        if offset + 2 > len(data):
            break
        segment_length = struct.unpack(">H", data[offset:offset + 2])[0]
        if segment_length < 2 or offset + segment_length > len(data):
            break
        if marker in sof_markers:
            if segment_length < 7:
                break
            height, width = struct.unpack(">HH", data[offset + 3:offset + 7])
            return width, height
        offset += segment_length

    raise AvatarVisionError("JPEG dimensions are unavailable.")


def validate_image_dimensions(image_bytes: bytes, mime_type: str) -> tuple[int, int]:
    """Require the minimum source size for automatic avatar preparation."""

    width, height = get_image_dimensions(image_bytes, mime_type)
    if min(width, height) < MIN_AVATAR_IMAGE_SIDE:
        raise AvatarVisionError(
            f"Avatar image must be at least {MIN_AVATAR_IMAGE_SIDE}px on its shortest side."
        )
    return width, height


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool) \
        and math.isfinite(float(value))


def _box_edges(box: dict[str, float]) -> tuple[float, float, float, float]:
    return (
        box["x"] - box["width"] / 2,
        box["y"] - box["height"] / 2,
        box["x"] + box["width"] / 2,
        box["y"] + box["height"] / 2,
    )


def _boxes_overlap(left: dict[str, float], right: dict[str, float]) -> bool:
    left_x1, left_y1, left_x2, left_y2 = _box_edges(left)
    right_x1, right_y1, right_x2, right_y2 = _box_edges(right)
    return max(left_x1, right_x1) < min(left_x2, right_x2) \
        and max(left_y1, right_y1) < min(left_y2, right_y2)


def normalize_box_1000(value: Any, field_name: str = "box") -> dict[str, float]:
    """Convert raw or canonical normalized coordinates into a center box."""

    if isinstance(value, dict):
        values = {field: value.get(field) for field in ("x", "y", "width", "height")}
        if any(not _is_number(item) for item in values.values()):
            raise AvatarVisionError(f"{field_name} values must be finite numbers.")
        box = {field: float(item) for field, item in values.items()}
        if box["width"] <= 0 or box["height"] <= 0 or not _box_inside_image(box):
            raise AvatarVisionError(f"{field_name} must describe an area inside the image.")
        return box

    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise AvatarVisionError(f"{field_name} must contain four coordinates.")
    if any(not isinstance(item, int) or isinstance(item, bool) for item in value):
        raise AvatarVisionError(f"{field_name} coordinates must be integers.")

    ymin, xmin, ymax, xmax = value
    if any(item < 0 or item > 1000 for item in value):
        raise AvatarVisionError(f"{field_name} coordinates must be between 0 and 1000.")
    if ymax <= ymin or xmax <= xmin:
        raise AvatarVisionError(f"{field_name} coordinates must describe an area.")

    return {
        "x": (xmin + xmax) / 2000,
        "y": (ymin + ymax) / 2000,
        "width": (xmax - xmin) / 1000,
        "height": (ymax - ymin) / 1000,
    }


def _optional_box(value: Any, field_name: str) -> dict[str, float] | None:
    if value is None:
        return None
    try:
        return normalize_box_1000(value, field_name)
    except AvatarVisionError:
        return None


def _optional_point(value: Any, field_name: str) -> dict[str, float] | None:
    """Convert a nullable [y, x] point from the model into normalized form."""

    if value is None:
        return None
    if isinstance(value, dict):
        x = value.get("x")
        y = value.get("y")
        if _is_number(x) and _is_number(y) and 0 <= x <= 1 and 0 <= y <= 1:
            return {"x": float(x), "y": float(y)}
        return None
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        return None
    if any(not isinstance(item, int) or isinstance(item, bool) for item in value):
        return None
    y, x = value
    if not 0 <= y <= 1000 or not 0 <= x <= 1000:
        return None
    return {"x": x / 1000, "y": y / 1000}


def _point_inside_image(point: dict[str, float] | None) -> bool:
    return bool(point and 0 <= point["x"] <= 1 and 0 <= point["y"] <= 1)


def _box_contains(outer: dict[str, float], inner: dict[str, float], tolerance: float) -> bool:
    outer_left, outer_top, outer_right, outer_bottom = _box_edges(outer)
    inner_left, inner_top, inner_right, inner_bottom = _box_edges(inner)
    return (
        inner_left >= outer_left - tolerance and
        inner_top >= outer_top - tolerance and
        inner_right <= outer_right + tolerance and
        inner_bottom <= outer_bottom + tolerance
    )


def _validate_mesh_geometry(value: dict[str, Any], confidence: float) -> dict[str, Any] | None:
    """Validate body geometry independently from the mouth capability."""

    if value.get("single_character") is not True:
        return None
    if value.get("head_visible") is not True or value.get("torso_visible") is not True:
        return None
    if confidence < 0.65:
        return None

    character = _optional_box(value.get("character_box"), "character_box")
    head = _optional_box(value.get("head_box"), "head_box")
    torso = _optional_box(value.get("torso_box"), "torso_box")
    neck = _optional_point(value.get("neck_point"), "neck_point")
    root = _optional_point(value.get("root_point"), "root_point")
    if not all((item is not None and _box_inside_image(item) for item in (character, head, torso))):
        return None
    if not _point_inside_image(neck) or not _point_inside_image(root):
        return None
    if head["width"] < 0.08 or head["height"] < 0.08:
        return None
    if torso["width"] < 0.08 or torso["height"] < 0.08:
        return None
    tolerance = max(0.03, character["width"] * 0.08)
    if not _box_contains(character, head, tolerance) or not _box_contains(character, torso, tolerance):
        return None
    if head["y"] >= torso["y"]:
        return None

    head_edges = _box_edges(head)
    torso_edges = _box_edges(torso)
    if not (
        head_edges[3] >= neck["y"] - 0.12 and
        head_edges[3] <= neck["y"] + 0.14 and
        torso_edges[1] <= neck["y"] + 0.14 and
        torso_edges[1] >= neck["y"] - 0.18
    ):
        return None

    character_edges = _box_edges(character)
    if root["y"] < character["y"] or root["y"] < character_edges[3] - character["height"] * 0.55:
        return None
    if abs(root["x"] - character["x"]) > character["width"] * 0.45:
        return None

    return {
        "character_box": character,
        "head_box": head,
        "torso_box": torso,
        "neck_point": neck,
        "root_point": root,
    }


def _validate_mouth_geometry(value: dict[str, Any], confidence: float) -> dict[str, Any] | None:
    """Validate the existing conservative face/mouth capability."""

    if value.get("mouth_visible") is not True or value.get("mouth_occluded") is True:
        return None
    if confidence < 0.55:
        return None

    try:
        face = normalize_box_1000(value.get("face_box"), "face_box")
        mouth = normalize_box_1000(value.get("mouth_box"), "mouth_box")
    except AvatarVisionError:
        return None
    if not _box_inside_image(face) or not _box_inside_image(mouth):
        return None

    face_left, face_top, face_right, face_bottom = _box_edges(face)
    mouth_left, mouth_top, mouth_right, mouth_bottom = _box_edges(mouth)
    face_width = face["width"]
    face_height = face["height"]
    relative_x = (mouth["x"] - face_left) / face_width
    relative_y = (mouth["y"] - face_top) / face_height
    width_ratio = mouth["width"] / face_width
    if not 0.12 <= relative_x <= 0.88:
        return None
    if not 0.40 <= relative_y <= 0.95:
        return None
    if not 0.03 <= width_ratio <= 0.80:
        return None
    if mouth["height"] > mouth["width"] * 0.60:
        return None
    if not _box_inside_face(mouth, face, face_width * 0.08):
        return None

    optional_boxes = {
        field: _optional_box(value.get(field), field)
        for field in _OPTIONAL_BOX_FIELDS
    }
    for field, box in optional_boxes.items():
        if box is None or not _box_inside_image(box):
            optional_boxes[field] = None
            continue
        if field.endswith("eye_box") and _boxes_overlap(mouth, box):
            optional_boxes[field] = None

    nose = optional_boxes["nose_box"]
    if nose is not None and nose["y"] >= mouth["y"]:
        optional_boxes["nose_box"] = None

    chin_y = value.get("chin_y")
    if chin_y is not None:
        if not isinstance(chin_y, int) or isinstance(chin_y, bool) or not 0 <= chin_y <= 1000:
            chin_y = None
        else:
            chin_y = chin_y / 1000
            if chin_y <= mouth_bottom or chin_y > face_bottom + face_height * 0.08:
                chin_y = None

    return {
        "face_box": face,
        "mouth_box": mouth,
        "left_eye_box": optional_boxes["left_eye_box"],
        "right_eye_box": optional_boxes["right_eye_box"],
        "nose_box": optional_boxes["nose_box"],
        "chin_y": chin_y,
    }


def _box_inside_image(box: dict[str, float]) -> bool:
    left, top, right, bottom = _box_edges(box)
    return (
        0 <= left <= right <= 1 and
        0 <= top <= bottom <= 1
    )


def _box_inside_face(box: dict[str, float], face: dict[str, float], tolerance: float) -> bool:
    box_left, box_top, box_right, box_bottom = _box_edges(box)
    face_left, face_top, face_right, face_bottom = _box_edges(face)
    return (
        box_left >= face_left - tolerance and
        box_right <= face_right + tolerance and
        box_top >= face_top - tolerance and
        box_bottom <= face_bottom + tolerance
    )


def validate_avatar_observation(value: Any) -> dict[str, Any]:
    """Validate and clean one model observation.

    Body and mouth capability validation is independent. A valid mouth-only
    observation remains usable by the existing renderer even when body mesh
    geometry is missing. If neither capability is valid, raise the same
    expected error used by the existing API.
    """

    if not isinstance(value, dict):
        raise AvatarVisionError("Avatar vision response must be an object.")

    orientation = value.get("orientation")
    if orientation not in _ALLOWED_ORIENTATIONS:
        raise AvatarVisionError("Avatar orientation is not supported.")

    confidence = value.get("confidence")
    if not _is_number(confidence) or not 0.55 <= float(confidence) <= 1:
        raise AvatarVisionError("Avatar vision confidence is too low.")

    mesh = _validate_mesh_geometry(value, float(confidence))
    mouth = _validate_mouth_geometry(value, float(confidence))
    if mesh is None and mouth is None:
        raise AvatarVisionError("Avatar has no safe body or mouth geometry.")

    return {
        **(mesh or {
            "character_box": None,
            "head_box": None,
            "torso_box": None,
            "neck_point": None,
            "root_point": None,
        }),
        **(mouth or {
            "face_box": None,
            "mouth_box": None,
            "left_eye_box": None,
            "right_eye_box": None,
            "nose_box": None,
            "chin_y": None,
        }),
        "mesh_eligible": mesh is not None,
        "mouth_eligible": mouth is not None,
        "orientation": orientation,
        "single_character": value.get("single_character") is True,
        "confidence": float(confidence),
    }


def to_canonical_avatar_geometry(observation: dict[str, Any], model_name: str) -> dict[str, Any]:
    """Return the frontend-facing, camelCase observation object."""

    validated = validate_avatar_observation(observation)
    return {
        "version": AVATAR_OBSERVATION_VERSION,
        "source": "gemini-vision",
        "model": model_name,
        "confidence": validated["confidence"],
        "orientation": validated["orientation"],
        "meshEligible": validated["mesh_eligible"],
        "mouthEligible": validated["mouth_eligible"],
        "singleCharacter": validated["single_character"],
        "characterBox": validated["character_box"],
        "headBox": validated["head_box"],
        "torsoBox": validated["torso_box"],
        "neckPoint": validated["neck_point"],
        "rootPoint": validated["root_point"],
        "mouthVisible": validated["mouth_eligible"],
        "mouthOccluded": not validated["mouth_eligible"],
        "faceBox": validated["face_box"],
        "mouthBox": validated["mouth_box"],
        "leftEyeBox": validated["left_eye_box"],
        "rightEyeBox": validated["right_eye_box"],
        "noseBox": validated["nose_box"],
        "chinY": validated["chin_y"],
    }


def validate_canonical_avatar_geometry(value: Any) -> dict[str, Any]:
    """Revalidate a cached/frontend-facing geometry object before reuse."""

    if not isinstance(value, dict) or value.get("version") != AVATAR_OBSERVATION_VERSION:
        raise AvatarVisionError("Avatar geometry version is stale or invalid.")

    model_name = value.get("model")
    if not isinstance(model_name, str) or not model_name.strip():
        raise AvatarVisionError("Avatar geometry model is missing.")

    observation = {
        "character_box": value.get("characterBox"),
        "head_box": value.get("headBox"),
        "torso_box": value.get("torsoBox"),
        "neck_point": value.get("neckPoint"),
        "root_point": value.get("rootPoint"),
        "face_box": value.get("faceBox"),
        "mouth_box": value.get("mouthBox"),
        "left_eye_box": value.get("leftEyeBox"),
        "right_eye_box": value.get("rightEyeBox"),
        "nose_box": value.get("noseBox"),
        "chin_y": (
            round(value.get("chinY") * 1000)
            if isinstance(value.get("chinY"), (int, float)) and 0 <= value.get("chinY") <= 1
            else value.get("chinY")
        ),
        "orientation": value.get("orientation"),
        "single_character": value.get("singleCharacter"),
        "head_visible": value.get("headBox") is not None,
        "torso_visible": value.get("torsoBox") is not None,
        "mouth_visible": value.get("mouthVisible") is True,
        "mouth_occluded": value.get("mouthOccluded") is True,
        "confidence": value.get("confidence"),
    }
    return to_canonical_avatar_geometry(observation, model_name.strip())


def _is_quota_error(error: Exception) -> bool:
    message = str(error).lower()
    return any(term in message for term in (
        "quota",
        "resource_exhausted",
        "rate limit",
        "too many requests",
        "429",
    ))


def analyze_avatar_image(client: Any, image_bytes: bytes, mime_type: str,
                         model_name: str | None = None) -> dict[str, Any]:
    """Call Gemini once and return validated canonical geometry."""

    if client is None:
        raise AvatarVisionUnavailableError("Gemini client is not configured.")

    normalized_mime = validate_image_signature(image_bytes, mime_type)
    validate_image_dimensions(image_bytes, normalized_mime)

    model_name = model_name or get_avatar_vision_model()
    try:
        response = client.models.generate_content(
            model=model_name,
            contents=[
                AVATAR_ANALYSIS_PROMPT,
                types.Part.from_bytes(
                    data=bytes(image_bytes),
                    mime_type=normalized_mime,
                    media_resolution=types.MediaResolution.MEDIA_RESOLUTION_HIGH,
                ),
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=AVATAR_OBSERVATION_SCHEMA,
                max_output_tokens=1000,
                temperature=0,
                thinking_config=types.ThinkingConfig(
                    thinking_level=types.ThinkingLevel.MINIMAL,
                ),
            ),
        )
    except Exception as error:
        if _is_quota_error(error):
            raise AvatarVisionQuotaError from error
        raise AvatarVisionUnavailableError from error

    raw_text = getattr(response, "text", None)
    if not isinstance(raw_text, str) or not raw_text.strip():
        raise AvatarVisionError("Gemini returned an empty avatar observation.")
    try:
        observation = json.loads(raw_text)
    except (TypeError, json.JSONDecodeError) as error:
        raise AvatarVisionError("Gemini returned invalid avatar JSON.") from error

    return to_canonical_avatar_geometry(observation, model_name)
