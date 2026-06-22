param(
  [string]$InstallDir = "$env:LOCALAPPDATA\KdenliveMCP",
  [switch]$AddToPath
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw 'Node.js 22 or newer is required. Install it from https://nodejs.org/ and retry.'
}
$NodeMajor = [int]((node --version).TrimStart('v').Split('.')[0])
if ($NodeMajor -lt 22) { throw "Node.js 22 or newer is required; found $(node --version)." }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  corepack enable
  corepack prepare pnpm@9.5.0 --activate
}

Push-Location $RepoRoot
try {
  pnpm install --frozen-lockfile
  pnpm package:release -- --platform windows --output artifacts/release
  $Archive = Get-ChildItem "$RepoRoot\artifacts\release\kdenlive-mcp-*-windows-x64.zip" |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $Archive) { throw 'Windows release archive was not created.' }
  $ResolvedInstall = [System.IO.Path]::GetFullPath($InstallDir)
  if (Test-Path -LiteralPath $ResolvedInstall) {
    Remove-Item -LiteralPath $ResolvedInstall -Recurse -Force
  }
  New-Item -ItemType Directory -Path $ResolvedInstall | Out-Null
  Expand-Archive -LiteralPath $Archive.FullName -DestinationPath $ResolvedInstall
  $PackageRoot = Get-ChildItem $ResolvedInstall -Directory | Select-Object -First 1
  if (-not $PackageRoot) { throw 'Installed package directory is missing.' }
  if ($AddToPath) {
    $UserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($UserPath -split ';') -notcontains $PackageRoot.FullName) {
      [Environment]::SetEnvironmentVariable('Path', "$UserPath;$($PackageRoot.FullName)", 'User')
    }
  }
  & "$($PackageRoot.FullName)\kdenlive-mcp.cmd" --version
  & "$($PackageRoot.FullName)\kdenlive-mcp.cmd" --doctor
  Write-Host "Installed to $($PackageRoot.FullName)"
  Write-Host 'Re-run this script to upgrade. See INSTALL.md for MCP client configuration.'
} finally {
  Pop-Location
}
