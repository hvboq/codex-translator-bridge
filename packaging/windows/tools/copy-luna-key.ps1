$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$env:CODEX_TRANSLATOR_HOME = $root
$configFile = Join-Path $root "config.ps1"
if (Test-Path -LiteralPath $configFile) {
    . $configFile
}

$homeDirectory = if ($env:CODEX_TRANSLATOR_HOME) {
    [IO.Path]::GetFullPath($env:CODEX_TRANSLATOR_HOME)
} else {
    $root
}
$dataDirectory = if ($env:CODEX_TRANSLATOR_DATA_DIR) {
    [IO.Path]::GetFullPath($env:CODEX_TRANSLATOR_DATA_DIR)
} else {
    Join-Path $homeDirectory "data"
}
$tokenPath = Join-Path $dataDirectory "token.txt"
$token = $env:CODEX_TRANSLATOR_TOKEN
if (-not $token -and (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
}
if (-not $token) {
    throw "로컬 API Key가 없습니다. 'Start Codex Translator.cmd'를 먼저 한 번 실행하세요."
}

$token.Trim() | Set-Clipboard
$hostName = if ($env:CODEX_TRANSLATOR_HOST) { $env:CODEX_TRANSLATOR_HOST } else { "127.0.0.1" }
$uriHost = if ($hostName -eq "::1") { "[::1]" } else { $hostName }
$port = if ($env:CODEX_TRANSLATOR_PORT) { $env:CODEX_TRANSLATOR_PORT } else { "8765" }

Write-Host "LunaTranslator용 API Key를 클립보드에 복사했습니다." -ForegroundColor Green
Write-Host "API 주소: http://$($uriHost):$port"
Write-Host "API Key 칸에는 방금 복사한 값만 붙여넣고 'Bearer '는 붙이지 마세요."
Write-Host "여러 키 순환을 막기 위해 API Key 칸에 | 문자가 없는지 확인하세요."
Read-Host "Enter를 누르면 닫힙니다"
