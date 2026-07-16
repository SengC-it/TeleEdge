$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$pidFile = Join-Path $app 'runtime/service.pid'
if (!(Test-Path $pidFile)) {
  Write-Output 'TeleEdge V7.5 is not running (PID file absent).'
  exit 0
}
$servicePid = [int](Get-Content $pidFile -Raw).Trim()
$process = Get-Process -Id $servicePid -ErrorAction SilentlyContinue
if ($process) {
  Stop-Process -Id $servicePid
  $process.WaitForExit(5000)
}
Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
Write-Output 'TeleEdge V7.5 paper service stopped.'
