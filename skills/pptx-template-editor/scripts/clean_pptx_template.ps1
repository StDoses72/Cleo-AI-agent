param(
  [Parameter(Mandatory=$true)][string]$InputPptx,
  [Parameter(Mandatory=$true)][string]$OutputPptx,
  [Parameter(Mandatory=$true)][string]$Profile,
  [Parameter(Mandatory=$true)][string]$WorkDir
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.IO.Compression.FileSystem

$profileJson = Get-Content -LiteralPath $Profile -Raw -Encoding UTF8
$config = $profileJson | ConvertFrom-Json

$ns = New-Object System.Xml.XmlNamespaceManager((New-Object System.Xml.NameTable))
$ns.AddNamespace("p", "http://schemas.openxmlformats.org/presentationml/2006/main")
$ns.AddNamespace("a", "http://schemas.openxmlformats.org/drawingml/2006/main")
$ns.AddNamespace("r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")
$ns.AddNamespace("rel", "http://schemas.openxmlformats.org/package/2006/relationships")

function As-Array($value) {
  if ($null -eq $value) { return @() }
  if ($value -is [System.Array]) { return @($value) }
  return @($value)
}

function Test-AnyRegex([string]$text, $patterns) {
  foreach ($pattern in (As-Array $patterns)) {
    if ([string]::IsNullOrWhiteSpace([string]$pattern)) { continue }
    if ($text -match [string]$pattern) { return $true }
  }
  return $false
}

function Test-SlideRule($rule, [int]$slideNum) {
  $slides = As-Array $rule.slides
  if ($slides.Count -gt 0 -and -not ($slides -contains $slideNum)) { return $false }
  $exceptSlides = As-Array $rule.exceptSlides
  if ($exceptSlides.Count -gt 0 -and ($exceptSlides -contains $slideNum)) { return $false }
  return $true
}

function Test-TableRule($rule, [int]$slideNum, [int]$tableIndex) {
  if (-not (Test-SlideRule $rule $slideNum)) { return $false }
  $tables = As-Array $rule.tables
  if ($tables.Count -gt 0 -and -not ($tables -contains $tableIndex)) { return $false }
  return $true
}

function Get-Text([System.Xml.XmlNode]$node) {
  $parts = @()
  foreach ($t in $node.SelectNodes(".//a:t", $script:ns)) {
    $parts += $t.InnerText
  }
  return ($parts -join "")
}

function Set-Text([System.Xml.XmlNode]$node, [string]$text) {
  $runs = @($node.SelectNodes(".//a:t", $script:ns))
  if ($runs.Count -eq 0) { return }
  $runs[0].InnerText = $text
  for ($i = 1; $i -lt $runs.Count; $i++) {
    $runs[$i].InnerText = ""
  }
}

function Clear-Text([System.Xml.XmlNode]$node) {
  foreach ($t in $node.SelectNodes(".//a:t", $script:ns)) {
    $t.InnerText = ""
  }
}

function Replace-RunText([System.Xml.XmlNode]$node, $rules) {
  foreach ($t in $node.SelectNodes(".//a:t", $script:ns)) {
    $value = $t.InnerText
    foreach ($rule in (As-Array $rules)) {
      if ($null -eq $rule.matchRegex) { continue }
      $replacement = if ($null -ne $rule.replacement) { [string]$rule.replacement } else { "" }
      $value = [regex]::Replace($value, [string]$rule.matchRegex, $replacement)
    }
    $t.InnerText = $value
  }
}

function Get-ShapeType([System.Xml.XmlNode]$node) {
  if ($node.LocalName -eq "pic") { return "pic" }
  if ($node.LocalName -eq "graphicFrame") { return "graphicFrame" }
  if ($node.LocalName -eq "grpSp") { return "grpSp" }
  if ($node.LocalName -eq "cxnSp") { return "connector" }
  $prst = $node.SelectSingleNode(".//a:prstGeom", $script:ns)
  if ($prst) { return [string]$prst.prst }
  return $node.LocalName
}

function Get-PlaceholderType([System.Xml.XmlNode]$node) {
  $ph = $node.SelectSingleNode(".//p:nvPr/p:ph", $script:ns)
  if ($ph -and $ph.type) { return [string]$ph.type }
  if ($ph) { return "placeholder" }
  return ""
}

function Get-ShapeName([System.Xml.XmlNode]$node) {
  $idNode = $node.SelectSingleNode(".//p:cNvPr", $script:ns)
  if ($idNode) { return [string]$idNode.name }
  return ""
}

function Get-ShapeId([System.Xml.XmlNode]$node) {
  $idNode = $node.SelectSingleNode(".//p:cNvPr", $script:ns)
  if ($idNode) { return [string]$idNode.id }
  return ""
}

function Get-Geometry([System.Xml.XmlNode]$node) {
  $xfrm = $node.SelectSingleNode(".//p:spPr/a:xfrm | .//p:grpSpPr/a:xfrm", $script:ns)
  if ($null -eq $xfrm) { $xfrm = $node.SelectSingleNode(".//a:xfrm", $script:ns) }
  if ($null -eq $xfrm) { return @{ x = $null; y = $null; w = $null; h = $null } }
  $off = $xfrm.SelectSingleNode("./a:off", $script:ns)
  $ext = $xfrm.SelectSingleNode("./a:ext", $script:ns)
  $emuPerIn = 914400.0
  if ($off -and $ext) {
    return @{
      x = [double]$off.x / $emuPerIn
      y = [double]$off.y / $emuPerIn
      w = [double]$ext.cx / $emuPerIn
      h = [double]$ext.cy / $emuPerIn
    }
  }
  return @{ x = $null; y = $null; w = $null; h = $null }
}

function Test-ShapeTarget([System.Xml.XmlNode]$node, $target) {
  if ($null -eq $target) { return $true }
  if ($null -ne $target.shapeId -and [string]$target.shapeId -ne (Get-ShapeId $node)) { return $false }
  if ($null -ne $target.placeholderType -and [string]$target.placeholderType -ne (Get-PlaceholderType $node)) { return $false }
  if ($null -ne $target.shapeNameRegex -and -not ((Get-ShapeName $node) -match [string]$target.shapeNameRegex)) { return $false }
  if ($null -ne $target.shapeType -and [string]$target.shapeType -ne (Get-ShapeType $node)) { return $false }
  return $true
}

function Test-ShapeRuleCriteria([System.Xml.XmlNode]$node, $rule) {
  $text = Get-Text $node
  if ($true -eq $rule.hasText -and [string]::IsNullOrWhiteSpace($text)) { return $false }
  if ($true -eq $rule.noText -and -not [string]::IsNullOrWhiteSpace($text)) { return $false }
  if ($null -ne $rule.textRegex -and -not ($text -match [string]$rule.textRegex)) { return $false }

  $shapeTypes = As-Array $rule.shapeTypes
  if ($shapeTypes.Count -gt 0 -and -not ($shapeTypes -contains (Get-ShapeType $node))) { return $false }

  $geom = Get-Geometry $node
  if ($null -ne $rule.minXInches -and ($null -eq $geom.x -or $geom.x -lt [double]$rule.minXInches)) { return $false }
  if ($null -ne $rule.maxXInches -and ($null -eq $geom.x -or $geom.x -gt [double]$rule.maxXInches)) { return $false }
  if ($null -ne $rule.minYInches -and ($null -eq $geom.y -or $geom.y -lt [double]$rule.minYInches)) { return $false }
  if ($null -ne $rule.maxYInches -and ($null -eq $geom.y -or $geom.y -gt [double]$rule.maxYInches)) { return $false }
  if ($null -ne $rule.minWidthInches -and ($null -eq $geom.w -or $geom.w -lt [double]$rule.minWidthInches)) { return $false }
  if ($null -ne $rule.maxWidthInches -and ($null -eq $geom.w -or $geom.w -gt [double]$rule.maxWidthInches)) { return $false }
  if ($null -ne $rule.minHeightInches -and ($null -eq $geom.h -or $geom.h -lt [double]$rule.minHeightInches)) { return $false }
  if ($null -ne $rule.maxHeightInches -and ($null -eq $geom.h -or $geom.h -gt [double]$rule.maxHeightInches)) { return $false }

  return $true
}

function Test-ShapeRule([System.Xml.XmlNode]$node, $rule, [int]$slideNum) {
  if ($false -eq $rule.enabled) { return $false }
  if (-not (Test-SlideRule $rule $slideNum)) { return $false }
  if (-not (Test-ShapeTarget $node $rule.target)) { return $false }
  return (Test-ShapeRuleCriteria $node $rule)
}

function Test-ProtectedTextNode([System.Xml.XmlNode]$node, [string]$text, $config) {
  if ([string]::IsNullOrWhiteSpace($text)) { return $true }
  if (Test-AnyRegex $text $config.keepTextRegex) { return $true }

  $placeholderType = Get-PlaceholderType $node
  if ((As-Array $config.preservePlaceholderTypes) -contains $placeholderType) { return $true }

  if ($true -eq $config.preserveTextInHeaderRegion) {
    $limit = 0.65
    if ($null -ne $config.headerRegionMaxYInches) { $limit = [double]$config.headerRegionMaxYInches }
    $geom = Get-Geometry $node
    if ($null -ne $geom.y -and $geom.y -le $limit) { return $true }
  }

  foreach ($rule in (As-Array $config.preserveTextRules)) {
    if ($false -eq $rule.enabled) { continue }
    if (-not (Test-ShapeTarget $node $rule.target)) { continue }
    if ($null -ne $rule.textRegex -and -not ($text -match [string]$rule.textRegex)) { continue }
    return $true
  }

  return $false
}

function Test-ProtectedShapeNode([System.Xml.XmlNode]$node, [int]$slideNum, $config) {
  if ((Get-PlaceholderType $node).Length -gt 0) { return $true }

  if ($true -eq $config.preserveShapesInHeaderRegion) {
    $limit = 0.65
    if ($null -ne $config.headerRegionMaxYInches) { $limit = [double]$config.headerRegionMaxYInches }
    $geom = Get-Geometry $node
    if ($null -ne $geom.y -and $geom.y -le $limit) { return $true }
  }

  foreach ($rule in (As-Array $config.preserveShapeRules)) {
    if (Test-ShapeRule $node $rule $slideNum) { return $true }
  }

  return $false
}

function Test-RemoveUnprotectedNonTextShape([System.Xml.XmlNode]$node, [int]$slideNum, $config) {
  if ($true -ne $config.removeUnprotectedNonTextShapes) { return $false }
  if ($node.LocalName -eq "graphicFrame") { return $false }
  if (-not [string]::IsNullOrWhiteSpace((Get-Text $node))) { return $false }
  if (Test-ProtectedShapeNode $node $slideNum $config) { return $false }

  $rules = As-Array $config.nonTextShapeRemovalRules
  if ($rules.Count -eq 0) { return $true }
  foreach ($rule in $rules) {
    if (Test-ShapeRule $node $rule $slideNum) { return $true }
  }
  return $false
}

function Remove-Node([System.Xml.XmlNode]$node) {
  if ($node.ParentNode) { [void]$node.ParentNode.RemoveChild($node) }
}

function Clear-Cell([System.Xml.XmlNode]$cell) {
  Clear-Text $cell
}

function Apply-TableRules([System.Xml.XmlNode]$tbl, [int]$slideNum, [int]$tableIndex, $rules, $stats) {
  foreach ($rule in (As-Array $rules)) {
    if ($false -eq $rule.enabled) { continue }
    if (-not (Test-TableRule $rule $slideNum $tableIndex)) { continue }
    $rows = @($tbl.SelectNodes("./a:tr", $script:ns))
    for ($r = 0; $r -lt $rows.Count; $r++) {
      $rowNumber = $r + 1
      $cells = @($rows[$r].SelectNodes("./a:tc", $script:ns))
      $rowText = (($cells | ForEach-Object { Get-Text $_ }) -join " ")
      $clearWholeRow = $false
      $preserveWholeRow = $false
      if ((As-Array $rule.preserveRows) -contains $rowNumber) { $preserveWholeRow = $true }
      if (Test-AnyRegex $rowText $rule.preserveRowsWhereAnyCellRegex) { $preserveWholeRow = $true }
      if ($null -ne $rule.clearRowsFrom -and $rowNumber -ge [int]$rule.clearRowsFrom) { $clearWholeRow = $true }
      $headerRows = 1
      if ($null -ne $rule.headerRows) { $headerRows = [int]$rule.headerRows }
      if ($true -eq $rule.clearDataRows -and $rowNumber -gt $headerRows) { $clearWholeRow = $true }
      if (Test-AnyRegex $rowText $rule.clearRowsWhereAnyCellRegex) { $clearWholeRow = $true }
      $clearExceptPatterns = As-Array $rule.clearRowsExceptWhereAnyCellRegex
      if ($clearExceptPatterns.Count -gt 0 -and -not (Test-AnyRegex $rowText $clearExceptPatterns)) { $clearWholeRow = $true }
      if ($preserveWholeRow) { $clearWholeRow = $false }

      for ($c = 0; $c -lt $cells.Count; $c++) {
        $colNumber = $c + 1
        $txt = (Get-Text $cells[$c]).Trim()
        $clear = $clearWholeRow
        if ((As-Array $rule.clearColumns) -contains $colNumber) { $clear = $true }
        if (Test-AnyRegex $txt $rule.clearCellsWhereTextRegex) { $clear = $true }
        foreach ($cellRule in (As-Array $rule.clearCells)) {
          if ([int]$cellRule.row -eq $rowNumber -and [int]$cellRule.column -eq $colNumber) { $clear = $true }
        }
        foreach ($preserve in (As-Array $rule.preserveCells)) {
          if ([int]$preserve.row -eq $rowNumber -and [int]$preserve.column -eq $colNumber) { $clear = $false }
        }
        if ($preserveWholeRow) { $clear = $false }
        if ($clear) {
          Clear-Cell $cells[$c]
          $stats.clearedTableCells++
        }
      }
    }
    $stats.appliedTableRules++
  }
}

if (Test-Path -LiteralPath $WorkDir) {
  Remove-Item -LiteralPath $WorkDir -Recurse -Force
}
New-Item -ItemType Directory -Path $WorkDir | Out-Null
[System.IO.Compression.ZipFile]::ExtractToDirectory($InputPptx, $WorkDir)

$stats = [ordered]@{
  slides = 0
  removedPictures = 0
  removedShapes = 0
  removedUnprotectedNonTextShapes = 0
  clearedTextShapes = 0
  clearedUnprotectedTextShapes = 0
  replacedTextShapes = 0
  appliedTableRules = 0
  clearedTableCells = 0
  removedMediaRelationships = 0
  removedMediaFiles = 0
}
$removedPicRelsBySlide = @{}

$slidesDir = Join-Path $WorkDir "ppt/slides"
$slideFiles = Get-ChildItem -LiteralPath $slidesDir -Filter "slide*.xml" | Sort-Object { [int]([regex]::Match($_.BaseName, "\d+").Value) }
foreach ($slideFile in $slideFiles) {
  $stats.slides++
  $slideNum = [int]([regex]::Match($slideFile.BaseName, "\d+").Value)
  $xml = New-Object System.Xml.XmlDocument
  $xml.PreserveWhitespace = $true
  $xml.Load($slideFile.FullName)

  if ($true -eq $config.removeTimings) {
    foreach ($timing in @($xml.SelectNodes("//p:timing", $ns))) {
      Remove-Node $timing
    }
  }

  foreach ($rule in (As-Array $config.textReplacements)) {
    if ($false -eq $rule.enabled) { continue }
    if (-not (Test-SlideRule $rule $slideNum)) { continue }
    foreach ($node in @($xml.SelectNodes("//p:sp | //p:grpSp | //p:graphicFrame", $ns))) {
      if (-not (Test-ShapeTarget $node $rule.target)) { continue }
      if ($null -ne $rule.fullText) {
        Set-Text $node ([string]$rule.fullText)
      } elseif ($null -ne $rule.runReplacements) {
        Replace-RunText $node $rule.runReplacements
      }
      $stats.replacedTextShapes++
    }
  }

  $tableIndex = 0
  foreach ($tbl in @($xml.SelectNodes("//a:tbl", $ns))) {
    $tableIndex++
    Apply-TableRules $tbl $slideNum $tableIndex $config.tableRules $stats
  }

  if ($true -eq $config.removePictures) {
    $picRIds = New-Object System.Collections.Generic.HashSet[string]
    foreach ($pic in @($xml.SelectNodes("//p:pic", $ns))) {
      foreach ($blip in @($pic.SelectNodes(".//a:blip[@r:embed]", $ns))) {
        [void]$picRIds.Add([string]$blip.GetAttribute("embed", "http://schemas.openxmlformats.org/officeDocument/2006/relationships"))
      }
      Remove-Node $pic
      $stats.removedPictures++
    }
    if ($picRIds.Count -gt 0) { $removedPicRelsBySlide[$slideFile.BaseName] = @($picRIds) }
  }

  foreach ($node in @($xml.SelectNodes("//p:cxnSp | //p:sp | //p:grpSp | //p:graphicFrame", $ns))) {
    if ($null -eq $node.ParentNode) { continue }
    $type = Get-ShapeType $node
    $text = Get-Text $node
    $keep = Test-AnyRegex $text $config.keepTextRegex

    $remove = $false
    if ((As-Array $config.removeShapeTypes) -contains $type) { $remove = $true }
    if (-not $keep -and (Test-AnyRegex $text $config.removeTextRegex)) { $remove = $true }
    foreach ($rule in (As-Array $config.removeShapeRules)) {
      if (Test-ShapeRule $node $rule $slideNum) {
        $remove = $true
      }
    }
    if (-not $remove -and (Test-RemoveUnprotectedNonTextShape $node $slideNum $config)) { $remove = $true }
    if ($remove) {
      Remove-Node $node
      $stats.removedShapes++
      if ([string]::IsNullOrWhiteSpace($text)) { $stats.removedUnprotectedNonTextShapes++ }
      continue
    }

    if (-not $keep -and (Test-AnyRegex $text $config.clearTextRegex)) {
      Clear-Text $node
      $stats.clearedTextShapes++
      continue
    }
    foreach ($rule in (As-Array $config.clearTextRules)) {
      if ($false -eq $rule.enabled) { continue }
      if (-not (Test-SlideRule $rule $slideNum)) { continue }
      if (-not (Test-ShapeTarget $node $rule.target)) { continue }
      if ($null -ne $rule.textRegex -and -not ($text -match [string]$rule.textRegex)) { continue }
      Clear-Text $node
      $stats.clearedTextShapes++
    }

    if ($true -eq $config.clearUnprotectedNonTableText -and $node.LocalName -ne "graphicFrame") {
      $updatedText = Get-Text $node
      if (-not (Test-ProtectedTextNode $node $updatedText $config)) {
        Clear-Text $node
        $stats.clearedUnprotectedTextShapes++
      }
    }
  }

  if ($true -eq $config.removeEmptyGroups) {
    foreach ($grp in @($xml.SelectNodes("//p:grpSp", $ns))) {
      $children = @($grp.SelectNodes("./p:sp | ./p:pic | ./p:graphicFrame | ./p:cxnSp | ./p:grpSp", $ns))
      if ($children.Count -eq 0) {
        Remove-Node $grp
        $stats.removedShapes++
      }
    }
  }

  $xml.Save($slideFile.FullName)
}

foreach ($slideBase in $removedPicRelsBySlide.Keys) {
  $relsPath = Join-Path $WorkDir ("ppt/slides/_rels/{0}.xml.rels" -f $slideBase)
  if (-not (Test-Path -LiteralPath $relsPath)) { continue }
  $rels = New-Object System.Xml.XmlDocument
  $rels.PreserveWhitespace = $true
  $rels.Load($relsPath)
  foreach ($rid in $removedPicRelsBySlide[$slideBase]) {
    $relNode = $rels.SelectSingleNode("//rel:Relationship[@Id='$rid']", $ns)
    if ($relNode) { [void]$relNode.ParentNode.RemoveChild($relNode) }
  }
  $rels.Save($relsPath)
}

if ($true -eq $config.removeVideos) {
  foreach ($relsPath in Get-ChildItem -LiteralPath (Join-Path $WorkDir "ppt/slides/_rels") -Filter "slide*.xml.rels" -ErrorAction SilentlyContinue) {
    $rels = New-Object System.Xml.XmlDocument
    $rels.PreserveWhitespace = $true
    $rels.Load($relsPath.FullName)
    $changed = $false
    foreach ($relNode in @($rels.SelectNodes("//rel:Relationship", $ns))) {
      $relType = [string]$relNode.Type
      if ($relType -match "/video$|/media$") {
        [void]$relNode.ParentNode.RemoveChild($relNode)
        $stats.removedMediaRelationships++
        $changed = $true
      }
    }
    if ($changed) { $rels.Save($relsPath.FullName) }
  }
}

if ($true -eq $config.removeUnreferencedMedia) {
  $referencedMedia = New-Object System.Collections.Generic.HashSet[string]
  foreach ($relsFile in Get-ChildItem -LiteralPath (Join-Path $WorkDir "ppt") -Filter "*.rels" -Recurse) {
    $rels = New-Object System.Xml.XmlDocument
    $rels.Load($relsFile.FullName)
    foreach ($relNode in $rels.SelectNodes("//rel:Relationship", $ns)) {
      $target = [string]$relNode.Target
      if ($target -match "media/([^/\\]+)$") {
        [void]$referencedMedia.Add($matches[1])
      }
    }
  }
  $mediaDir = Join-Path $WorkDir "ppt/media"
  if (Test-Path -LiteralPath $mediaDir) {
    foreach ($media in Get-ChildItem -LiteralPath $mediaDir -File) {
      if (-not $referencedMedia.Contains($media.Name)) {
        Remove-Item -LiteralPath $media.FullName -Force
        $stats.removedMediaFiles++
      }
    }
  }
}

$outputParent = Split-Path -Parent $OutputPptx
if ($outputParent -and -not (Test-Path -LiteralPath $outputParent)) {
  New-Item -ItemType Directory -Path $outputParent | Out-Null
}
if (Test-Path -LiteralPath $OutputPptx) {
  Remove-Item -LiteralPath $OutputPptx -Force
}
[System.IO.Compression.ZipFile]::CreateFromDirectory($WorkDir, $OutputPptx)

$reportPath = [System.IO.Path]::ChangeExtension($OutputPptx, ".clean-report.json")
$stats | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $reportPath -Encoding UTF8
Write-Output ($stats | ConvertTo-Json -Depth 6)
