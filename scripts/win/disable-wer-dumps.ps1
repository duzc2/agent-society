param(
  [string[]]$Executables = @("bun.exe", "node.exe"),
  [switch]$RemoveRootIfEmpty
)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "This script must run as Administrator."
}

$baseKeyPath = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps"
$removed = @()
$missing = @()

if (Test-Path -LiteralPath $baseKeyPath) {
  foreach ($exe in $Executables) {
    $normalizedExe = [System.IO.Path]::GetFileName($exe)
    if ([string]::IsNullOrWhiteSpace($normalizedExe)) {
      continue
    }

    $targetKeyPath = Join-Path $baseKeyPath $normalizedExe
    if (Test-Path -LiteralPath $targetKeyPath) {
      Remove-Item -LiteralPath $targetKeyPath -Recurse -Force
      $removed += $normalizedExe
    } else {
      $missing += $normalizedExe
    }
  }

  if ($RemoveRootIfEmpty) {
    $children = Get-ChildItem -LiteralPath $baseKeyPath -ErrorAction SilentlyContinue
    if (-not $children) {
      Remove-Item -LiteralPath $baseKeyPath -Recurse -Force
    }
  }
} else {
  $missing = $Executables
}

[PSCustomObject]@{
  baseKey = $baseKeyPath
  removed = $removed
  missing = $missing
  removeRootIfEmpty = [bool]$RemoveRootIfEmpty
} | ConvertTo-Json -Depth 5
