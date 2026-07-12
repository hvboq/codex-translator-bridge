$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$node = Join-Path $root "runtime\node.exe"
$codex = Join-Path $root "app\node_modules\@openai\codex\bin\codex.js"
foreach ($required in @($node, $codex)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "The portable package is incomplete: $required"
    }
}

Write-Host "브라우저에서 사용할 ChatGPT 계정으로 로그인하세요."
& $node $codex login
if ($LASTEXITCODE -ne 0) {
    throw "Codex login failed with exit code $LASTEXITCODE."
}
Write-Host "Codex 로그인이 완료되었습니다." -ForegroundColor Green
Read-Host "Enter를 누르면 닫힙니다"
