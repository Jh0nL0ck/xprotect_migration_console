param(
    [Parameter(Mandatory = $true)]
    [string] $InputPath
)

$ErrorActionPreference = "Stop"

function New-PlainCredential {
    param(
        [Parameter(Mandatory = $true)][string] $UserName,
        [Parameter(Mandatory = $true)][string] $Password
    )

    $secure = ConvertTo-SecureString $Password -AsPlainText -Force
    [System.Management.Automation.PSCredential]::new($UserName, $secure)
}

function Connect-XProtect {
    param(
        [Parameter(Mandatory = $true)] $Connection,
        [Parameter(Mandatory = $true)] [string] $Name
    )

    $credential = New-PlainCredential -UserName $Connection.username -Password $Connection.password
    $params = @{
        Name          = $Name
        ServerAddress = [Uri] $Connection.serverUrl
        Credential    = $credential
        AcceptEula    = $true
    }

    if ($Connection.auth -eq "basic") {
        $params.BasicUser = $true
    }

    Connect-Vms @params | Out-Null
}

function Disconnect-XProtect {
    try {
        Disconnect-Vms -ErrorAction SilentlyContinue | Out-Null
    } catch {
    }
}

try {
    $config = Get-Content -Raw -LiteralPath $InputPath | ConvertFrom-Json
    Import-Module MilestonePSTools -ErrorAction Stop

    $runDirectory = Split-Path -Parent $InputPath
    $exportPath = Join-Path $runDirectory "hardware.xlsx"
    $csvExportPath = Join-Path $runDirectory "hardware.csv"
    $deviceTypes = @("Camera", "Microphone", "Speaker", "Metadata", "Input", "Output")

    Connect-XProtect -Connection $config.source -Name "xma-source"
    $sourceHardware = Get-VmsRecordingServer | Get-VmsHardware
    try {
        $sourceHardware | Export-VmsHardware -Path $exportPath -DeviceType $deviceTypes -EnableFilter All
    } catch {
        if ($_.Exception.Message -match "ImportExcel") {
            $exportPath = $csvExportPath
            $sourceHardware | Export-VmsHardware -Path $exportPath -DeviceType $deviceTypes -EnableFilter All
        } else {
            throw
        }
    }
    $exportedCount = @($sourceHardware).Count
    Disconnect-XProtect

    Connect-XProtect -Connection $config.target -Name "xma-target"
    $targetRecorder = Get-VmsRecordingServer | Select-Object -First 1

    if ($null -eq $targetRecorder) {
        throw "No target recording server was found."
    }

    $importParams = @{
        Path            = $exportPath
        RecordingServer = $targetRecorder
        UpdateExisting  = $true
    }

    if ($config.options.hardwareUsername -and $config.options.hardwarePassword) {
        $importParams.Credential = @(
            New-PlainCredential -UserName $config.options.hardwareUsername -Password $config.options.hardwarePassword
        )
    }

    $rows = @(Import-VmsHardware @importParams)
    $failedRows = @($rows | Where-Object {
        $_.Result -and ($_.Result -notmatch "success|added|updated|ok")
    })
    $successRows = @($rows | Where-Object {
        -not $_.Result -or ($_.Result -match "success|added|updated|ok")
    })

    Disconnect-XProtect

    if (Test-Path -LiteralPath $exportPath) {
        Remove-Item -LiteralPath $exportPath -Force
    }

    if ((Test-Path -LiteralPath $csvExportPath) -and ($csvExportPath -ne $exportPath)) {
        Remove-Item -LiteralPath $csvExportPath -Force
    }

    [pscustomobject]@{
        ok              = $true
        exported        = $exportedCount
        imported        = $successRows.Count
        failed          = $failedRows.Count
        targetRecorder  = $targetRecorder.Name
        errors          = @($failedRows | Select-Object -First 20 | ForEach-Object {
            $name = $_.Name
            if (-not $name) { $name = $_.HardwareName }
            if (-not $name) { $name = $_.Address }
            "$name`: $($_.Result)"
        })
    } | ConvertTo-Json -Depth 8 -Compress
} catch {
    Disconnect-XProtect

    [pscustomobject]@{
        ok       = $false
        exported = 0
        imported = 0
        failed   = 0
        errors   = @($_.Exception.Message)
    } | ConvertTo-Json -Depth 8 -Compress
}
