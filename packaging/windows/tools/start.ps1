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

$node = Join-Path $root "runtime\node.exe"
$codex = Join-Path $root "app\node_modules\@openai\codex\bin\codex.js"
$application = Join-Path $root "app\dist\src\main.js"
foreach ($required in @($node, $codex, $application)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "The portable package is incomplete: $required"
    }
}

& $node $codex login status *> $null
if ($LASTEXITCODE -ne 0) {
    Write-Host "Codex 로그인이 필요합니다. 브라우저 로그인 창을 엽니다." -ForegroundColor Yellow
    Write-Host "A Codex login is required. Opening the browser sign-in flow."
    & $node $codex login
    if ($LASTEXITCODE -ne 0) {
        throw "Codex login failed with exit code $LASTEXITCODE."
    }
}

Write-Host ""
Write-Host "Codex Bridge를 시작합니다." -ForegroundColor Green
Write-Host "이 창을 닫으면 로컬 API 서버도 종료됩니다. 종료하려면 Ctrl+C를 누르세요."
Write-Host "로컬 API Key는 'Copy Local API Key.cmd'로 복사할 수 있습니다."
$hostName = Get-EnvValue "CODEX_BRIDGE_HOST" "CODEX_TRANSLATOR_HOST" "127.0.0.1"
$uriHost = if ($hostName -eq "::1") { "[::1]" } else { $hostName }
$port = Get-EnvValue "CODEX_BRIDGE_PORT" "CODEX_TRANSLATOR_PORT" "8765"
Write-Host "OpenAI 호환 Base URL: http://$($uriHost):$port/v1"
Write-Host ""

& $node $application
exit $LASTEXITCODE
