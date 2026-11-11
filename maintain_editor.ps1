# SuperSplat standalone Editor maintenance (Windows PowerShell 5.1+).
# Manager bootstrap and integrity tests are mandatory; all public/internal API inventories are advisory.
# Version is reported, not pinned. Hard failures block; reviews and warnings are classified.
# Native release artifacts are inventoried before/after deployment; build uses a clean dist with rollback.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('clone', 'build', 'copy')]
    [string]$Operation,
    [string]$ManagementOrigin = $null # e.g. http://127.0.0.1:3014; 'same-origin' restores A
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $Root 'supersplat'
$Dist = Join-Path $Source 'dist'
$External = Join-Path $Root 'plugin-manager\custom-editor.js' # Deployed manager
$PluginValidator = Join-Path $Root 'plugin-manager\validate-plugin-store.cjs'
$EditorApiAuditor = Join-Path $Root 'plugin-manager\audit-editor-api.cjs'
$InternalApiAuditor = Join-Path $Root 'plugin-manager\audit-editor-internals.cjs'
$ManagerContractAuditor = Join-Path $Root 'plugin-manager\audit-manager-contract.cjs'
$InstalledPluginAuditor = Join-Path $Root 'plugin-manager\audit-plugin-store.cjs'
$PluginCompat = Join-Path $Root 'plugin-manager\plugin-compat.cjs'
$ManagerTestsDir = Join-Path $Root 'plugin-manager\tests'
$LocalPluginServer = Join-Path $Root 'plugin-manager\local-server.cjs'
$ManagementServer = Join-Path $Root 'plugin-manager\management-server.cjs'
$ManagementCore = Join-Path $Root 'plugin-manager\management-core.cjs'
$PluginStore = Join-Path $Dist 'plugins'
$ApiInventory = Join-Path $PluginStore 'editor-api.json'
$StampPath = Join-Path $Root '.custom-editor-build-state.json'
$ReferenceVersion = '3.7.0' # Previously audited version, informational comparison only
$RunCommit = 'unknown0'
$CleanBuildPrepared = $false
$CopySnapshot = $null
$PriorDistMoved = $false
$PriorStampSaved = $false
$PriorDistBackup = $null
$PriorStampBackup = $null
if (Test-Path -LiteralPath (Join-Path $Source '.git')) {
    try {
        $HeadForLog = (& git.exe -C $Source rev-parse HEAD 2>$null | Out-String).Trim()
        if ($HeadForLog -match '^[a-fA-F0-9]{40}$') { $RunCommit = $HeadForLog }
    } catch { }
}
$Utc = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')
$LogDir = Join-Path $Root ('logs\' + $Utc + '_' + $RunCommit.Substring(0, 8) + '_' + $Operation)
if (Test-Path -LiteralPath $LogDir) { $LogDir += '_' + ([Guid]::NewGuid().ToString('N').Substring(0, 6)) }
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$Encoding = New-Object System.Text.UTF8Encoding($false)
$Stage = 'initialization'
$Summary = [ordered]@{
    operation = $Operation
    status = 'FAIL'
    started_at_utc = [DateTime]::UtcNow.ToString('o')
    reference_version = $ReferenceVersion
    version_audit = $null
    upgrade_approval = 'NOT_ASSESSED'
    final_report = $null
    gate_decision = $null
    upstream_commit = $null
    upstream_version = $null
    upstream_package_sha256 = $null
    build_contracts = [ordered]@{
        B01 = 'NOT_RUN'; B02 = 'NOT_RUN'; B03 = 'NOT_RUN'; B04 = 'NOT_RUN'; B05 = 'NOT_RUN'
        B06 = 'NOT_RUN'; B07 = 'NOT_RUN'; B08 = 'NOT_RUN'; B09 = 'NOT_RUN'; B10 = 'NOT_RUN'
    }
    browser_runtime = 'NOT_RUN'
    git_origin = $null
    node = $null
    npm = $null
    node_requirement = $null
    build_command = $null
    build_type = 'release'
    base_href = ''
    package_lock_sha256 = $null
    custom_editor_sha256 = $null
    editor_api_inventory = $null
    editor_internal_inventory = $null
    manager_contract = $null
    plugin_compatibility = $null
    manager_test_count = 0
    plugin_store = $null
    maintenance_ps1_sha256 = $null
    steps = [ordered]@{ clone = 'NOT_RUN'; version_audit = 'NOT_RUN'; npm_ci = 'NOT_RUN'; build = 'NOT_RUN'; upstream_test = 'NOT_RUN'; syntax = 'NOT_RUN'; manager_tests = 'NOT_RUN'; reference_tests = 'NOT_RUN'; plugin_validation = 'NOT_RUN'; editor_api_inventory = 'NOT_RUN'; editor_internal_inventory = 'NOT_RUN'; manager_contract = 'NOT_RUN'; plugin_compatibility = 'NOT_RUN'; deploy = 'NOT_RUN' }
    deployment = $null
    native_preservation = 'NOT_RUN'
    clean_dist_build = 'NOT_RUN'
    previous_dist_backup = $null
    recovery = 'NOT_REQUIRED'
    failed_stage = $null
    error = $null
    ended_at_utc = $null
}

function Require([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
function Sha256([string]$Path) {
    Require (Test-Path -LiteralPath $Path -PathType Leaf) "Missing file: $Path"
    $Stream = [IO.File]::OpenRead($Path)
    try {
        $Hasher = [System.Security.Cryptography.SHA256]::Create()
        try { return ([System.BitConverter]::ToString($Hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant() }
        finally { $Hasher.Dispose() }
    }
    finally { $Stream.Dispose() }
}
function ReadJson([string]$Path) {
    Require (Test-Path -LiteralPath $Path -PathType Leaf) "Missing file: $Path"
    return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json)
}
function WriteJson([string]$Path, $Value) {
    [IO.File]::WriteAllText($Path, (ConvertTo-Json -InputObject $Value -Depth 12) + "`n", $script:Encoding)
}
function Logged([string]$Exe, [string]$ArgumentLine, [string]$Cwd, [string]$LogName) {
    # Drain both pipes asynchronously to avoid deadlocks on large npm output.
    $Info = New-Object Diagnostics.ProcessStartInfo
    $Info.FileName = $Exe
    $Info.Arguments = $ArgumentLine
    $Info.WorkingDirectory = $Cwd
    $Info.UseShellExecute = $false
    $Info.CreateNoWindow = $true
    $Info.RedirectStandardOutput = $true
    $Info.RedirectStandardError = $true
    $Process = New-Object Diagnostics.Process
    $Process.StartInfo = $Info
    [void]$Process.Start()
    try {
        $Out = $Process.StandardOutput.ReadToEndAsync()
        $Err = $Process.StandardError.ReadToEndAsync()
        $Process.WaitForExit()
        $Output = "# $Exe $ArgumentLine`r`n# exit=$($Process.ExitCode)`r`n" +
                  "--- stdout ---`r`n$($Out.Result)`r`n--- stderr ---`r`n$($Err.Result)`r`n"
        [IO.File]::AppendAllText((Join-Path $LogDir $LogName), $Output, $script:Encoding)
        Write-Host "  $Exe : exit=$($Process.ExitCode) (see $LogName)"
        return $Process.ExitCode
    }
    finally { $Process.Dispose() }
}
function Git([string[]]$Arguments) {
    $Output = @(& git.exe -C $Source @Arguments 2>&1)
    Require ($LASTEXITCODE -eq 0) "git $($Arguments -join ' ') failed: $($Output -join ' ')"
    return ($Output -join "`n").Trim()
}
function VerifySource {
    $script:Stage = 'source'
    Require (Test-Path -LiteralPath (Join-Path $Source '.git')) 'Missing Git checkout. Run clone.'
    $Origin = Git -Arguments @('remote', 'get-url', 'origin')
    Require ($Origin -match '^(https://github\.com/playcanvas/supersplat(?:\.git)?/?|git@github\.com:playcanvas/supersplat(?:\.git)?)$') "Unexpected origin: $Origin"
    $Head = Git -Arguments @('rev-parse', 'HEAD')
    $Status = Git -Arguments @('status', '--porcelain=v1', '--untracked-files=all')
    Require ([string]::IsNullOrWhiteSpace($Status)) "Upstream checkout has local changes: $Status"
    $PackageFile = Join-Path $Source 'package.json'
    $Package = ReadJson $PackageFile
    Require ([string]$Package.name -eq 'supersplat') "Not an expected SuperSplat package: $($Package.name)"
    $Version = [string]$Package.version
    Require ($Version -match '^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$') "Invalid SuperSplat package version: $Version"
    $Comparison = if ($Version -eq $ReferenceVersion) { 'MATCH' } else { 'DIFFERENT' }
    $script:Summary.upstream_commit = $Head
    $script:Summary.upstream_version = $Version
    $script:Summary.upstream_package_sha256 = Sha256 $PackageFile
    $script:Summary.git_origin = $Origin
    $script:Summary.package_lock_sha256 = Sha256 (Join-Path $Source 'package-lock.json')
    $script:Summary.version_audit = [ordered]@{
        reference_version = $ReferenceVersion
        checkout_version = $Version
        comparison = $Comparison
        git_commit = $Head
        package_json_sha256 = $script:Summary.upstream_package_sha256
        note = 'Version match is informational; dependency screening runs for every build.'
    }
    WriteJson (Join-Path $LogDir 'version-audit.json') $script:Summary.version_audit
    $script:Summary.steps.version_audit = 'PASS'
    $script:Summary.build_contracts.B01 = 'PASS'
    Write-Host "SuperSplat Editor: reference v$ReferenceVersion | checkout v$Version ($Comparison)"
    Write-Host "Git HEAD: $Head"
    return $Package
}
function VerifyToolchain($Package) {
    $script:Stage = 'toolchain'
    $Node = (& node.exe --version 2>&1 | Out-String).Trim()
    Require ($LASTEXITCODE -eq 0) 'Node.js not available.'
    $Npm = (& npm.cmd --version 2>&1 | Out-String).Trim()
    Require ($LASTEXITCODE -eq 0) 'npm not available.'
    $Engine = [string]$Package.engines.node
    Require ($Engine -match '^>=\s*(\d+)\.(\d+)\.(\d+)$') "Review Node engine requirement: $Engine"
    $Minimum = [Version]($Matches[1] + '.' + $Matches[2] + '.' + $Matches[3])
    Require ([Version]($Node.TrimStart('v').Split('-')[0]) -ge $Minimum) "Node $Node does not satisfy $Engine"
    Require (-not [string]::IsNullOrWhiteSpace([string]$Package.scripts.build)) 'Upstream npm build script missing.'
    Require ([string]::IsNullOrWhiteSpace($env:BASE_HREF)) 'BASE_HREF override requires review.'
    Require ([string]::IsNullOrWhiteSpace($env:BUILD_TYPE) -or $env:BUILD_TYPE -eq 'release') 'BUILD_TYPE override requires review.'
    $env:BUILD_TYPE = 'release'
    $env:BASE_HREF = ''
    $script:Summary.node = $Node
    $script:Summary.npm = $Npm
    $script:Summary.node_requirement = $Engine
    $script:Summary.build_command = [string]$Package.scripts.build
    $script:Summary.build_contracts.B02 = 'PASS'
    $script:Summary.build_contracts.B03 = 'PASS'
}
function NativeFiles {
    # Only the HTML bootstrap is a fixed Manager deployment contract.
    # The full upstream output is tracked dynamically by NativeInventory.
    return @('index.html')
}
function NativeHashes {
    $Result = [ordered]@{}
    foreach ($Name in NativeFiles) { $Result[$Name] = Sha256 (Join-Path $Dist $Name) }
    return $Result
}
function NativeInventory {
    # Inventory every upstream file dynamically. Existing legacy managed paths are
    # excluded for stamp compatibility; clean builds explicitly reject collisions.
    # Keep native index.html and all upstream-generated assets in the hash inventory.
    Require (Test-Path -LiteralPath $Dist -PathType Container) 'Native dist directory missing.'
    $Directory = [IO.Path]::GetFullPath($Dist).TrimEnd([char[]]@('\','/'))
    $Inventory = [ordered]@{}
    foreach ($Item in @(Get-ChildItem -LiteralPath $Dist -File -Recurse | Sort-Object FullName)) {
        $Relative = $Item.FullName.Substring($Directory.Length + 1).Replace('\', '/')
        if ($Relative -ceq 'custom-editor.js' -or $Relative.StartsWith('plugins/', [StringComparison]::Ordinal) -or
            $Relative.StartsWith('runtime/', [StringComparison]::Ordinal) -or
            $Relative.StartsWith('node_modules/', [StringComparison]::Ordinal) -or
            $Relative -ceq 'start_architecture_c.ps1' -or $Relative -ceq 'run_supersplatEditor_p3013.bat' -or
            $Relative -ceq 'stop_supersplatEditor_p3013.bat') { continue }
        $Inventory[$Relative] = Sha256 $Item.FullName
    }
    Require ($Inventory.Contains('index.html') -and $Inventory.Count -ge 1) 'Native distribution is missing index.html.'
    return $Inventory
}
function AssertNativeInventory($Expected, $Actual, [bool]$IgnoreHtml, [string]$Context) {
    # Accept [ordered] dictionaries from this run and JSON objects from a stamp.
    $ExpectedHashes = @{}
    if ($Expected -is [System.Collections.IDictionary]) {
        foreach ($Key in $Expected.Keys) { $ExpectedHashes[[string]$Key] = [string]$Expected[$Key] }
    } else {
        foreach ($Prop in $Expected.PSObject.Properties) { $ExpectedHashes[$Prop.Name] = [string]$Prop.Value }
    }
    Require ($ExpectedHashes.Count -eq $Actual.Count) "$Context : native artifact count differs (expected $($ExpectedHashes.Count), found $($Actual.Count))."
    foreach ($Path in $ExpectedHashes.Keys) {
        Require ($Actual.Contains($Path)) "$Context : native artifact missing: $Path"
        if ($IgnoreHtml -and $Path -ceq 'index.html') { continue }
        Require ($ExpectedHashes[$Path] -ceq [string]$Actual[$Path]) "$Context : native artifact changed: $Path"
    }
}
function VerifyBuildStamp {
    $script:Stage = 'build_stamp'
    $Saved = ReadJson $StampPath
    Require ($Saved.upstream_commit -ieq $Summary.upstream_commit) 'Build stamp commit differs; rebuild.'
    Require ($Saved.package_lock_sha256 -eq $Summary.package_lock_sha256) 'Dependencies changed; rebuild.'
    $StampedScript = if ($Saved.build_command) { $Saved.build_command } else { $Saved.build_script }
    Require ($StampedScript -eq $Summary.build_command) 'Build script changed; rebuild.'
    Require ($Saved.build_type -eq 'release' -and $Saved.base_href -eq '') 'Build mode changed; rebuild.'
    Require ($Saved.stamp_schema -eq 4 -and $null -ne $Saved.native_inventory) 'Build stamp requires schema 4 native artifact provenance; run build once before copy.'
    # API reference inventories are advisory. Detect and invalidate stale evidence,
    # but never block an otherwise valid Manager copy on catalog completeness.
    if (Test-Path -LiteralPath $ApiInventory -PathType Leaf) {
        $StaleReason = $null
        try {
            $Reference = ReadJson $ApiInventory
            if ($Reference.commit -ine $Summary.upstream_commit -or $Reference.schema_version -ne 1 -or
                $null -eq $Reference.available_methods) { $StaleReason = 'wrong Editor commit or invalid schema' }
            elseif ($Saved.editor_api_sha256 -and (Sha256 $ApiInventory) -cne [string]$Saved.editor_api_sha256) {
                $StaleReason = 'optional API inventory changed since the prior build'
            }
        } catch { $StaleReason = $_.Exception.Message }
        if ($StaleReason) {
            Write-Warning "Stale optional API inventory discarded: $StaleReason"
            Remove-Item -LiteralPath $ApiInventory -Force -ErrorAction Stop
            $script:Summary.steps.editor_api_inventory = 'NOT_ASSESSED'
        }
    }
    $Now = NativeInventory
    AssertNativeInventory $Saved.native_inventory $Now $false 'Copy stamp verification'
    foreach ($Name in NativeFiles) {
        $Expected = [string]$Saved.native_artifacts.PSObject.Properties[$Name].Value
        Require ($Expected -eq (Sha256 (Join-Path $Dist $Name))) "Dist asset changed: $Name. Rebuild."
    }
    ValidatePluginStore
    $script:Summary.build_contracts.B09 = 'PASS'
}

function PluginInventory([string]$Directory) {
    Require (Test-Path -LiteralPath $Directory -PathType Container) "Missing plugin directory: $Directory"
    $Directory = [IO.Path]::GetFullPath($Directory).TrimEnd([char[]]@('\','/'))
    $Result = [ordered]@{}
    foreach ($File in @(Get-ChildItem -LiteralPath $Directory -File -Recurse | Sort-Object FullName)) {
        $Relative = $File.FullName.Substring($Directory.Length + 1).Replace('\', '/')
        $Result[$Relative] = Sha256 $File.FullName
    }
    Require ($Result.Contains('manifest.json')) 'Plugin store manifest.json missing.'
    return $Result
}
function ValidatePluginStore {
    $script:Stage = 'validate_plugins'
    Require (Test-Path -LiteralPath $PluginValidator -PathType Leaf) "Missing plugin validator: $PluginValidator"
    Require ((Logged 'node.exe' ('"' + $PluginValidator + '" "' + $PluginStore + '"') $Root 'plugins.log') -eq 0) 'Plugin store validation failed.'
    $script:Summary.steps.plugin_validation = 'PASS'
    $script:Summary.plugin_store = [ordered]@{
        directory = 'dist/plugins'
        files = (PluginInventory $PluginStore).Count
        validation = 'PASS'
        model = 'single_authoritative_store'
    }
}
function RestorePluginStore {
    # Called after the native build; the previous dist is a recovery snapshot, not a live registry.
    $script:Stage = 'restore_plugins'
    Require (-not (Test-Path -LiteralPath $PluginStore)) 'Upstream native build now owns plugins/ namespace; review required.'
    $BackupStore = if ($script:PriorDistMoved) { Join-Path $script:PriorDistBackup 'plugins' } else { $null }
    if ($BackupStore -and (Test-Path -LiteralPath $BackupStore -PathType Container)) {
        $Expected = PluginInventory $BackupStore
        Copy-Item -LiteralPath $BackupStore -Destination $PluginStore -Recurse -ErrorAction Stop
        $Actual = PluginInventory $PluginStore
        AssertNativeInventory $Expected $Actual $false 'Plugin store preservation'
        WriteJson (Join-Path $LogDir 'plugins-preserved.json') $Actual
    } else {
        New-Item -ItemType Directory -Path $PluginStore -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path $PluginStore 'manifest.json'), "{`"schema_version`":1,`"plugins`":[]}`n", $script:Encoding)
        WriteJson (Join-Path $LogDir 'plugins-preserved.json') (PluginInventory $PluginStore)
    }
    ValidatePluginStore
}
function AssertCleanNativeNamespaces {
    # Called after an upstream-only clean build, before restoring managed extensions.
    # Changes in upstream output are allowed; collisions with our reserved paths are not.
    foreach ($Name in @('custom-editor.js','plugins','runtime','node_modules',
                        'start_architecture_c.ps1','run_supersplatEditor_p3013.bat',
                        'stop_supersplatEditor_p3013.bat')) {
        Require (-not (Test-Path -LiteralPath (Join-Path $Dist $Name))) `
            "Clean upstream build now owns reserved path '$Name'; stop for namespace review."
    }
}
function RestoreRuntime {
    # A clean upstream build must remain clean. The backend is deployed later from
    # current validated Manager source, never copied from the old distribution.
    $script:Stage = 'runtime_namespace'
    Require (-not (Test-Path -LiteralPath (Join-Path $Dist 'runtime'))) `
        'Upstream native build now owns runtime/ namespace; review required.'
    $script:Summary.steps.runtime_preservation = 'DEPLOY_CURRENT_SOURCE'
}
function PrepareCleanBuild {
    # Keep the previous distribution and stamp intact until a new build is ready.
    # No deletion/reset of the upstream checkout and no second Rollup build.
    $script:Stage = 'prepare_clean_dist'
    $script:PriorDistBackup = Join-Path $LogDir 'previous-dist'
    $script:PriorStampBackup = Join-Path $LogDir 'previous-build-state.json'
    if (Test-Path -LiteralPath $StampPath -PathType Leaf) {
        Copy-Item -LiteralPath $StampPath -Destination $script:PriorStampBackup -ErrorAction Stop
        $script:PriorStampSaved = $true
    }
    if (Test-Path -LiteralPath $Dist) {
        Require (Test-Path -LiteralPath $Dist -PathType Container) 'dist exists but is not a directory.'
        Require (-not (Test-Path -LiteralPath $script:PriorDistBackup)) 'Previous distribution backup path unexpectedly exists.'
        Move-Item -LiteralPath $Dist -Destination $script:PriorDistBackup -ErrorAction Stop
        $script:PriorDistMoved = $true
        $script:Summary.previous_dist_backup = 'previous-dist'
    }
    $script:CleanBuildPrepared = $true
    $script:Summary.clean_dist_build = 'PASS'
}
function RestoreFailedBuild {
    if (-not $script:CleanBuildPrepared) { return }
    $script:Stage = 'restore_previous_dist'
    if (Test-Path -LiteralPath $Dist) {
        Remove-Item -LiteralPath $Dist -Recurse -Force -ErrorAction Stop
    }
    if ($script:PriorDistMoved) {
        Require (Test-Path -LiteralPath $script:PriorDistBackup -PathType Container) 'Prior distribution backup missing during recovery.'
        Move-Item -LiteralPath $script:PriorDistBackup -Destination $Dist -ErrorAction Stop
    }
    if ($script:PriorStampSaved) {
        Copy-Item -LiteralPath $script:PriorStampBackup -Destination $StampPath -Force -ErrorAction Stop
    } elseif (Test-Path -LiteralPath $StampPath) {
        Remove-Item -LiteralPath $StampPath -Force -ErrorAction Stop
    }
    $script:Summary.recovery = if ($script:PriorDistMoved) { 'PREVIOUS_DIST_RESTORED' } else { 'PARTIAL_DIST_REMOVED_NO_PREVIOUS_DIST' }
    $script:Summary.previous_dist_backup = $null
    Write-Host 'Failed candidate output cleared; previous distribution/build stamp restored where available.'
}
function Deploy([bool]$FreshBuild) {
    $script:Stage = 'deploy'
    # Snapshot the COMPLETE native output before injecting/copying anything.
    $Before = NativeInventory
    WriteJson (Join-Path $LogDir 'native-before.json') $Before
    $null = NativeHashes
    $HtmlFile = Join-Path $Dist 'index.html'
    $OriginalHtmlBytes = [IO.File]::ReadAllBytes($HtmlFile)
    $HadBom = $OriginalHtmlBytes.Length -ge 3 -and $OriginalHtmlBytes[0] -eq 239 -and
        $OriginalHtmlBytes[1] -eq 187 -and $OriginalHtmlBytes[2] -eq 191
    $HtmlEncoding = New-Object System.Text.UTF8Encoding($HadBom)
    $OriginalHtml = [IO.File]::ReadAllText($HtmlFile, $HtmlEncoding)
    Require ($OriginalHtml -notmatch '__BASE_HREF__') 'Unresolved HTML base placeholder.'
    # The upstream build owns its JS/CSS entry names. Any HTML bootstrap change
    # is assessed by the mandatory Manager contract audit rather than hard-coded filenames.
    $ValidHook = '(?is)<script\b(?=[^>]*\btype\s*=\s*["'']module["''])(?=[^>]*\bsrc\s*=\s*["'']\./custom-editor\.js["''])[^>]*>\s*</script\s*>'
    $AnyHook = '(?is)<script\b[^>]*\bsrc\s*=\s*["''][^"'']*custom-editor\.js["''][^>]*>'
    $Hooks = [regex]::Matches($OriginalHtml, $ValidHook)
    $ValidCount = $Hooks.Count
    Require ([regex]::Matches($OriginalHtml, $AnyHook).Count -eq $ValidCount) 'Unexpected customization script tag.'
    $BaseHook = '<script type="module" src="./custom-editor.js"></script>'
    $ExistingHook = if ($ValidCount -eq 1) { [string]$Hooks[0].Value } else { $null }
    if ($ExistingHook) {
        # Strictly recognize our own A/C-generated hook, never silently adopt extra attributes.
        $IsA = $ExistingHook -ceq $BaseHook
        $IsC = $ExistingHook -cmatch '^<script type="module" src="\./custom-editor\.js" data-management-origin="http://127\.0\.0\.1:[0-9]{1,5}"></script>$'
        Require ($IsA -or $IsC) 'Existing customization hook differs from the authorized Architecture A/C format.'
    }
    $DesiredHook = $BaseHook
    if ($null -ne $ManagementOrigin -and $ManagementOrigin -ne 'same-origin') {
        $BackendUri = $null
        Require ([Uri]::TryCreate($ManagementOrigin, [UriKind]::Absolute, [ref]$BackendUri)) 'Invalid management origin.'
        Require ($BackendUri.Scheme -ceq 'http' -and $BackendUri.Host -ceq '127.0.0.1' -and
            $BackendUri.Port -ge 1024 -and $BackendUri.Port -le 65535 -and
            $ManagementOrigin -ceq $BackendUri.GetLeftPart([UriPartial]::Authority)) 'Management origin must be http://127.0.0.1:<port>.'
        $DesiredHook = '<script type="module" src="./custom-editor.js" data-management-origin="' + $ManagementOrigin + '"></script>'
    } elseif ($null -eq $ManagementOrigin -and -not $FreshBuild -and $ExistingHook) {
        $DesiredHook = $ExistingHook # ordinary copy preserves the existing architecture
    }
    $HookLine = '    ' + $DesiredHook + "`r`n"
    if ($FreshBuild) {
        Require ($ValidCount -eq 0) 'Fresh native build already includes a customization hook.'
        Require (-not (Test-Path -LiteralPath (Join-Path $Dist 'custom-editor.js'))) 'Native build unexpectedly generated custom-editor.js.'
        Require ([regex]::Matches($OriginalHtml, '(?i)</body\s*>').Count -eq 1) 'HTML closing body tag changed.'
        $NewHtml = [regex]::Replace($OriginalHtml, '(?i)</body\s*>', $HookLine + '</body>')
        [IO.File]::WriteAllText($HtmlFile, $NewHtml, $HtmlEncoding)
    } else {
        Require ($ValidCount -eq 1) 'copy requires exactly one existing module hook; rebuild first.'
        if ($ExistingHook -cne $DesiredHook) {
            $ChangedHtml = $OriginalHtml.Replace($ExistingHook, $DesiredHook)
            Require ($ChangedHtml -cne $OriginalHtml) 'Unable to change the authorized module hook.'
            [IO.File]::WriteAllText($HtmlFile, $ChangedHtml, $HtmlEncoding)
        }
    }
    Copy-Item -LiteralPath $External -Destination (Join-Path $Dist 'custom-editor.js') -Force
    $FinalHtml = [IO.File]::ReadAllText($HtmlFile)
    Require ([regex]::Matches($FinalHtml, $ValidHook).Count -eq 1) 'Customization hook not installed exactly once.'
    Require ([regex]::Matches($FinalHtml, $AnyHook).Count -eq 1) 'Unexpected customization script tag after deployment.'
    Require ($FinalHtml.Contains($DesiredHook)) 'Unexpected module hook configuration after deployment.'
    Require ((Sha256 $External) -eq (Sha256 (Join-Path $Dist 'custom-editor.js'))) 'Custom JS deploy mismatch.'
    if ($FreshBuild) {
        Require ($FinalHtml.Replace($HookLine, '') -ceq $OriginalHtml) 'index.html contains changes beyond the added extension module hook.'
        # Compare the full expected output bytes, preserving any original UTF-8 BOM.
        $ExpectedHtmlBytes = $HtmlEncoding.GetPreamble() + $HtmlEncoding.GetBytes($NewHtml)
        $WrittenHtmlBytes = [IO.File]::ReadAllBytes($HtmlFile)
        Require ($ExpectedHtmlBytes.Length -eq $WrittenHtmlBytes.Length) 'index.html byte length changed unexpectedly.'
        $Hasher = [Security.Cryptography.SHA256]::Create()
        try { $ExpectedHtmlDigest = [BitConverter]::ToString($Hasher.ComputeHash([byte[]]$ExpectedHtmlBytes)).Replace('-', '').ToLowerInvariant() }
        finally { $Hasher.Dispose() }
        Require ($ExpectedHtmlDigest -eq (Sha256 $HtmlFile)) 'index.html bytes differ from the exact expected hook addition.'
    } else {
        $ExpectedCopyHtml = $OriginalHtml.Replace($ExistingHook, $DesiredHook)
        Require ($FinalHtml -ceq $ExpectedCopyHtml) 'copy changed index.html beyond the authorized module hook.'
    }
    $After = NativeInventory
    WriteJson (Join-Path $LogDir 'native-after.json') $After
    AssertNativeInventory $Before $After $true 'Additive-only deployment'
    $script:Summary.native_preservation = 'PASS'
    $script:Summary.deployment = [ordered]@{
        hook_count = 1
        custom_editor_sha256 = Sha256 $External
        native_artifacts = NativeHashes
        native_file_count = $After.Count
        native_files_preserved = $true
        html_only_expected_hook = $true
        inventory_before = 'native-before.json'
        inventory_after = 'native-after.json'
    }
    $script:Summary.steps.deploy = 'PASS'
    $script:Summary.build_contracts.B05 = 'PASS'
    $script:Summary.build_contracts.B06 = 'PASS'
    $script:Summary.build_contracts.B07 = 'PASS'
    $script:Summary.build_contracts.B08 = 'PASS'
    Write-Host "Native preservation: PASS ($($After.Count) files; reserved Manager namespaces excluded from native inventory)."
}

# Embedded, executable gate policy. No new external policy or Markdown input file.
# Technical priority describes impact; severity describes required action.
function AddGateFinding([string]$Id, [string]$Severity, [string]$Priority, [string]$Description) {
    $script:GateFindings.Add([ordered]@{
        id = $Id; severity = $Severity; priority = $Priority; description = $Description
    }) | Out-Null
}
function LogContains([string]$Filename, [string]$Pattern) {
    $File = Join-Path $LogDir $Filename
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
    return [regex]::IsMatch([IO.File]::ReadAllText($File), $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function ReadReferenceJson([string]$Path) {
    try { return ReadJson $Path }
    catch {
        Write-Warning ("Optional reference report unreadable: " + $Path + ' — ' + $_.Exception.Message)
        return $null
    }
}
function EvaluateGateDecision {
    $script:GateFindings = New-Object 'System.Collections.Generic.List[object]'
    # Each failure is blocking; source/API uncertainty is NOT falsely converted into a pass.
    if ($Summary.status -eq 'FAIL') {
        AddGateFinding 'OPERATION_FAILURE' 'HARD_FAIL' 'CRITICAL' ("Stage {0}: {1}" -f $Summary.failed_stage, $Summary.error)
    }
    if ($Summary.operation -eq 'build') {
        $EditorDiff = Join-Path $LogDir 'editor-api-diff.json'
        if (Test-Path -LiteralPath $EditorDiff -PathType Leaf) {
            $Diff = ReadReferenceJson $EditorDiff
            if ($Diff.status -eq 'REVIEW_REQUIRED') {
                AddGateFinding 'EDITOR_API_CHANGED' 'REVIEW_REQUIRED' 'HIGH' 'Typed Editor API paths or signatures changed; review editor-api-diff.json and affected installed plugins.'
            }
        }
        $InternalDiff = Join-Path $LogDir 'editor-internal-diff.json'
        if (Test-Path -LiteralPath $InternalDiff -PathType Leaf) {
            $DiffInternal = ReadReferenceJson $InternalDiff
            if ($DiffInternal.status -eq 'REVIEW_REQUIRED') {
                AddGateFinding 'EDITOR_INTERNAL_CHANGED' 'REVIEW_REQUIRED' 'HIGH' 'Plugin-reachable internal interface declarations changed; inspect editor-internal-diff.json, per-plugin findings and runtime behavior.'
            }
        }
        $PluginReport = Join-Path $LogDir 'plugin-compatibility.json'
        if (Test-Path -LiteralPath $PluginReport -PathType Leaf) {
            $Checks = ReadReferenceJson $PluginReport
            if ($Checks.counts.INCOMPATIBLE -gt 0) {
                AddGateFinding 'INSTALLED_PLUGIN_INCOMPATIBLE' 'REVIEW_REQUIRED' 'HIGH' 'Installed plugins have static API/import findings; activation remains a user/developer decision.'
            }
            if ($Checks.counts.REVIEW_REQUIRED -gt 0) {
                AddGateFinding 'INSTALLED_PLUGIN_REVIEW' 'REVIEW_REQUIRED' 'MEDIUM' 'Installed plugins have internal dependencies; audit is informational.'
            }
            if ($Checks.counts.NOT_ASSESSED -gt 0) {
                AddGateFinding 'INSTALLED_PLUGIN_UNASSESSED' 'REVIEW_REQUIRED' 'MEDIUM' 'Installed plugins lack usable dependency declarations; compatibility is not assessed.'
            }
        }
        foreach ($Id in @('B01','B02','B03','B04','B05','B06','B07','B08','B09')) {
            if ($Summary.status -eq 'PASS' -and $Summary.build_contracts[$Id] -ne 'PASS') {
                AddGateFinding $Id 'HARD_FAIL' 'CRITICAL' ('Required build/deployment contract not PASS: ' + $Summary.build_contracts[$Id])
            }
        }
        if ($Summary.build_contracts.B10 -eq 'REVIEW_REQUIRED') {
            AddGateFinding 'MANAGER_TEST_COVERAGE' 'HARD_FAIL' 'CRITICAL' 'Mandatory Manager tests were not completed.'
        }
        if ($Summary.steps.editor_api_inventory -in @('REVIEW_REQUIRED', 'NOT_AVAILABLE')) {
            AddGateFinding 'EDITOR_API_REFERENCE_UNAVAILABLE' 'REVIEW_REQUIRED' 'MEDIUM' 'Public Editor API inventory is unavailable; developer compatibility evidence is incomplete, but Manager core checks are independent.'
        }
        if ($Summary.steps.editor_internal_inventory -in @('REVIEW_REQUIRED', 'NOT_AVAILABLE')) {
            AddGateFinding 'EDITOR_INTERNAL_REFERENCE_UNAVAILABLE' 'REVIEW_REQUIRED' 'MEDIUM' 'Internal interface inventory is unavailable; this does not block Manager deployment.'
        }
        if ($Summary.steps.plugin_compatibility -in @('REVIEW_REQUIRED', 'NOT_AVAILABLE')) {
            AddGateFinding 'PLUGIN_REFERENCE_UNAVAILABLE' 'INFO' 'NONE' 'Optional installed-plugin compatibility report unavailable.'
        }
        if ($Summary.status -eq 'PASS' -and $Summary.native_preservation -ne 'PASS') {
            AddGateFinding 'NATIVE_PRESERVATION' 'HARD_FAIL' 'CRITICAL' 'Native output preservation check was not completed.'
        }
        if ($Summary.browser_runtime -ne 'PASS') {
            AddGateFinding 'BROWSER_RUNTIME' 'REVIEW_REQUIRED' 'MEDIUM' 'Editor browser startup, Manager bootstrap, static plugin loading and management-backend connectivity require real-browser verification.'
        }
        if (LogContains 'install.log' '(?m)^\s*\d+\s+vulnerabilities?\s*\(') {
            AddGateFinding 'NPM_SECURITY' 'REVIEW_REQUIRED' 'HIGH' 'npm reported security advisories; inspect install.log and triage separately. Do not run npm audit fix automatically.'
        }
        if (LogContains 'install.log' '(?m)install-scripts\s+\d+ packages had install scripts blocked') {
            AddGateFinding 'NPM_BLOCKED_SCRIPTS' 'REVIEW_REQUIRED' 'HIGH' 'Dependency installation scripts were blocked; assess whether these packages are required at runtime.'
        }
        if (LogContains 'install.log' 'ERESOLVE overriding peer dependency') {
            AddGateFinding 'NPM_PEER_DEPENDENCY' 'WARNING' 'MEDIUM' 'npm reported peer-dependency conflicts, but npm ci completed; check install.log.'
        }
        $KnownBuildWarnings = New-Object 'System.Collections.Generic.List[string]'
        if (LogContains 'build.log' 'skipping missing file static/lib') { $KnownBuildWarnings.Add('optional static/lib folder') }
        if (LogContains 'build.log' 'legacy JS API is deprecated') { $KnownBuildWarnings.Add('Sass legacy JS API') }
        if (LogContains 'build.log' 'Circular dependencies') { $KnownBuildWarnings.Add('Rollup circular dependencies') }
        if (LogContains 'build.log' 'has been rewritten to .undefined.') { $KnownBuildWarnings.Add('Rollup top-level this rewrite') }
        if ($KnownBuildWarnings.Count) {
            AddGateFinding 'KNOWN_BUILD_WARNINGS' 'WARNING' 'LOW' ('Known nonblocking build warnings: ' + ($KnownBuildWarnings -join '; ') + '. Verify required generated assets separately.')
        }
        $BuildLog = Join-Path $LogDir 'build.log'
        if (Test-Path -LiteralPath $BuildLog -PathType Leaf) {
            $BuildText = [IO.File]::ReadAllText($BuildLog)
            # Strip ANSI terminal color codes before classifying Rollup warning headings.
            $BuildText = [regex]::Replace($BuildText, '\x1b\[[0-9;]*[A-Za-z]', '')
            $RollupHeaders = [regex]::Matches($BuildText, '\(!\)\s*([^\r\n]+)')
            $Unexpected = @($RollupHeaders | ForEach-Object { $_.Groups[1].Value.Trim() } | Where-Object { $_ -notmatch '^(Circular dependencies|"this" has been rewritten to "undefined")$' } | Select-Object -Unique)
            if ($Unexpected.Count) {
                AddGateFinding 'NEW_BUILD_WARNING' 'REVIEW_REQUIRED' 'MEDIUM' ('Unexpected Rollup warning category: ' + ($Unexpected -join '; '))
            }
        }
    }
    if ($Summary.version_audit -and $Summary.version_audit.comparison -eq 'DIFFERENT') {
        AddGateFinding 'VERSION_CHANGE' 'INFO' 'NONE' 'Checkout package version differs from previously audited v3.7.0. Version alone is not a build blocker.'
    }
    $Counts = [ordered]@{}
    foreach ($Level in @('HARD_FAIL','REVIEW_REQUIRED','WARNING','INFO')) {
        $Counts[$Level] = @($script:GateFindings | Where-Object { $_.severity -eq $Level }).Count
    }
    # Preserve ordinary exit semantics, but fail closed on inconsistent recorded gates.
    if ($Summary.status -eq 'PASS' -and $Counts.HARD_FAIL -gt 0) {
        $script:Summary.status = 'FAIL'
        $script:Summary.failed_stage = 'gate_decision'
        $script:Summary.error = 'Gate decision detected a missing/failed mandatory check.'
    }
    $Release = if ($Summary.status -ne 'PASS') { 'BLOCKED' }
               elseif ($Summary.operation -eq 'build') { 'REVIEW_REQUIRED' }
               else { 'NOT_ASSESSED' }
    $Decision = [ordered]@{
        policy_version = 1
        operation = $Summary.operation
        automated_result = $Summary.status
        release_readiness = $Release
        upgrade_approval = 'NOT_ASSESSED'
        severity_rules = [ordered]@{
            HARD_FAIL = 'Blocks build/deploy: missing required interface, failed command/test, integrity mismatch.'
            REVIEW_REQUIRED = 'Candidate build may continue; must be reviewed or tested before approval.'
            WARNING = 'Nonblocking known warning; retain diagnostic evidence.'
            INFO = 'Provenance/identity only; no gate effect.'
        }
        counts = $Counts
        findings = @($script:GateFindings.ToArray())
    }
    WriteJson (Join-Path $LogDir 'gate-decision.json') $Decision
    $script:Summary.gate_decision = [ordered]@{
        automated_result = $Decision.automated_result
        release_readiness = $Decision.release_readiness
        counts = $Counts
        report_file = 'gate-decision.json'
    }
    Write-Host "Gate decision: BUILD $($Decision.automated_result) | ACCEPTANCE $Release | hard=$($Counts.HARD_FAIL), review=$($Counts.REVIEW_REQUIRED), warning=$($Counts.WARNING)"
}

# Human-readable result of the same checks already recorded in JSON.
# No second auditor and no Markdown input dependency.
function WriteFinalReport {
    $Rows = New-Object 'System.Collections.Generic.List[string]'
    $Rows.Add('# SuperSplat Maintenance - Final Verification Report')
    $Rows.Add('')
    $Rows.Add("- Operation: **$($Summary.operation)**")
    $Rows.Add("- Automated operation result: **$($Summary.status)**")
    $Rows.Add("- Checkout: **v$($Summary.upstream_version)** (reference v$ReferenceVersion)")
    $Rows.Add("- Version comparison: **$(if ($Summary.version_audit) { $Summary.version_audit.comparison } else { 'NOT_RUN' })**")
    $Rows.Add("- Git commit: ``$($Summary.upstream_commit)``")
    $Rows.Add("- Browser Plugin Manager SHA-256: ``$($Summary.custom_editor_sha256)``")
    $Rows.Add('')
    $Rows.Add('## Gate policy and decision')
    $Rows.Add('')
    $Rows.Add('| Severity | Effect |')
    $Rows.Add('|---|---|')
    $Rows.Add('| HARD_FAIL | Stop build/deployment; record failed stage and cause |')
    $Rows.Add('| REVIEW_REQUIRED | Continue candidate build if hard checks pass; verify before approval |')
    $Rows.Add('| WARNING | Continue and record known nonblocking diagnostic |')
    $Rows.Add('| INFO | Provenance only; does not affect gate |')
    $Rows.Add('')
    $Rows.Add('Contract impact priority (CRITICAL / HIGH / MEDIUM) is independent of gate severity. Changed critical internals require urgent review but do not prevent a candidate build when the static gate passes.')
    $DecisionPath = Join-Path $LogDir 'gate-decision.json'
    if (Test-Path -LiteralPath $DecisionPath -PathType Leaf) {
        $Decision = ReadJson $DecisionPath
        $Rows.Add('')
        $Rows.Add("- Build/deploy: **$($Decision.automated_result)**")
        $Rows.Add("- Release readiness: **$($Decision.release_readiness)** (automated PASS is never automatic release approval)")
        $Rows.Add("- Finding counts: **$($Decision.counts.HARD_FAIL) hard failures**, **$($Decision.counts.REVIEW_REQUIRED) reviews**, **$($Decision.counts.WARNING) warnings**, **$($Decision.counts.INFO) informational**")
        foreach ($Level in @('HARD_FAIL','REVIEW_REQUIRED','WARNING','INFO')) {
            $Matches = @($Decision.findings | Where-Object { $_.severity -eq $Level })
            if ($Matches.Count) {
                $Rows.Add('')
                $Rows.Add("### $Level")
                foreach ($Finding in $Matches) {
                    $Rows.Add("- **$($Finding.id)** ($($Finding.priority)): $($Finding.description)")
                }
            }
        }
        $Rows.Add('')
        $Rows.Add('Detailed machine-readable decisions: `gate-decision.json`.')
    } else {
        $Rows.Add('- Gate decision: **NOT_AVAILABLE**')
    }
    $Rows.Add('')
    $Rows.Add('## Editor public and internal API references (advisory)')
    $Rows.Add('')
    $Rows.Add("- Public Editor API inventory: **$($Summary.steps.editor_api_inventory)**")
    if ($Summary.editor_api_inventory) {
        $Rows.Add("- Public methods recorded: **$($Summary.editor_api_inventory.method_count)**; comparison: **$($Summary.editor_api_inventory.change_status)**; report: ``editor-api-inventory.json`` and ``editor-api-diff.json``")
    }
    $Rows.Add("- Internal Editor interface inventory: **$($Summary.steps.editor_internal_inventory)**")
    if ($Summary.editor_internal_inventory) {
        $Rows.Add("- Internal source interfaces recorded: **$($Summary.editor_internal_inventory.interface_count)**, classes: **$($Summary.editor_internal_inventory.class_count)**; comparison: **$($Summary.editor_internal_inventory.change_status)**; report: ``editor-internal-inventory.json`` and ``editor-internal-diff.json``")
    }
    $Rows.Add("- Installed-plugin API/import compatibility screening: **$($Summary.steps.plugin_compatibility)**; report: ``plugin-compatibility.json``")
    if ($Summary.plugin_compatibility) {
        $Rows.Add("- Installed plugins assessed: **$($Summary.plugin_compatibility.installed_count)**; findings remain advisory.")
    }
    $Rows.Add('Source inventories are evidence for developer review, not runtime certification. NO_PREVIOUS_INVENTORY means no valid comparison baseline was available.')
    $Rows.Add('')
    $Rows.Add('## B01-B10 build and deployment verification')
    $BuildPassed = @($Summary.build_contracts.GetEnumerator() | Where-Object { $_.Key -ne 'B10' -and $_.Value -eq 'PASS' }).Count
    $Rows.Add("- B01-B09: **$BuildPassed/9 PASS**; full statuses in ``build-contracts.json``")
    $Rows.Add("- B10 automated tests: **$($Summary.build_contracts.B10)**")
    $Rows.Add("- Build: **$($Summary.steps.build)**; deployment: **$($Summary.steps.deploy)**")
    $Rows.Add("- Upstream test: **$($Summary.steps.upstream_test)**; extension syntax: **$($Summary.steps.syntax)**")
    $Rows.Add("- Mandatory Manager test suites: **$($Summary.manager_test_count)**; status: **$($Summary.steps.manager_tests)**; advisory reference tests: **$($Summary.steps.reference_tests)**")
    $Rows.Add("- Plugin store validation: **$($Summary.steps.plugin_validation)**; single authoritative store: ``dist/plugins/``")
    $Rows.Add("- Plugin Manager mandatory bootstrap contract: **$($Summary.steps.manager_contract)**; independent of API inventory; see ``manager-contract.json``")
    $Rows.Add('')
    $Rows.Add('## Native build preservation')
    $Rows.Add("- Clean native build: **$($Summary.clean_dist_build)**")
    $Rows.Add("- Additive-only deployment: **$($Summary.native_preservation)**")
    if ($Summary.deployment) {
        $Rows.Add("- Native files inventoried: **$($Summary.deployment.native_file_count)** (all chunks, maps, assets)")
        $Rows.Add('- Before/after manifests: `native-before.json`, `native-after.json`')
        $Rows.Add('- HTML change: exact single extension hook only; other native artifacts unchanged')
    }
    if ($Summary.previous_dist_backup) { $Rows.Add("- Previous distribution retained: **$($Summary.previous_dist_backup)** (under this log folder)") }
    $Rows.Add("- Failure recovery: **$($Summary.recovery)**")
    $Rows.Add('')
    $Rows.Add('## Outstanding verification')
    $Rows.Add("- Editor and Manager browser smoke: **$($Summary.browser_runtime)**")
    $Rows.Add("- Upgrade approval: **$($Summary.upgrade_approval)**")
    $Rows.Add('')
    $Rows.Add('An automated build PASS does not establish browser readiness or plugin-specific functional acceptance.')
    $Rows.Add('Inspect install.log and build.log for dependency/build warnings; verify each installed plugin with its own test procedure.')
    if ($Summary.status -eq 'FAIL') {
        $Rows.Add('')
        $Rows.Add('## Failure')
        $Rows.Add("- Stage: **$($Summary.failed_stage)**")
        $Rows.Add("- Reason: $($Summary.error)")
    }
    [IO.File]::WriteAllText((Join-Path $LogDir 'final-report.md'), ($Rows -join "`r`n") + "`r`n", $script:Encoding)
    $script:Summary.final_report = 'final-report.md'
}

try {
    $Summary.maintenance_ps1_sha256 = Sha256 (Join-Path $Root 'maintain_editor.ps1')
    if ($Operation -eq 'clone') {
        $Stage = 'clone'
        if (-not (Test-Path -LiteralPath $Source)) {
            Require ((Logged 'git.exe' ('clone https://github.com/playcanvas/supersplat.git "' + $Source + '"') $Root 'clone.log') -eq 0) 'Clone failed.'
        } else { Write-Host 'Checkout exists; checking without modifying it.' }
        $null = VerifySource
        $Summary.steps.clone = 'PASS'
    } else {
        Require (Test-Path -LiteralPath $External -PathType Leaf) 'Missing plugin-manager/custom-editor.js.'
        Require (Test-Path -LiteralPath $LocalPluginServer -PathType Leaf) 'Missing local plugin-management HTTP server.'
        foreach ($ScriptFile in @($ManagerContractAuditor, $PluginValidator, $LocalPluginServer, $ManagementCore, $ManagementServer)) {
            Require (Test-Path -LiteralPath $ScriptFile -PathType Leaf) "Missing mandatory Manager component: $ScriptFile"
        }
        $Summary.custom_editor_sha256 = Sha256 $External
        $Package = VerifySource
        VerifyToolchain $Package
        if ($Operation -eq 'build') {
            $Stage = 'npm_ci'
            Require ((Logged 'cmd.exe' '/d /s /c "npm ci"' $Source 'install.log') -eq 0) 'npm ci failed.'
            Require ((Logged 'cmd.exe' '/d /s /c "npm ls --depth=0"' $Source 'dependencies.log') -eq 0) 'Installed top-level dependency verification failed.'
            $Summary.steps.npm_ci = 'PASS'
            $Summary.build_contracts.B04 = 'PASS'
            # Manager bootstrap gate: mandatory and independent of reference API discovery.
            $Stage = 'manager_contract'
            $ManagerContractFile = Join-Path $LogDir 'manager-contract.json'
            $ManagerContractArgs = ('"' + $ManagerContractAuditor + '" --source "' + $Source +
                '" --manager "' + $External + '" --output "' + $ManagerContractFile + '"')
            Require ((Logged 'node.exe' $ManagerContractArgs $Root 'manager-contract.log') -eq 0) 'Plugin Manager bootstrap audit failed.'
            $ManagerContractResult = ReadJson $ManagerContractFile
            Require ($ManagerContractResult.status -eq 'PASS_STATIC' -and $ManagerContractResult.inventory_dependency -eq 'NONE') 'Manager bootstrap contract not established independently.'
            $Summary.manager_contract = [ordered]@{ file = 'manager-contract.json'; status = [string]$ManagerContractResult.status }
            $Summary.steps.manager_contract = 'PASS_STATIC'
            # Public/internal inventories are optional developer references.
            # Any generator failure is visible but cannot veto a valid Manager build.
            $Stage = 'editor_api_inventory'
            $ApiOutput = Join-Path $LogDir 'editor-api-inventory.json'
            $ApiDiff = Join-Path $LogDir 'editor-api-diff.json'
            $ApiPrevious = Join-Path $PluginStore 'editor-api.json'
            $ReferenceGenerated = $false
            if (Test-Path -LiteralPath $EditorApiAuditor -PathType Leaf) {
                try {
                    $ApiArgs = ('"' + $EditorApiAuditor + '" --source "' + $Source + '" --commit ' +
                                $Summary.upstream_commit + ' --output "' + $ApiOutput + '" --diff "' + $ApiDiff + '"')
                    if (Test-Path -LiteralPath $ApiPrevious -PathType Leaf) {
                        try {
                            $Previous = ReadJson $ApiPrevious
                            if ($Previous.schema_version -eq 1 -and $null -ne $Previous.available_methods) {
                                $ApiArgs += (' --previous "' + $ApiPrevious + '"')
                            } else { Write-Warning 'Previous public API inventory invalid; diff baseline skipped.' }
                        } catch { Write-Warning 'Previous public API inventory unreadable; diff baseline skipped.' }
                    }
                    Require ((Logged 'node.exe' $ApiArgs $Root 'editor-api.log') -eq 0) 'Public API inventory generation failed.'
                    $TypedApi = ReadJson $ApiOutput
                    Require ($TypedApi.commit -ieq $Summary.upstream_commit -and $TypedApi.schema_version -eq 1 -and
                        $TypedApi.method_count -ge 25) 'Public API inventory incomplete.'
                    $Summary.editor_api_inventory = [ordered]@{ file = 'editor-api-inventory.json'; method_count = $TypedApi.method_count; change_status = (ReadJson $ApiDiff).status }
                    $Summary.steps.editor_api_inventory = 'PASS_STATIC'
                    $ReferenceGenerated = $true
                } catch {
                    $Summary.steps.editor_api_inventory = 'REVIEW_REQUIRED'
                    Write-Warning ("Advisory public API inventory failed: " + $_.Exception.Message)
                    if (Test-Path -LiteralPath $ApiOutput) { Remove-Item -LiteralPath $ApiOutput -Force }
                }
            } else {
                $Summary.steps.editor_api_inventory = 'NOT_AVAILABLE'
                Write-Warning 'Public Editor API inventory generator missing (advisory).'
            }
            $Stage = 'editor_internal_inventory'
            if ($ReferenceGenerated -and (Test-Path -LiteralPath $InternalApiAuditor -PathType Leaf)) {
                try {
                    $InternalOutput = Join-Path $LogDir 'editor-internal-inventory.json'
                    $InternalDiff = Join-Path $LogDir 'editor-internal-diff.json'
                    $InternalArgs = ('"' + $InternalApiAuditor + '" --source "' + $Source + '" --commit ' +
                        $Summary.upstream_commit + ' --output "' + $InternalOutput +
                        '" --combined "' + $ApiOutput + '" --diff "' + $InternalDiff + '"')
                    if (Test-Path -LiteralPath $ApiPrevious -PathType Leaf) {
                        try { $null = ReadJson $ApiPrevious; $InternalArgs += (' --previous "' + $ApiPrevious + '"') }
                        catch { Write-Warning 'Previous internal API baseline unreadable; diff skipped.' }
                    }
                    Require ((Logged 'node.exe' $InternalArgs $Root 'editor-internal.log') -eq 0) 'Internal API inventory generation failed.'
                    $InternalReport = ReadJson $InternalOutput
                    Require ($InternalReport.commit -ieq $Summary.upstream_commit -and
                        $InternalReport.interface_count -gt 0 -and $InternalReport.entry_roots.scene) 'Internal interface inventory incomplete.'
                    $Summary.editor_internal_inventory = [ordered]@{ file = 'editor-internal-inventory.json'; interface_count = $InternalReport.interface_count; class_count = $InternalReport.class_count; change_status = (ReadJson $InternalDiff).status }
                    $Summary.steps.editor_internal_inventory = 'PASS_STATIC'
                } catch {
                    $Summary.steps.editor_internal_inventory = 'REVIEW_REQUIRED'
                    Write-Warning ("Advisory internal interface inventory failed: " + $_.Exception.Message)
                    # Public-only inventory remains valid for reference.
                }
            } else {
                $Summary.steps.editor_internal_inventory = 'NOT_AVAILABLE'
                Write-Warning 'Internal interface inventory unavailable (advisory or missing public catalog).'
            }
            PrepareCleanBuild
            $Stage = 'build'
            $BuildStarted = [DateTime]::UtcNow
            Require ((Logged 'cmd.exe' '/d /s /c "npm run build"' $Source 'build.log') -eq 0) 'npm run build failed.'
            foreach ($File in @('index.html')) {
                $Built = Join-Path $Dist $File
                Require (Test-Path -LiteralPath $Built -PathType Leaf) "Missing output $File"
                Require ((Get-Item -LiteralPath $Built).LastWriteTimeUtc -ge $BuildStarted.AddSeconds(-5)) "Stale output $File; inspect build.log."
            }
            # Record actual upstream output BEFORE restoring or injecting Manager additions.
            AssertCleanNativeNamespaces
            WriteJson (Join-Path $LogDir 'native-clean.json') (NativeInventory)
            $Summary.steps.build = 'PASS'
            # Run only the upstream-declared test script, not arbitrary test/*.mjs files.
            if (-not [string]::IsNullOrWhiteSpace([string]$Package.scripts.test)) {
                $Stage = 'upstream_test'
                Require ((Logged 'cmd.exe' '/d /s /c "npm test"' $Source 'test.log') -eq 0) 'Upstream npm test failed.'
                $Summary.steps.upstream_test = 'PASS'
            }
            AssertCleanNativeNamespaces
            RestorePluginStore
            RestoreRuntime
            # Only build-derived API evidence is refreshed; installed packages and manifest remain authoritative.
            if ($ReferenceGenerated) {
                try {
                    $CurrentReference = ReadJson $ApiOutput
                    Require ($CurrentReference.schema_version -eq 1 -and $CurrentReference.commit -ieq $Summary.upstream_commit -and
                        $null -ne $CurrentReference.available_methods) 'Optional merged API catalog invalid.'
                } catch {
                    $ReferenceGenerated = $false
                    $Summary.steps.editor_api_inventory = 'REVIEW_REQUIRED'
                    Write-Warning ("Generated API catalog discarded rather than published: " + $_.Exception.Message)
                }
            }
            if ($ReferenceGenerated) {
                Copy-Item -LiteralPath $ApiOutput -Destination $ApiInventory -Force -ErrorAction Stop
            } elseif (Test-Path -LiteralPath $ApiInventory -PathType Leaf) {
                Remove-Item -LiteralPath $ApiInventory -Force -ErrorAction Stop
                Write-Warning 'Old API inventory invalidated: current checkout reference inventory unavailable.'
            }
            $Stage = 'plugin_compatibility'
            if ($ReferenceGenerated -and (Test-Path -LiteralPath $InstalledPluginAuditor -PathType Leaf)) {
                try {
                    $PluginReport = Join-Path $LogDir 'plugin-compatibility.json'
                    $PluginArgs = ('"' + $InstalledPluginAuditor + '" --dist "' + $Dist + '" --output "' + $PluginReport + '"')
                    Require ((Logged 'node.exe' $PluginArgs $Root 'plugin-compatibility.log') -eq 0) 'Optional installed-plugin compatibility audit failed.'
                    $CheckedPlugins = ReadJson $PluginReport
                    $Summary.plugin_compatibility = [ordered]@{ file = 'plugin-compatibility.json'; installed_count = $CheckedPlugins.installed_count; counts = $CheckedPlugins.counts }
                    $Summary.steps.plugin_compatibility = 'PASS_STATIC'
                } catch {
                    $Summary.steps.plugin_compatibility = 'REVIEW_REQUIRED'
                    Write-Warning ("Installed-plugin compatibility audit failed (advisory): " + $_.Exception.Message)
                }
            } else {
                $Summary.steps.plugin_compatibility = 'NOT_AVAILABLE'
                Write-Warning 'Installed-plugin compatibility audit unavailable (advisory).'
            }
        } else {
            VerifyBuildStamp
            $Stage = 'manager_contract'
            $ManagerContractFile = Join-Path $LogDir 'manager-contract.json'
            $ManagerContractArgs = ('"' + $ManagerContractAuditor + '" --source "' + $Source +
                '" --manager "' + $External + '" --output "' + $ManagerContractFile + '"')
            Require ((Logged 'node.exe' $ManagerContractArgs $Root 'manager-contract.log') -eq 0) 'Plugin Manager bootstrap audit failed for copy.'
            $ManagerContractResult = ReadJson $ManagerContractFile
            Require ($ManagerContractResult.status -eq 'PASS_STATIC' -and $ManagerContractResult.inventory_dependency -eq 'NONE') 'Manager bootstrap contract failed for copy.'
            $Summary.manager_contract = [ordered]@{ file = 'manager-contract.json'; status = [string]$ManagerContractResult.status }
            $Summary.steps.manager_contract = 'PASS_STATIC'
        }
        $Stage = 'syntax'
        Require ((Logged 'node.exe' ('--check "' + $External + '"') $Root 'test.log') -eq 0) 'Custom JavaScript syntax failed.'
        Require ((Logged 'node.exe' ('--check "' + $LocalPluginServer + '"') $Root 'test.log') -eq 0) 'Local plugin server syntax failed.'
        foreach ($ScriptFile in @($ManagementCore, $ManagementServer)) {
            Require ((Logged 'node.exe' ('--check "' + $ScriptFile + '"') $Root 'test.log') -eq 0) "Management server syntax failed: $ScriptFile"
        }
        foreach ($ScriptFile in @($ManagerContractAuditor, $PluginValidator, (Join-Path $Root 'plugin-manager\typescript-loader.cjs'))) {
            Require (Test-Path -LiteralPath $ScriptFile -PathType Leaf) "Missing mandatory Manager component: $ScriptFile"
            Require ((Logged 'node.exe' ('--check "' + $ScriptFile + '"') $Root 'test.log') -eq 0) "Mandatory Manager script syntax failed: $ScriptFile"
        }
        foreach ($ScriptFile in @($EditorApiAuditor, $InternalApiAuditor, $InstalledPluginAuditor, $PluginCompat)) {
            if (Test-Path -LiteralPath $ScriptFile -PathType Leaf) {
                $OptionalSyntax = Logged 'node.exe' ('--check "' + $ScriptFile + '"') $Root 'test.log'
                if ($OptionalSyntax -ne 0) { Write-Warning "Optional reference auditor syntax failed: $ScriptFile" }
            }
        }
        $Summary.steps.syntax = 'PASS'
        $Stage = 'manager_tests'
        Require (Test-Path -LiteralPath $ManagerTestsDir -PathType Container) 'Missing Manager test directory.'
        $ManagerTestNames = @('test_manager.cjs', 'test_local_server.cjs', 'test_manager_contract.cjs', 'test_management_server.cjs', 'test_dist_runtime_portable.cjs')
        $Summary.manager_test_count = $ManagerTestNames.Count
        foreach ($TestName in $ManagerTestNames) {
            $TestFile = Join-Path $ManagerTestsDir $TestName
            Require (Test-Path -LiteralPath $TestFile -PathType Leaf) "Missing mandatory Manager test: $TestName"
            Require ((Logged 'node.exe' ('"' + $TestFile + '"') $Root 'test.log') -eq 0) "Manager regression test failed: $TestName"
        }
        $Summary.steps.manager_tests = 'PASS'
        $Summary.build_contracts.B10 = 'PASS_AUTOMATED_BROWSER_NOT_RUN'
        if ($Operation -eq 'build') {
            $Stage = 'reference_tests'
            $ReferenceTest = Join-Path $ManagerTestsDir 'test_editor_api_audit.cjs'
            if (Test-Path -LiteralPath $ReferenceTest -PathType Leaf) {
                try {
                    Require ((Logged 'node.exe' ('"' + $ReferenceTest + '"') $Root 'reference-tests.log') -eq 0) 'Advisory reference auditor tests failed.'
                    $Summary.steps.reference_tests = 'PASS'
                } catch {
                    $Summary.steps.reference_tests = 'REVIEW_REQUIRED'
                    Write-Warning ("Advisory reference-auditor tests failed: " + $_.Exception.Message)
                }
            } else {
                $Summary.steps.reference_tests = 'NOT_AVAILABLE'
                Write-Warning 'Reference-auditor tests unavailable (advisory).'
            }
        }
        $Stage = 'validate_plugins'
        ValidatePluginStore
        # Copy can update the injected hook and browser Manager; preserve both until
        # backend deployment succeeds. Build already has full-dist rollback.
        if ($Operation -eq 'copy') {
            $script:CopySnapshot = Join-Path $LogDir 'previous-copy-assets'
            New-Item -ItemType Directory -Path $script:CopySnapshot -Force | Out-Null
            Copy-Item -LiteralPath (Join-Path $Dist 'index.html') -Destination $script:CopySnapshot -ErrorAction Stop
            Copy-Item -LiteralPath (Join-Path $Dist 'custom-editor.js') -Destination $script:CopySnapshot -ErrorAction Stop
        }
        Deploy ($Operation -eq 'build')
        # Rollback to same-origin Architecture A must not require the C backend.
        $DeployedHtml = [IO.File]::ReadAllText((Join-Path $Dist 'index.html'))
        if ($DeployedHtml.Contains('data-management-origin="http://127.0.0.1:')) {
            $Stage = 'runtime_deploy'
            $RuntimeDeployer = Join-Path $Root 'deploy_runtime.ps1'
            Require (Test-Path -LiteralPath $RuntimeDeployer -PathType Leaf) 'Missing deploy_runtime.ps1.'
            $RuntimeArgs = ('-NoProfile -ExecutionPolicy Bypass -File "' + $RuntimeDeployer + '" -EditorPort 3013 -ManagementPort 3014')
            Require ((Logged 'powershell.exe' $RuntimeArgs $Root 'runtime-deploy.log') -eq 0) `
                'Plugin Manager backend deployment failed; inspect runtime-deploy.log.'
            $Summary.steps.runtime_deploy = 'PASS'
        } else {
            $Summary.steps.runtime_deploy = 'NOT_APPLICABLE_SAME_ORIGIN'
        }
        if ($Operation -eq 'copy') {
            $State = ReadJson $StampPath
            $NewHtmlHash = Sha256 (Join-Path $Dist 'index.html')
            $State.native_artifacts.PSObject.Properties['index.html'].Value = $NewHtmlHash
            $State.native_inventory.PSObject.Properties['index.html'].Value = $NewHtmlHash
            WriteJson $StampPath $State
        }
        if ($Operation -eq 'build') {
            $RecordedApiHash = if (Test-Path -LiteralPath $ApiInventory -PathType Leaf) { Sha256 $ApiInventory } else { $null }
            $State = [ordered]@{
                stamp_schema = 4
                upstream_commit = $Summary.upstream_commit
                upstream_version = $Summary.upstream_version
                upgrade_approval = $Summary.upgrade_approval
                package_lock_sha256 = $Summary.package_lock_sha256
                build_command = $Summary.build_command
                build_type = 'release'
                base_href = ''
                native_artifacts = NativeHashes
                native_inventory = NativeInventory
                plugin_manager_sha256 = Sha256 $External
                editor_api_sha256 = $RecordedApiHash
                plugin_store_model = 'dist/plugins'
            }
            WriteJson $StampPath $State
            $Summary.build_contracts.B09 = 'PASS'
        }
    }
    $Summary.status = 'PASS'
} catch {
    $Summary.failed_stage = $Stage
    $Summary.error = $_.Exception.Message
    Write-Host "ERROR [$Stage]: $($Summary.error)" -ForegroundColor Red
} finally {
    $Summary.ended_at_utc = [DateTime]::UtcNow.ToString('o')
    try {
        EvaluateGateDecision
        WriteFinalReport
    } catch {
        # Report generation is part of the requested operation; never claim PASS if missing.
        if ($Summary.status -eq 'PASS') {
            $Summary.status = 'FAIL'
            $Summary.failed_stage = 'final_report'
            $Summary.error = $_.Exception.Message
        }
        Write-Host "ERROR [gate_report]: $($_.Exception.Message)" -ForegroundColor Red
        # Try to replace an obsolete PASS decision after a report failure.
        try { EvaluateGateDecision } catch { }
    }
    if ($Operation -eq 'copy' -and $Summary.status -ne 'PASS' -and $CopySnapshot) {
        try {
            foreach ($Name in @('index.html','custom-editor.js')) {
                $Old = Join-Path $CopySnapshot $Name
                if (Test-Path -LiteralPath $Old -PathType Leaf) {
                    Copy-Item -LiteralPath $Old -Destination (Join-Path $Dist $Name) -Force -ErrorAction Stop
                }
            }
            $Summary.recovery = 'COPY_ASSETS_RESTORED'
        } catch {
            $Summary.recovery = 'COPY_RESTORE_FAILED'
            $Summary.error += " | Copy recovery failed: $($_.Exception.Message)"
        }
        try { WriteFinalReport } catch { }
    }
    if ($Operation -eq 'build' -and $CleanBuildPrepared -and $Summary.status -ne 'PASS') {
        try { RestoreFailedBuild }
        catch {
            $Summary.recovery = 'RESTORE_FAILED'
            $Summary.error += " | Recovery failed: $($_.Exception.Message)"
            Write-Host "ERROR [restore_previous_dist]: $($_.Exception.Message)" -ForegroundColor Red
        }
        try { WriteFinalReport } catch { }
    }
    WriteJson (Join-Path $LogDir 'build-contracts.json') $Summary.build_contracts
    WriteJson (Join-Path $LogDir 'summary.json') $Summary
    Write-Host "Result: $($Summary.status). Logs: $LogDir"
    if ($Summary.final_report) { Write-Host "Final report: $(Join-Path $LogDir $Summary.final_report)" }
}
if ($Summary.status -ne 'PASS') { exit 1 }
exit 0
