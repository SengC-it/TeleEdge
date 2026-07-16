$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$runtime = Join-Path $app 'runtime'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$stdout = Join-Path $runtime 'service.stdout.log'
$stderr = Join-Path $runtime 'service.stderr.log'

# Node does not automatically inherit the Windows system proxy. Detect the
# proxy used by .NET/PowerShell and enable Node's environment proxy support.
if (!$env:HTTPS_PROXY) {
  $probe = [Uri]'https://fapi.binance.com/fapi/v1/time'
  $proxy = [System.Net.WebRequest]::DefaultWebProxy.GetProxy($probe)
  if ($proxy -and $proxy.AbsoluteUri -ne $probe.AbsoluteUri) {
    $env:HTTPS_PROXY = $proxy.AbsoluteUri
  }
}
if ($env:HTTPS_PROXY) { $env:NODE_USE_ENV_PROXY = '1' }

$existingPidFile = Join-Path $runtime 'service.pid'
if (Test-Path $existingPidFile) {
  $existingPid = [int](Get-Content $existingPidFile -Raw).Trim()
  if (Get-Process -Id $existingPid -ErrorAction SilentlyContinue) {
    Write-Output "TeleEdge V7.5 is already running with PID $existingPid"
    exit 0
  }
}

$process = Start-Process -WindowStyle Hidden -FilePath 'node.exe' -ArgumentList 'src/daemon.mjs' `
  -WorkingDirectory $app -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
Set-Content -Path $existingPidFile -Value $process.Id
Write-Output "Started TeleEdge V7.5 paper service with PID $($process.Id)"
