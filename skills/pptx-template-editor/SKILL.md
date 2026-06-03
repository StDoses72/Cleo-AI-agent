---
name: pptx-template-editor
description: Inspect and clean existing PPTX report templates by preserving reusable layout, master styling, headers, titles, backgrounds, placeholders, and generic template text while removing project-specific images, annotations, instructions, example values, and concrete customer/product content. Use when an agent needs to convert a filled PowerPoint report into a reusable PPTX template through an inspect -> profile JSON -> clean -> verify workflow.
---

# PPTX Template Editor

Use this skill when turning an existing filled `.pptx` report into a reusable template.

The workflow is agent-driven:

1. Inspect the PPTX structure and table content.
2. Build an agent-authored hierarchical title outline JSON from the inspected slide titles and table-of-contents evidence.
3. Decide what is reusable template structure vs. project-specific content.
4. Write a cleaning profile JSON that records those decisions.
5. Run the generic OpenXML cleaning engine with that profile.
6. Re-inspect the cleaned PPTX and revise the profile if needed.

Do not encode domain-specific keep/delete terms into the cleaning engine. The engine executes JSON rules; the agent decides the rules after inspecting the actual PPTX.

## Core Principle

Preserve the template. Remove the filled-in project.

Keep objects and only the minimum text needed to define how the next report should be structured. Remove or clear content that only describes the current customer, product, part, drawing, risk, image, instruction, date, person, or example.

Default text policy: preserve required header/title/footer text and reusable keys/labels; clear ordinary body text unless the agent can explain why it is a reusable label.

## What To Preserve

Always preserve:

- slide masters, layouts, themes, backgrounds, fonts, colors, and formatting
- headers, footers, page numbers, section bars, and title areas
- slide titles and section titles
- empty layout boxes, image wells, comparison panels, table shells, and placeholders that are part of the reusable page structure
- table headers, field names, column names, and row labels
- reusable category or module labels, such as process names, inspection categories, field labels, or report section names

Examples of reusable text are field or module labels such as `产品名称`, `Product Name`, `整形检验`, `检验项目`, `客户回复 / Customer Reply`, `风险描述 / Risk Description`, and `改善措施 / Improvement Measure`.

Do not copy these examples into every profile automatically. They illustrate the decision rule: keep text that the next report author would still need as a label.

Important distinction: a shape is reusable only if it defines a stable page region or label. A PowerPoint shape used to mark a specific drawing, screenshot, defect, dimension, or product feature is an annotation, even if it is made from ordinary rectangles, lines, arrows, circles, or grouped shapes. Delete those project-specific annotation shapes.

## What To Clear But Not Delete

Clear text when the shape, table cell, or placeholder is reusable but its current value is project-specific.

Clear examples include:

- normal body explanations that are filled-in report content rather than keys or labels
- values inside fields such as customer name, supplier name, contact person, department, phone, and email
- values inside fields such as part number, drawing number, product name, project name, revision number, and date
- concrete dimensions, tolerances, material grades, weights, cycle times, tonnage, capacity, quantities
- concrete risk descriptions, concrete improvement measures, and project-specific conclusions
- table data rows and value columns while preserving headers and field labels

Keep the field labels themselves when they are reusable. For example, preserve labels like `Customer`, `Supplier`, `Contact`, `Department`, `Phone`, `Email`, `Product Name`, or `Drawing No.` when they function as template fields; clear the filled values next to or below those labels.

Prefer clearing over deleting when the container helps future users understand where to fill content.

## What To Delete

Delete objects that are not reusable structure:

- project-specific product images, drawings, screenshots, analysis images, simulation images, test images, videos, and embedded media
- annotation arrows, connectors, circles, callouts, labels, and grouped markups that point at a specific image or issue
- rectangles, highlights, freeform shapes, or grouped PowerPoint drawings that mark specific drawing features, dimensions, defects, risks, or improvement locations
- temporary instructions to the report generator, such as request notes or generation hints
- empty groups left behind after deleting their child annotations

If a shape is part of the layout, keep it. If it only marks a specific current example, delete it.

