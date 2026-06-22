param([string]$InstallDir = "$env:LOCALAPPDATA\KdenliveMCP")
$ErrorActionPreference = 'Stop'
$ResolvedInstall = [System.IO.Path]::GetFullPath($InstallDir)
if (Test-Path -LiteralPath $ResolvedInstall) {
  Remove-Item -LiteralPath $ResolvedInstall -Recurse -Force
}
Write-Host "Removed $ResolvedInstall. Project directories and MCP client configuration were not deleted."
