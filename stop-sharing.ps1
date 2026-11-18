$ErrorActionPreference = 'Stop'
$file = Join-Path $PSScriptRoot 'share-runtime.json'
if (!(Test-Path $file)) { Write-Host 'Sharing is not running.'; return }
$runtime = Get-Content -Raw $file | ConvertFrom-Json
$tunnel = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.tunnelPID)" -ErrorAction SilentlyContinue
if ($tunnel -and $tunnel.ExecutablePath -eq (Join-Path $PSScriptRoot 'tools\cloudflared.exe')) {
  Stop-Process -Id $tunnel.ProcessId
}
$gateway = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.gatewayPID)" -ErrorAction SilentlyContinue
if ($gateway -and $gateway.Name -eq 'node.exe' -and $gateway.CommandLine -match 'share\.mjs') {
  Stop-Process -Id $gateway.ProcessId
}
Write-Host 'Public access stopped. Local chat remains available at http://127.0.0.1:4317'
