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

function Get-ItemName {
    param($Item)

    if ($Item.DisplayName) { return [string] $Item.DisplayName }
    if ($Item.Name) { return [string] $Item.Name }
    if ($Item.Id) { return [string] $Item.Id }
    return "Unnamed item"
}

function Get-ItemId {
    param($Item)

    if ($Item.Id) { return [string] $Item.Id }
    if ($Item.Path) { return [string] $Item.Path }
    return $null
}

function Test-Selected {
    param(
        [Parameter(Mandatory = $true)] $Item,
        [Parameter(Mandatory = $true)] $SelectedItems
    )

    $selected = @($SelectedItems)
    if ($selected.Count -eq 0) {
        return $true
    }

    $id = Get-ItemId -Item $Item
    $name = Get-ItemName -Item $Item

    foreach ($selectedItem in $selected) {
        if ($selectedItem.id -and $id -and $selectedItem.id -eq $id) {
            return $true
        }

        if ($selectedItem.name -and $name -and $selectedItem.name -eq $name) {
            return $true
        }
    }

    return $false
}

function Get-ConfigItems {
    param([Parameter(Mandatory = $true)][string] $Type)

    if ($Type -eq "rules") {
        return @(Get-VmsRule)
    }

    if ($Type -eq "views") {
        return @(Get-VmsViewGroup -Recurse)
    }

    throw "Unsupported PSTools migration type: $Type"
}

function Export-ConfigItem {
    param(
        [Parameter(Mandatory = $true)][string] $Type,
        [Parameter(Mandatory = $true)] $Item,
        [Parameter(Mandatory = $true)][string] $Path
    )

    if ($Type -eq "rules") {
        $Item | Export-VmsRule -Path $Path -Force
        return
    }

    if ($Type -eq "views") {
        $Item | Export-VmsViewGroup -Path $Path -Force
        return
    }
}

function Import-ConfigItem {
    param(
        [Parameter(Mandatory = $true)][string] $Type,
        [Parameter(Mandatory = $true)][string] $Path
    )

    if ($Type -eq "rules") {
        Import-VmsRule -Path $Path | Out-Null
        return
    }

    if ($Type -eq "views") {
        Import-VmsViewGroup -Path $Path | Out-Null
        return
    }
}

try {
    $config = Get-Content -Raw -LiteralPath $InputPath | ConvertFrom-Json
    Import-Module MilestonePSTools -ErrorAction Stop

    $runDirectory = Split-Path -Parent $InputPath
    $type = [string] $config.type
    $mode = [string] $config.mode
    $selectedItems = @($config.selectedItems)

    if ($mode -eq "inventory") {
        Connect-XProtect -Connection $config.source -Name "xma-pstools-inventory"
        $items = @(Get-ConfigItems -Type $type)
        Disconnect-XProtect

        [pscustomobject]@{
            ok    = $true
            type  = $type
            count = $items.Count
            items = @($items | ForEach-Object {
                $name = Get-ItemName -Item $_
                $id = Get-ItemId -Item $_

                [pscustomobject]@{
                    id = $id
                    name = $name
                    meta = $id
                    identity = [pscustomobject]@{
                        id = if ($id) { $id } else { "" }
                        name = $name
                        address = ""
                    }
                }
            })
            errors = @()
        } | ConvertTo-Json -Depth 8 -Compress
        exit 0
    }

    Connect-XProtect -Connection $config.source -Name "xma-pstools-source"
    $items = @(Get-ConfigItems -Type $type | Where-Object {
        Test-Selected -Item $_ -SelectedItems $selectedItems
    })
    $exportedCount = $items.Count
    $exportFiles = @()
    $index = 0

    foreach ($item in $items) {
        $index += 1
        $safeName = (Get-ItemName -Item $item) -replace '[\\/:*?"<>|]', '_'
        $exportPath = Join-Path $runDirectory ("{0}_{1}_{2}.json" -f $type, $index, $safeName)
        Export-ConfigItem -Type $type -Item $item -Path $exportPath
        $exportFiles += [pscustomobject]@{
            name = Get-ItemName -Item $item
            path = $exportPath
        }
    }
    Disconnect-XProtect

    Connect-XProtect -Connection $config.target -Name "xma-pstools-target"
    $imported = 0
    $errors = @()

    foreach ($file in $exportFiles) {
        try {
            Import-ConfigItem -Type $type -Path $file.path
            $imported += 1
        } catch {
            $errors += "$($file.name): $($_.Exception.Message)"
        }
    }
    Disconnect-XProtect

    [pscustomobject]@{
        ok        = $true
        type      = $type
        exported  = $exportedCount
        imported  = $imported
        failed    = $errors.Count
        files     = $exportFiles
        errors    = $errors
    } | ConvertTo-Json -Depth 8 -Compress
} catch {
    Disconnect-XProtect

    [pscustomobject]@{
        ok       = $false
        type     = $type
        exported = 0
        imported = 0
        failed   = 0
        errors   = @($_.Exception.Message)
    } | ConvertTo-Json -Depth 8 -Compress
}
