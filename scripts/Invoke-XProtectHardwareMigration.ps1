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

function Get-ObjectValue {
    param(
        [Parameter(Mandatory = $true)] $Object,
        [Parameter(Mandatory = $true)] [string[]] $Names
    )

    foreach ($name in $Names) {
        if ($Object.PSObject.Properties[$name] -and $Object.$name) {
            return [string] $Object.$name
        }
    }

    return ""
}

function Test-HardwareSelected {
    param(
        [Parameter(Mandatory = $true)] $Hardware,
        [Parameter(Mandatory = $true)] $SelectedHardware
    )

    $selectedItems = @($SelectedHardware)
    if ($selectedItems.Count -eq 0) {
        return $false
    }

    $id = Get-ObjectValue -Object $Hardware -Names @("Id", "ID", "Path", "ReferenceId")
    $name = Get-ObjectValue -Object $Hardware -Names @("Name", "DisplayName")
    $address = Get-ObjectValue -Object $Hardware -Names @("HardwareAddress", "Address", "HostName", "Hostname", "Uri", "IpAddress")

    foreach ($selected in $selectedItems) {
        if ($selected.id -and $id -and ($selected.id -eq $id)) {
            return $true
        }

        if ($selected.name -and $name -and ($selected.name -eq $name)) {
            return $true
        }

        if ($selected.address -and $address -and ($selected.address -eq $address)) {
            return $true
        }
    }

    return $false
}

try {
    $config = Get-Content -Raw -LiteralPath $InputPath | ConvertFrom-Json
    Import-Module MilestonePSTools -ErrorAction Stop

    $runDirectory = Split-Path -Parent $InputPath
    $exportPath = Join-Path $runDirectory "hardware.xlsx"
    $csvExportPath = Join-Path $runDirectory "hardware.csv"
    $deviceTypes = @("Camera", "Microphone", "Speaker", "Metadata", "Input", "Output")

    Connect-XProtect -Connection $config.source -Name "xma-source"
    $selectedHardware = @($config.options.selectedHardware)
    $hardwareSelectionEnabled = [bool] $config.options.hardwareSelectionEnabled
    $sourceHardware = @(Get-VmsRecordingServer | Get-VmsHardware)
    if ($hardwareSelectionEnabled) {
        $sourceHardware = @($sourceHardware | Where-Object {
            Test-HardwareSelected -Hardware $_ -SelectedHardware $selectedHardware
        })
    }
    $exportedCount = @($sourceHardware).Count
    $selectedCount = @($selectedHardware).Count

    if ($exportedCount -eq 0) {
        Disconnect-XProtect

        [pscustomobject]@{
            ok             = $true
            exported       = 0
            imported       = 0
            failed         = 0
            selected       = $selectedCount
        targetRecorder = $null
        exportPath     = $null
        csvExportPath  = $null
        errors         = @()
        } | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }

    try {
        $sourceHardware | Export-VmsHardware -Path $exportPath -DeviceType $deviceTypes -EnableFilter All
        try {
            $sourceHardware | Export-VmsHardware -Path $csvExportPath -DeviceType $deviceTypes -EnableFilter All
        } catch {
        }
    } catch {
        if ($_.Exception.Message -match "ImportExcel") {
            $exportPath = $csvExportPath
            $sourceHardware | Export-VmsHardware -Path $exportPath -DeviceType $deviceTypes -EnableFilter All
        } else {
            throw
        }
    }
    Disconnect-XProtect
    $createdCsvExportPath = if (Test-Path -LiteralPath $csvExportPath) { $csvExportPath } else { $null }

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

    [pscustomobject]@{
        ok              = $true
        exported        = $exportedCount
        imported        = $successRows.Count
        failed          = $failedRows.Count
        selected        = $selectedCount
        targetRecorder  = $targetRecorder.Name
        exportPath      = $exportPath
        csvExportPath   = $createdCsvExportPath
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
        exportPath = $exportPath
        csvExportPath = $csvExportPath
        errors   = @($_.Exception.Message)
    } | ConvertTo-Json -Depth 8 -Compress
}
