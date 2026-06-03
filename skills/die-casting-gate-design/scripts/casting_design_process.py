from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Literal, get_args


AlloyType = Literal["zinc", "aluminum", "magnesium", "copper"]
PartComplexity = Literal["simple", "complex"]

GATE_SPEED_TABLE: tuple[tuple[float, tuple[float, float]], ...] = (
    (1.0, (46.0, 55.0)),
    (1.5, (44.0, 53.0)),
    (2.0, (42.0, 50.0)),
    (2.5, (40.0, 48.0)),
    (3.0, (38.0, 46.0)),
    (3.5, (36.0, 44.0)),
    (4.0, (34.0, 42.0)),
    (5.0, (32.0, 40.0)),
    (6.0, (30.0, 37.0)),
    (7.0, (28.0, 34.0)),
    (8.0, (26.0, 32.0)),
    (9.0, (24.0, 29.0)),
    (10.0, (22.0, 27.0)),
)

FILL_TIME_TABLE: tuple[tuple[float, tuple[float, float]], ...] = (
    (1.0, (0.010, 0.014)),
    (1.5, (0.014, 0.020)),
    (2.0, (0.018, 0.026)),
    (2.5, (0.022, 0.032)),
    (3.0, (0.028, 0.040)),
    (3.5, (0.034, 0.050)),
    (4.0, (0.040, 0.060)),
    (5.0, (0.048, 0.072)),
    (6.0, (0.056, 0.084)),
    (7.0, (0.066, 0.100)),
    (8.0, (0.076, 0.116)),
    (9.0, (0.088, 0.138)),
    (10.0, (0.100, 0.160)),
)

GATE_THICKNESS_TABLE: dict[
    str,
    dict[str, tuple[tuple[tuple[float, float | None], tuple[float, float]], ...]],
] = {
    "simple": {
        "zinc": (
            ((0.6, 1.5), (0.4, 1.0)),
            ((1.5, 3.0), (0.8, 1.5)),
            ((3.0, 6.0), (1.5, 2.0)),
            ((6.0, None), (0.2, 0.4)),
        ),
        "aluminum": (
            ((0.6, 1.5), (0.6, 1.2)),
            ((1.5, 3.0), (1.0, 1.8)),
            ((3.0, 6.0), (1.8, 3.0)),
            ((6.0, None), (0.4, 0.6)),
        ),
        "magnesium": (
            ((0.6, 1.5), (0.6, 1.2)),
            ((1.5, 3.0), (1.0, 1.8)),
            ((3.0, 6.0), (1.8, 3.0)),
            ((6.0, None), (0.4, 0.6)),
        ),
        "copper": (
            ((0.6, 1.5), (0.8, 1.2)),
            ((1.5, 3.0), (1.0, 2.0)),
            ((3.0, 6.0), (2.0, 4.0)),
            ((6.0, None), (0.4, 0.6)),
        ),
    },
    "complex": {
        "zinc": (
            ((0.6, 1.5), (0.4, 0.8)),
            ((1.5, 3.0), (0.6, 1.2)),
            ((3.0, 6.0), (1.0, 2.0)),
            ((6.0, None), (0.2, 0.4)),
        ),
        "aluminum": (
            ((0.6, 1.5), (0.6, 1.0)),
            ((1.5, 3.0), (0.8, 1.5)),
            ((3.0, 6.0), (1.5, 2.5)),
            ((6.0, None), (0.4, 0.6)),
        ),
        "magnesium": (
            ((0.6, 1.5), (0.6, 1.0)),
            ((1.5, 3.0), (0.8, 1.5)),
            ((3.0, 6.0), (1.5, 2.5)),
            ((6.0, None), (0.4, 0.6)),
        ),
        "copper": (
            ((0.6, 1.5), (0.6, 1.0)),
            ((1.5, 3.0), (1.0, 1.8)),
            ((3.0, 6.0), (1.5, 3.0)),
            ((6.0, None), (0.4, 0.6)),
        ),
    },
}

