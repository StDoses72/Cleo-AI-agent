param(
  [Parameter(Mandatory=$true)][string]$PptxPath,
  [Parameter(Mandatory=$true)][string]$OutDir
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.IO.Compression.FileSystem

if (Test-Path -LiteralPath $OutDir) {
  Remove-Item -LiteralPath $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Path $OutDir | Out-Null
$extractDir = Join-Path $OutDir "unzipped"
[System.IO.Compression.ZipFile]::ExtractToDirectory($PptxPath, $extractDir)

$ns = New-Object System.Xml.XmlNamespaceManager((New-Object System.Xml.NameTable))
$ns.AddNamespace("p", "http://schemas.openxmlformats.org/presentationml/2006/main")
$ns.AddNamespace("a", "http://schemas.openxmlformats.org/drawingml/2006/main")
$ns.AddNamespace("r", "http://schemas.openxmlformats.org/officeDocument/2006/relationships")

function Get-Text([System.Xml.XmlNode]$node) {
  $parts = @()
  foreach ($t in $node.SelectNodes(".//a:t", $script:ns)) {
    if ($null -ne $t.InnerText -and $t.InnerText.Trim().Length -gt 0) {
      $parts += $t.InnerText
    }
  }
  return ($parts -join "")
}

function Get-Geometry([System.Xml.XmlNode]$node) {
  $xfrm = $node.SelectSingleNode(".//p:spPr/a:xfrm | .//p:grpSpPr/a:xfrm", $script:ns)
  if ($null -eq $xfrm) {
    $xfrm = $node.SelectSingleNode(".//a:xfrm", $script:ns)
  }
  if ($null -eq $xfrm) {
    return @{ x = $null; y = $null; cx = $null; cy = $null }
  }
  $off = $xfrm.SelectSingleNode("./a:off", $script:ns)
  $ext = $xfrm.SelectSingleNode("./a:ext", $script:ns)
  $emuPerIn = 914400.0
  if ($off -and $ext) {
    return @{
      x = [math]::Round([double]$off.x / $emuPerIn, 2)
      y = [math]::Round([double]$off.y / $emuPerIn, 2)
      cx = [math]::Round([double]$ext.cx / $emuPerIn, 2)
      cy = [math]::Round([double]$ext.cy / $emuPerIn, 2)
    }
  }
  return @{ x = $null; y = $null; cx = $null; cy = $null }
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

function Get-Placeholder([System.Xml.XmlNode]$node) {
  $ph = $node.SelectSingleNode(".//p:nvPr/p:ph", $script:ns)
  if ($ph) {
    $type = [string]$ph.type
    $idx = [string]$ph.idx
    if ($type -or $idx) { return "$type#$idx" }
    return "placeholder"
  }
  return ""
}

$slidesDir = Join-Path $extractDir "ppt/slides"
$slideFiles = Get-ChildItem -LiteralPath $slidesDir -Filter "slide*.xml" | Sort-Object { [int]([regex]::Match($_.BaseName, "\d+").Value) }
$summary = @()
$allLines = New-Object System.Collections.Generic.List[string]

foreach ($slideFile in $slideFiles) {
  $xml = New-Object System.Xml.XmlDocument
  $xml.PreserveWhitespace = $true
  $xml.Load($slideFile.FullName)
  $num = [int]([regex]::Match($slideFile.BaseName, "\d+").Value)
  $cSld = $xml.SelectSingleNode("//p:cSld", $ns)
  $spTree = $xml.SelectSingleNode("//p:cSld/p:spTree", $ns)
  $shapes = @()
  foreach ($node in $spTree.ChildNodes) {
    if ($node.LocalName -in @("sp","pic","graphicFrame","cxnSp","grpSp")) {
      $idNode = $node.SelectSingleNode(".//p:cNvPr", $ns)
      $geom = Get-Geometry $node
      $text = Get-Text $node
      $shapeType = Get-ShapeType $node
      $ph = Get-Placeholder $node
      $shapes += [pscustomobject]@{
        id = if ($idNode) { [string]$idNode.id } else { "" }
        name = if ($idNode) { [string]$idNode.name } else { "" }
        type = $shapeType
        placeholder = $ph
        x = $geom.x
        y = $geom.y
        w = $geom.cx
        h = $geom.cy
        text = $text
      }
    }
  }
  $summary += [pscustomobject]@{
    slide = $num
    shapeCount = $shapes.Count
    pictureCount = ($shapes | Where-Object { $_.type -eq "pic" }).Count
    connectorCount = ($shapes | Where-Object { $_.type -eq "connector" }).Count
    textCount = ($shapes | Where-Object { $_.text }).Count
  }
  $allLines.Add("SLIDE $num  shapes=$($shapes.Count) pics=$(($shapes | Where-Object { $_.type -eq 'pic' }).Count) connectors=$(($shapes | Where-Object { $_.type -eq 'connector' }).Count)")
  foreach ($s in $shapes) {
    $oneLine = ($s.text -replace "\s+", " ").Trim()
    if ($oneLine.Length -gt 120) { $oneLine = $oneLine.Substring(0, 120) + "..." }
    $allLines.Add(("  id={0,-4} type={1,-14} ph={2,-12} xywh={3},{4},{5},{6} name={7} text={8}" -f $s.id,$s.type,$s.placeholder,$s.x,$s.y,$s.w,$s.h,$s.name,$oneLine))
  }
  $allLines.Add("")
}

$summary | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutDir "summary.json") -Encoding UTF8
$allLines | Set-Content -LiteralPath (Join-Path $OutDir "shapes.txt") -Encoding UTF8
Write-Output "Wrote $OutDir"
