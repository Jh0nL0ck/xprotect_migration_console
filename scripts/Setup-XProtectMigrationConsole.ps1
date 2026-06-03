param(
    [switch] $InstallNodeWithWinget
)

$ErrorActionPreference = "Stop"

function Write-Step {
    param([string] $Message)
    Write-Host "==> $Message" -ForegroundColor Cyan
}

function Test-Command {
    param([string] $Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

Write-Step "Checking Node.js"
if (-not (Test-Command "node")) {
    if ($InstallNodeWithWinget) {
        if (-not (Test-Command "winget")) {
            throw "Node.js is missing and winget is not available. Install Node.js 18+ manually from https://nodejs.org/"
        }

        Write-Step "Installing Node.js LTS with winget"
        winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
    } else {
        throw "Node.js is missing. Install Node.js 18+ manually, or rerun this script with -InstallNodeWithWinget."
    }
}

$nodeVersion = & node --version
Write-Host "Node.js detected: $nodeVersion"

Write-Step "Preparing PowerShell Gallery"
if (-not (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
    Install-PackageProvider -Name NuGet -Scope CurrentUser -Force | Out-Null
}

Write-Step "Installing or updating MilestonePSTools"
Set-PSRepository -Name PSGallery -InstallationPolicy Trusted
Install-Module MilestonePSTools -Scope CurrentUser -Force -AllowClobber
Import-Module MilestonePSTools -Force

Write-Step "Validating MilestonePSTools commands"
$requiredCommands = @(
    "Connect-Vms",
    "Get-VmsRecordingServer",
    "Export-VmsHardware",
    "Import-VmsHardware"
)

foreach ($command in $requiredCommands) {
    if (-not (Test-Command $command)) {
        throw "Required command not found after installation: $command"
    }
}

Write-Step "Setup completed"
Write-Host "You can start the app with:" -ForegroundColor Green
Write-Host "  powershell -ExecutionPolicy Bypass -File scripts\Start-XProtectMigrationConsole.ps1" -ForegroundColor Green
