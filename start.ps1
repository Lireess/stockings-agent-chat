$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot
$candidates = @(
  (Get-Command node -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source),
  'C:\Program Files\Microsoft Visual Studio\18\Community\MSBuild\Microsoft\VisualStudio\NodeJs\node.exe',
  'C:\Program Files\Adobe\Adobe Creative Cloud Experience\libs\node.exe'
)
$node = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (!$node) { throw 'Не найден Node.js. Установите Node.js 22 или новее.' }
Start-Process 'http://127.0.0.1:4317'
& $node (Join-Path $PSScriptRoot 'server.mjs')
