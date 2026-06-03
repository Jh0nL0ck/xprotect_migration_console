$ErrorActionPreference = "Stop"

$scriptDirectory = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $scriptDirectory

Set-Location $projectRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is not installed or not in PATH. Run scripts\Setup-XProtectMigrationConsole.ps1 first."
}

if (-not (Get-Command Import-VmsHardware -ErrorAction SilentlyContinue)) {
    throw "MilestonePSTools is not installed. Run scripts\Setup-XProtectMigrationConsole.ps1 first."
}

Write-Host "Starting XProtect Migration Console at http://localhost:4173" -ForegroundColor Green
node server.js