## Profile Authoring

The profile JSON is the agent's observation record. Fill it after inspecting the deck. Start from `profiles/cleaning-profile.template.json`, save a new profile file, and only enable rules that are supported by inspection evidence.

Write the profile in this order:

1. Summarize the deck's reusable structure: cover/title pattern, recurring header/footer, section title bars, table types, image wells, comparison panels, and repeated placeholders.
2. Turn on `clearUnprotectedNonTableText` unless the user explicitly wants to keep body prose. This clears non-table text that is not protected by title/header/footer rules or `keepTextRegex`.
3. List protected reusable text in `keepTextRegex`: field labels, column headers, row labels, reusable process names, inspection categories, and generic region labels. Keep this list small. Do not preserve filled explanations just because they sound generally useful.
4. List whole text-bearing objects to delete in `removeTextRegex`: generator instructions, temporary notes, and text boxes whose shape should disappear with the text.
5. List project-specific text values to empty in `clearTextRegex` only when the broad unprotected-text clearing mode is not enough.
6. List annotation geometry in `removeShapeTypes` and `removeShapeRules`: connectors, arrows, callouts, circles, highlight rectangles, freeform marks, and grouped markups tied to a specific image or drawing.
7. Turn on `removeUnprotectedNonTextShapes` when the deck contains pictorial marks made from PowerPoint shapes. Use `nonTextShapeRemovalRules` for small unlabeled body shapes, and `preserveShapeRules` for real layout containers that must survive.
8. Add `textReplacements` for cover/title fields that are filled with a specific customer, product, part number, or project name and should become generic.
9. Add `tableRules` last. Prefer table rules over broad text regex when clearing tabular data.
10. Run the cleaner, inspect the output, and revise the profile until project content is gone while the template remains usable.

Use:

- `keepTextRegex` for reusable labels and section language that should never be cleared by broad rules
- `clearUnprotectedNonTableText` to clear ordinary text boxes unless protected by title/header/footer rules or `keepTextRegex`
- `preserveTextInHeaderRegion`, `headerRegionMaxYInches`, and `preservePlaceholderTypes` for required header/title/footer preservation
- `removeTextRegex` for instruction boxes or text-bearing shapes that should be deleted with the shape
- `clearTextRegex` for project-specific text inside reusable text boxes
- `removeShapeTypes` for non-reusable annotation geometry such as connectors, lines, and callouts
- `removeShapeRules` for deck-specific grouped markups or annotation objects
- `removeUnprotectedNonTextShapes` and `nonTextShapeRemovalRules` for small unlabeled body shapes that are likely project drawings, marks, bars, or symbolic annotations
- `preserveShapeRules` for reusable non-text layout containers, large image wells, comparison panels, and other framework shapes
- `clearTextRules` for targeted text boxes that should be emptied but kept
- `textReplacements` for replacing a filled cover/title with generic reusable title text
- `tableRules` for preserving table structure while clearing example rows, value columns, or concrete data cells

Do not use one broad regex if a table rule is safer. Tables should usually preserve headers and labels while clearing rows or columns containing values.

Use conservative default decisions:

- If an object is a stable page region, keep it.
- If an object is a mark on a specific drawing/image/problem, delete it.
- If a shape has no text and is small or medium-sized in the body region, treat it as suspicious project content unless it is clearly a reusable container.
- If a shape is a large empty panel, image well, comparison box, table shell, or recurring placeholder, protect it with `preserveShapeRules`.
- If text is a field label, keep it.
- If text is a field value, clear it.
- If text is a sentence or paragraph explaining the current project, clear it.
- If a table cell names what should be filled, keep it.
- If a table cell shows the current project's filled answer, clear it.
- If unsure whether a word is a reusable label or a project value, preserve the container and clear only the suspect value.