WALL_THICKNESS_MIN = min(wall for wall, _ in GATE_SPEED_TABLE)
WALL_THICKNESS_MAX = max(wall for wall, _ in GATE_SPEED_TABLE)
FINAL_FIELDS = (
    "wall_thickness_mm",
    "max_wall_thickness_mm",
    "gate_speed_ms",
    "fill_time_s",
    "product_volume_mm3",
    "overflow_volume_mm3",
    "gate_area_mm2",
    "alloy_type",
    "part_complexity",
    "gate_thickness_mm",
    "gate_width_mm",
)
OVERFLOW_MODES = ("gate_sizing_only", "full_overflow_design")


def validate_wall_thickness_inputs(
    wall_thickness: float,
    max_wall_thickness: float,
) -> None:
    if wall_thickness <= 0:
        raise ValueError("wall_thickness must be greater than zero")
    if max_wall_thickness <= 0:
        raise ValueError("max_wall_thickness must be greater than zero")
    if max_wall_thickness < wall_thickness:
        raise ValueError("max_wall_thickness must be greater than or equal to wall_thickness")


def clamp_wall_thickness_to_table_range(wall_thickness: float) -> float:
    return min(max(wall_thickness, WALL_THICKNESS_MIN), WALL_THICKNESS_MAX)


def interpolate_value(lower: float, upper: float, ratio: float) -> float:
    return lower + ((upper - lower) * ratio)


def get_interpolated_table_range(
    table: tuple[tuple[float, tuple[float, float]], ...],
    wall_thickness: float,
) -> tuple[float, float]:
    effective_wall_thickness = clamp_wall_thickness_to_table_range(wall_thickness)
    previous_wall, previous_range = table[0]

    if effective_wall_thickness <= previous_wall:
        return previous_range

    for current_wall, current_range in table[1:]:
        if effective_wall_thickness == current_wall:
            return current_range
        if effective_wall_thickness < current_wall:
            ratio = (
                (effective_wall_thickness - previous_wall)
                / (current_wall - previous_wall)
            )
            return (
                interpolate_value(previous_range[0], current_range[0], ratio),
                interpolate_value(previous_range[1], current_range[1], ratio),
            )
        previous_wall, previous_range = current_wall, current_range

    return table[-1][1]


def interpolate_in_range(
    low: float,
    high: float,
    wall_thickness: float,
    max_wall_thickness: float,
) -> float:
    if wall_thickness == WALL_THICKNESS_MAX:
        return round(low, 6)

    ratio = (max_wall_thickness - wall_thickness) / (
        WALL_THICKNESS_MAX - wall_thickness
    )
    return round(low + ((high - low) * ratio), 6)


def prepare_lookup_inputs(
    table: tuple[tuple[float, tuple[float, float]], ...],
    wall_thickness: float,
    max_wall_thickness: float,
) -> tuple[float, float, tuple[float, float]]:
    validate_wall_thickness_inputs(wall_thickness, max_wall_thickness)

    effective_wall_thickness = clamp_wall_thickness_to_table_range(wall_thickness)
    effective_max_wall_thickness = clamp_wall_thickness_to_table_range(
        max_wall_thickness
    )
    if effective_max_wall_thickness < effective_wall_thickness:
        effective_max_wall_thickness = effective_wall_thickness

    value_range = get_interpolated_table_range(table, wall_thickness)
    return effective_wall_thickness, effective_max_wall_thickness, value_range


def gate_speed_lookup(
    wall_thickness: float,
    max_wall_thickness: float,
) -> dict[str, Any]:
    wall_used, max_wall_used, speed_range = prepare_lookup_inputs(
        GATE_SPEED_TABLE,
        wall_thickness,
        max_wall_thickness,
    )
    speed_min, speed_max = speed_range
    gate_speed = interpolate_in_range(
        speed_max,
        speed_min,
        wall_used,
        max_wall_used,
    )
    return {
        "operation": "gate_speed_lookup",
        "gate_speed": gate_speed,
        "gate_speed_ms": gate_speed,
        "unit": "m/s",
        "source": "lookup_table_interpolation",
        "wall_thickness_used": wall_used,
        "max_wall_thickness_used": max_wall_used,
        "range": {"min": speed_min, "max": speed_max},
    }


