---
name: cad-geometry-extractor
description: Extract geometric information from STL CAD models for AI4Casting workflows. Use when the user provides an STL file path or asks to retrieve casting geometry fields such as product volume, average wall thickness, minimum wall thickness, or maximum wall thickness.
---

# CAD Geometry Extractor

Use this skill to extract geometric information from an STL model before casting-process calculations.

## Scope

- Accept only user-provided paths ending in `.stl`.
- Windows absolute paths such as `D:\Supremium\part.stl` are acceptable as read-only input arguments to the bundled analyzer script.
- Do not accept manually typed volume or wall-thickness values as substitutes when the workflow requires CAD-derived geometry.
- If the user provides a different CAD format, ask for an STL export first unless another tool explicitly supports that format.
- If the STL path changes, rerun the analyzer. If the same file has already been analyzed, the script may return a cached result.

## Procedure

1. Confirm the STL file path from the user.
2. Keep Windows absolute paths exactly as the user provided them. Do not rewrite `D:\...` paths to `/workspace/...`.
3. Run the bundled analyzer script from the project root through the restricted shell tool:

```powershell
python skills/cad-geometry-extractor/scripts/runStpAnalyzer.py "D:\path\to\part.stl"
```

Use an empty `working_directory` or the project root. The shell sandbox only limits where the script starts from; the STL path is a read-only script argument.

4. Read the JSON output and use the normalized fields below.
5. Preserve the raw output path in any debugging notes when analysis fails or values look suspicious.

## Output Contract

The script returns a JSON object with these normalized fields when available:

```json
{
  "volume": 10000.0,
  "avg_thickness": 2.0,
  "min_thickness": 1.2,
  "max_thickness": 5.0,
  "raw_output_path": "..._output.json",
  "output_model_path": "... .ply",
  "cached": false
}
```

Use the fields as follows:

- `volume`: product volume in mm^3.
- `avg_thickness`: preferred characteristic wall thickness in mm.
- `min_thickness`: fallback characteristic wall thickness in mm when `avg_thickness` is absent.
- `max_thickness`: maximum wall thickness in mm.

For downstream casting-process work, map them to:

- `volume` -> `product_volume_mm3`
- `avg_thickness` -> `wall_thickness_mm`
- `min_thickness` -> `wall_thickness_mm` only if `avg_thickness` is absent
- `max_thickness` -> `max_wall_thickness_mm`

## Failure Handling

- If the script reports that Windows is required, explain that `stpanalyzer.exe` is only available on Windows.
- If the executable is missing, report the missing path and do not invent geometry values.
- If the STL file is missing, ask the user for a valid path.
- If the analyzer returns incomplete geometry, continue only with fields that are present and ask for a new STL or manual engineering review for missing geometry.

## Discipline

- Do not estimate geometry values from the filename, user description, screenshots, or general casting knowledge.
- Do not rerun the analyzer for the same STL unless the user asks for a fresh run or the previous output is incomplete.
- Do not modify or delete the original STL file. The script copies it into a workspace job directory before analysis.
- Do not tell the user that Windows absolute paths are inaccessible merely because the Deep Agents filesystem uses `/workspace`; call the analyzer script through `run_shell_command` instead.
