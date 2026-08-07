param(
  [string]$SessionDir
)

if ([string]::IsNullOrWhiteSpace($SessionDir)) {
  throw "Use -SessionDir to provide the session folder from start-procdump-monitor.ps1."
}

$resolvedSessionDir = [System.IO.Path]::GetFullPath((Join-Path $PWD $SessionDir))
$sessionFile = Join-Path $resolvedSessionDir "session.json"
if (-not (Test-Path -LiteralPath $sessionFile)) {
  throw "session.json not found: $sessionFile"
}

$session = Get-Content -LiteralPath $sessionFile -Raw | ConvertFrom-Json
$stopped = @()
$notRunning = @()

foreach ($watcher in $session.watchers) {
  $pid = [int]$watcher.watcherPid
  $p = Get-Process -Id $pid -ErrorAction SilentlyContinue
  if ($p) {
    Stop-Process -Id $pid -Force
    $stopped += [PSCustomObject]@{
      target = $watcher.target
      watcherPid = $pid
    }
  } else {
    $notRunning += [PSCustomObject]@{
      target = $watcher.target
      watcherPid = $pid
    }
  }
}

[PSCustomObject]@{
  sessionId = $session.sessionId
  sessionDir = $resolvedSessionDir
  stopped = $stopped
  notRunning = $notRunning
  checkedAt = (Get-Date).ToString("o")
} | ConvertTo-Json -Depth 6