def fill_time_lookup(
    wall_thickness: float,
    max_wall_thickness: float,
) -> dict[str, Any]:
    wall_used, max_wall_used, fill_range = prepare_lookup_inputs(
        FILL_TIME_TABLE,
        wall_thickness,
        max_wall_thickness,
    )
    fill_min, fill_max = fill_range
    fill_time = interpolate_in_range(
        fill_min,
        fill_max,
        wall_used,
        max_wall_used,
    )
    return {
        "operation": "fill_time_lookup",
        "fill_time": fill_time,
        "fill_time_s": fill_time,
        "unit": "s",
        "source": "lookup_table_interpolation",
        "wall_thickness_used": wall_used,
        "max_wall_thickness_used": max_wall_used,
        "range": {"min": fill_min, "max": fill_max},
    }


def gate_area_calc(
    product_volume: float,
    gate_speed: float,
    fill_time: float,
    overflow_volume: float = 0.0,
) -> dict[str, Any]:
    if product_volume <= 0:
        raise ValueError("product_volume must be positive")
    if overflow_volume < 0:
        raise ValueError("overflow_volume must not be negative")
    if gate_speed <= 0:
        raise ValueError("gate_speed must be greater than zero")
    if fill_time <= 0:
        raise ValueError("fill_time must be greater than zero")

    gate_area = (product_volume + overflow_volume) / (
        gate_speed * 1000 * fill_time
    )
    return {
        "operation": "gate_area_calc",
        "gate_area": gate_area,
        "gate_area_mm2": gate_area,
        "unit": "mm^2",
        "source": "calculation",
    }


def gate_thickness_lookup(
    wall_thickness: float,
    alloy: str,
    complexity: str = "simple",
) -> dict[str, Any]:
    if complexity not in GATE_THICKNESS_TABLE:
        raise ValueError(
            f"Unsupported complexity {complexity}. "
            f"Supported values: {sorted(GATE_THICKNESS_TABLE)}"
        )

    alloy_table = GATE_THICKNESS_TABLE[complexity]
    if alloy not in alloy_table:
        raise ValueError(
            f"Unsupported alloy {alloy}. Supported values: {sorted(alloy_table)}"
        )
    if wall_thickness < 0.6:
        raise ValueError("wall_thickness must be greater than or equal to 0.6")

    for (lower, upper), thickness_range in alloy_table[alloy]:
        if upper is None and wall_thickness > lower:
            min_value, max_value = thickness_range
            gate_thickness = round(wall_thickness * min_value, 6)
            return {
                "operation": "gate_thickness_lookup",
                "gate_thickness": gate_thickness,
                "gate_thickness_mm": gate_thickness,
                "unit": "mm",
                "source": "lookup_table",
                "wall_thickness_range": {"min": lower, "max": upper},
                "thickness_rule": {
                    "type": "wall_thickness_ratio",
                    "min_ratio": min_value,
                    "max_ratio": max_value,
                    "selected_ratio": min_value,
                },
            }
        if upper is not None and lower <= wall_thickness <= upper:
            min_value, max_value = thickness_range
            gate_thickness = round((min_value + max_value) / 2, 6)
            return {
                "operation": "gate_thickness_lookup",
                "gate_thickness": gate_thickness,
                "gate_thickness_mm": gate_thickness,
                "unit": "mm",
                "source": "lookup_table",
                "wall_thickness_range": {"min": lower, "max": upper},
                "thickness_range": {"min": min_value, "max": max_value},
            }

    raise ValueError(f"Unsupported wall_thickness {wall_thickness}")


def gate_width_calc(gate_area: float, gate_thickness: float) -> dict[str, Any]:
    if gate_area <= 0:
        raise ValueError("gate_area must be greater than zero")
    if gate_thickness <= 0:
        raise ValueError("gate_thickness must be greater than zero")

    gate_width = gate_area / gate_thickness
    return {
        "operation": "gate_width_calc",
        "gate_width": gate_width,
        "gate_width_mm": gate_width,
        "unit": "mm",
        "source": "calculation",
    }


