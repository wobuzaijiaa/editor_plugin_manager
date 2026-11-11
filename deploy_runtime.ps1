# Architecture C: deploy only the Plugin Manager backend code to supersplat/dist/runtime.
# Environment packages, operational scripts, logs and runtime state belong OUTSIDE dist.
# Requires a completed validated Editor copy/build; does not install npm packages.
[CmdletBinding()]
param(
    [ValidateRange(1024,65535)][int]$EditorPort = 3013,
    [ValidateRange(1024,65535)][int]$ManagementPort = 3014
)
$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $Root 'supersplat'
$Dist = Join-Path $Source 'dist'
$Manager = Join-Path $Root 'plugin-manager'
$Suffix = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
$Stage = Join-Path $Root ('logs\runtime-staging\' + $Suffix)
$Backup = Join-Path $Root ('logs\runtime-backups\' + $Suffix)
$Dest = Join-Path $Dist 'runtime'
$Utf8 = New-Object System.Text.UTF8Encoding($false)
$BackendFiles = @('management-server.cjs','management-core.cjs','custom-editor.js',
                  'plugin-compat.cjs','typescript-loader.cjs')
function Require([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function RequireFile([string]$File) { Require (Test-Path -LiteralPath $File -PathType Leaf) "Missing required file: $File" }
function Sha256([string]$File) {
    RequireFile $File
    $Stream = [IO.File]::OpenRead($File)
    try {
        $Hasher = [Security.Cryptography.SHA256]::Create()
        try { return [BitConverter]::ToString($Hasher.ComputeHash($Stream)).Replace('-','').ToLowerInvariant() }
        finally { $Hasher.Dispose() }
    } finally { $Stream.Dispose() }
}
function RequirePortIdle([int]$Port) {
    Require (@(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).Count -eq 0) `
        "Port $Port is active. Stop both services before deployment."
}
try {
    Require ($EditorPort -ne $ManagementPort) 'Editor and management ports must be different.'
    RequirePortIdle $EditorPort
    RequirePortIdle $ManagementPort
    RequireFile (Join-Path $Dist 'index.html')
    RequireFile (Join-Path $Dist 'custom-editor.js')
    RequireFile (Join-Path $Dist 'plugins\manifest.json')
    foreach ($Name in $BackendFiles) { RequireFile (Join-Path $Manager $Name) }

    $ExpectedHook = '<script type="module" src="./custom-editor.js" data-management-origin="http://127.0.0.1:' + $ManagementPort + '"></script>'
    Require ([IO.File]::ReadAllText((Join-Path $Dist 'index.html')).Contains($ExpectedHook)) `
        'Editor management-origin hook differs. Run maintain_editor.bat copy with the correct backend port.'
    Require ((Sha256 (Join-Path $Manager 'custom-editor.js')) -eq (Sha256 (Join-Path $Dist 'custom-editor.js'))) `
        'Browser Manager differs from validated source. Run maintain_editor.bat copy first.'

    # Dist must not contain bundled environment dependencies or operating tools.
    # The older packager used these names. Never delete unproven user-owned files.
    foreach ($Legacy in @('node_modules','run_supersplatEditor_p3013.bat',
                          'stop_supersplatEditor_p3013.bat','start_architecture_c.ps1')) {
        $Path = Join-Path $Dist $Legacy
        Require (-not (Test-Path -LiteralPath $Path)) `
            "Legacy/unknown item under dist: $Path. Back it up and classify its ownership before moving it outside dist. Deployment did not delete it."
    }
    # Environment dependencies are installed by upstream npm, never by this packager.
    $ServePkg = Join-Path $Source 'node_modules\serve\package.json'
    $TsPkg = Join-Path $Source 'node_modules\typescript\package.json'
    RequireFile $ServePkg
    RequireFile $TsPkg
    $ServeVersion = [string]((Get-Content -LiteralPath $ServePkg -Raw -Encoding UTF8 | ConvertFrom-Json).version)
    $TsVersion = [string]((Get-Content -LiteralPath $TsPkg -Raw -Encoding UTF8 | ConvertFrom-Json).version)
    Require (-not [string]::IsNullOrWhiteSpace($ServeVersion)) 'Existing serve dependency has no version.'
    Require (-not [string]::IsNullOrWhiteSpace($TsVersion)) 'Existing TypeScript dependency has no version.'

    New-Item -ItemType Directory -Path $Stage -Force | Out-Null
    foreach ($Name in $BackendFiles) {
        Copy-Item -LiteralPath (Join-Path $Manager $Name) -Destination (Join-Path $Stage $Name) -ErrorAction Stop
        Require ((Sha256 (Join-Path $Manager $Name)) -eq (Sha256 (Join-Path $Stage $Name))) `
            "Staging integrity mismatch: $Name"
    }
    # Browser validator copy must be loaded as an ESM module by the CJS backend.
    [IO.File]::WriteAllText((Join-Path $Stage 'package.json'),
        '{"private":true,"type":"module"}' + "`n", $Utf8)
    foreach ($Name in @('management-server.cjs','management-core.cjs','plugin-compat.cjs','typescript-loader.cjs','custom-editor.js')) {
        & node.exe --check (Join-Path $Stage $Name)
        Require ($LASTEXITCODE -eq 0) "Runtime module syntax error: $Name"
    }
    & node.exe -e 'const l=require(process.argv[1]); if(!l.typeScriptFrom(process.argv[2]).createSourceFile) process.exit(2);' `
        (Join-Path $Stage 'typescript-loader.cjs') $Source
    Require ($LASTEXITCODE -eq 0) 'TypeScript compatibility parser cannot resolve from existing SuperSplat environment.'

    if (Test-Path -LiteralPath $Dest) {
        Require (Test-Path -LiteralPath $Dest -PathType Container) 'runtime path is not a directory.'
        $Existing = @(Get-ChildItem -LiteralPath $Dest -Force | Select-Object -ExpandProperty Name)
        foreach ($Item in $Existing) {
            Require ($Item -in ($BackendFiles + @('package.json'))) `
                "Unrecognized file under dist/runtime: $Item. Review before overwriting a non-managed directory."
        }
        RequireFile (Join-Path $Dest 'management-server.cjs')
    }
    $HadPrevious = Test-Path -LiteralPath $Dest
    if ($HadPrevious) {
        New-Item -ItemType Directory -Path (Split-Path -Parent $Backup) -Force | Out-Null
        Move-Item -LiteralPath $Dest -Destination $Backup -ErrorAction Stop
    }
    try {
        Move-Item -LiteralPath $Stage -Destination $Dest -ErrorAction Stop
        foreach ($Name in $BackendFiles) {
            Require ((Sha256 (Join-Path $Dest $Name)) -eq (Sha256 (Join-Path $Manager $Name))) `
                "Installed runtime integrity mismatch: $Name"
        }
    } catch {
        $InstallError = $_
        if (Test-Path -LiteralPath $Dest) { Remove-Item -LiteralPath $Dest -Recurse -Force -ErrorAction Stop }
        if ($HadPrevious) { Move-Item -LiteralPath $Backup -Destination $Dest -ErrorAction Stop }
        throw $InstallError
    }
    Write-Host "Plugin Manager backend installed: $Dest"
    Write-Host "Environment reused: serve $ServeVersion, TypeScript $TsVersion (no npm install or copying)."
    if ($HadPrevious) { Write-Host "Previous backend saved outside HTTP root: $Backup" }
    Write-Warning 'dist/runtime contains backend source, which may be HTTP-readable; no secrets or runtime logs belong there.'
    exit 0
} catch {
    Write-Host "Runtime deployment failed: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if (Test-Path -LiteralPath $Stage) {
        Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue
    }
}
