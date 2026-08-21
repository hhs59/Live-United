"""Generate a small deterministic mesh-avatar package from one image.

The only remote operation is one structured vision observation. No image
generation or runtime inference is performed here or in the browser.
"""

from dataclasses import dataclass
from datetime import datetime, timezone
import argparse
import json
import os
from pathlib import Path
import sys
import uuid

from backend.avatar_vision import (
    AvatarVisionError,
    analyze_avatar_image,
    get_avatar_vision_model,
)

from .source_image import SourceImage, read_source_image


@dataclass(frozen=True)
class GenerationResult:
    run_dir: Path
    package_dir: Path
    rig_path: Path
    manifest_path: Path
    report_path: Path
    source_hash: str


def _json_write(path: Path, value: object) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def _create_client():
    from google import genai

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        raise RuntimeError("GEMINI_API_KEY is required for avatar preparation.")
    return genai.Client(api_key=api_key)


def _build_rig(source: SourceImage, geometry: dict[str, object]) -> dict[str, object]:
    if geometry.get("meshEligible") is not True:
        raise AvatarVisionError("Vision did not return safe body geometry for mesh generation.")

    return {
        "rigVersion": 4,
        "analysisVersion": 2,
        "sourceHash": source.sha256,
        "sourceWidth": source.width,
        "sourceHeight": source.height,
        "source": "gemini-vision",
        "analyzerModel": geometry.get("model"),
        "confidence": geometry.get("confidence"),
        "orientation": geometry.get("orientation"),
        "singleCharacter": geometry.get("singleCharacter") is True,
        "characterBox": geometry.get("characterBox"),
        "headBox": geometry.get("headBox"),
        "torsoBox": geometry.get("torsoBox"),
        "neckPoint": geometry.get("neckPoint"),
        "rootPoint": geometry.get("rootPoint"),
        "faceBox": geometry.get("faceBox"),
        "mouthBox": geometry.get("mouthBox"),
        "mesh": {
            "columns": 13,
            "rows": 13,
            "headFeather": 0.06,
            "torsoFeather": 0.08,
            "rootAnchorHeight": 0.14,
        },
        "motionPreset": "subtle-v1",
    }


def _write_preview(run_dir: Path, image_name: str) -> None:
    preview = """<!doctype html>
<html lang=\"en\">
<meta charset=\"utf-8\">
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">
<title>Avatar mesh preview</title>
<style>html,body{margin:0;min-height:100%;background:#f4f3ef;font:16px system-ui;color:#1c344c}body{display:grid;place-items:center}main{width:min(90vw,640px);text-align:center}#stage{position:relative;width:min(90vw,560px);aspect-ratio:1;overflow:hidden;border-radius:50%;background:#fff}canvas{position:absolute;inset:0;width:100%;height:100%}button{margin:.75rem;padding:.6rem 1rem}</style>
<main><h1>Avatar mesh preview</h1><div id=\"stage\"><canvas id=\"motion\"></canvas></div><button id=\"state\">Cycle state</button></main>
<script type=\"module\">
import { createAvatarMeshRenderer } from '../../../../src/modules/avatar_mesh_renderer.js';
import { computeImageTransform } from '../../../../src/modules/avatar_geometry.js';
const rig = await fetch('package/rig.json').then(response => response.json());
const image = new Image(); image.src = 'package/__IMAGE_NAME__'; await image.decode();
const canvas = document.querySelector('#motion'); const stage = document.querySelector('#stage');
const states = ['idle','listening','thinking','speaking']; let index = 0;
const renderer = createAvatarMeshRenderer({ canvas, image, rig, getViewTransform: () => computeImageTransform({sourceWidth:image.naturalWidth,sourceHeight:image.naturalHeight,targetWidth:canvas.width,targetHeight:canvas.height,fit:'contain',positionX:.5,positionY:.5,zoom:1}) });
renderer.start(); document.querySelector('#state').onclick = () => { index = (index + 1) % states.length; renderer.setState(states[index]); };
window.addEventListener('beforeunload', () => renderer.destroy());
</script>
""".replace('__IMAGE_NAME__', image_name)
    (run_dir / "preview.html").write_text(preview, encoding="utf-8")


def generate_avatar_package(source_path: Path, output_root: Path, client=None,
                            model_name: str | None = None,
                            *, allow_model_call: bool = False) -> GenerationResult:
    """Create one unique package directory after exactly one approved call."""

    if not allow_model_call:
        raise PermissionError("Pass allow_model_call=True only after approving the image upload.")
    source = read_source_image(Path(source_path))
    output_root = Path(output_root).expanduser().resolve()
    output_root.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_dir = output_root / f"{source.path.stem}-{stamp}-{uuid.uuid4().hex[:8]}"
    package_dir = run_dir / "package"
    source_dir = run_dir / "source"
    package_dir.mkdir(parents=True)
    source_dir.mkdir(parents=True)

    source_copy = source_dir / source.path.name
    package_image = package_dir / ("avatar.png" if source.mime_type == "image/png" else "avatar.jpg")
    source_copy.write_bytes(source.data)
    package_image.write_bytes(source.data)

    report: dict[str, object] = {
        "status": "started",
        "source": str(source.path),
        "sourceHash": source.sha256,
        "sourceWidth": source.width,
        "sourceHeight": source.height,
        "model": model_name or get_avatar_vision_model(),
        "startedAt": datetime.now(timezone.utc).isoformat(),
    }
    report_path = run_dir / "generation-report.json"
    _json_write(report_path, report)

    try:
        geometry = analyze_avatar_image(
            client or _create_client(),
            source.data,
            source.mime_type,
            model_name=model_name,
        )
        rig = _build_rig(source, geometry)
        rig_path = package_dir / "rig.json"
        manifest_path = package_dir / "avatar.json"
        _json_write(rig_path, rig)
        _json_write(manifest_path, {
            "version": 1,
            "image": package_image.name,
            "view": {"fit": "contain", "positionX": 0.5, "positionY": 0.5, "zoom": 1},
            "mouth": {"mode": "auto", "style": "cartoon"},
            "motion": {
                "mode": "mesh",
                "rig": rig_path.name,
                "preset": "subtle-v1",
                "intensity": 1,
            },
        })
        _write_preview(run_dir, package_image.name)
        report.update({
            "status": "success",
            "meshEligible": True,
            "mouthEligible": geometry.get("mouthEligible") is True,
            "packageDir": str(package_dir),
            "rig": str(rig_path),
            "manifest": str(manifest_path),
            "preview": str(run_dir / "preview.html"),
            "finishedAt": datetime.now(timezone.utc).isoformat(),
        })
        _json_write(report_path, report)
        return GenerationResult(run_dir, package_dir, rig_path, manifest_path, report_path, source.sha256)
    except Exception as error:
        report.update({
            "status": "failed",
            "failure": type(error).__name__,
            "finishedAt": datetime.now(timezone.utc).isoformat(),
        })
        _json_write(report_path, report)
        raise


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Generate a one-image avatar mesh package.")
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output-root", default=Path("runtime/avatar-mesh/runs"), type=Path)
    parser.add_argument("--model", dest="model_name")
    parser.add_argument("--allow-model-call", action="store_true",
                        help="Explicitly authorize one provider-image upload to Gemini.")
    args = parser.parse_args(argv)
    if not args.allow_model_call:
        parser.error("--allow-model-call is required before any image is uploaded.")
    try:
        result = generate_avatar_package(
            args.source,
            args.output_root,
            model_name=args.model_name,
            allow_model_call=True,
        )
    except Exception as error:
        print(f"Avatar package generation failed: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    print(result.package_dir)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