def submit_casting_process(params: dict[str, Any]) -> dict[str, Any]:
    required = {
        "wall_thickness_mm": float,
        "max_wall_thickness_mm": float,
        "gate_speed_ms": float,
        "fill_time_s": float,
        "product_volume_mm3": float,
        "gate_area_mm2": float,
        "alloy_type": str,
        "part_complexity": str,
        "gate_thickness_mm": float,
        "gate_width_mm": float,
    }
    optional_defaults = {"overflow_volume_mm3": 0.0}

    normalized = dict(params)
    for key, default in optional_defaults.items():
        normalized.setdefault(key, default)

    missing = [key for key in required if key not in normalized]
    if missing:
        raise ValueError(f"Missing required fields: {', '.join(missing)}")

    for key, expected_type in required.items():
        if expected_type is float:
            normalized[key] = float(normalized[key])
            if normalized[key] <= 0:
                raise ValueError(f"{key} must be greater than zero")
        elif expected_type is str:
            normalized[key] = str(normalized[key])

    normalized["overflow_volume_mm3"] = float(normalized["overflow_volume_mm3"])
    if normalized["overflow_volume_mm3"] < 0:
        raise ValueError("overflow_volume_mm3 must not be negative")
    if normalized["max_wall_thickness_mm"] < normalized["wall_thickness_mm"]:
        raise ValueError("max_wall_thickness_mm must be >= wall_thickness_mm")
    if normalized["alloy_type"] not in get_args(AlloyType):
        raise ValueError(
            f"alloy_type must be one of {', '.join(get_args(AlloyType))}"
        )
    if normalized["part_complexity"] not in get_args(PartComplexity):
        raise ValueError(
            "part_complexity must be one of "
            f"{', '.join(get_args(PartComplexity))}"
        )

    ordered = {
        "wall_thickness_mm": normalized["wall_thickness_mm"],
        "max_wall_thickness_mm": normalized["max_wall_thickness_mm"],
        "gate_speed_ms": normalized["gate_speed_ms"],
        "fill_time_s": normalized["fill_time_s"],
        "product_volume_mm3": normalized["product_volume_mm3"],
        "overflow_volume_mm3": normalized["overflow_volume_mm3"],
        "gate_area_mm2": normalized["gate_area_mm2"],
        "alloy_type": normalized["alloy_type"],
        "part_complexity": normalized["part_complexity"],
        "gate_thickness_mm": normalized["gate_thickness_mm"],
        "gate_width_mm": normalized["gate_width_mm"],
    }
    return {
        "operation": "submit_casting_process",
        "submission_status": "submitted",
        "final_design": ordered,
    }


def normalize_state(raw_state: dict[str, Any]) -> dict[str, Any]:
    state = dict(raw_state)
    aliases = {
        "volume": "product_volume_mm3",
        "product_volume": "product_volume_mm3",
        "avg_thickness": "wall_thickness_mm",
        "min_thickness": "wall_thickness_mm",
        "max_thickness": "max_wall_thickness_mm",
        "wall_thickness": "wall_thickness_mm",
        "max_wall_thickness": "max_wall_thickness_mm",
        "gate_speed": "gate_speed_ms",
        "fill_time": "fill_time_s",
        "overflow_volume": "overflow_volume_mm3",
        "gate_area": "gate_area_mm2",
        "alloy": "alloy_type",
        "complexity": "part_complexity",
        "gate_thickness": "gate_thickness_mm",
        "gate_width": "gate_width_mm",
        "overflow_mode": "overflow_design_mode",
    }
    for source, target in aliases.items():
        value = state.get(source)
        if value is not None and state.get(target) is None:
            state[target] = value
    return state


def as_float(value: Any, field_name: str) -> float:
    try:
        return float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{field_name} must be numeric") from exc


def has_value(state: dict[str, Any], field_name: str) -> bool:
    return state.get(field_name) is not None


