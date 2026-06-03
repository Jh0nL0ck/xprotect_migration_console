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
    $address = Normalize-Address -Value (Get-ObjectValue -Object $Hardware -Names @("HardwareAddress", "Address", "HostName", "Hostname", "Uri", "IpAddress"))

    foreach ($selected in $selectedItems) {
        if ($selected.id -and $id -and ($selected.id -eq $id)) {
            return $true
        }

        if ($selected.name -and $name -and ($selected.name -eq $name)) {
            return $true
        }

        if ($selected.address -and $address -and ((Normalize-Address -Value $selected.address) -eq $address)) {
            return $true
        }
    }

    return $false
}

function Normalize-Text {
    param([string] $Value)

    return ($Value -replace "\s+", " ").Trim().ToLowerInvariant()
}

function Normalize-Address {
    param([string] $Value)

    if (-not $Value) {
        return ""
    }

    return $Value.Trim().TrimEnd("/").ToLowerInvariant()
}

function Test-CameraRowSelected {
    param(
        [Parameter(Mandatory = $true)] $Row,
        [Parameter(Mandatory = $true)] $SelectedCameras
    )

    $selectedItems = @($SelectedCameras)
    if ($selectedItems.Count -eq 0) {
        return $true
    }

    $rowName = Normalize-Text -Value $Row.Name
    foreach ($selected in $selectedItems) {
        $selectedName = Normalize-Text -Value $selected.name
        if ($selectedName -and ($rowName -eq $selectedName -or $rowName.Contains($selectedName) -or $selectedName.Contains($rowName))) {
            return $true
        }
    }

    return $false
}

function Update-HardwareCsv {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)] $SelectedCameras,
        [Parameter(Mandatory = $true)][string[]] $ExistingAddresses
    )

    $rows = @(Import-Csv -LiteralPath $Path)
    $selectedCameraRows = @($rows | Where-Object {
        $_.DeviceType -eq "Camera" -and (Test-CameraRowSelected -Row $_ -SelectedCameras $SelectedCameras)
    })

    $selectedHardwareNames = @($selectedCameraRows | Select-Object -ExpandProperty HardwareName -Unique)
    if (@($SelectedCameras).Count -eq 0) {
        $selectedHardwareNames = @($rows | Select-Object -ExpandProperty HardwareName -Unique)
    }

    $filteredRows = @($rows | Where-Object {
        $cameraIsSelected = $_.DeviceType -eq "Camera" -and (Test-CameraRowSelected -Row $_ -SelectedCameras $SelectedCameras)
        $relatedDeviceIsSelected = $_.DeviceType -ne "Camera" -and ($selectedHardwareNames -contains $_.HardwareName)
        $rowAddress = Normalize-Address -Value $_.Address
        $notAlreadyDefined = $ExistingAddresses -notcontains $rowAddress

        ($cameraIsSelected -or $relatedDeviceIsSelected) -and $notAlreadyDefined
    })
    $skippedExisting = @($rows | Where-Object {
        ($selectedHardwareNames -contains $_.HardwareName) -and ($ExistingAddresses -contains (Normalize-Address -Value $_.Address))
    } | Select-Object -ExpandProperty Address -Unique).Count

    if ($filteredRows.Count -gt 0) {
        $filteredRows | Export-Csv -LiteralPath $Path -NoTypeInformation -Encoding UTF8
    } else {
        ($rows | Select-Object -First 1) | ConvertTo-Csv -NoTypeInformation | Select-Object -First 1 | Set-Content -LiteralPath $Path -Encoding UTF8
    }

    return [pscustomobject]@{
        Path = $Path
        Rows = $filteredRows.Count
        HardwareNames = @($filteredRows | Select-Object -ExpandProperty HardwareName -Unique)
        SkippedExisting = $skippedExisting
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
    $selectedHardware = @($config.options.selectedHardware)
    $selectedCameras = @($config.options.selectedCameras)
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

    $targetHardware = @(Get-VmsRecordingServer | Get-VmsHardware)
    $existingAddresses = @($targetHardware | ForEach-Object {
        Get-ObjectValue -Object $_ -Names @("HardwareAddress", "Address", "HostName", "Hostname", "Uri", "IpAddress")
    } | Where-Object { $_ } | ForEach-Object {
        Normalize-Address -Value $_
    } | Where-Object { $_ } | Select-Object -Unique)
    $skippedExisting = 0
    $importPath = $exportPath

    if ($createdCsvExportPath) {
        $csvFilter = Update-HardwareCsv -Path $createdCsvExportPath -SelectedCameras $selectedCameras -ExistingAddresses $existingAddresses
        $skippedExisting = $csvFilter.SkippedExisting
        $importPath = $createdCsvExportPath

        if ($csvFilter.Rows -eq 0) {
            Disconnect-XProtect

            [pscustomobject]@{
                ok              = $true
                exported        = $exportedCount
                imported        = 0
                failed          = 0
                skipped         = $skippedExisting
                selected        = $selectedCount
                targetRecorder  = $targetRecorder.Name
                exportPath      = $exportPath
                csvExportPath   = $createdCsvExportPath
                errors          = @("Selected hardware already exists on the target recording server, so no new hardware was imported.")
            } | ConvertTo-Json -Depth 8 -Compress
            exit 0
        }
    }

    $importParams = @{
        Path            = $importPath
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
        skipped         = $skippedExisting
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
