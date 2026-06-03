---
name: die-casting-gate-design
description: Guide die-casting internal gate design for AI4Casting. Use when the user asks for die-casting gate design, internal gate sizing, filling-time analysis, gate speed selection, gate area calculation, gate thickness/width sizing, or final gate-design parameter submission.
---

# Die-Casting Gate Design

Use this skill to guide a user through die-casting internal gate design. Follow the workflow in order, gather missing data one item at a time, and use deterministic tools for calculations when available. Do not finish the workflow by text alone when a final submission tool is available.

This skill is migrated from the v3 `casting_process` scenario into the current LangChain Deep Agents architecture, but its business scope here is gate design rather than a complete casting-process plan. The v3 tool names are implemented here as deterministic CLI subcommands under:

```text
skills/die-casting-gate-design/scripts/casting_design_process.py
```

Call the script through the available `run_shell_command` tool. Use `python` from the project root and keep the working directory at `/workspace` or blank.

## Resilient Execution Policy

Use a three-level execution strategy:

1. Preferred: use the one-shot `advance` command. It reads the current draft state, runs every deterministic step that has enough inputs, returns the updated draft, and submits automatically when all final fields are complete.
2. Fallback: if `advance` fails unexpectedly or returns unusable output, tell the user you are falling back to individual CLI commands and that the result should be reviewed. Then run the specific subcommand needed for the blocked step.
3. Last resort: if script execution is unavailable or individual CLI commands fail, tell the user you are using the embedded reference tables manually and that the result may have calculation or transcription risk. Then calculate from the tables and formulas in this skill and clearly mark the source as `manual_fallback`.

When using fallback level 2 or 3, always include a short user-facing caution such as: "The deterministic workflow script was unavailable, so this result should be checked before production use."

For human-in-the-loop behavior: before running individual CLI fallback commands, tell the user what command category you need to run and why. If the runtime supports tool approval or interrupts, request confirmation before executing the fallback command. The preferred `advance` command does not require a special warning because it is the normal deterministic path for this skill.

## Preferred One-Shot Command

Maintain a JSON draft state with the required fields that are known. Prefer writing it to a workspace file and passing that file to `advance`:

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py advance --state-file workspace/die-casting-gate-design/state.json
```

If a state file is unnecessary, pass the known fields directly to the same one-shot command:

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py advance --wall-thickness-mm 2.1 --max-wall-thickness-mm 3.4 --product-volume-mm3 12000 --overflow-design-mode gate_sizing_only --alloy-type aluminum --part-complexity simple
```

Example state file:

```json
{
  "wall_thickness_mm": 2.1,
  "max_wall_thickness_mm": 3.4,
  "product_volume_mm3": 12000,
  "overflow_design_mode": "gate_sizing_only",
  "alloy_type": "aluminum",
  "part_complexity": "simple"
}
```

The script also accepts inline JSON, but prefer state files or direct field arguments on Windows because shell quoting for JSON is fragile:

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py advance --state-json "{\"wall_thickness_mm\":2.1,\"max_wall_thickness_mm\":3.4,\"product_volume_mm3\":12000,\"overflow_design_mode\":\"gate_sizing_only\",\"alloy_type\":\"aluminum\",\"part_complexity\":\"simple\"}"
```

The script prints JSON. Treat top-level `"status": "success"` as "the script ran." Then inspect `workflow_status`:

- `completed`: use `final_design` as the formal result.
- `needs_input`: ask `next_question`, then update the draft state and call `advance` again.
- `blocked`: inspect `errors`. If the issue is an expected missing or invalid user input, ask for the smallest correction. If it looks like an unexpected script failure, use the fallback policy.

## Individual CLI Fallback Commands

Use these only when the preferred `advance` command is unavailable or unusable. Tell the user before using this fallback.

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py gate-speed --wall-thickness 2.1 --max-wall-thickness 3.4
```

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py fill-time --wall-thickness 2.1 --max-wall-thickness 3.4
```

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py gate-area --product-volume 12000 --overflow-volume 0 --gate-speed 44.2 --fill-time 0.026
```

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py gate-thickness --wall-thickness 2.1 --alloy aluminum --complexity simple
```

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py gate-width --gate-area 10.44 --gate-thickness 1.4
```

```text
python skills/die-casting-gate-design/scripts/casting_design_process.py submit --wall-thickness-mm 2.1 --max-wall-thickness-mm 3.4 --gate-speed-ms 44.2 --fill-time-s 0.026 --product-volume-mm3 12000 --overflow-volume-mm3 0 --gate-area-mm2 10.44 --alloy-type aluminum --part-complexity simple --gate-thickness-mm 1.4 --gate-width-mm 7.457143
```