def first_missing_user_field(state: dict[str, Any]) -> tuple[str | None, str | None]:
    if not has_value(state, "wall_thickness_mm"):
        return (
            "wall_thickness_mm",
            "Please provide an STL file path so CAD geometry can supply wall thickness.",
        )
    if not has_value(state, "max_wall_thickness_mm"):
        return (
            "max_wall_thickness_mm",
            "Please provide an STL file path so CAD geometry can supply max wall thickness.",
        )
    if not has_value(state, "product_volume_mm3"):
        return (
            "product_volume_mm3",
            "Please provide an STL file path so CAD geometry can supply product volume.",
        )
    if not has_value(state, "overflow_design_mode"):
        return (
            "overflow_design_mode",
            "Please confirm whether this is gate sizing only or a full overflow system design.",
        )
    if state.get("overflow_design_mode") not in OVERFLOW_MODES:
        return (
            "overflow_design_mode",
            "Please choose overflow design mode: gate_sizing_only or full_overflow_design.",
        )
    if state.get("overflow_design_mode") == "full_overflow_design" and not has_value(
        state,
        "overflow_volume_mm3",
    ):
        return (
            "overflow_volume_mm3",
            "Please provide overflow volume in mm^3, or provide an overflow STL for extraction.",
        )
    if not has_value(state, "alloy_type"):
        return (
            "alloy_type",
            "Please confirm alloy type: zinc, aluminum, magnesium, or copper.",
        )
    if not has_value(state, "part_complexity"):
        return (
            "part_complexity",
            "Please confirm part complexity: simple or complex.",
        )
    return None, None


