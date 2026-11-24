# Windows PowerShell 5.1. Shared GUI and console entry point for all profiles.
param(
    [ValidateSet('Gui','Start','Stop')][string]$Mode = 'Gui',
    [string]$EditorPort = '',
    [string]$ManagementPort = '',
    [switch]$NoPause
)
$ErrorActionPreference = 'Stop'
$script:root = [IO.Path]::GetFullPath($PSScriptRoot)
$script:configFile = Join-Path $script:root 'launcher_config.json'
$script:helper = Join-Path $script:root 'editor_services.mjs'
function Read-Profile {
    $config = Get-Content -LiteralPath $script:configFile -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($config.schema_version -ne 1 -or [string]::IsNullOrEmpty($config.active_profile)) { throw 'Expected schema_version 1 and a valid active_profile.' }
    $selected = @($config.profiles.PSObject.Properties | Where-Object { $_.Name -ceq $config.active_profile })
    if ($selected.Count -ne 1) { throw 'Active profile not found.' }
    return [pscustomobject]@{ Name = [string]$config.active_profile; Settings = $selected[0].Value }
}
function Resolve-ConfiguredPath([string]$value, [switch]$Executable) {
    if ([string]::IsNullOrWhiteSpace($value)) { throw 'Missing configured path.' }
    $expanded = [Environment]::ExpandEnvironmentVariables($value)
    if ($expanded -match '%[^%]+%') { throw ('Undefined environment variable in path: ' + $value) }
    if ($Executable -and $expanded -notmatch '[\\/]' -and -not [IO.Path]::IsPathRooted($expanded)) {
        foreach ($entry in ($env:PATH -split ';')) {
            $dir = $entry.Trim('"')
            if (-not [IO.Path]::IsPathRooted($dir)) { continue }
            $candidate = Join-Path $dir $expanded
            if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
        }
        throw ('Configured Node executable not found on PATH: ' + $expanded)
    }
    if ([IO.Path]::IsPathRooted($expanded)) { return [IO.Path]::GetFullPath($expanded) }
    return [IO.Path]::GetFullPath((Join-Path $script:root $expanded))
}
function Resolve-Node($settings) {
    $candidate = Resolve-ConfiguredPath $settings.paths.node -Executable
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { throw ('Missing configured Node executable: ' + $candidate) }
    return $candidate
}
function Assert-Profile {
    $current = Read-Profile
    if ($current.Name -cne $script:profile -or ($current.Settings | ConvertTo-Json -Depth 20 -Compress) -cne $script:profileSnapshot -or (Resolve-Node $current.Settings) -ine $script:node) {
        throw 'Active deployment configuration changed. Restore it or close and reopen the launcher after verified Stop.'
    }
}
try {
    $selected = Read-Profile
    $script:profile = $selected.Name
    $script:settings = $selected.Settings
    $script:profileSnapshot = $script:settings | ConvertTo-Json -Depth 20 -Compress
    $script:node = Resolve-Node $script:settings
    if (-not (Test-Path -LiteralPath $script:helper -PathType Leaf)) { throw 'Missing editor_services.mjs' }
    $script:defaultEditor = [int]$script:settings.ports.editor
    $script:defaultManager = [int]$script:settings.ports.management
    if ($script:defaultEditor -lt 1024 -or $script:defaultEditor -gt 65535 -or $script:defaultManager -lt 1024 -or $script:defaultManager -gt 65535 -or $script:defaultEditor -eq $script:defaultManager) { throw 'Invalid profile default ports.' }
    $script:logs = Resolve-ConfiguredPath $script:settings.paths.logs
} catch {
    if ($Mode -eq 'Gui') {
        Add-Type -AssemblyName System.Windows.Forms
        [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Editor Plugin Manager - Error','OK','Error') | Out-Null
    } else {
        [Console]::Error.WriteLine($_.Exception.Message)
        if ($Mode -eq 'Stop' -and -not $NoPause) { Write-Host 'Press any key to close this window.'; & $env:ComSpec /d /c 'pause >nul' }
    }
    exit 1
}
# The BAT wrappers use these console modes. Both resolve Node through the same
# profile code as the GUI; the Node launcher remains the only lifecycle authority.
if ($Mode -ne 'Gui') {
    $result = 1
    $interactiveStop = $false
    Push-Location -LiteralPath $script:root
    try {
        Assert-Profile
        if ($Mode -eq 'Start') {
            if ([string]::IsNullOrEmpty($EditorPort)) { $EditorPort = [string]$script:defaultEditor }
            if ([string]::IsNullOrEmpty($ManagementPort)) { $ManagementPort = [string]$script:defaultManager }
            & $script:node $script:helper start $EditorPort $ManagementPort
            $result = $LASTEXITCODE
            if ($result -eq 0) {
                try { Start-Process ('http://127.0.0.1:{0}/' -f [int]$EditorPort) }
                catch { Write-Warning ('Browser launch failed: ' + $_.Exception.Message) }
                try { Start-Process -FilePath $script:node -ArgumentList @(('"' + $script:helper + '"'),'watch') -WorkingDirectory $script:root -NoNewWindow }
                catch { Write-Warning ('Native monitor could not start: ' + $_.Exception.Message) }
                Write-Host 'Services started. Press any key to stop both, or use stop.bat in another terminal.'
                & $env:ComSpec /d /c 'pause >nul'
                $interactiveStop = $true
                Assert-Profile
                & $script:node $script:helper stop
                $result = $LASTEXITCODE
            }
        } else {
            & $script:node $script:helper stop
            $result = $LASTEXITCODE
        }
    } catch { [Console]::Error.WriteLine($_.Exception.Message); $result = 1 }
    finally { Pop-Location }
    if ($Mode -eq 'Stop' -or $interactiveStop) {
        if ($result -eq 0) { Write-Host 'Stop command completed. See the verified result above.' }
        else { Write-Warning 'Controlled shutdown was not confirmed. Inspect logs.' }
    } elseif ($result -ne 0) { Write-Warning 'Startup failed. Inspect logs.' }
    if (-not $NoPause -and -not $interactiveStop -and ($Mode -eq 'Stop' -or $result -ne 0)) {
        Write-Host 'Press any key to close this window.'
        & $env:ComSpec /d /c 'pause >nul'
    }
    if ($result -ne 0) { exit 1 }; exit 0
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
. (Join-Path $script:root 'project_ui.ps1')
$script:guiLog = Join-Path $script:logs 'launcher_gui.log'
$script:stateFile = Join-Path $script:root '.editor-services.json'
$script:lockFile = Join-Path $script:root '.editor-services.command.lock'
$script:phase = 'Ready'
$script:command = $null
$script:monitor = $null
$script:activePort = $null
$script:ownSession = $false
$script:closeRequested = $false
$script:allowClose = $false
$script:logWarning = $false
$script:projectNotice = ''
$script:projectNoticeLevel = ''

function New-Label($text, $x, $y, $w, $h) {
    $c = New-Object System.Windows.Forms.Label
    $c.Text = $text; $c.SetBounds($x,$y,$w,$h)
    return $c
}
function New-Button($text, $x, $y, $w, $h) {
    $c = New-Object System.Windows.Forms.Button
    $c.Text = $text; $c.SetBounds($x,$y,$w,$h)
    return $c
}
function New-Port($value, $x, $y) {
    $c = New-Object System.Windows.Forms.NumericUpDown
    $c.Minimum = 1024; $c.Maximum = 65535; $c.Value = $value
    $c.SetBounds($x,$y,155,27)
    return $c
}
function Has-Record {
    return ((Test-Path -LiteralPath $script:stateFile) -or (Test-Path -LiteralPath $script:lockFile))
}
function Write-OutputLine([string]$text, [switch]$AlreadyLogged) {
    $line = '[{0}] {1}{2}' -f (Get-Date -Format 'HH:mm:ss'), $text, [Environment]::NewLine
    # Bound in-memory output; keep the complete transcript on disk.
    $selectionStart = $script:output.SelectionStart
    $selectionLength = $script:output.SelectionLength
    if ($script:output.TextLength -gt 180000) {
        $trim = $script:output.TextLength - 120000
        $script:output.Text = $script:output.Text.Substring($trim)
        $selectionLength = [Math]::Max(0,($selectionLength-[Math]::Max(0,($trim-$selectionStart))))
        $selectionStart = [Math]::Max(0,($selectionStart-$trim))
    }
    $script:output.AppendText($line)
    if ($selectionLength -gt 0) {
        $script:output.Select([Math]::Min($selectionStart,$script:output.TextLength),[Math]::Min($selectionLength,($script:output.TextLength-[Math]::Min($selectionStart,$script:output.TextLength))))
    } else {
        $script:output.SelectionStart = $script:output.TextLength
        $script:output.ScrollToCaret()
    }
    if ($AlreadyLogged) { return }
    try {
        [IO.Directory]::CreateDirectory($script:logs) | Out-Null
        [IO.File]::AppendAllText($script:guiLog, $line, [Text.Encoding]::UTF8)
    } catch {
        if (-not $script:logWarning) {
            $script:logWarning = $true
            $script:output.AppendText("WARNING: Cannot write GUI log. Output remains in this window.`r`n")
        }
    }
}
function Update-Controls {
    $busy = $null -ne $script:command
    $idle = ($script:phase -in @('Ready','Stopped','Recovered','No saved session','Start failed','Unresolved')) -and -not $busy -and $null -eq $script:monitor
    $script:startButton.Enabled = $idle
    # Project files must not be mutated while any launcher session/lock is unresolved.
    Update-ProjectControls ($idle -and -not (Has-Record))
    # Explicit Stop is also available for a recordless recovery check, as with the Stop BAT.
    $script:stopButton.Enabled = -not $busy
    $script:servePort.Enabled = $idle
    $script:managerPort.Enabled = $idle
    $script:openButton.Enabled = -not $busy -and $script:phase -eq 'Running' -and $null -ne $script:activePort
    $script:status.Text = 'Status: ' + $script:phase
    $script:status.ForeColor = switch ($script:phase) {
        'Running' { [System.Drawing.Color]::DarkGreen }
        'Unresolved' { [System.Drawing.Color]::Firebrick }
        'Start failed' { [System.Drawing.Color]::Firebrick }
        'Recovered' { [System.Drawing.Color]::DarkOrange }
        default { [System.Drawing.Color]::FromArgb(45,45,45) }
    }
    if ($script:phase -eq 'Ready') { $script:hint.Text = 'Select ports. Start checks availability and existing services.' }
    elseif ($script:phase -eq 'Stopped') { $script:hint.Text = 'Launcher verified process termination and port release.' }
    elseif ($script:phase -eq 'Recovered') { $script:hint.Text = 'Recovery verified, not a graceful shutdown. See Output.' }
    elseif ($script:phase -eq 'No saved session') { $script:hint.Text = 'No saved launch or matching residual reported. Ports not tested.' }
    elseif ($script:phase -eq 'Running') {
        $script:hint.Text = if ($script:projectNotice) { $script:projectNotice } else { 'Launcher Start succeeded. Stop before exiting.' }
    }
    elseif ($script:phase -eq 'Unresolved') { $script:hint.Text = 'Use Stop to verify recovery, or Start to let the launcher check the session.' }
    elseif ($script:phase -eq 'Start failed') { $script:hint.Text = 'Correct the reported error and retry Start, or use Stop to verify cleanup.' }
    else { $script:hint.Text = 'Waiting for the existing launcher to complete...' }
    $script:hint.ForeColor = if ($script:phase -eq 'Running' -and $script:projectNoticeLevel -in @('FAILED','PARTIAL','ERROR')) { [System.Drawing.Color]::Firebrick }
        elseif ($script:phase -eq 'Running' -and $script:projectNoticeLevel -eq 'WARNING') { [System.Drawing.Color]::DarkOrange }
        else { [System.Drawing.Color]::FromArgb(45,45,45) }
}
function Set-Phase([string]$phase) {
    $script:phase = $phase
    Update-Controls
}
function Toggle-Runtime {
    # Expand only vertically. Keep the user's current width and the controls in place.
    $form = $script:mainForm
    $form.SuspendLayout()
    try {
        if ($script:outputExpanded) {
            $script:outputExpanded = $false
            $script:runtimePanel.Visible = $false
            $script:terminalButton.Text = 'Show Output'
            $form.MinimumSize = $script:compactMinimum
            if ($form.WindowState -eq [System.Windows.Forms.FormWindowState]::Normal) {
                $form.ClientSize = [System.Drawing.Size]::new($form.ClientSize.Width,$script:compactHeight)
            }
        } else {
            $script:outputExpanded = $true
            $script:runtimePanel.Visible = $true
            $script:terminalButton.Text = 'Hide Output'
            $form.MinimumSize = [System.Drawing.Size]::new($script:compactMinimum.Width,($script:compactMinimum.Height+150))
            # Let Windows retain its maximized/minimized bounds and restore rectangle.
            if ($form.WindowState -eq [System.Windows.Forms.FormWindowState]::Normal) {
                $screen = [System.Windows.Forms.Screen]::FromControl($form).WorkingArea
                $frameHeight = $form.Height - $form.ClientSize.Height
                $height = [Math]::Max(($script:compactHeight+150),[Math]::Min(($script:compactHeight+270),($screen.Height-$frameHeight)))
                $form.ClientSize = [System.Drawing.Size]::new($form.ClientSize.Width,[Math]::Max($form.ClientSize.Height,$height))
                # A vertically expanded window should not disappear below the taskbar.
                if ($form.Bottom -gt $screen.Bottom) {
                    $form.Top = [Math]::Max($screen.Top,($screen.Bottom-$form.Height))
                }
            }
            $script:output.SelectionStart = $script:output.TextLength
            $script:output.ScrollToCaret()
        }
    } finally { $form.ResumeLayout($true) }
}
function Show-Runtime {
    if (-not $script:outputExpanded) { Toggle-Runtime }
}
function Open-Editor {
    if ($script:phase -ne 'Running' -or $null -eq $script:activePort) { return }
    try {
        $url = 'http://127.0.0.1:{0}/' -f $script:activePort
        $session = Get-Content -LiteralPath $script:stateFile -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($session.project -eq $true) {
            if ($session.projectId -notmatch '^[a-f0-9]{48}$' -or $session.editorPort -ne $script:activePort) { throw 'Invalid project session record.' }
            $url += '__editor_project_' + $session.projectId + '/index.html'
        }
        Start-Process $url
    }
    catch { Write-OutputLine ('Browser launch failed: ' + $_.Exception.Message) }
}

# ReadLineAsync tasks are polled on the WinForms UI thread. No PowerShell
# callbacks execute on the subprocess reader threads. Both streams are drained
# while the command runs, then through EOF before its result is reported.
function New-LauncherProcess([string]$action, [string[]]$ports = @()) {
    Assert-Profile
    if (-not (Test-Path -LiteralPath $script:node -PathType Leaf)) { throw 'Selected Node executable is missing' }
    if (-not (Test-Path -LiteralPath $script:helper -PathType Leaf)) { throw 'Missing editor_services.mjs' }
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $script:node
    $info.WorkingDirectory = $script:root
    $info.Arguments = '"' + $script:helper + '" ' + $action
    if ($ports.Count -gt 0) { $info.Arguments += ' ' + ($ports -join ' ') }
    if ($action -eq 'start' -and $script:projectFile) {
        $info.Arguments += ' --project "' + $script:projectFile + '"'
    }
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    Write-OutputLine ('> ' + $script:node + ' editor_services.mjs ' + $action + ' ' + ($ports -join ' '))
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $info
    try { if (-not $process.Start()) { throw 'Process did not start' } }
    catch { $process.Dispose(); throw }
    $op = [pscustomobject]@{
        Action = $action; Process = $process
        OutTask = $null; ErrTask = $null
        OutDone = $false; ErrDone = $false
        ReadError = $false; StopResult = $null
    }
    foreach ($stream in @('Out','Err')) {
        try {
            if ($stream -eq 'Out') { $op.OutTask = $process.StandardOutput.ReadLineAsync() }
            else { $op.ErrTask = $process.StandardError.ReadLineAsync() }
        } catch {
            $op.ReadError = $true
            $op.($stream + 'Done') = $true
            Write-OutputLine ('Output reader failed: ' + $_.Exception.Message)
        }
    }
    return $op
}
function Read-Stream($op, [string]$kind) {
    $taskName = $kind + 'Task'; $doneName = $kind + 'Done'
    # Limit work per tick so long output cannot monopolize the UI thread.
    for ($i = 0; $i -lt 80 -and -not $op.$doneName; $i++) {
        $task = $op.$taskName
        if (-not $task.IsCompleted) { break }
        try {
            $line = $task.GetAwaiter().GetResult()
            if ($null -eq $line) { $op.$doneName = $true; break }
            # The existing Stop CLI distinguishes graceful completion, recovery,
            # and absence of a saved session. Do not collapse them into one status.
            if ($op.Action -eq 'stop' -and $kind -eq 'Out') {
                switch ($line.Trim()) {
                    'Shutdown verified: owned processes and listening ports released.' { $op.StopResult = 'Stopped' }
                    'Failed session cleared after process and port verification (not a graceful shutdown).' { $op.StopResult = 'Recovered' }
                    'No saved launch or matching supervisor/monitor processes.' { $op.StopResult = 'No saved session' }
                }
            }
            $prefix = if ($kind -eq 'Err') { "[$($op.Action) stderr] " } else { "[$($op.Action)] " }
            if ($line -match '^\[Project(?: notification)?\] (INFO|WARNING|SUCCESS|FAILED|PARTIAL|ERROR): (.*)$') {
                $script:projectNoticeLevel = $Matches[1]
                $script:projectNotice = $Matches[2]
                if ($script:projectNotice.StartsWith('Fallback completed')) { $script:projectNoticeLevel = 'WARNING' }
                if ($script:phase -eq 'Running') { Update-Controls }
                if ($script:projectNoticeLevel -in @('WARNING','FAILED','PARTIAL','ERROR')) { Show-Runtime }
            }
            Write-OutputLine ($prefix + $line) -AlreadyLogged:($line.StartsWith('[Project notification] '))
            if ($kind -eq 'Out') { $op.$taskName = $op.Process.StandardOutput.ReadLineAsync() }
            else { $op.$taskName = $op.Process.StandardError.ReadLineAsync() }
        } catch {
            $op.ReadError = $true; $op.$doneName = $true
            Write-OutputLine ('Output reader failed: ' + $_.Exception.Message)
        }
    }
}
function Pump-Process($op) {
    Read-Stream $op 'Out'
    Read-Stream $op 'Err'
    return ($op.Process.HasExited -and $op.OutDone -and $op.ErrDone)
}
function Start-Editor {
    if ($null -ne $script:command -or $script:phase -notin @('Ready','Stopped','Recovered','No saved session','Start failed','Unresolved') -or $null -ne $script:monitor) { return }
    $ep = [int]$script:servePort.Value; $mp = [int]$script:managerPort.Value
    if ($ep -eq $mp) {
        [System.Windows.Forms.MessageBox]::Show($script:mainForm,'Editor and Management ports must differ.','Editor Plugin Manager','OK','Warning') | Out-Null
        return
    }
    $script:activePort = $ep
    $script:ownSession = $false
    $script:projectNotice = ''; $script:projectNoticeLevel = ''
    Set-Phase 'Starting'
    try { $script:command = New-LauncherProcess 'start' @([string]$ep,[string]$mp) }
    catch {
        Write-OutputLine ('Start could not be invoked: ' + $_.Exception.Message)
        $script:activePort = $null
        $script:closeRequested = $false
        if (Has-Record) { Set-Phase 'Unresolved' } else { Set-Phase 'Start failed' }
        Show-Runtime
    }
    Update-Controls
}
function Stop-Editor {
    if ($null -ne $script:command) { return }
    Set-Phase 'Stopping'
    try { $script:command = New-LauncherProcess 'stop' }
    catch {
        Write-OutputLine ('Stop could not be invoked: ' + $_.Exception.Message)
        $script:closeRequested = $false
        Set-Phase 'Unresolved'; Show-Runtime
    }
    Update-Controls
}
function Complete-Command($op) {
    $code = $op.Process.ExitCode
    Write-OutputLine ("$($op.Action) exited with code $code.")
    $op.Process.Dispose()
    $script:command = $null
    if ($op.Action -eq 'start') {
        if ($code -eq 0 -and (Test-Path -LiteralPath $script:stateFile)) {
            $script:ownSession = $true
            Set-Phase 'Running'
            if ($script:closeRequested) { Stop-Editor; return }
            Open-Editor
            try { $script:monitor = New-LauncherProcess 'watch' }
            catch {
                Write-OutputLine ('WARNING: Native monitoring could not start: ' + $_.Exception.Message)
                Show-Runtime
            }
        } else {
            $script:closeRequested = $false
            # Never adopt or automatically stop another session after rejected Start.
            if (Has-Record -or $code -eq 0) { Set-Phase 'Unresolved' } else { Set-Phase 'Start failed' }
            $script:activePort = $null
            Write-OutputLine 'Startup was not confirmed. Review the output; correct the error or use Stop to verify cleanup.'
            Show-Runtime
        }
    } else {
        if ($code -eq 0 -and -not (Has-Record) -and $null -ne $op.StopResult) {
            $script:ownSession = $false; $script:activePort = $null
            Set-Phase $op.StopResult
            if ($op.StopResult -ne 'Stopped') { Show-Runtime }
            Write-OutputLine ('Stop result: ' + $op.StopResult + '. See launcher output for details.')
        } else {
            $script:closeRequested = $false
            Set-Phase 'Unresolved'
            Write-OutputLine 'Shutdown not confirmed. Review the actual launcher message and retry Stop if requested.'
            Show-Runtime
        }
    }
    Update-Controls
}

# Single control window per distribution root. The Node launcher's existing
# command lock still protects all direct CLI/BAT callers.
$hash = [System.Security.Cryptography.SHA256]::Create()
try { $key = [BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:root.ToUpperInvariant()))).Replace('-','') }
finally { $hash.Dispose() }
$mutex = [System.Threading.Mutex]::new($false, ('Local\EditorPluginManager-' + $key))
$acquired = $false
try {
    try { $acquired = $mutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) {
        [System.Windows.Forms.MessageBox]::Show('The control window is already open for this Editor directory.','Editor Plugin Manager') | Out-Null
        return
    }
    $script:mainForm = New-Object System.Windows.Forms.Form
    $script:mainForm.Text = 'Editor Plugin Manager'
    $script:mainForm.StartPosition = 'CenterScreen'
    $script:mainForm.FormBorderStyle = 'Sizable'
    $script:mainForm.ControlBox = $true
    $script:mainForm.MinimizeBox = $true
    $script:mainForm.MaximizeBox = $true
    $script:mainForm.ShowInTaskbar = $true
    $script:mainForm.Font = [System.Drawing.Font]::new('Segoe UI',10)
    $script:mainForm.AutoScaleMode = 'Font'
    $script:mainForm.Padding = [System.Windows.Forms.Padding]::new(16)
    $script:mainForm.ClientSize = [System.Drawing.Size]::new(760,710)

    # One control area, one optional full-width output area immediately below it.
    $controls = New-Object System.Windows.Forms.Panel
    $controls.Size = [System.Drawing.Size]::new(728,678)
    $controls.Dock = 'Top'
    $heading = New-Label ('Deployment: ' + $script:profile) 0 0 516 24
    $heading.Font = [System.Drawing.Font]::new('Segoe UI',11,[System.Drawing.FontStyle]::Bold)
    $editorLabel = New-Label 'Editor Port' 0 36 240 22
    $managerLabel = New-Label 'Management Port' 260 36 256 22
    $script:servePort = New-Port $script:defaultEditor 0 60
    $script:managerPort = New-Port $script:defaultManager 260 60
    $script:servePort.Width = 190
    $script:managerPort.Width = 190
    $script:servePort.AccessibleName = 'Editor Port'
    $script:managerPort.AccessibleName = 'Management Port'
    $script:startButton = New-Button 'Start' 0 100 156 34
    $script:stopButton = New-Button 'Stop' 166 100 156 34
    $script:openButton = New-Button 'Open Editor' 332 100 184 34
    $script:status = New-Label 'Status: Ready' 0 150 516 26
    $script:status.Font = [System.Drawing.Font]::new('Segoe UI',11,[System.Drawing.FontStyle]::Bold)
    $script:hint = New-Label '' 0 180 516 38
    $script:terminalButton = New-Button 'Show Output' 0 220 156 32
    $logsButton = New-Button 'Open Logs' 396 220 120 32
    $controls.Controls.AddRange(@($heading,$editorLabel,$managerLabel,$script:servePort,$script:managerPort,$script:startButton,$script:stopButton,$script:openButton,$script:status,$script:hint,$script:terminalButton,$logsButton))
    foreach ($label in @($heading,$script:status,$script:hint)) { $label.Anchor = 'Top, Left, Right' }
    foreach ($c in @($controls.Controls)) { $c.Top += 422 }
    $logsButton.Left = 608
    $logsButton.Anchor = 'Top, Right'
    $controls.Controls.Add((New-ProjectPanel))
    $tabs = @($script:servePort,$script:managerPort,$script:startButton,$script:stopButton,$script:openButton,$script:terminalButton,$logsButton)
    for ($i=0; $i -lt $tabs.Count; $i++) { $tabs[$i].TabIndex = $i }

    $script:runtimePanel = New-Object System.Windows.Forms.Panel
    $script:runtimePanel.Dock = 'Fill'
    $script:runtimePanel.Padding = [System.Windows.Forms.Padding]::new(0,8,0,0)
    $script:runtimePanel.Visible = $false
    $script:outputExpanded = $false
    $script:output = New-Object System.Windows.Forms.RichTextBox
    $script:output.Multiline = $true; $script:output.ReadOnly = $true
    $script:output.DetectUrls = $false
    $script:output.WordWrap = $true; $script:output.ScrollBars = 'ForcedVertical'
    $script:output.Dock = 'Fill'; $script:output.MaxLength = 0
    $script:output.BackColor = [System.Drawing.Color]::FromArgb(24,24,24)
    $script:output.ForeColor = [System.Drawing.Color]::Gainsboro
    $script:output.Font = [System.Drawing.Font]::new('Consolas',10)
    $script:output.AccessibleName = 'Runtime Output'
    # The read-only RichTextBox supports text selection and Ctrl+C.
    $script:output.Add_KeyDown({ param($sender,$e)
        if ($e.Control -and $e.KeyCode -eq [System.Windows.Forms.Keys]::A) {
            $sender.SelectAll(); $e.SuppressKeyPress = $true
        }
    })
    $script:runtimePanel.Controls.Add($script:output)
    # Dock the top controls first (reverse z-order), then fill the remaining height.
    $script:mainForm.Controls.Add($script:runtimePanel)
    $script:mainForm.Controls.Add($controls)
    $script:compactHeight = $script:mainForm.ClientSize.Height
    $script:compactMinimum = $script:mainForm.Size
    $script:mainForm.MinimumSize = $script:compactMinimum
    $script:startButton.Add_Click({ Start-Editor })
    $script:stopButton.Add_Click({ Stop-Editor })
    $script:openButton.Add_Click({ Open-Editor })
    $script:terminalButton.Add_Click({ Toggle-Runtime })
    $logsButton.Add_Click({
        try { [IO.Directory]::CreateDirectory($script:logs) | Out-Null; Start-Process -FilePath $script:logs }
        catch { Write-OutputLine ('Cannot open logs: ' + $_.Exception.Message) }
    })
    $script:mainForm.Add_Shown({
        # Account for the actual initial client dimensions after display scaling.
        $script:compactHeight = $script:mainForm.ClientSize.Height
        $script:compactMinimum = $script:mainForm.Size
        $script:mainForm.MinimumSize = $script:compactMinimum
    })
    $script:mainForm.Add_FormClosing({ param($sender,$e)
        if ($script:allowClose) { return }
        if ($null -ne $script:command) {
            $e.Cancel = $true; $script:closeRequested = $true
            Write-OutputLine 'Close requested; waiting for the current launcher command.'
        } elseif ($script:ownSession) {
            $e.Cancel = $true; $script:closeRequested = $true
            Stop-Editor
        } elseif ($script:phase -eq 'Unresolved' -or (Has-Record)) {
            $result = [System.Windows.Forms.MessageBox]::Show($script:mainForm,'Shutdown has not been verified. Services may still be running. Close the control window without resolving this session?','Editor Plugin Manager','YesNo','Warning','Button2')
            if ($result -ne [System.Windows.Forms.DialogResult]::Yes) { $e.Cancel = $true }
        }
    })
    $script:timer = New-Object System.Windows.Forms.Timer
    $script:timer.Interval = 100
    $script:timer.Add_Tick({
        try {
            if ($null -ne $script:monitor -and (Pump-Process $script:monitor)) {
                $code = $script:monitor.Process.ExitCode
                $script:monitor.Process.Dispose(); $script:monitor = $null
                Write-OutputLine "Native monitor exited with code $code."
                if ($script:phase -eq 'Running') {
                    Write-OutputLine 'Native monitoring ended; this does not establish service shutdown.'
                    Show-Runtime
                }
            }
            if ($null -ne $script:command -and (Pump-Process $script:command)) {
                # A successful Stop already verified process termination. Drain the
                # monitor's remaining captured output before enabling restart/close.
                if ($script:command.Action -ne 'stop' -or $script:command.Process.ExitCode -ne 0 -or $null -eq $script:monitor) {
                    Complete-Command $script:command
                }
            }
            if ($null -eq $script:command) {
                if (($script:phase -in @('Ready','Stopped','Recovered','No saved session','Start failed')) -and (Has-Record)) {
                    Write-OutputLine 'An external or unresolved session is present. Start and Stop will check it.'
                    Set-Phase 'Unresolved'; Show-Runtime
                } elseif ($script:phase -eq 'Running' -and -not (Test-Path -LiteralPath $script:stateFile)) {
                    Write-OutputLine 'Launcher session record disappeared. Stop can check residuals; Start can check availability.'
                    $script:ownSession = $false; $script:activePort = $null
                    Set-Phase 'Unresolved'; Show-Runtime
                }
                if ($script:closeRequested -and ($script:phase -in @('Ready','Stopped','Recovered','No saved session')) -and $null -eq $script:monitor) {
                    $script:allowClose = $true; $script:mainForm.Close(); return
                }
            }
            Update-Controls
        } catch {
            Write-OutputLine ('GUI error: ' + $_.Exception.Message)
            $script:closeRequested = $false
            Set-Phase 'Unresolved'; Show-Runtime
        }
    })
    Write-OutputLine ('Deployment root: ' + $script:root)
    Write-OutputLine ('Deployment profile: ' + $script:profile)
    Write-OutputLine ('Node: ' + $script:node)
    if ($script:settings.policies.management_origin -eq 'validate') { Write-OutputLine 'Management port must match the deployed Manager origin (validate policy).' }
    Initialize-Projects
    Write-OutputLine 'Ready to use the shared launcher.'
    if (Has-Record) {
        Write-OutputLine 'Existing session or command lock detected. Start and Stop will check it; no automatic adoption.'
        Set-Phase 'Unresolved'
    } else { Update-Controls }
    $script:timer.Start()
    [System.Windows.Forms.Application]::Run($script:mainForm)
} catch {
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message,'Editor Plugin Manager - Error','OK','Error') | Out-Null
} finally {
    if ($null -ne $script:timer) { $script:timer.Stop(); $script:timer.Dispose() }
    # Dispose handles only; never terminate a launcher or service from the GUI.
    foreach ($op in @($script:command,$script:monitor)) { if ($null -ne $op) { $op.Process.Dispose() } }
    if ($null -ne $script:mainForm) { $script:mainForm.Dispose() }
    if ($acquired) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
