param(
  [string[]]$Executables = @("bun.exe", "node.exe"),
  [string]$DumpRoot = "..\..\agent-society-data\crash\dumps",
  [ValidateSet("Mini", "Full", "Custom")]
  [string]$DumpType = "Full",
  [int]$DumpCount = 30,
  [int]$CustomDumpFlags = 0
)

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  throw "This script must run as Administrator."
}

if ($Executables.Count -eq 0) {
  throw "Executables cannot be empty."
}

if ($DumpCount -lt 1 -or $DumpCount -gt 200) {
  throw "DumpCount must be in range 1-200."
}

$resolvedDumpRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $DumpRoot))
if (-not (Test-Path -LiteralPath $resolvedDumpRoot)) {
  New-Item -ItemType Directory -Path $resolvedDumpRoot -Force | Out-Null
}

$dumpTypeValue = switch ($DumpType) {
  "Mini" { 1 }
  "Full" { 2 }
  "Custom" { 0 }
}

$baseKeyPath = "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps"
if (-not (Test-Path -LiteralPath $baseKeyPath)) {
  New-Item -Path $baseKeyPath -Force | Out-Null
}

$result = @()
foreach ($exe in $Executables) {
  $normalizedExe = [System.IO.Path]::GetFileName($exe)
  if ([string]::IsNullOrWhiteSpace($normalizedExe)) {
    continue
  }

  $targetKeyPath = Join-Path $baseKeyPath $normalizedExe
  if (-not (Test-Path -LiteralPath $targetKeyPath)) {
    New-Item -Path $targetKeyPath -Force | Out-Null
  }

  New-ItemProperty -Path $targetKeyPath -Name "DumpFolder" -Value $resolvedDumpRoot -PropertyType ExpandString -Force | Out-Null
  New-ItemProperty -Path $targetKeyPath -Name "DumpCount" -Value $DumpCount -PropertyType DWord -Force | Out-Null
  New-ItemProperty -Path $targetKeyPath -Name "DumpType" -Value $dumpTypeValue -PropertyType DWord -Force | Out-Null

  if ($dumpTypeValue -eq 0) {
    New-ItemProperty -Path $targetKeyPath -Name "CustomDumpFlags" -Value $CustomDumpFlags -PropertyType DWord -Force | Out-Null
  }

  $result += [PSCustomObject]@{
    executable = $normalizedExe
    keyPath = $targetKeyPath
    dumpFolder = $resolvedDumpRoot
    dumpType = $DumpType
    dumpTypeValue = $dumpTypeValue
    dumpCount = $DumpCount
    customDumpFlags = if ($dumpTypeValue -eq 0) { $CustomDumpFlags } else { $null }
  }
}

$result | ConvertTo-Json -Depth 5
