param(
  [Parameter(Mandatory=$true)][string]$ExtractDir,
  [Parameter(Mandatory=$true)][string]$OutPath
)

$ErrorActionPreference = "Stop"
$ns = New-Object System.Xml.XmlNamespaceManager((New-Object System.Xml.NameTable))
$ns.AddNamespace("p", "http://schemas.openxmlformats.org/presentationml/2006/main")
$ns.AddNamespace("a", "http://schemas.openxmlformats.org/drawingml/2006/main")

function Get-Text([System.Xml.XmlNode]$node) {
  $parts = @()
  foreach ($t in $node.SelectNodes(".//a:t", $script:ns)) {
    $parts += $t.InnerText
  }
  return ($parts -join "")
}

$slideFiles = Get-ChildItem -LiteralPath (Join-Path $ExtractDir "ppt/slides") -Filter "slide*.xml" | Sort-Object { [int]([regex]::Match($_.BaseName, "\d+").Value) }
$lines = New-Object System.Collections.Generic.List[string]
foreach ($slideFile in $slideFiles) {
  $xml = New-Object System.Xml.XmlDocument
  $xml.PreserveWhitespace = $true
  $xml.Load($slideFile.FullName)
  $num = [int]([regex]::Match($slideFile.BaseName, "\d+").Value)
  $tables = $xml.SelectNodes("//a:tbl", $ns)
  if ($tables.Count -eq 0) { continue }
  $lines.Add("SLIDE $num TABLES=$($tables.Count)")
  $ti = 0
  foreach ($tbl in $tables) {
    $ti++
    $lines.Add("  TABLE $ti")
    $ri = 0
    foreach ($tr in $tbl.SelectNodes("./a:tr", $ns)) {
      $ri++
      $cells = @()
      foreach ($tc in $tr.SelectNodes("./a:tc", $ns)) {
        $cells += ((Get-Text $tc) -replace "\s+", " ").Trim()
      }
      $lines.Add(("    R{0}: {1}" -f $ri, ($cells -join " | ")))
    }
  }
  $lines.Add("")
}
$lines | Set-Content -LiteralPath $OutPath -Encoding UTF8
Write-Output "Wrote $OutPath"
