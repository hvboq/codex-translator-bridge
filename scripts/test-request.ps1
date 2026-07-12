$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$configFile = Join-Path $root "config.ps1"
if (Test-Path -LiteralPath $configFile) {
    . $configFile
}

function Get-EnvValue([string]$CurrentName, [string]$LegacyName, [string]$Fallback) {
    $current = [Environment]::GetEnvironmentVariable($CurrentName)
    if ($null -ne $current) { return $current }
    $legacy = [Environment]::GetEnvironmentVariable($LegacyName)
    if ($null -ne $legacy) { return $legacy }
    return $Fallback
}

$hostName = Get-EnvValue "CODEX_BRIDGE_HOST" "CODEX_TRANSLATOR_HOST" "127.0.0.1"
$uriHost = if ($hostName -eq "::1") { "[::1]" } else { $hostName }
$port = Get-EnvValue "CODEX_BRIDGE_PORT" "CODEX_TRANSLATOR_PORT" "8765"
$homeDirectory = Get-EnvValue "CODEX_BRIDGE_HOME" "CODEX_TRANSLATOR_HOME" $root
$dataDirectory = Get-EnvValue "CODEX_BRIDGE_DATA_DIR" "CODEX_TRANSLATOR_DATA_DIR" (Join-Path $homeDirectory "data")
$tokenPath = Join-Path $dataDirectory "token.txt"
$token = Get-EnvValue "CODEX_BRIDGE_TOKEN" "CODEX_TRANSLATOR_TOKEN" ""
if (-not $token -and (Test-Path -LiteralPath $tokenPath)) {
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
}

$headers = @{}
if ($token) {
    $headers.Authorization = "Bearer $token"
} else {
    $noAuth = Get-EnvValue "CODEX_BRIDGE_NO_AUTH" "CODEX_TRANSLATOR_NO_AUTH" "false"
    if ($noAuth -notin @("1", "true", "yes", "on")) {
        throw "No local bearer token was found. Start Codex Bridge once before running this test."
    }
}

$baseUri = "http://$($uriHost):$port"
$modelList = Invoke-RestMethod -Method Get -Uri "$baseUri/v1/models" -Headers $headers
$availableModels = @($modelList.data)
if ($availableModels.Count -eq 0) {
    throw "No GPT-5.6 model is available for the current Codex account."
}
$configuredModel = Get-EnvValue "CODEX_BRIDGE_MODEL" "CODEX_TRANSLATOR_MODEL" ""
$defaultModel = $availableModels | Where-Object { $_.is_default } | Select-Object -First 1
$model = if ($configuredModel -and $configuredModel -notin @("codex-bridge", "codex-translator")) {
    $configuredModel
} elseif ($defaultModel) {
    $defaultModel.id
} else {
    $availableModels[0].id
}
Write-Host "Testing model: $model"

function Invoke-JsonPost([string]$Path, [hashtable]$Payload) {
    $body = $Payload | ConvertTo-Json -Depth 10 -Compress
    Invoke-RestMethod -Method Post -Uri "$baseUri$Path" -Headers $headers -ContentType "application/json; charset=utf-8" -Body ([Text.Encoding]::UTF8.GetBytes($body))
}

Write-Host "Chat Completions:"
Invoke-JsonPost "/v1/chat/completions" @{
    model = $model
    messages = @(@{ role = "user"; content = "Reply with exactly: bridge-ok" })
}

Write-Host "Responses:"
Invoke-JsonPost "/v1/responses" @{
    model = $model
    input = "Reply with exactly: responses-ok"
}

Write-Host "Optional translation helper:"
Invoke-JsonPost "/translate" @{
    model = $model
    text = "Hello."
    source = "en"
    target = "ko"
}
