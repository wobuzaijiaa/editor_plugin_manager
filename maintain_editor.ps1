# SuperSplat standalone Editor maintenance (Windows PowerShell 5.1+).
# Every build screens A01-A18 before compiling; PowerShell owns B01-B10.
# Version is reported, not pinned. Hard failures block; reviews and warnings are classified.
# Native release artifacts are inventoried before/after deployment; build uses a clean dist with rollback.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('clone', 'build', 'copy')]
    [string]$Operation
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $Root 'supersplat'
$Dist = Join-Path $Source 'dist'
$External = Join-Path $Root 'custom-editor_xyz_plugin\external\custom-editor.js'
$TestsDir = Join-Path $Root 'custom-editor_xyz_plugin\tests'
$StampPath = Join-Path $Root '.custom-editor-build-state.json'
$ReferenceVersion = '3.7.0' # Previously audited version, informational comparison only
$AuditScript = Join-Path $Root 'audit_supersplat_contracts.cjs'
$RunCommit = 'unknown0'
$CleanBuildPrepared = $false
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
    prebuild_audit = $null
    final_report = $null
    gate_decision = $null
    upstream_commit = $null
    upstream_version = $null
    upstream_package_sha256 = $null
    api_compatibility = 'NOT_VERIFIED'
    api_source_review = 'NOT_ASSESSED'
    build_contracts = [ordered]@{
        B01 = 'NOT_RUN'; B02 = 'NOT_RUN'; B03 = 'NOT_RUN'; B04 = 'NOT_RUN'; B05 = 'NOT_RUN'
        B06 = 'NOT_RUN'; B07 = 'NOT_RUN'; B08 = 'NOT_RUN'; B09 = 'NOT_RUN'; B10 = 'NOT_RUN'
    }
    browser_runtime = 'NOT_RUN'
    geometric_acceptance = 'NOT_RUN'
    git_origin = $null
    node = $null
    npm = $null
    node_requirement = $null
    build_command = $null
    build_type = 'release'
    base_href = ''
    package_lock_sha256 = $null
    custom_editor_sha256 = $null
    maintenance_ps1_sha256 = $null
    steps = [ordered]@{ clone = 'NOT_RUN'; version_audit = 'NOT_RUN'; prebuild_audit = 'NOT_RUN'; npm_ci = 'NOT_RUN'; build = 'NOT_RUN'; upstream_test = 'NOT_RUN'; syntax = 'NOT_RUN'; custom_tests = 'NOT_RUN'; deploy = 'NOT_RUN' }
    custom_test_count = 0
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
    return @('index.html', 'index.js', 'index.css', 'manifest.json', 'static\lib\webp\webp.wasm')
}
function NativeHashes {
    $Result = [ordered]@{}
    foreach ($Name in NativeFiles) { $Result[$Name] = Sha256 (Join-Path $Dist $Name) }
    return $Result
}
function NativeInventory {
    # Inventory every upstream file, including chunks, source maps and static assets.
    # The external module alone is excluded; index.html is included separately.
    Require (Test-Path -LiteralPath $Dist -PathType Container) 'Native dist directory missing.'
    $Directory = [IO.Path]::GetFullPath($Dist).TrimEnd([char[]]@('\','/'))
    $Inventory = [ordered]@{}
    foreach ($Item in @(Get-ChildItem -LiteralPath $Dist -File -Recurse | Sort-Object FullName)) {
        $Relative = $Item.FullName.Substring($Directory.Length + 1).Replace('\', '/')
        if ($Relative -ceq 'custom-editor.js') { continue }
        $Inventory[$Relative] = Sha256 $Item.FullName
    }
    Require ($Inventory.Count -ge 5) 'Native distribution inventory unexpectedly small.'
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
    Require ($Saved.stamp_schema -eq 2 -and $null -ne $Saved.native_inventory) 'Old build stamp lacks full native inventory; run build once before copy.'
    $Now = NativeInventory
    AssertNativeInventory $Saved.native_inventory $Now $false 'Copy stamp verification'
    foreach ($Name in NativeFiles) {
        $Expected = [string]$Saved.native_artifacts.PSObject.Properties[$Name].Value
        Require ($Expected -eq (Sha256 (Join-Path $Dist $Name))) "Dist asset changed: $Name. Rebuild."
    }
    $script:Summary.build_contracts.B09 = 'PASS'
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
    $Wasm = Join-Path $Source 'node_modules\@playcanvas\splat-transform\lib\webp.wasm'
    Require ((Sha256 $Wasm) -eq (Sha256 (Join-Path $Dist 'static\lib\webp\webp.wasm'))) 'WebP WASM hash mismatch.'
    $HtmlFile = Join-Path $Dist 'index.html'
    $OriginalHtmlBytes = [IO.File]::ReadAllBytes($HtmlFile)
    $HadBom = $OriginalHtmlBytes.Length -ge 3 -and $OriginalHtmlBytes[0] -eq 239 -and
        $OriginalHtmlBytes[1] -eq 187 -and $OriginalHtmlBytes[2] -eq 191
    $HtmlEncoding = New-Object System.Text.UTF8Encoding($HadBom)
    $OriginalHtml = [IO.File]::ReadAllText($HtmlFile, $HtmlEncoding)
    Require ($OriginalHtml -notmatch '__BASE_HREF__') 'Unresolved HTML base placeholder.'
    Require ($OriginalHtml -match '(?is)<script\b[^>]*\bsrc\s*=\s*["'']\./index\.js["'']') 'Native entry script missing.'
    Require ($OriginalHtml -match '(?is)<link\b[^>]*\bhref\s*=\s*["'']\./index\.css["'']') 'Native stylesheet missing.'
    $ValidHook = '(?is)<script\b(?=[^>]*\btype\s*=\s*["'']module["''])(?=[^>]*\bsrc\s*=\s*["'']\./custom-editor\.js["''])[^>]*>\s*</script\s*>'
    $AnyHook = '(?is)<script\b[^>]*\bsrc\s*=\s*["''][^"'']*custom-editor\.js["''][^>]*>'
    $ValidCount = [regex]::Matches($OriginalHtml, $ValidHook).Count
    Require ([regex]::Matches($OriginalHtml, $AnyHook).Count -eq $ValidCount) 'Unexpected customization script tag.'
    $HookLine = "    <script type=`"module`" src=`"./custom-editor.js`"></script>`r`n"
    if ($FreshBuild) {
        Require ($ValidCount -eq 0) 'Fresh native build already includes a customization hook.'
        Require (-not (Test-Path -LiteralPath (Join-Path $Dist 'custom-editor.js'))) 'Native build unexpectedly generated custom-editor.js.'
        Require ([regex]::Matches($OriginalHtml, '(?i)</body\s*>').Count -eq 1) 'HTML closing body tag changed.'
        $NewHtml = [regex]::Replace($OriginalHtml, '(?i)</body\s*>', $HookLine + '</body>')
        [IO.File]::WriteAllText($HtmlFile, $NewHtml, $HtmlEncoding)
    } else {
        Require ($ValidCount -eq 1) 'copy requires exactly one existing module hook; rebuild first.'
    }
    Copy-Item -LiteralPath $External -Destination (Join-Path $Dist 'custom-editor.js') -Force
    $FinalHtml = [IO.File]::ReadAllText($HtmlFile)
    Require ([regex]::Matches($FinalHtml, $ValidHook).Count -eq 1) 'Customization hook not installed exactly once.'
    Require ([regex]::Matches($FinalHtml, $AnyHook).Count -eq 1) 'Unexpected customization script tag after deployment.'
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
        Require ($FinalHtml -ceq $OriginalHtml) 'copy changed native index.html unexpectedly.'
    }
    $After = NativeInventory
    WriteJson (Join-Path $LogDir 'native-after.json') $After
    AssertNativeInventory $Before $After $true 'Additive-only deployment'
    $script:Summary.native_preservation = 'PASS'
    $script:Summary.deployment = [ordered]@{
        hook_count = 1
        custom_editor_sha256 = Sha256 $External
        wasm_sha256 = Sha256 $Wasm
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
    Write-Host "Native preservation: PASS ($($After.Count) files; only the extension HTML hook added)."
}

# Embedded, executable gate policy. No new external policy or Markdown input file.
# Technical priority describes impact; severity describes required action.
function AddGateFinding([string]$Id, [string]$Severity, [string]$Priority, [string]$Description) {
    $script:GateFindings.Add([ordered]@{
        id = $Id; severity = $Severity; priority = $Priority; description = $Description
    }) | Out-Null
}
function ContractPriority([string]$Id) {
    if (@('A01','A02','A03','A04','A07','A08','A09','A11','A12','A13') -contains $Id) { return 'CRITICAL' }
    if (@('A05','A06','A10','A15','A17','A18') -contains $Id) { return 'HIGH' }
    if (@('A14','A16') -contains $Id) { return 'MEDIUM' }
    return 'UNCLASSIFIED'
}
function LogContains([string]$Filename, [string]$Pattern) {
    $File = Join-Path $LogDir $Filename
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $false }
    return [regex]::IsMatch([IO.File]::ReadAllText($File), $Pattern, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
}
function EvaluateGateDecision {
    $script:GateFindings = New-Object 'System.Collections.Generic.List[object]'
    # Each failure is blocking; source/API uncertainty is NOT falsely converted into a pass.
    if ($Summary.status -eq 'FAIL') {
        AddGateFinding 'OPERATION_FAILURE' 'HARD_FAIL' 'CRITICAL' ("Stage {0}: {1}" -f $Summary.failed_stage, $Summary.error)
    }
    if ($Summary.operation -eq 'build') {
        $AuditPath = Join-Path $LogDir 'api-audit.json'
        if (Test-Path -LiteralPath $AuditPath -PathType Leaf) {
            $Audit = ReadJson $AuditPath
            foreach ($Contract in @($Audit.contracts | Where-Object { $null -ne $_ -and $_.id })) {
                $Id = [string]$Contract.id
                if ($Contract.static_status -eq 'FAIL') {
                    AddGateFinding $Id 'HARD_FAIL' (ContractPriority $Id) "Required source/extension markers missing; see api-audit.json."
                } elseif ($Contract.static_status -eq 'NOT_AUTOMATABLE') {
                    AddGateFinding $Id 'REVIEW_REQUIRED' (ContractPriority $Id) 'Cannot establish runtime/browser behavior from static source screening.'
                } elseif ($Contract.static_status -ne 'PASS_STATIC') {
                    AddGateFinding $Id 'REVIEW_REQUIRED' (ContractPriority $Id) "Unrecognized or incomplete static status: $($Contract.static_status)."
                }
            }
            $MissingContractMarkers = @($Audit.contracts | Where-Object { $_.static_status -eq 'FAIL' })
            if ($Audit.gate -eq 'FAIL' -and $MissingContractMarkers.Count -eq 0) {
                AddGateFinding 'AUDIT_GATE' 'HARD_FAIL' 'CRITICAL' ('Static auditor returned FAIL: ' + (@($Audit.errors) -join '; '))
            }
            if ($Audit.review_status -eq 'REVIEW_REQUIRED') {
                $ChangedIds = @($Audit.affected_contracts | ForEach-Object { $_.id })
                $Critical = @($ChangedIds | Where-Object { (ContractPriority $_) -eq 'CRITICAL' })
                $Priority = if ($Critical.Count) { 'CRITICAL' } else { 'HIGH' }
                AddGateFinding 'UPSTREAM_CHANGE' 'REVIEW_REQUIRED' $Priority ('Upstream changes or unavailable reference diff; affected A-contracts: ' + $(if ($ChangedIds.Count) { $ChangedIds -join ', ' } else { 'none or unknown' }) + '. Check signatures and behavior before approval.')
            }
        } else {
            if ($Summary.status -eq 'PASS') {
                AddGateFinding 'AUDIT_MISSING' 'HARD_FAIL' 'CRITICAL' 'A successful build must include its prebuild API audit.'
            }
        }
        foreach ($Id in @('B01','B02','B03','B04','B05','B06','B07','B08','B09')) {
            if ($Summary.status -eq 'PASS' -and $Summary.build_contracts[$Id] -ne 'PASS') {
                AddGateFinding $Id 'HARD_FAIL' 'CRITICAL' ('Required build/deployment contract not PASS: ' + $Summary.build_contracts[$Id])
            }
        }
        if ($Summary.steps.custom_tests -eq 'NOT_AVAILABLE' -or $Summary.build_contracts.B10 -eq 'REVIEW_REQUIRED') {
            AddGateFinding 'B10' 'REVIEW_REQUIRED' 'HIGH' 'Automated regression coverage is incomplete; review before accepting a new version.'
        }
        if ($Summary.status -eq 'PASS' -and $Summary.native_preservation -ne 'PASS') {
            AddGateFinding 'NATIVE_PRESERVATION' 'HARD_FAIL' 'CRITICAL' 'Native output preservation check was not completed.'
        }
        if ($Summary.browser_runtime -ne 'PASS') {
            AddGateFinding 'BROWSER_RUNTIME' 'REVIEW_REQUIRED' 'HIGH' 'Browser/WebGPU behavior, live filtering, mask restoration and snapshots require actual application testing.'
        }
        if ($Summary.geometric_acceptance -ne 'PASS') {
            AddGateFinding 'GEOMETRIC_ACCEPTANCE' 'REVIEW_REQUIRED' 'CRITICAL' 'Filtered export/reimport, nonidentity model transform and downstream reprojection are not yet verified.'
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
    $Rows.Add("- Custom extension SHA-256: ``$($Summary.custom_editor_sha256)``")
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
    $Rows.Add('## A01-A18 API continuity screening')
    $AuditPath = Join-Path $LogDir 'api-audit.json'
    if (Test-Path -LiteralPath $AuditPath -PathType Leaf) {
        $Audit = ReadJson $AuditPath
        $Contracts = @($Audit.contracts | Where-Object { $null -ne $_ -and $_.id })
        $StaticPass = @($Contracts | Where-Object { $_.static_status -eq 'PASS_STATIC' }).Count
        $NotAutomated = @($Contracts | Where-Object { $_.static_status -eq 'NOT_AUTOMATABLE' })
        $StaticFailed = @($Contracts | Where-Object { $_.static_status -eq 'FAIL' })
        $NotAutomatedIds = if ($NotAutomated.Count) { ($NotAutomated | ForEach-Object { $_.id }) -join ', ' } else { 'none' }
        $Rows.Add("- Pre-build static gate: **$($Audit.gate)**")
        $Rows.Add("- Coverage: **$StaticPass PASS_STATIC**, **$($NotAutomated.Count) NOT_AUTOMATABLE**, **$($StaticFailed.Count) FAIL** (out of $($Contracts.Count) contracts)")
        $Rows.Add("- Not automatically checked: **$NotAutomatedIds**")
        $Rows.Add("- Source-change review: **$($Audit.review_status)**; affected contracts: $(@($Audit.affected_contracts).Count)")
        $Rows.Add("- Runtime API compatibility: **$($Audit.api_compatibility)**")
        $Rows.Add("- Details: ``api-audit.json`` and ``audit.log``")
        if ($Summary.operation -eq 'build') {
            Write-Host "Audit coverage: $StaticPass PASS_STATIC, $($NotAutomated.Count) NOT_AUTOMATABLE ($NotAutomatedIds), $($StaticFailed.Count) FAIL; runtime compatibility NOT_VERIFIED"
        }
    } else {
        $Rows.Add('- Static screening: **NOT_RUN** (no api-audit.json generated)')
    }
    $Rows.Add('')
    $Rows.Add('## B01-B10 build and deployment verification')
    $BuildPassed = @($Summary.build_contracts.GetEnumerator() | Where-Object { $_.Key -ne 'B10' -and $_.Value -eq 'PASS' }).Count
    $Rows.Add("- B01-B09: **$BuildPassed/9 PASS**; full statuses in ``build-contracts.json``")
    $Rows.Add("- B10 automated tests: **$($Summary.build_contracts.B10)**")
    $Rows.Add("- Build: **$($Summary.steps.build)**; deployment: **$($Summary.steps.deploy)**")
    $Rows.Add("- Upstream test: **$($Summary.steps.upstream_test)**; extension syntax: **$($Summary.steps.syntax)**")
    $Rows.Add("- Custom test suites: **$($Summary.custom_test_count)**; status: **$($Summary.steps.custom_tests)**")
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
    $Rows.Add("- Browser/WebGPU behavior: **$($Summary.browser_runtime)**")
    $Rows.Add("- Geometric/export/reprojection acceptance: **$($Summary.geometric_acceptance)**")
    $Rows.Add("- Upgrade approval: **$($Summary.upgrade_approval)**")
    $Rows.Add('')
    $Rows.Add('A static gate PASS authorizes a candidate build, not a claim that all A01-A18 runtime contracts are verified.')
    $Rows.Add('Inspect install.log and build.log for nonblocking dependency/build warnings; browser and geometry tests require separate evidence.')
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
        Require (Test-Path -LiteralPath $External -PathType Leaf) 'Missing custom-editor_xyz_plugin/external/custom-editor.js.'
        $Summary.custom_editor_sha256 = Sha256 $External
        $Package = VerifySource
        VerifyToolchain $Package
        if ($Operation -eq 'build') {
            $Stage = 'prebuild_audit'
            Require (Test-Path -LiteralPath $AuditScript -PathType Leaf) "Missing contract auditor: $AuditScript"
            $AuditFile = Join-Path $LogDir 'api-audit.json'
            $AuditArgs = ('"' + $AuditScript + '" --source "' + $Source + '" --extension "' + $External +
                          '" --output "' + $AuditFile + '"')
            $AuditExit = Logged 'node.exe' $AuditArgs $Root 'audit.log'
            Require (Test-Path -LiteralPath $AuditFile -PathType Leaf) 'Audit did not produce api-audit.json.'
            $Report = ReadJson $AuditFile
            $Summary.prebuild_audit = [ordered]@{
                gate = [string]$Report.gate
                review_status = [string]$Report.review_status
                contract_group = [string]$Report.contract_group
                report_file = 'api-audit.json'
                error_count = @($Report.errors).Count
                affected_contract_count = @($Report.affected_contracts).Count
            }
            $Summary.api_source_review = [string]$Report.review_status
            $Summary.steps.prebuild_audit = 'FAIL'
            Require ($Report.target_commit -ieq $Summary.upstream_commit) 'Audit target commit differs from checkout.'
            Require ($Report.custom_editor_sha256 -eq $Summary.custom_editor_sha256) 'Audit custom-editor.js hash mismatch.'
            Require ($Report.package_version -eq $Summary.upstream_version) 'Audit package version mismatch.'
            Require ($Report.contract_group -eq 'A01-A18') 'Audit contract group mismatch.'
            Require (($AuditExit -eq 0) -and ($Report.gate -eq 'PASS')) 'A01-A18 static dependency screening failed; review audit.log.'
            $Summary.steps.prebuild_audit = 'PASS_STATIC'
            Write-Host "A01-A18 static gate: PASS; source review: $($Report.review_status)"
            $Stage = 'npm_ci'
            Require ((Logged 'cmd.exe' '/d /s /c "npm ci"' $Source 'install.log') -eq 0) 'npm ci failed.'
            Require ((Logged 'cmd.exe' '/d /s /c "npm ls --depth=0"' $Source 'dependencies.log') -eq 0) 'Installed top-level dependency verification failed.'
            $Summary.steps.npm_ci = 'PASS'
            $Summary.build_contracts.B04 = 'PASS'
            PrepareCleanBuild
            $Stage = 'build'
            $BuildStarted = [DateTime]::UtcNow
            Require ((Logged 'cmd.exe' '/d /s /c "npm run build"' $Source 'build.log') -eq 0) 'npm run build failed.'
            foreach ($File in @('index.html', 'index.js')) {
                $Built = Join-Path $Dist $File
                Require (Test-Path -LiteralPath $Built -PathType Leaf) "Missing output $File"
                Require ((Get-Item -LiteralPath $Built).LastWriteTimeUtc -ge $BuildStarted.AddSeconds(-5)) "Stale output $File; inspect build.log."
            }
            $Summary.steps.build = 'PASS'
            # Run only the upstream-declared test script, not arbitrary test/*.mjs files.
            if (-not [string]::IsNullOrWhiteSpace([string]$Package.scripts.test)) {
                $Stage = 'upstream_test'
                Require ((Logged 'cmd.exe' '/d /s /c "npm test"' $Source 'test.log') -eq 0) 'Upstream npm test failed.'
                $Summary.steps.upstream_test = 'PASS'
            }
        } else { VerifyBuildStamp }
        $Stage = 'syntax'
        Require ((Logged 'node.exe' ('--check "' + $External + '"') $Root 'test.log') -eq 0) 'Custom JavaScript syntax failed.'
        $Summary.steps.syntax = 'PASS'
        if ($Operation -eq 'build' -and (Test-Path -LiteralPath $TestsDir -PathType Container)) {
            $Stage = 'custom_tests'
            $TestFiles = @(Get-ChildItem -LiteralPath $TestsDir -File -Filter 'test_*.cjs' | Sort-Object Name)
            Require ($TestFiles.Count -gt 0) "No test_*.cjs files found in $TestsDir."
            $Summary.custom_test_count = $TestFiles.Count
            foreach ($TestFile in $TestFiles) {
                Write-Host "  custom test: $($TestFile.Name)"
                Require ((Logged 'node.exe' ('"' + $TestFile.FullName + '"') $Root 'test.log') -eq 0) "Custom regression test failed: $($TestFile.Name)"
            }
            $Summary.steps.custom_tests = 'PASS'
        } elseif ($Operation -eq 'build') {
            $Summary.steps.custom_tests = 'NOT_AVAILABLE'
            Write-Host 'Custom tests directory not present; upgrade acceptance requires regression testing.'
        }
        if ($Operation -eq 'build') {
            $Summary.build_contracts.B10 = if ($Summary.steps.custom_tests -eq 'PASS' -and
                ($Summary.steps.upstream_test -eq 'PASS' -or [string]::IsNullOrWhiteSpace([string]$Package.scripts.test))) {
                'PASS_AUTOMATED_BROWSER_NOT_RUN'
            } else { 'REVIEW_REQUIRED' }
        }
        Deploy ($Operation -eq 'build')
        if ($Operation -eq 'build') {
            $State = [ordered]@{
                stamp_schema = 2
                upstream_commit = $Summary.upstream_commit
                upstream_version = $Summary.upstream_version
                upgrade_approval = $Summary.upgrade_approval
                prebuild_audit = $Summary.steps.prebuild_audit
                package_lock_sha256 = $Summary.package_lock_sha256
                build_command = $Summary.build_command
                build_type = 'release'
                base_href = ''
                native_artifacts = NativeHashes
                native_inventory = NativeInventory
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
