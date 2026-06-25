#!/usr/bin/env python3
"""Thin CLI bridge for the MaaS Seedance Python SDK.

Node passes JSON on stdin and receives JSON on stdout. Secrets are read from
environment variables only.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Dict, List


ROOT = Path(__file__).resolve().parent
PYTHON_DEPS_DIR = ROOT / "python_deps"
if PYTHON_DEPS_DIR.exists():
    sys.path.insert(0, str(PYTHON_DEPS_DIR))

SDK_DIR = ROOT / "vendor" / "maas_seedance_sdk"
if SDK_DIR.exists():
    sys.path.insert(0, str(SDK_DIR))


def emit(payload: Dict[str, Any], code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(code)


def read_payload() -> Dict[str, Any]:
    raw = sys.stdin.read().strip()
    if not raw:
        return {}
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        emit({"success": False, "error": f"Invalid JSON payload: {exc}"}, 2)


def env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() not in {"0", "false", "no", "off"}


def import_client():
    try:
        from maas_seedance import MaasSeedanceClient
    except ModuleNotFoundError as exc:
        missing = exc.name or "unknown"
        emit(
            {
                "success": False,
                "error": (
                    f"Missing Python dependency '{missing}'. Run: "
                    "python3 -m pip install -r requirements-seedance.txt"
                ),
            },
            3,
        )
    return MaasSeedanceClient


def build_client():
    MaasSeedanceClient = import_client()

    api_key = (
        os.getenv("SEEDANCE_API_KEY")
        or os.getenv("SEEDANCE_KPI")
        or os.getenv("MAAS_API_KEY")
        or os.getenv("KPI")
    )
    if not api_key:
        emit(
            {
                "success": False,
                "error": "Missing Seedance API key. Set SEEDANCE_API_KEY, SEEDANCE_KPI, MAAS_API_KEY, or KPI in .env.",
            },
            4,
        )

    base_url = os.getenv("SEEDANCE_BASE_URL") or os.getenv("MAAS_BASE_URL") or "https://zhenze-huhehaote.cmecloud.cn/api/v3"
    model = os.getenv("SEEDANCE_MODEL") or os.getenv("MAAS_MODEL") or "doubao-seedance-2.0"
    enable_encrypt = env_bool("SEEDANCE_ENABLE_VIDEO_ENCRYPT", True)

    client = MaasSeedanceClient(
        maas_base_url=base_url,
        maas_api_key=api_key,
        maas_model=model,
        enable_video_encrypt=enable_encrypt,
    )

    if enable_encrypt:
        key_dir = ROOT / "tmp" / "seedance_keys"
        key_dir.mkdir(parents=True, exist_ok=True)
        client.set_video_file_encrypt_key(
            public_key_path=str(key_dir / "seedance_pub.pem"),
            private_key_path=str(key_dir / "seedance_priv.pem"),
        )

    return client


def normalize_bool(payload: Dict[str, Any], key: str, default: bool) -> bool:
    value = payload.get(key, default)
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() not in {"0", "false", "no", "off"}
    return bool(value)


def build_content(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    content = payload.get("content")
    if isinstance(content, list) and content:
        return content

    prompt = str(payload.get("prompt") or "").strip()
    if not prompt:
        emit({"success": False, "error": "Missing prompt"}, 5)

    result: List[Dict[str, Any]] = [{"type": "text", "text": prompt}]

    for url in payload.get("referenceImageUrls") or []:
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            result.append(
                {
                    "type": "image_url",
                    "image_url": {"url": url},
                    "role": "reference_image",
                }
            )

    for url in payload.get("referenceVideoUrls") or []:
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            result.append(
                {
                    "type": "video_url",
                    "video_url": {"url": url},
                    "role": "reference_video",
                }
            )

    for url in payload.get("referenceAudioUrls") or []:
        if isinstance(url, str) and url.startswith(("http://", "https://")):
            result.append(
                {
                    "type": "audio_url",
                    "audio_url": {"url": url},
                    "role": "reference_audio",
                }
            )

    return result


def create_task(payload: Dict[str, Any]) -> None:
    duration = int(payload.get("duration") or 10)
    ratio = str(payload.get("ratio") or "9:16")
    request_data = {
        "content": build_content(payload),
        "generate_audio": normalize_bool(payload, "generateAudio", True),
        "ratio": ratio,
        "duration": duration,
        "watermark": normalize_bool(payload, "watermark", False),
    }
    client = build_client()
    task_id = client.create_video_generation_task(request_data)
    if not task_id:
        emit({"success": False, "error": "Seedance task creation returned empty task id"}, 6)
    emit({"success": True, "taskId": task_id})


def query_task(payload: Dict[str, Any]) -> None:
    task_id = str(payload.get("taskId") or "").strip()
    if not task_id:
        emit({"success": False, "error": "Missing taskId"}, 5)
    client = build_client()
    task = client.query_video_generation_task(task_id)
    emit({"success": True, "task": task})


def download_task(payload: Dict[str, Any]) -> None:
    task_id = str(payload.get("taskId") or "").strip()
    output_path = str(payload.get("outputPath") or "").strip()
    if not task_id:
        emit({"success": False, "error": "Missing taskId"}, 5)
    if not output_path:
        emit({"success": False, "error": "Missing outputPath"}, 5)

    out = Path(output_path)
    out.parent.mkdir(parents=True, exist_ok=True)

    client = build_client()
    ok = client.download_video(task_id, str(out))
    emit({"success": bool(ok), "path": str(out) if ok else "", "error": "" if ok else "Seedance video download failed"})


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["create", "query", "download"])
    args = parser.parse_args()
    payload = read_payload()

    try:
        if args.command == "create":
            create_task(payload)
        elif args.command == "query":
            query_task(payload)
        elif args.command == "download":
            download_task(payload)
    except SystemExit:
        raise
    except Exception as exc:
        emit({"success": False, "error": str(exc)}, 1)


if __name__ == "__main__":
    main()
