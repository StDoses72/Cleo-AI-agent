import argparse
import json
import sys
from pathlib import Path


ROWS = [
    ("wall_thickness_mm", "壁厚", "mm"),
    ("max_wall_thickness_mm", "最大壁厚", "mm"),
    ("gate_speed_ms", "浇口速度", "m/s"),
    ("fill_time_s", "填充时间", "s"),
    ("product_volume_mm3", "产品体积", "mm^3"),
    ("overflow_volume_mm3", "溢流体积", "mm^3"),
    ("gate_area_mm2", "内浇口截面积", "mm^2"),
    ("alloy_type", "合金类型", ""),
    ("part_complexity", "产品复杂度", ""),
    ("gate_thickness_mm", "内浇口厚度", "mm"),
    ("gate_width_mm", "内浇口宽度", "mm"),
]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Generate markdown report from die-casting gate design data.")
    parser.add_argument("--JP", required=True, type=Path, help="Path to the input final_design JSON file.")
    parser.add_argument("--MP", required=True, type=Path, help="Output Markdown file path, or output directory.")
    return parser

def load_profile(path: Path) -> dict:
    if not path.is_file():
        raise FileNotFoundError(f"input JSON file does not exist: {path}")
    with open(path, "r", encoding="utf-8-sig") as f:
        data = json.load(f)
    if not isinstance(data, dict):
        raise ValueError("input JSON must be an object")
    if not isinstance(data.get("final_design"), dict):
        raise ValueError("input JSON must contain object field: final_design")
    if not isinstance(data.get("field_sources"), dict):
        raise ValueError("input JSON must contain object field: field_sources")
    return data


def resolve_output_path(path: Path) -> Path:
    if path.suffix.lower() == ".md":
        return path
    return path / "final_gate_design.md"


def render_markdown(data: dict) -> str:
    lines: list[str] = []

    product_name = data.get("product_name", "Unknown Product")
    workflow = data.get("workflow", "Unknown Workflow")
    final_design = data["final_design"]
    field_sources = data["field_sources"]

    lines.append("# 压铸内浇口设计结果")
    lines.append("")
    lines.append(f"- 产品名称: {product_name}")
    lines.append(f"- 设计流程: {workflow}")
    lines.append("")
    lines.append("| 参数 | 数值 | 单位 | 来源 | 来源信息 |")
    lines.append("|---|---:|---|---|---|")

    for key, label, unit in ROWS:
        value = final_design.get(key, "")
        source = field_sources.get(key, {})
        source_type = source.get("source_type", "Unknown Source Type")
        source_detail = source.get("source_detail", "No additional information")
        lines.append(f"| {label} | {value} | {unit} | {source_type} | {source_detail} |")

    warnings = data.get("warnings", [])
    if warnings:
        lines.append("")
        lines.append("## 复核提醒")
        lines.append("")
        for warning in warnings:
            lines.append(f"- {warning}")

    return "\n".join(lines) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        data = load_profile(args.JP)
        output_path = resolve_output_path(args.MP)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text(render_markdown(data), encoding="utf-8")
    except Exception as exc:
        print(f"Error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1

    print(f"Markdown has been generated successfully: {output_path}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
