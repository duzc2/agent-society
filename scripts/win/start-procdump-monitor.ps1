param(
  [string]$ProcDumpPath = "procdump.exe",
  [string[]]$TargetProcessNames = @("bun.exe", "node.exe"),
  [string]$OutputDir = "..\..\agent-society-data\crash\procdump",
  [int]$MaxDumpsPerProcess = 5,
  [switch]$IncludeTerminate,
  [switch]$FirstChance
)

if ($TargetProcessNames.Count -eq 0) {
  throw "TargetProcessNames cannot be empty."
}

$normalizedTargets = @()
foreach ($target in $TargetProcessNames) {
  if ([string]::IsNullOrWhiteSpace($target)) {
    continue
  }
  foreach ($part in ($target -split ",")) {
    $name = $part.Trim()
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $normalizedTargets += $name
    }
  }
}

if ($normalizedTargets.Count -eq 0) {
  throw "No valid target process names."
}

if ($MaxDumpsPerProcess -lt 1 -or $MaxDumpsPerProcess -gt 20) {
  throw "MaxDumpsPerProcess must be in range 1-20."
}

$resolvedOutputDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $OutputDir))
if (-not (Test-Path -LiteralPath $resolvedOutputDir)) {
  New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null
}

$resolvedProcDump = $null
if ([System.IO.Path]::IsPathRooted($ProcDumpPath) -or $ProcDumpPath.Contains("\")) {
  if (Test-Path -LiteralPath $ProcDumpPath) {
    $resolvedProcDump = [System.IO.Path]::GetFullPath($ProcDumpPath)
  }
} else {
  $cmd = Get-Command $ProcDumpPath -ErrorAction SilentlyContinue
  if ($cmd) {
    $resolvedProcDump = $cmd.Source
  }
}

if ([string]::IsNullOrWhiteSpace($resolvedProcDump)) {
  throw "ProcDump not found. Use -ProcDumpPath with a full path."
}

$sessionId = Get-Date -Format "yyyyMMdd-HHmmss"
$sessionDir = Join-Path $resolvedOutputDir $sessionId
New-Item -ItemType Directory -Path $sessionDir -Force | Out-Null

$started = @()
foreach ($target in $normalizedTargets) {
  $processName = [System.IO.Path]::GetFileName($target)
  if ([string]::IsNullOrWhiteSpace($processName)) {
    continue
  }

  $targetDir = Join-Path $sessionDir $processName
  New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

  $args = @("-accepteula", "-ma", "-e")
  if ($FirstChance) {
    $args += "1"
  }
  if ($IncludeTerminate) {
    $args += "-t"
  }
  $args += @("-n", $MaxDumpsPerProcess.ToString(), "-w", $processName, (Join-Path $targetDir "$processName-crash.dmp"))

  $proc = Start-Process -FilePath $resolvedProcDump -ArgumentList $args -WorkingDirectory $targetDir -PassThru -WindowStyle Hidden

  $started += [PSCustomObject]@{
    target = $processName
    watcherPid = $proc.Id
    outputDir = $targetDir
    arguments = ($args -join " ")
  }
}

$sessionInfo = [PSCustomObject]@{
  sessionId = $sessionId
  procDumpPath = $resolvedProcDump
  outputDir = $sessionDir
  startedAt = (Get-Date).ToString("o")
  watchers = $started
}

$sessionFile = Join-Path $sessionDir "session.json"
$sessionInfo | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $sessionFile -Encoding UTF8
$sessionInfo | ConvertTo-Json -Depth 6