## Required Final Fields

Track these fields throughout the conversation:

- `wall_thickness_mm`
- `max_wall_thickness_mm`
- `gate_speed_ms`
- `fill_time_s`
- `product_volume_mm3`
- `overflow_volume_mm3`
- `gate_area_mm2`
- `alloy_type`
- `part_complexity`
- `gate_thickness_mm`
- `gate_width_mm`

## Workflow

### 1. Geometry and Thickness

Ask for an `.stl` file path and use the `cad-geometry-extractor` skill to extract geometry.

Use the returned fields as follows:

- `volume` -> `product_volume_mm3`
- `avg_thickness` -> `wall_thickness_mm`
- `min_thickness` -> `wall_thickness_mm` only when `avg_thickness` is absent
- `max_thickness` -> `max_wall_thickness_mm`

Do not accept manually typed `wall_thickness_mm`, `max_wall_thickness_mm`, or `product_volume_mm3` as substitutes when CAD-derived geometry is required. Preserve continuous CAD values; do not round them to table rows before calling lookup tools.

### 2. Gate Speed

After `wall_thickness_mm` and `max_wall_thickness_mm` are known, call the preferred `advance` command. It will fill `gate_speed_ms` automatically. Use the individual `gate-speed` command only as fallback.

Reference ranges:

| Feature thickness (mm) | Gate speed (m/s) |
| --- | --- |
| 1.0 | 46-55 |
| 1.5 | 44-53 |
| 2.0 | 42-50 |
| 2.5 | 40-48 |
| 3.0 | 38-46 |
| 3.5 | 36-44 |
| 4.0 | 34-42 |
| 5.0 | 32-40 |
| 6.0 | 30-37 |
| 7.0 | 28-34 |
| 8.0 | 26-32 |
| 9.0 | 24-29 |
| 10.0 | 22-27 |

Use JSON field `gate_speed_ms` as `gate_speed_ms`. Explain the value as a lookup/interpolation result, not as a hand calculation.

### 3. Fill Time

After `wall_thickness_mm` and `max_wall_thickness_mm` are known, call the preferred `advance` command. It will fill `fill_time_s` automatically. Use the individual `fill-time` command only as fallback.

Reference ranges:

| Feature thickness (mm) | Fill time (s) |
| --- | --- |
| 1.0 | 0.010-0.014 |
| 1.5 | 0.014-0.020 |
| 2.0 | 0.018-0.026 |
| 2.5 | 0.022-0.032 |
| 3.0 | 0.028-0.040 |
| 3.5 | 0.034-0.050 |
| 4.0 | 0.040-0.060 |
| 5.0 | 0.048-0.072 |
| 6.0 | 0.056-0.084 |
| 7.0 | 0.066-0.100 |
| 8.0 | 0.076-0.116 |
| 9.0 | 0.088-0.138 |
| 10.0 | 0.100-0.160 |

Use JSON field `fill_time_s` as `fill_time_s`.

### 4. Volume and Overflow Volume

Use CAD extraction for `product_volume_mm3`.

Handle `overflow_volume_mm3` as follows:

- Before defaulting overflow volume, confirm the task mode:
  - `gate_sizing_only`: manufacturability or internal gate sizing only. Set `overflow_volume_mm3 = 0.0` and do not block the workflow.
  - `full_overflow_design`: full overflow system design. Ask for overflow volume or an overflow STL before calculating gate area.
- If the user's wording clearly says they only need gate sizing, manufacturability, or a quick process estimate, set `overflow_design_mode = gate_sizing_only`.
- If the user's wording clearly says they need overflow groove/system design, set `overflow_design_mode = full_overflow_design`.
- If the mode is ambiguous, ask: "Is this only for gate sizing/manufacturability, or do you want a full overflow system design?"

### 5. Gate Area

When `product_volume_mm3`, `overflow_volume_mm3`, `gate_speed_ms`, and `fill_time_s` are known, call the preferred `advance` command. It will fill `gate_area_mm2` automatically. Use the individual `gate-area` command only as fallback.

Reference formula:

```text
gate_area_mm2 = (product_volume_mm3 + overflow_volume_mm3) / (gate_speed_ms * 1000 * fill_time_s)
```

Use JSON field `gate_area_mm2` as `gate_area_mm2`. Do not hand-calculate unless both `advance` and the individual CLI fallback are unavailable or unusable.

### 6. Gate Thickness

Ask for:

