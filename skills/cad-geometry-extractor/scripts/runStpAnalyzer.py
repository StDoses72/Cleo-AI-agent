import asyncio
import argparse
import json
import os
import platform
import shutil
import sys
from hashlib import sha256
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parents[3]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from config.settings import settings

_STPANALYZER_PROTOCOL_ID = 3368772


def _strip_matching_quotes(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _unwrap_numeric(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, dict):
        for nested_value in value.values():
            unwrapped = _unwrap_numeric(nested_value)
            if unwrapped is not None:
                return unwrapped
    return None


def normalize_output(raw: dict[str, Any]) -> dict[str, Any]:
    """Normalize stpanalyzer output into fields consumed by AI4Casting."""
    normalized = {
        "volume": _unwrap_numeric(raw.get("volume")),
        "avg_thickness": _unwrap_numeric(raw.get("avg_thickness")),
        "min_thickness": _unwrap_numeric(raw.get("min_thickness")),
        "max_thickness": _unwrap_numeric(raw.get("max_thickness")),
    }
    return {key: value for key, value in normalized.items() if value is not None}


async def run_stp_analyzer(
    stl_file_path: str,
    volume: bool = True,
    min_thickness: bool = True,
    timeout_seconds: float = 120.0,
) -> dict[str, Any]:
    if platform.system() != "Windows":
        raise ValueError("Unsupported operating system. This script only supports Windows.")

    analyzer_dir = Path(__file__).resolve().parent
    stp_analyzer_path = analyzer_dir / "stpanalyzer.exe"
    source_path = Path(_strip_matching_quotes(stl_file_path)).resolve()
    if not source_path.exists():
        raise FileNotFoundError(f"STL file not found at {stl_file_path}")
    if not stp_analyzer_path.exists():
        raise FileNotFoundError(f"STP Analyzer executable not found at {stp_analyzer_path}")

    file_data = source_path.read_bytes()
    input_model_hash = sha256(file_data).hexdigest()
    job_path = (settings.WORKSPACE_DIR / "stp_analyzer_jobs" / input_model_hash).resolve()
    job_path.mkdir(parents=True, exist_ok=True)

    input_model_path = job_path / f"{input_model_hash}{source_path.suffix}"
    input_json_path = job_path / f"{input_model_hash}_input.json"
    output_model_path = job_path / f"{input_model_hash}.ply"
    output_json_path = job_path / f"{input_model_hash}_output.json"

    shutil.copyfile(source_path, input_model_path)

    input_json = {
        "file_path": str(input_model_path),
        "json": _STPANALYZER_PROTOCOL_ID,
        "params": {
            "output_file": str(output_model_path),
            "volume": volume,
            "estimated_mesh_count": False,
            "min_thickness": min_thickness,
            "projected_areas": False,
        },
    }
    if input_json_path.exists() and output_json_path.exists():
        cached_input = json.loads(input_json_path.read_text(encoding="utf-8"))
        if cached_input == input_json:
            raw = json.loads(output_json_path.read_text(encoding="utf-8"))
            return {
                **normalize_output(raw),
                "raw_output_path": str(output_json_path),
                "output_model_path": str(output_model_path),
                "cached": True,
            }

    input_json_path.write_text(
        json.dumps(input_json, ensure_ascii=False),
        encoding="utf-8",
    )
    env = os.environ.copy()
    env["PATH"] = str(analyzer_dir) + os.pathsep + env.get("PATH", "")

    process = await asyncio.create_subprocess_exec(
        str(stp_analyzer_path),
        "-i",
        str(input_json_path),
        "-o",
        str(output_json_path),
        cwd=str(job_path),
        env=env,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        stdout, stderr = await asyncio.wait_for(
            process.communicate(),
            timeout=timeout_seconds,
        )
    except asyncio.TimeoutError as exc:
        try:
            process.kill()
        except ProcessLookupError:
            pass
        raise TimeoutError(f"stpanalyzer timed out after {timeout_seconds} seconds") from exc

    if process.returncode != 0:
        raise RuntimeError(
            f"stpanalyzer failed with exit code {process.returncode}\n"
            f"stdout:\n{stdout.decode(errors='replace')}\n"
            f"stderr:\n{stderr.decode(errors='replace')}"
        )

    raw = json.loads(output_json_path.read_text(encoding="utf-8"))
    return {
        **normalize_output(raw),
        "raw_output_path": str(output_json_path),
        "output_model_path": str(output_model_path),
        "cached": False,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Run stpanalyzer.exe for an STL file.")
    parser.add_argument("stl_file_path", help="Path to the STL model file.")
    parser.add_argument("--no-volume", action="store_true", help="Disable volume extraction.")
    parser.add_argument(
        "--no-min-thickness",
        action="store_true",
        help="Disable thickness extraction.",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=float,
        default=120.0,
        help="Maximum time to wait for stpanalyzer.exe.",
    )
    args = parser.parse_args()

    result = asyncio.run(
        run_stp_analyzer(
            args.stl_file_path,
            volume=not args.no_volume,
            min_thickness=not args.no_min_thickness,
            timeout_seconds=args.timeout_seconds,
        )
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
