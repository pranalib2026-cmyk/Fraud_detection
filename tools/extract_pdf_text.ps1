# Minimal PDF text extractor for ReportLab-generated PDFs (ASCII85 + Flate streams).
# Usage: powershell -File tools/extract_pdf_text.ps1 -Path <pdf> -Out <txt>
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$Out
)

$ErrorActionPreference = 'Stop'

function Decode-Ascii85 {
  param([byte[]]$Bytes)
  $s = [System.Text.Encoding]::ASCII.GetString($Bytes)
  # strip whitespace, leading <~ if present, trailing ~>
  $s = $s -replace '\s', ''
  if ($s.StartsWith('<~')) { $s = $s.Substring(2) }
  $idx = $s.IndexOf('~>')
  if ($idx -ge 0) { $s = $s.Substring(0, $idx) }

  $out = New-Object System.Collections.Generic.List[byte]
  $tuple = 0
  $count = 0
  foreach ($ch in $s.ToCharArray()) {
    $code = [int][char]$ch
    if ($code -eq 122 -and $count -eq 0) {  # 'z' shorthand for 4 zero bytes
      $out.Add(0); $out.Add(0); $out.Add(0); $out.Add(0)
      continue
    }
    if ($code -lt 33 -or $code -gt 117) { continue }
    $tuple = $tuple * 85 + ($code - 33)
    $count++
    if ($count -eq 5) {
      $out.Add(($tuple -shr 24) -band 0xFF)
      $out.Add(($tuple -shr 16) -band 0xFF)
      $out.Add(($tuple -shr 8) -band 0xFF)
      $out.Add($tuple -band 0xFF)
      $tuple = 0
      $count = 0
    }
  }
  if ($count -gt 1) {
    for ($i = $count; $i -lt 5; $i++) { $tuple = $tuple * 85 + 84 }
    $tmp = @(
      ($tuple -shr 24) -band 0xFF,
      ($tuple -shr 16) -band 0xFF,
      ($tuple -shr 8) -band 0xFF,
      $tuple -band 0xFF
    )
    for ($i = 0; $i -lt ($count - 1); $i++) { $out.Add([byte]$tmp[$i]) }
  }
  return $out.ToArray()
}

function Inflate-Zlib {
  param([byte[]]$Bytes)
  $ms = New-Object System.IO.MemoryStream(, $Bytes)
  $ms.Position = 2  # skip zlib header
  $ds = New-Object System.IO.Compression.DeflateStream($ms, [System.IO.Compression.CompressionMode]::Decompress)
  $out = New-Object System.IO.MemoryStream
  $ds.CopyTo($out)
  $ds.Dispose()
  return $out.ToArray()
}

function Unescape-Pdf {
  param([string]$S)
  $sb = New-Object System.Text.StringBuilder
  for ($i = 0; $i -lt $S.Length; $i++) {
    $c = $S[$i]
    if ($c -eq '\' -and $i + 1 -lt $S.Length) {
      $i++
      $n = $S[$i]
      switch ($n) {
        'n' { [void]$sb.Append("`n") }
        'r' { [void]$sb.Append("`r") }
        't' { [void]$sb.Append("`t") }
        'b' { [void]$sb.Append("`b") }
        'f' { [void]$sb.Append("`f") }
        '(' { [void]$sb.Append('(') }
        ')' { [void]$sb.Append(')') }
        '\' { [void]$sb.Append('\') }
        default {
          if ($n -match '[0-7]') {
            $oct = "$n"
            while ($oct.Length -lt 3 -and $i + 1 -lt $S.Length -and $S[$i + 1] -match '[0-7]') { $i++; $oct += $S[$i] }
            [void]$sb.Append([char][Convert]::ToInt32($oct, 8))
          }
          else { [void]$sb.Append($n) }
        }
      }
    }
    else { [void]$sb.Append($c) }
  }
  return $sb.ToString()
}

$bytes = [System.IO.File]::ReadAllBytes($Path)
$all = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)

$textOut = New-Object System.Text.StringBuilder
$pos = 0
while ($true) {
  $sIdx = $all.IndexOf('stream', $pos)
  if ($sIdx -lt 0) { break }
  $eIdx = $all.IndexOf('endstream', $sIdx)
  if ($eIdx -lt 0) { break }

  $start = $sIdx + 6
  if ($start -lt $all.Length -and $all[$start] -eq "`r") { $start++ }
  if ($start -lt $all.Length -and $all[$start] -eq "`n") { $start++ }
  $len = $eIdx - $start
  $pos = $eIdx + 9
  if ($len -le 0) { continue }

  $raw = New-Object byte[] $len
  [Array]::Copy($bytes, $start, $raw, 0, $len)

  # Sniff the encoding: zlib/Flate streams start with 0x78; ReportLab ASCII85
  # streams start with '<~' or go straight into the ASCII85 alphabet.
  $inflated = $null
  if ($raw.Length -gt 1 -and $raw[0] -eq 0x78 -and ($raw[1] -eq 0x01 -or $raw[1] -eq 0x9C -or $raw[1] -eq 0xDA)) {
    try { $inflated = Inflate-Zlib -Bytes $raw } catch { $inflated = $null }
  }
  if ($null -eq $inflated) {
    $decoded = $null
    try { $decoded = Decode-Ascii85 -Bytes $raw } catch { continue }
    if ($null -eq $decoded -or $decoded.Length -eq 0) { continue }
    try { $inflated = Inflate-Zlib -Bytes $decoded } catch { continue }
  }
  if ($null -eq $inflated -or $inflated.Length -eq 0) { continue }

  $content = [System.Text.Encoding]::GetEncoding(28591).GetString($inflated)

  # Extract literal strings from BT..ET blocks (Tj / TJ operators)
  $m = [regex]::Matches($content, '\((?:\\.|[^\\()])*\)')
  foreach ($mm in $m) {
    $lit = $mm.Value.Substring(1, $mm.Value.Length - 2)
    [void]$textOut.Append((Unescape-Pdf -S $lit))
  }
  [void]$textOut.Append("`n")
}

[System.IO.File]::WriteAllText($Out, $textOut.ToString(), [System.Text.Encoding]::UTF8)
Write-Host "Wrote $Out ($($textOut.Length) chars)"
