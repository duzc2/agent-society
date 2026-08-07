param(
  [datetime]$StartTime,
  [datetime]$EndTime,
  [string]$OutputDir = "..\..\agent-society-data\crash\events",
  [string[]]$LogNames = @("Application", "System"),
  [int]$MaxEventsPerLog = 5000
)

if (-not $StartTime) {
  throw "StartTime is required."
}

if (-not $EndTime) {
  $EndTime = Get-Date
}

if ($EndTime -lt $StartTime) {
  throw "EndTime must be later than StartTime."
}

if ($MaxEventsPerLog -lt 100 -or $MaxEventsPerLog -gt 50000) {
  throw "MaxEventsPerLog must be in range 100-50000."
}

$resolvedOutputDir = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot $OutputDir))
if (-not (Test-Path -LiteralPath $resolvedOutputDir)) {
  New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null
}

$windowId = "{0}_{1}" -f $StartTime.ToString("yyyyMMdd-HHmmss"), $EndTime.ToString("yyyyMMdd-HHmmss")
$targetDir = Join-Path $resolvedOutputDir $windowId
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null

$providerAllowList = @(
  "Application Error",
  "Windows Error Reporting",
  "Microsoft-Windows-WER-SystemErrorReporting",
  "Service Control Manager"
)

$idAllowList = @(1000, 1001, 1002, 1026, 7031, 7034, 7040, 7045)
$summary = @()

foreach ($logName in $LogNames) {
  $events = Get-WinEvent -FilterHashtable @{
    LogName = $logName
    StartTime = $StartTime
    EndTime = $EndTime
  } -ErrorAction SilentlyContinue

  if ($events) {
    $events = $events |
      Where-Object {
        $_.ProviderName -in $providerAllowList -or $_.Id -in $idAllowList
      } |
      Select-Object -First $MaxEventsPerLog
  }

  $rows = @()
  foreach ($ev in $events) {
    $rows += [PSCustomObject]@{
      time = if ($ev.TimeCreated) { $ev.TimeCreated.ToString("o") } else { $null }
      logName = $ev.LogName
      id = $ev.Id
      level = $ev.LevelDisplayName
      provider = $ev.ProviderName
      machine = $ev.MachineName
      processId = $ev.ProcessId
      threadId = $ev.ThreadId
      recordId = $ev.RecordId
      message = $ev.Message
    }
  }

  $outFile = Join-Path $targetDir ("{0}.json" -f $logName.ToLower())
  $rows | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $outFile -Encoding UTF8

  $summary += [PSCustomObject]@{
    logName = $logName
    total = $rows.Count
    file = $outFile
  }
}

$summaryObject = [PSCustomObject]@{
  startTime = $StartTime.ToString("o")
  endTime = $EndTime.ToString("o")
  outputDir = $targetDir
  providerAllowList = $providerAllowList
  idAllowList = $idAllowList
  logs = $summary
}

$summaryFile = Join-Path $targetDir "summary.json"
$summaryObject | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $summaryFile -Encoding UTF8
$summaryObject | ConvertTo-Json -Depth 6
