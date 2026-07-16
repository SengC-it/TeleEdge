$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
if (!$env:HTTPS_PROXY) {
  $probe = [Uri]'https://fapi.binance.com/fapi/v1/time'
  $proxy = [System.Net.WebRequest]::DefaultWebProxy.GetProxy($probe)
  if ($proxy -and $proxy.AbsoluteUri -ne $probe.AbsoluteUri) {
    $env:HTTPS_PROXY = $proxy.AbsoluteUri
  }
}
if ($env:HTTPS_PROXY) { $env:NODE_USE_ENV_PROXY = '1' }
& node.exe (Join-Path $app 'src/cli.mjs') scan
exit $LASTEXITCODE