Profile fields are regex-based. Escape special regex characters when matching literal values such as `(`, `)`, `.`, `+`, `?`, `[`, `]`, or `\`. Use narrow regexes whenever possible, scoped by `slides`, `tables`, or `target`, so the cleaner does not remove reusable text elsewhere.

Example profile decisions:

```json
{
  "clearUnprotectedNonTableText": true,
  "preserveTextInHeaderRegion": true,
  "preserveShapesInHeaderRegion": true,
  "headerRegionMaxYInches": 0.65,
  "removeUnprotectedNonTextShapes": true,
  "preservePlaceholderTypes": [
    "title",
    "ctrTitle",
    "subTitle",
    "sldNum",
    "dt",
    "ftr"
  ],
  "keepTextRegex": [
    "Product Name",
    "Customer Reply",
    "Risk Description",
    "Improvement Measure"
  ],
  "removeTextRegex": [
    "^AGENT_INSTRUCTION_PREFIX[:：]"
  ],
  "clearTextRegex": [
    "CURRENT_PROJECT_PRODUCT_OR_PART_NUMBER_REGEX",
    "\\b20\\d{2}[-./]\\d{1,2}[-./]\\d{1,2}\\b"
  ],
  "removeShapeTypes": [
    "connector",
    "line",
    "wedgeRectCallout"
  ],
  "nonTextShapeRemovalRules": [
    {
      "enabled": true,
      "noText": true,
      "minYInches": 0.65,
      "maxWidthInches": 3,
      "maxHeightInches": 0.85
    }
  ]
}
```

Treat the example above as a shape of answer, not a universal vocabulary. The agent must fill real values after inspecting the specific PPTX.

## Table Rules

For key/value tables, preserve the key or field column and clear the value column.

For revision histories, issue logs, team rosters, concern lists, and capacity tables, preserve header rows and clear data rows.

For checklists, preserve checklist item labels if they are reusable process requirements; clear only current status, owner, evidence, date, and result fields.

For product/process parameter tables, preserve parameter names and units when useful; clear measured or selected values.

For prose-like checklist tables, keep only the row keys or inspection item names. Clear rows or cells that contain filled explanations, requirements, judgments, or current-project descriptions. Use `clearRowsExceptWhereAnyCellRegex` when the reusable keys can be identified by row text, and use `preserveRows`, `preserveRowsWhereAnyCellRegex`, or `preserveCells` to protect header/key rows.

## Shape Rules

Many reports use PowerPoint shapes as drawings rather than as template structure. After images are removed, these shapes can remain as scattered arrows, colored bars, small markers, hole symbols, fixture marks, or simplified product/drawing features.

Use this default stance:

- preserve header and title-region shapes
- preserve large reusable containers, image wells, comparison panels, table shells, and placeholders
- delete small or medium unlabeled body shapes unless the profile explicitly protects them
- delete grouped shapes when they were drawn to explain a specific screenshot, drawing, defect, feature, dimension, or process example

The template profile includes a default `nonTextShapeRemovalRules` entry for unlabeled body shapes whose width is at most 3 inches and height is at most 0.85 inches. Tune those thresholds per deck. If legitimate framework shapes are removed, add a `preserveShapeRules` entry scoped by slide, shape name, or geometry.

## Scripts

Run scripts from the skill directory.

Inspect shapes and text:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\inspect_pptx_openxml.ps1 `
  -PptxPath ".\templates\input.pptx" `
  -OutDir ".\scratch\inspect"
```

Inspect tables:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\inspect_pptx_tables.ps1 `
  -ExtractDir ".\scratch\inspect\unzipped" `
  -OutPath ".\scratch\inspect\tables.txt"
```

Clean with a profile:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\clean_pptx_template.ps1 `
  -InputPptx ".\templates\input.pptx" `
  -OutputPptx ".\output\cleaned-template.pptx" `
  -Profile ".\profiles\profile-name.json" `
  -WorkDir ".\scratch\clean-work"
```

## Verification

After cleaning, re-run both inspection scripts on the output.

Check that:

- all slides are still present
- the agent-authored hierarchical outline JSON contains the expected title/header tree
- slide titles, headers, backgrounds, and layouts remain
- no page-level `pic` objects remain unless the profile intentionally allowed reusable imagery
- connectors, arrows, callouts, and temporary annotations are gone
- instruction text is gone
- project-specific names, part numbers, dates, concrete values, and example data are gone
- reusable labels, table headers, and placeholder containers remain

