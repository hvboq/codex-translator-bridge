$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

$configFile = Join-Path $root "config.ps1"
if (Test-Path -LiteralPath $configFile) {
    . $configFile
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "Node.js 18 or newer is required."
}
$nodeMajor = [int](node.exe -p "Number(process.versions.node.split('.')[0])")
if ($nodeMajor -lt 18) {
    throw "Node.js 18 or newer is required. Found Node.js $nodeMajor."
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm.cmd was not found on PATH."
}

$codexLauncher = Join-Path $root "node_modules\@openai\codex\bin\codex.js"
$typescriptCompiler = Join-Path $root "node_modules\typescript\bin\tsc"
if (
    -not (Test-Path -LiteralPath $codexLauncher) -or
    -not (Test-Path -LiteralPath $typescriptCompiler)
) {
    npm.cmd ci
    if ($LASTEXITCODE -ne 0) {
        throw "npm ci failed with exit code $LASTEXITCODE."
    }
}

npm.cmd run build
if ($LASTEXITCODE -ne 0) {
    throw "Build failed with exit code $LASTEXITCODE."
}

npm.cmd start
exit $LASTEXITCODE
