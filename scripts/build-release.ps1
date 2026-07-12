[CmdletBinding()]
param(
    [string]$Version = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$root = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $root

if ($env:OS -ne "Windows_NT") {
    throw "The Windows portable release must be built on Windows."
}
if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
    throw "node.exe was not found."
}
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
    throw "npm.cmd was not found."
}

$packageJson = Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json
$packageVersion = [string]$packageJson.version
$releaseVersion = if ($Version) { $Version.TrimStart("v") } else { $packageVersion }
if ($releaseVersion -ne $packageVersion) {
    throw "Release version $releaseVersion does not match package.json version $packageVersion."
}
$nodeArchitecture = (& node.exe -p "process.arch").Trim()
if ($nodeArchitecture -ne "x64") {
    throw "Only Windows x64 release builds are currently supported. Found: $nodeArchitecture"
}

function Reset-SafeDirectory {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedParent
    )
    $fullPath = [IO.Path]::GetFullPath($Path)
    $fullParent = [IO.Path]::GetFullPath($AllowedParent).TrimEnd("\") + "\"
    if (-not $fullPath.StartsWith($fullParent, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to reset a directory outside ${fullParent}: $fullPath"
    }
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Recurse -Force
    }
    New-Item -ItemType Directory -Path $fullPath -Force | Out-Null
    return $fullPath
}

Write-Host "Building TypeScript application..."
npm.cmd run build
if ($LASTEXITCODE -ne 0) {
    throw "npm run build failed with exit code $LASTEXITCODE."
}

$distRoot = Join-Path $root "dist"
$releaseRoot = Reset-SafeDirectory -Path (Join-Path $distRoot "release") -AllowedParent $distRoot
$stageRoot = Join-Path $releaseRoot "stage"
$packageRoot = Join-Path $stageRoot "CodexTranslatorBridge"
$appRoot = Join-Path $packageRoot "app"
$runtimeRoot = Join-Path $packageRoot "runtime"
$licenseRoot = Join-Path $packageRoot "licenses"
New-Item -ItemType Directory -Path $appRoot, $runtimeRoot, $licenseRoot -Force | Out-Null

Copy-Item -LiteralPath (Join-Path $root "package.json") -Destination $appRoot
Copy-Item -LiteralPath (Join-Path $root "package-lock.json") -Destination $appRoot
New-Item -ItemType Directory -Path (Join-Path $appRoot "dist") -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $root "dist\src") -Destination (Join-Path $appRoot "dist\src") -Recurse

Write-Host "Installing production Codex runtime..."
npm.cmd ci --prefix $appRoot --omit=dev --ignore-scripts
if ($LASTEXITCODE -ne 0) {
    throw "Production dependency installation failed with exit code $LASTEXITCODE."
}

$nodeVersion = (& node.exe -p "process.versions.node").Trim()
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeBaseUrl = "https://nodejs.org/dist/v$nodeVersion"
$nodeArchive = Join-Path $releaseRoot $nodeArchiveName
$nodeChecksums = Join-Path $releaseRoot "SHASUMS256.txt"
Write-Host "Downloading Node.js $nodeVersion portable runtime..."
Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/$nodeArchiveName" -OutFile $nodeArchive
Invoke-WebRequest -UseBasicParsing -Uri "$nodeBaseUrl/SHASUMS256.txt" -OutFile $nodeChecksums
$checksumLine = Get-Content -LiteralPath $nodeChecksums | Where-Object { $_ -match "\s+$([regex]::Escape($nodeArchiveName))$" } | Select-Object -First 1
if (-not $checksumLine) {
    throw "Node.js checksum was not found for $nodeArchiveName."
}
$expectedNodeHash = ($checksumLine -split "\s+")[0].ToLowerInvariant()
$actualNodeHash = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualNodeHash -ne $expectedNodeHash) {
    throw "Node.js archive checksum mismatch."
}

$nodeExtractRoot = Join-Path $releaseRoot "node-extracted"
Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtractRoot -Force
$nodeDistribution = Get-ChildItem -LiteralPath $nodeExtractRoot -Directory | Select-Object -First 1
if (-not $nodeDistribution) {
    throw "The Node.js archive did not contain a distribution directory."
}
Copy-Item -LiteralPath (Join-Path $nodeDistribution.FullName "node.exe") -Destination $runtimeRoot
Copy-Item -LiteralPath (Join-Path $nodeDistribution.FullName "LICENSE") -Destination (Join-Path $licenseRoot "Node.js-LICENSE.txt")

Copy-Item -Path (Join-Path $root "packaging\windows\*") -Destination $packageRoot -Recurse
Copy-Item -LiteralPath (Join-Path $root "config.example.ps1") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $root "LICENSE") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $root "THIRD_PARTY_NOTICES.md") -Destination $packageRoot
Copy-Item -LiteralPath (Join-Path $root "third_party_licenses\openai-codex-Apache-2.0.txt") -Destination (Join-Path $licenseRoot "OpenAI-Codex-Apache-2.0.txt")

$commit = (& git rev-parse HEAD 2>$null).Trim()
$manifest = [ordered]@{
    name = "Codex Translator Bridge"
    version = $releaseVersion
    architecture = "windows-x64"
    nodeVersion = $nodeVersion
    codexVersion = [string]$packageJson.dependencies."@openai/codex"
    commit = $commit
    builtAtUtc = [DateTime]::UtcNow.ToString("o")
}
$manifest | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $packageRoot "RELEASE-MANIFEST.json") -Encoding UTF8

$bundledNode = Join-Path $runtimeRoot "node.exe"
$bundledCodex = Join-Path $appRoot "node_modules\@openai\codex\bin\codex.js"
$codexVersionOutput = & $bundledNode $bundledCodex --version
if ($LASTEXITCODE -ne 0 -or $codexVersionOutput -notmatch [regex]::Escape([string]$packageJson.dependencies."@openai/codex")) {
    throw "Bundled Codex runtime verification failed: $codexVersionOutput"
}
Push-Location -LiteralPath $packageRoot
try {
    $importCheck = "await import('./app/dist/src/http-server.js'); await import('./app/dist/src/translation-service.js');"
    & $bundledNode --input-type=module -e $importCheck
    if ($LASTEXITCODE -ne 0) {
        throw "Bundled application import verification failed with exit code $LASTEXITCODE."
    }
} finally {
    Pop-Location
}

$zipName = "CodexTranslatorBridge-v$releaseVersion-windows-x64.zip"
$zipPath = Join-Path $releaseRoot $zipName
Compress-Archive -LiteralPath $packageRoot -DestinationPath $zipPath -CompressionLevel Optimal
$zipHash = (Get-FileHash -LiteralPath $zipPath -Algorithm SHA256).Hash.ToLowerInvariant()
$checksumPath = "$zipPath.sha256"
Set-Content -LiteralPath $checksumPath -Value "$zipHash  $zipName" -Encoding Ascii

Remove-Item -LiteralPath $stageRoot, $nodeExtractRoot, $nodeArchive, $nodeChecksums -Recurse -Force

Write-Host "Release package created:" -ForegroundColor Green
Write-Host $zipPath
Write-Host "SHA-256: $zipHash"