If visual rendering tools are available, render selected slides before final delivery. If rendering is unavailable, report that verification was based on OpenXML/package inspection.

## Title Outline

After running the inspect scripts, create a JSON outline from the inspected slide titles. Do this as an agent-authored artifact, not by running a fixed outline parser.

Use the evidence available in `shapes.txt`, `tables.txt`, and any table-of-contents slide:

- slide title or header-region text
- title placeholders and their coordinates
- table-of-contents entries
- numbering prefixes when they are consistent
- section divider pages, repeated title patterns, and semantic grouping

Do not assume every customer's PPT uses numeric title prefixes. If numbering is consistent, use it. If numbering is absent or inconsistent, organize the outline by table-of-contents entries, section pages, or title semantics.

Write the outline JSON under `scratch/`. Make it tree-first and human-readable, like a file tree with comments. Each node should represent one title/section and explain what that section is for. Do not make the outline only a flat list of nodes or slide ranges.

Use this shape:

```json
{
  "source": "input.pptx",
  "outlineMethod": "agent-authored from inspect_pptx_openxml and inspect_pptx_tables",
  "outlineTree": [
    {
      "number": "05",
      "title": "Product scheme",
      "slide": 31,
      "comment": "Reusable product planning section covering team, timing, process, equipment, quality, and capacity planning.",
      "children": [
        {
          "number": "05-2",
          "title": "Project development cycle",
          "slide": 34,
          "comment": "Schedule or milestone page for the product development cycle.",
          "children": []
        }
      ]
    }
  ],
  "slides": [
    {
      "slide": 1,
      "sourceTitle": "Cover title",
      "outlinePath": [],
      "role": "cover"
    },
    {
      "slide": 31,
      "sourceTitle": "05 Product scheme",
      "outlinePath": ["05"],
      "role": "section"
    },
    {
      "slide": 34,
      "sourceTitle": "05-2 Project development cycle",
      "outlinePath": ["05", "05-2"],
      "role": "content"
    }
  ]
}
```

Node fields:

- `number`: numbering prefix when available; omit or set `null` when the customer PPT has no stable numbering
- `title`: use the original PPTX title/header text as much as possible; only synthesize a title when no title/header can be found
- `displayTitle`: optional cleaned or shortened title for readability, if the original `title` is noisy
- `slide`: the first slide where this title/section starts
- `comment`: a short explanation of the section's purpose, similar to a code/file-tree comment
- `children`: nested sub-sections

The optional `slides` list maps each slide back to the outline tree using `outlinePath`; this helps debugging but the hierarchy lives in `outlineTree`.

Do not translate, rewrite, normalize, or shorten PPTX titles in the required `title` field. If the title includes numbering, bilingual text, or customer-specific wording and it is the actual slide title, keep it. Put any cleaned label in `displayTitle` instead.

When title numbers are stable, use them to organize the tree. For example, title `05-5-6-4 OP10 CNC Fixture Scheme` should become nested like this:

```json
{
  "number": "05",
  "title": "Product scheme",
  "slide": 31,
  "comment": "Product planning section.",
  "children": [
    {
      "number": "05-5",
      "title": "Machining technology scheme",
      "slide": 48,
      "comment": "Machining process planning pages.",
      "children": [
        {
          "number": "05-5-6",
          "title": "CNC fixture scheme",
          "slide": 50,
          "comment": "Fixture planning subsection.",
          "children": [
            {
              "number": "05-5-6-4",
              "title": "OP10 CNC Fixture Scheme",
              "slide": 52,
              "comment": "Specific OP10 CNC fixture scheme page.",
              "children": []
            }
          ]
        }
      ]
    }
  ]
}
```

When title numbers are absent or inconsistent, infer the tree from table-of-contents pages, section divider slides, repeated page title patterns, and title semantics. In that case, omit `number` or set it to `null`, but still produce nested `children`.

Keep the outline concise. The `outlineTree` should read like a useful project/document map, not a verbose slide inventory.
