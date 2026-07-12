$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$configFile = Join-Path $root "config.ps1"
if (Test-Path -LiteralPath $configFile) {
    . $configFile
}
if (-not $env:CODEX_BRIDGE_HOME -and -not $env:CODEX_TRANSLATOR_HOME) {
    $env:CODEX_BRIDGE_HOME = $root
}

function Get-EnvValue([string]$CurrentName, [string]$LegacyName, [string]$Fallback) {
    $current = [Environment]::GetEnvironmentVariable($CurrentName)
    if ($null -ne $current) { return $current }
    $legacy = [Environment]::GetEnvironmentVariable($LegacyName)
    if ($null -ne $legacy) { return $legacy }
    return $Fallback
}

$homeDirectory = [IO.Path]::GetFullPath((Get-EnvValue "CODEX_BRIDGE_HOME" "CODEX_TRANSLATOR_HOME" $root))
$dataDirectory = [IO.Path]::GetFullPath((Get-EnvValue "CODEX_BRIDGE_DATA_DIR" "CODEX_TRANSLATOR_DATA_DIR" (Join-Path $homeDirectory "data")))
$tokenPath = Join-Path $dataDirectory "token.txt"
$token = Get-EnvValue "CODEX_BRIDGE_TOKEN" "CODEX_TRANSLATOR_TOKEN" ""
if (-not $token -and (Test-Path -LiteralPath $tokenPath -PathType Leaf)) {
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
}
if (-not $token) {
    throw "로컬 API Key가 없습니다. 'Start Codex Bridge.cmd'를 먼저 한 번 실행하세요."
}

$token.Trim() | Set-Clipboard
$hostName = Get-EnvValue "CODEX_BRIDGE_HOST" "CODEX_TRANSLATOR_HOST" "127.0.0.1"
$uriHost = if ($hostName -eq "::1") { "[::1]" } else { $hostName }
$port = Get-EnvValue "CODEX_BRIDGE_PORT" "CODEX_TRANSLATOR_PORT" "8765"

Write-Host "Codex Bridge 로컬 API Key를 클립보드에 복사했습니다." -ForegroundColor Green
Write-Host "OpenAI 호환 Base URL: http://$($uriHost):$port/v1"
Write-Host "일부 프로그램은 주소에 /v1을 자동으로 붙이므로 그 경우 http://$($uriHost):$port 를 사용하세요."
Write-Host "API Key에는 복사한 값만 붙여넣고 'Bearer '는 붙이지 마세요."
Read-Host "Enter를 누르면 닫힙니다"
