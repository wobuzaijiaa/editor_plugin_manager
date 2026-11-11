# Architecture C launcher for project-root Run/Stop BAT files.
# Uses original upstream serve from supersplat/node_modules. No build or npm install.
# CAUTION: dist/runtime backend source may be HTTP-readable; store no secrets there.
# No clone, rebuild, deployment, or plugin-store writes. Windows PowerShell 5.1+.
[CmdletBinding()]
param(
    [ValidateSet('start','stop')][string]$Action = 'start',
    [ValidateRange(1024,65535)][int]$EditorPort = 3013,
    [ValidateRange(1024,65535)][int]$ManagementPort = 3014
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $Root 'supersplat'
$Dist = Join-Path $Source 'dist'
$Runtime = Join-Path $Dist 'runtime'
$BackendScript = Join-Path $Runtime 'management-server.cjs'
$LogRoot = Join-Path $Root 'logs\run_logs'
$StateFile = Join-Path $LogRoot "active-p${EditorPort}-p${ManagementPort}.json"
# Runtime logs are generated BESIDE dist, never under the HTTP-served directory.
$EditorOrigin = "http://127.0.0.1:$EditorPort"
$BackendOrigin = "http://127.0.0.1:$ManagementPort"

function Require([bool]$Condition, [string]$ErrorMessage) {
    if (-not $Condition) { throw $ErrorMessage }
}
function Read-Json([string]$Filename) {
    return (Get-Content -LiteralPath $Filename -Raw -Encoding UTF8 | ConvertFrom-Json)
}
function Sha256([string]$File) {
    Require (Test-Path -LiteralPath $File -PathType Leaf) "Missing file: $File"
    $Stream = [IO.File]::OpenRead($File)
    try {
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
        try { return ([BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
        finally { $Hasher.Dispose() }
    } finally { $Stream.Dispose() }
}
function Get-ListenerPids([int]$Port) {
    return @((Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique))
}
function Get-OwnedProcess($Record) {
    $ProcessId = [int]$Record.pid
    $Process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $Process) { return $null }
    try { $Ticks = $Process.StartTime.ToUniversalTime().Ticks }
    catch { return $null }
    if ([string]$Ticks -cne [string]$Record.start_ticks) { return $null }
    $WinProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
    if (-not $WinProcess -or $WinProcess.Name -ine 'node.exe') { return $null }
    $Command = [string]$WinProcess.CommandLine
    $Exe = [string]$WinProcess.ExecutablePath
    if (-not $Command -or -not $Exe -or
        $Exe.IndexOf([string]$Record.node, [StringComparison]::OrdinalIgnoreCase) -ne 0 -or
        $Exe.Length -ne ([string]$Record.node).Length -or
        $Command.IndexOf([string]$Record.script, [StringComparison]::OrdinalIgnoreCase) -lt 0 -or
        $Command.IndexOf([string]$Record.port_argument, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
        return $null
    }
    return $Process
}
function Assert-NotOccupied([int]$Port) {
    Require ((Get-ListenerPids $Port).Count -eq 0) "Port $Port is already in use. No process was stopped."
}
function Assert-ListenerOwned([int]$Port, $Record) {
    $Listeners = @(Get-ListenerPids $Port)
    if ($Listeners.Count -eq 0) { return }
    Require ($Listeners.Count -eq 1 -and [int]$Listeners[0] -eq [int]$Record.pid) "REFUSED: Port $Port belongs to an unrecognized process."
    Require ($null -ne (Get-OwnedProcess $Record)) "REFUSED: Port $Port process identity no longer matches the saved launch."
}
function Make-Record($Process, [string]$Script, [string]$PortArgument, [string]$Node) {
    return [ordered]@{
        pid = [int]$Process.Id
        start_ticks = [string]$Process.StartTime.ToUniversalTime().Ticks
        script = $Script
        port_argument = $PortArgument
        node = $Node
    }
}
function Check-Ready([string]$Url) {
    try {
        $Response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 1 -ErrorAction Stop
        return ($Response.StatusCode -eq 200)
    } catch { return $false }
}

try {
    Require ($EditorPort -ne $ManagementPort) 'Editor and management ports must be different.'
    if ($Action -eq 'stop') {
        $StopStateFile = $StateFile
        if (-not (Test-Path -LiteralPath $StopStateFile -PathType Leaf)) {
            Assert-NotOccupied $EditorPort
            Assert-NotOccupied $ManagementPort
            Write-Host 'Architecture C already stopped. No saved services to terminate.'
            exit 0
        }
        $Saved = Read-Json $StopStateFile
        Require ([int]$Saved.schema -eq 1 -and [string]$Saved.root -ieq $Root -and
            [int]$Saved.editor_port -eq $EditorPort -and [int]$Saved.management_port -eq $ManagementPort) 'Saved process record does not match this checkout and port pair.'
        # Check BOTH listeners before stopping either one. Never kill an unrelated PID.
        Assert-ListenerOwned $EditorPort $Saved.editor
        Assert-ListenerOwned $ManagementPort $Saved.management
        foreach ($Entry in @($Saved.editor, $Saved.management)) {
            $Owned = Get-OwnedProcess $Entry
            if ($null -ne $Owned) {
                Stop-Process -Id $Owned.Id -Force -ErrorAction Stop
                Write-Host "Stopped owned Node service (PID $($Owned.Id))."
            }
        }
        Remove-Item -LiteralPath $StopStateFile -Force
        Write-Host 'Architecture C stopped.'
        exit 0
    }

    # Start requires a validated deployed Editor and existing environment.
    # No clone, build, copy, or dependency installation is performed here.
    foreach ($File in @((Join-Path $Dist 'index.html'),
        (Join-Path $Dist 'custom-editor.js'),
        (Join-Path $Dist 'plugins\manifest.json'), $BackendScript,
        (Join-Path $Runtime 'management-core.cjs'),
        (Join-Path $Runtime 'custom-editor.js'))) {
        Require (Test-Path -LiteralPath $File -PathType Leaf) "Required deployed file missing: $File. Run maintain_editor.bat copy or build."
    }
    $Html = [IO.File]::ReadAllText((Join-Path $Dist 'index.html'))
    $ExpectedHook = '<script type="module" src="./custom-editor.js" data-management-origin="' + $BackendOrigin + '"></script>'
    Require ($Html.Contains($ExpectedHook)) "Editor hook must target $BackendOrigin. Run maintain_editor.bat copy first."
    Require ((Sha256 (Join-Path $Dist 'custom-editor.js')) -eq (Sha256 (Join-Path $Runtime 'custom-editor.js'))) `
        'Runtime and browser Manager copies disagree; redeploy runtime.'
    # Honor the reviewed original upstream serve command. Any future change needs review,
    # not a silent switch to a substitute static-serving implementation.
    $UpstreamPkg = Read-Json (Join-Path $Source 'package.json')
    Require ([string]$UpstreamPkg.scripts.serve -ceq 'serve dist -C') `
        "Upstream serve script changed: $([string]$UpstreamPkg.scripts.serve). Review the launcher for this SuperSplat version."
    $ServePackageFile = Join-Path $Source 'node_modules\serve\package.json'
    Require (Test-Path -LiteralPath $ServePackageFile -PathType Leaf) `
        'Upstream serve dependency missing from supersplat/node_modules. Install the upstream environment first.'
    $ServePackage = Read-Json $ServePackageFile
    $Bin = if ($ServePackage.bin -is [string]) { [string]$ServePackage.bin } else { [string]$ServePackage.bin.serve }
    Require (-not [string]::IsNullOrWhiteSpace($Bin)) 'Unable to locate original serve CLI entry.'
    $ServeCli = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $ServePackageFile) $Bin))
    Require ($ServeCli.StartsWith([IO.Path]::GetFullPath((Join-Path $Source 'node_modules\serve')) +
        [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) 'Serve CLI points outside installed upstream serve package.'
    Require (Test-Path -LiteralPath $ServeCli -PathType Leaf) "Original serve CLI missing: $ServeCli"
    # Compatibility parser remains an upstream environment dependency, not a dist asset.
    Require (Test-Path -LiteralPath (Join-Path $Source 'node_modules\typescript\package.json') -PathType Leaf) `
        'TypeScript compatibility-audit dependency missing from upstream environment.'
    $Node = (Get-Command node.exe -ErrorAction Stop).Source
    Assert-NotOccupied $EditorPort
    Assert-NotOccupied $ManagementPort
    New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null
    if (Test-Path -LiteralPath $StateFile -PathType Leaf) {
        $Old = Read-Json $StateFile
        if ((Get-OwnedProcess $Old.editor) -or (Get-OwnedProcess $Old.management)) {
            throw 'A prior Architecture C launch is still running. Stop it before starting another.'
        }
        Remove-Item -LiteralPath $StateFile -Force
    }
    $LogDir = Join-Path $LogRoot ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ'))
    New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
    $Backend = $null
    $Static = $null
    try {
        $Backend = Start-Process -FilePath $Node -WindowStyle Hidden -PassThru -WorkingDirectory $Root `
            -ArgumentList @(('"' + $BackendScript + '"'),'--dist',('"' + $Dist + '"'),'--port',"$ManagementPort",'--editor-origin',$EditorOrigin) `
            -RedirectStandardOutput (Join-Path $LogDir 'management.stdout.log') -RedirectStandardError (Join-Path $LogDir 'management.stderr.log')
        # Original upstream Vercel serve executable from supersplat/node_modules; serve dist.
        # Launched as one known Node PID so Stop BAT can terminate it safely.
        $Static = Start-Process -FilePath $Node -WindowStyle Hidden -PassThru -WorkingDirectory $Source `
            -ArgumentList @(('"' + $ServeCli + '"'),'dist','-C','-l',"tcp://127.0.0.1:$EditorPort",'--no-port-switching') `
            -RedirectStandardOutput (Join-Path $LogDir 'editor.stdout.log') -RedirectStandardError (Join-Path $LogDir 'editor.stderr.log')
        $BackendRecord = Make-Record $Backend $BackendScript "--port $ManagementPort" $Node
        $EditorRecord = Make-Record $Static $ServeCli "tcp://127.0.0.1:$EditorPort" $Node
        $BackendReady = $false
        $EditorReady = $false
        for ($Attempt=0; $Attempt -lt 40; $Attempt++) {
            if ($Backend.HasExited -or $Static.HasExited) { throw 'One or both services exited. Inspect the logged stderr.' }
            if (-not $BackendReady) { $BackendReady = Check-Ready "$BackendOrigin/api/plugins/capabilities" }
            if (-not $EditorReady) { $EditorReady = Check-Ready "$EditorOrigin/" }
            if ($BackendReady -and $EditorReady) { break }
            Start-Sleep -Milliseconds 250
        }
        Require ($BackendReady -and $EditorReady) 'One or both services did not become ready; inspect logs/run_logs.'
        Assert-ListenerOwned $ManagementPort $BackendRecord
        Assert-ListenerOwned $EditorPort $EditorRecord
        $CurrentRecord = [ordered]@{
            schema = 1; root = $Root; editor_port = $EditorPort; management_port = $ManagementPort
            editor = $EditorRecord; management = $BackendRecord; logs = $LogDir
        }
        [IO.File]::WriteAllText($StateFile, (ConvertTo-Json -InputObject $CurrentRecord -Depth 6) + "`n", (New-Object System.Text.UTF8Encoding($false)))
        Write-Host "Editor:     $EditorOrigin/"
        Write-Host "Management: $BackendOrigin/api/plugins/capabilities"
        Write-Host "Logs:       $LogDir"
        Write-Host 'Original upstream serve and independent management backend are running.'
        exit 0
    } catch {
        # Only these two Process objects created by the current invocation are eligible.
        foreach ($Started in @($Static, $Backend)) {
            if ($null -ne $Started) {
                try { if (-not $Started.HasExited) { Stop-Process -Id $Started.Id -Force -ErrorAction Stop } }
                catch { Write-Warning "Cleanup failed for launched process PID $($Started.Id): $_" }
            }
        }
        throw
    }
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