def advance_casting_process(raw_state: dict[str, Any]) -> dict[str, Any]:
    state = normalize_state(raw_state)
    completed_steps: list[str] = []
    errors: list[dict[str, str]] = []

    if state.get("requires_overflow_system_design") is True and not has_value(
        state,
        "overflow_design_mode",
    ):
        state["overflow_design_mode"] = "full_overflow_design"

    if (
        state.get("overflow_design_mode") == "gate_sizing_only"
        and not has_value(state, "overflow_volume_mm3")
    ):
        state["overflow_volume_mm3"] = 0.0
        completed_steps.append("default_overflow_volume")

    if has_value(state, "wall_thickness_mm") and has_value(
        state,
        "max_wall_thickness_mm",
    ):
        wall = as_float(state["wall_thickness_mm"], "wall_thickness_mm")
        max_wall = as_float(state["max_wall_thickness_mm"], "max_wall_thickness_mm")

        if not has_value(state, "gate_speed_ms"):
            try:
                result = gate_speed_lookup(wall, max_wall)
                state["gate_speed_ms"] = result["gate_speed_ms"]
                completed_steps.append("gate_speed_lookup")
            except Exception as exc:
                errors.append(
                    {
                        "step": "gate_speed_lookup",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )

        if not has_value(state, "fill_time_s"):
            try:
                result = fill_time_lookup(wall, max_wall)
                state["fill_time_s"] = result["fill_time_s"]
                completed_steps.append("fill_time_lookup")
            except Exception as exc:
                errors.append(
                    {
                        "step": "fill_time_lookup",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )

        if (
            has_value(state, "alloy_type")
            and has_value(state, "part_complexity")
            and not has_value(state, "gate_thickness_mm")
        ):
            try:
                result = gate_thickness_lookup(
                    wall_thickness=wall,
                    alloy=str(state["alloy_type"]),
                    complexity=str(state["part_complexity"]),
                )
                state["gate_thickness_mm"] = result["gate_thickness_mm"]
                completed_steps.append("gate_thickness_lookup")
            except Exception as exc:
                errors.append(
                    {
                        "step": "gate_thickness_lookup",
                        "error": f"{type(exc).__name__}: {exc}",
                    }
                )

    if (
        has_value(state, "product_volume_mm3")
        and has_value(state, "overflow_volume_mm3")
        and has_value(state, "gate_speed_ms")
        and has_value(state, "fill_time_s")
        and not has_value(state, "gate_area_mm2")
    ):
        try:
            result = gate_area_calc(
                product_volume=as_float(
                    state["product_volume_mm3"],
                    "product_volume_mm3",
                ),
                overflow_volume=as_float(
                    state["overflow_volume_mm3"],
                    "overflow_volume_mm3",
                ),
                gate_speed=as_float(state["gate_speed_ms"], "gate_speed_ms"),
                fill_time=as_float(state["fill_time_s"], "fill_time_s"),
            )
            state["gate_area_mm2"] = result["gate_area_mm2"]
            completed_steps.append("gate_area_calc")
        except Exception as exc:
            errors.append(
                {
                    "step": "gate_area_calc",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )

    if (
        has_value(state, "gate_area_mm2")
        and has_value(state, "gate_thickness_mm")
        and not has_value(state, "gate_width_mm")
    ):
        try:
            result = gate_width_calc(
                gate_area=as_float(state["gate_area_mm2"], "gate_area_mm2"),
                gate_thickness=as_float(
                    state["gate_thickness_mm"],
                    "gate_thickness_mm",
                ),
            )
            state["gate_width_mm"] = result["gate_width_mm"]
            completed_steps.append("gate_width_calc")
        except Exception as exc:
            errors.append(
                {
                    "step": "gate_width_calc",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )

    missing_fields = [field for field in FINAL_FIELDS if not has_value(state, field)]
    next_field, next_question = first_missing_user_field(state)

    if not missing_fields:
        try:
            final = submit_casting_process(state)["final_design"]
            return {
                "operation": "advance_casting_process",
                "workflow_status": "completed",
                "completed_steps": completed_steps,
                "errors": errors,
                "missing_fields": [],
                "draft": {field: final[field] for field in FINAL_FIELDS},
                "final_design": final,
            }
        except Exception as exc:
            errors.append(
                {
                    "step": "submit_casting_process",
                    "error": f"{type(exc).__name__}: {exc}",
                }
            )

    workflow_status = "blocked" if errors else "needs_input"
    return {
        "operation": "advance_casting_process",
        "workflow_status": workflow_status,
        "completed_steps": completed_steps,
        "errors": errors,
        "missing_fields": missing_fields,
        "next_missing_field": next_field,
        "next_question": next_question,
        "draft": {field: state.get(field) for field in FINAL_FIELDS if field in state},
    }


def load_state(args: argparse.Namespace) -> dict[str, Any]:
    if getattr(args, "state_file", None):
        with open(args.state_file, "r", encoding="utf-8") as state_file:
            data = json.load(state_file)
    elif getattr(args, "state_json", None):
        data = json.loads(args.state_json)
    else:
        data = {
            "wall_thickness_mm": getattr(args, "wall_thickness_mm", None),
            "max_wall_thickness_mm": getattr(args, "max_wall_thickness_mm", None),
            "gate_speed_ms": getattr(args, "gate_speed_ms", None),
            "fill_time_s": getattr(args, "fill_time_s", None),
            "product_volume_mm3": getattr(args, "product_volume_mm3", None),
            "overflow_volume_mm3": getattr(args, "overflow_volume_mm3", None),
            "overflow_design_mode": getattr(args, "overflow_design_mode", None),
            "gate_area_mm2": getattr(args, "gate_area_mm2", None),
            "alloy_type": getattr(args, "alloy_type", None),
            "part_complexity": getattr(args, "part_complexity", None),
            "gate_thickness_mm": getattr(args, "gate_thickness_mm", None),
            "gate_width_mm": getattr(args, "gate_width_mm", None),
            "requires_overflow_system_design": getattr(
                args,
                "requires_overflow_system_design",
                False,
            ),
        }
        data = {key: value for key, value in data.items() if value is not None}
    if not isinstance(data, dict):
        raise ValueError("state must be a JSON object")
    return data


def print_json(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Deterministic die-casting gate design calculations.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    gate_speed = subparsers.add_parser("gate-speed")
    gate_speed.add_argument("--wall-thickness", type=float, required=True)
    gate_speed.add_argument("--max-wall-thickness", type=float, required=True)

    fill_time = subparsers.add_parser("fill-time")
    fill_time.add_argument("--wall-thickness", type=float, required=True)
    fill_time.add_argument("--max-wall-thickness", type=float, required=True)

    gate_area = subparsers.add_parser("gate-area")
    gate_area.add_argument("--product-volume", type=float, required=True)
    gate_area.add_argument("--overflow-volume", type=float, default=0.0)
    gate_area.add_argument("--gate-speed", type=float, required=True)
    gate_area.add_argument("--fill-time", type=float, required=True)

    gate_thickness = subparsers.add_parser("gate-thickness")
    gate_thickness.add_argument("--wall-thickness", type=float, required=True)
    gate_thickness.add_argument(
        "--alloy",
        choices=get_args(AlloyType),
        required=True,
    )
    gate_thickness.add_argument(
        "--complexity",
        choices=get_args(PartComplexity),
        default="simple",
    )

    gate_width = subparsers.add_parser("gate-width")
    gate_width.add_argument("--gate-area", type=float, required=True)
    gate_width.add_argument("--gate-thickness", type=float, required=True)

    advance = subparsers.add_parser("advance")
    advance.add_argument(
        "--state-file",
        type=Path,
        help="Path to a JSON object containing the current casting draft state.",
    )
    advance.add_argument(
        "--state-json",
        help="Inline JSON object containing the current casting draft state.",
    )
    advance.add_argument("--wall-thickness-mm", type=float)
    advance.add_argument("--max-wall-thickness-mm", type=float)
    advance.add_argument("--gate-speed-ms", type=float)
    advance.add_argument("--fill-time-s", type=float)
    advance.add_argument("--product-volume-mm3", type=float)
    advance.add_argument("--overflow-volume-mm3", type=float)
    advance.add_argument("--overflow-design-mode", choices=OVERFLOW_MODES)
    advance.add_argument("--gate-area-mm2", type=float)
    advance.add_argument("--alloy-type", choices=get_args(AlloyType))
    advance.add_argument("--part-complexity", choices=get_args(PartComplexity))
    advance.add_argument("--gate-thickness-mm", type=float)
    advance.add_argument("--gate-width-mm", type=float)
    advance.add_argument(
        "--requires-overflow-system-design",
        action="store_true",
    )

    submit = subparsers.add_parser("submit")
    submit.add_argument("--wall-thickness-mm", type=float, required=True)
    submit.add_argument("--max-wall-thickness-mm", type=float, required=True)
    submit.add_argument("--gate-speed-ms", type=float, required=True)
    submit.add_argument("--fill-time-s", type=float, required=True)
    submit.add_argument("--product-volume-mm3", type=float, required=True)
    submit.add_argument("--overflow-volume-mm3", type=float, default=0.0)
    submit.add_argument("--gate-area-mm2", type=float, required=True)
    submit.add_argument("--alloy-type", choices=get_args(AlloyType), required=True)
    submit.add_argument(
        "--part-complexity",
        choices=get_args(PartComplexity),
        required=True,
    )
    submit.add_argument("--gate-thickness-mm", type=float, required=True)
    submit.add_argument("--gate-width-mm", type=float, required=True)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    try:
        if args.command == "gate-speed":
            result = gate_speed_lookup(args.wall_thickness, args.max_wall_thickness)
        elif args.command == "fill-time":
            result = fill_time_lookup(args.wall_thickness, args.max_wall_thickness)
        elif args.command == "gate-area":
            result = gate_area_calc(
                product_volume=args.product_volume,
                overflow_volume=args.overflow_volume,
                gate_speed=args.gate_speed,
                fill_time=args.fill_time,
            )
        elif args.command == "gate-thickness":
            result = gate_thickness_lookup(
                wall_thickness=args.wall_thickness,
                alloy=args.alloy,
                complexity=args.complexity,
            )
        elif args.command == "gate-width":
            result = gate_width_calc(
                gate_area=args.gate_area,
                gate_thickness=args.gate_thickness,
            )
        elif args.command == "advance":
            result = advance_casting_process(load_state(args))
        elif args.command == "submit":
            result = submit_casting_process(vars(args))
        else:
            parser.error(f"Unsupported command: {args.command}")
            return 2
    except Exception as exc:
        print_json(
            {
                "status": "failed",
                "operation": args.command,
                "error": f"{type(exc).__name__}: {exc}",
            }
        )
        return 1

    print_json({"status": "success", **result})
    return 0


if __name__ == "__main__":
    sys.exit(main())