- `alloy_type`: one of `zinc`, `aluminum`, `magnesium`, `copper`
- `part_complexity`: one of `simple`, `complex`

Normalize common user terms:

- Aluminum, aluminium, Al, 6061 -> `aluminum`
- Zinc, Zn -> `zinc`
- Magnesium, Mg -> `magnesium`
- Copper, Cu -> `copper`
- Simple, normal, ordinary part -> `simple`
- Complex, thin-wall complex part -> `complex`

After `wall_thickness_mm`, `alloy_type`, and `part_complexity` are known, call the preferred `advance` command. It will fill `gate_thickness_mm` automatically. Use the individual `gate-thickness` command only as fallback.

### 7. Gate Width

After `gate_area_mm2` and `gate_thickness_mm` are known, call the preferred `advance` command. It will fill `gate_width_mm` automatically. Use the individual `gate-width` command only as fallback.

Reference formula:

```text
gate_width_mm = gate_area_mm2 / gate_thickness_mm
```

Use JSON field `gate_width_mm` as `gate_width_mm`.

### 8. Final Gate Design Submission

When all required final fields are present, call the preferred `advance` command. It will submit automatically and return `final_design`. Use the individual `submit` command only as fallback.

Use the returned `final_design` object as the formal validated gate-design result. This command replaces v3's `submit_casting_process` tool inside the current deepagent architecture.

After submission, summarize the final design in a compact table with:

- parameter name
- value and unit
- source, such as STL analysis, lookup table, calculation tool, or user input

## Final Gate Design Profile

After `advance` returns `workflow_status: completed`, create a final output JSON from:

```text
skills/die-casting-gate-design/profiles/final_design_template.json
```

Write the completed profile to this temporary workspace location:

```text
workspace/die-casting-gate-design/final_design.json
```

Then generate a Markdown report:

```text
python skills/die-casting-gate-design/scripts/markdown_output.py --JP workspace/die-casting-gate-design/final_design.json --MP workspace/die-casting-gate-design/final_design.md
```

If an intermediate state file is needed while the workflow is still incomplete, use:

```text
workspace/die-casting-gate-design/state.json
```

Fill `final_design` exactly from the `advance.final_design` object. Do not alter, round, rename, or recompute numeric values while filling the profile.

Fill `field_sources` from the conversation, CAD extraction output, and script outputs. Keep `source_type` simple; use only these values:

- `STL_data`: geometry values extracted from STL/CAD, such as wall thickness, max wall thickness, or product volume.
- `user_input`: values confirmed or supplied by the user, such as alloy type, part complexity, or full-overflow volume.
- `script_calculation`: values produced by this skill's deterministic workflow script, including lookup table results, formula calculations, validation, and defaulted overflow volume for `gate_sizing_only`.
- `manual_fallback`: values produced after the preferred script path failed and the agent had to use individual CLI fallback or manual table/formula calculation.

Use `source_detail` for the precise explanation. Examples:

- `avg_thickness from STL extraction`
- `gate_sizing_only mode, overflow volume defaulted to 0`
- `advance script: gate speed lookup table interpolation`
- `advance script: gate area formula`
- `user confirmed aluminum`

Add `warnings` for source reliability risks:

- If any geometry field (`wall_thickness_mm`, `max_wall_thickness_mm`, `product_volume_mm3`) uses `user_input` or `manual_fallback`, add a warning that geometry-critical data was not produced from STL extraction and should be verified.
- If any calculated field (`gate_speed_ms`, `fill_time_s`, `gate_area_mm2`, `gate_thickness_mm`, `gate_width_mm`) uses `manual_fallback`, add a warning that deterministic script calculation was not used and the result should be checked before production use.
- If `overflow_volume_mm3` uses `user_input` in `full_overflow_design` mode, add a warning that overflow volume was user-supplied and should be checked against the overflow geometry.

## Working Rules

- At the start of each turn, identify known fields and the next missing field.
- Ask for only one missing user-provided item at a time.
- Use deterministic tools for lookup, calculation, and final validation whenever available.
- Do not discretize or round CAD-derived continuous values before calling lookup tools.
- If a tool fails, explain the failure and ask for the smallest next action needed to continue.
- Treat the `advance` command's `workflow_status: completed` result as the normal formal completion path. Treat the individual `submit` script command as a fallback completion path only when `advance` is unavailable.
- Keep a local draft in the conversation with the 11 required final fields. Update the draft from script JSON outputs after each command.
- If forced into manual table calculation, show the caution, identify the exact table/formula used, and recommend deterministic verification before production use.
