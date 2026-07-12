$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root
$configFile = Join-Path $root "config.ps1"
if (Test-Path -LiteralPath $configFile) {
    . $configFile
}

$hostName = if ($env:CODEX_TRANSLATOR_HOST) { $env:CODEX_TRANSLATOR_HOST } else { "127.0.0.1" }
$uriHost = if ($hostName -eq "::1") { "[::1]" } else { $hostName }
$port = if ($env:CODEX_TRANSLATOR_PORT) { $env:CODEX_TRANSLATOR_PORT } else { "8765" }
$homeDirectory = if ($env:CODEX_TRANSLATOR_HOME) {
    $env:CODEX_TRANSLATOR_HOME
} else {
    $root
}
$dataDirectory = if ($env:CODEX_TRANSLATOR_DATA_DIR) {
    $env:CODEX_TRANSLATOR_DATA_DIR
} else {
    Join-Path $homeDirectory "data"
}
$tokenPath = Join-Path $dataDirectory "token.txt"
$token = $env:CODEX_TRANSLATOR_TOKEN
if (-not $token -and (Test-Path -LiteralPath $tokenPath)) {
    $token = (Get-Content -LiteralPath $tokenPath -Raw).Trim()
}

$headers = @{}
if ($token) {
    $headers.Authorization = "Bearer $token"
} elseif ($env:CODEX_TRANSLATOR_NO_AUTH -notin @("1", "true", "yes", "on")) {
    throw "No local bearer token was found. Start the bridge once before running this test."
}
$baseUri = "http://$($uriHost):$port"
$modelList = Invoke-RestMethod -Method Get -Uri "$baseUri/v1/models" -Headers $headers
$availableModels = @($modelList.data)
if ($availableModels.Count -eq 0) {
    throw "No GPT-5.6 model is available for the current Codex account."
}
$configuredModel = $env:CODEX_TRANSLATOR_MODEL
$defaultModel = $availableModels | Where-Object { $_.is_default } | Select-Object -First 1
$model = if ($configuredModel -and $configuredModel -ne "codex-translator") {
    $configuredModel
} elseif ($defaultModel) {
    $defaultModel.id
} else {
    $availableModels[0].id
}
Write-Host "Testing model: $model"
$body = @{
    text = "Hello."
    source = "en"
    target = "ko"
    model = $model
} | ConvertTo-Json -Compress
$request = @{
    Method = "Post"
    Uri = "$baseUri/translate"
    Headers = $headers
    ContentType = "application/json; charset=utf-8"
    Body = [Text.Encoding]::UTF8.GetBytes($body)
}

Invoke-RestMethod @request
