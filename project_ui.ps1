# Dot-sourced only by the graphical launcher. No deployment-profile or lifecycle logic.
$script:projectRoot = ''
$script:projectFile = $null
$script:projectData = $null
$script:projectUpdating = $false
$script:projectPrefs = Join-Path $script:root '.editor-launcher-project.json'
function Save-ProjectJson($file,$data) {
    $temp = $file + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temp,($data | ConvertTo-Json -Depth 20),[Text.UTF8Encoding]::new($false))
        if ([IO.File]::Exists($file)) { [IO.File]::Replace($temp,$file,[NullString]::Value) }
        else { [IO.File]::Move($temp,$file) }
    } finally { if ([IO.File]::Exists($temp)) { [IO.File]::Delete($temp) } }
}
function Project-Error($message) {
    Write-OutputLine ('Project: ' + $message)
    [System.Windows.Forms.MessageBox]::Show($script:mainForm,[string]$message,'Project','OK','Warning') | Out-Null
}
function Remember-Project {
    try { Save-ProjectJson $script:projectPrefs @{schema_version=1;root=$script:projectRoot;project=$script:projectFile} }
    catch { Write-OutputLine ('Could not remember last project: ' + $_.Exception.Message) }
}
function Read-Project($file) {
    $obj = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($obj.schema_version -ne 1 -or -not $obj.name -or $obj.auto_restore -isnot [bool] -or $obj.models -isnot [array]) { throw 'Invalid project.json contract.' }
    foreach ($m in $obj.models) { if (-not $m.id -or -not $m.name -or -not $m.path -or -not $m.rotation -or $m.enabled -isnot [bool]) { throw 'Invalid model registration.' } }
    return $obj
}
function Refresh-ProjectModels {
    $script:projectUpdating = $true
    try {
        $script:modelGrid.Rows.Clear()
        $script:autoRestore.Checked = $null -ne $script:projectData -and $script:projectData.auto_restore
        if ($null -ne $script:projectData) {
            foreach ($m in $script:projectData.models) {
                $i = $script:modelGrid.Rows.Add([bool]$m.enabled,[string]$m.name,[string]$m.path,[string]$m.rotation.preset,('{0}, {1}, {2}' -f $m.rotation.x,$m.rotation.y,$m.rotation.z))
                $script:modelGrid.Rows[$i].Tag = [string]$m.id
            }
        }
    } finally { $script:projectUpdating = $false }
    Update-Controls
}
function Set-Project($file) {
    $data = if ($file) { Read-Project $file } else { $null }
    $script:projectFile = $file
    $script:projectData = $data
    Refresh-ProjectModels
    Remember-Project
}
function Reload-Projects($selectedFile) {
    $script:projectUpdating = $true
    try {
        $script:rootBox.Text = $script:projectRoot
        $script:projectCombo.Items.Clear()
        [void]$script:projectCombo.Items.Add('(Standalone)')
        $index = 0
        if ($script:projectRoot -and (Test-Path -LiteralPath $script:projectRoot -PathType Container)) {
            foreach ($dir in (Get-ChildItem -LiteralPath $script:projectRoot -Directory | Sort-Object Name)) {
                if (Test-Path -LiteralPath (Join-Path $dir.FullName 'project.json') -PathType Leaf) {
                    $i = $script:projectCombo.Items.Add($dir.Name)
                    if ((Join-Path $dir.FullName 'project.json') -ieq $selectedFile) { $index = $i }
                }
            }
        }
        $script:projectCombo.SelectedIndex = $index
    } finally { $script:projectUpdating = $false }
    if ($index -eq 0) { Set-Project $null }
    else { Set-Project (Join-Path (Join-Path $script:projectRoot ([string]$script:projectCombo.SelectedItem)) 'project.json') }
}
function Save-CurrentProject {
    if (-not $script:projectFile) { throw 'Select a project first.' }
    Save-ProjectJson $script:projectFile $script:projectData
    Refresh-ProjectModels
    Write-OutputLine ('Project saved: ' + $script:projectData.name)
}
function Project-ModelPath([string]$filename) {
    $base = [IO.Path]::GetDirectoryName($script:projectFile).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    $full = [IO.Path]::GetFullPath($filename)
    if ($full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { return $full.Substring($base.Length).Replace('\','/') }
    return $full
}
function Get-SelectedModel {
    if ($script:modelGrid.SelectedRows.Count -ne 1) { return $null }
    $id = $script:modelGrid.SelectedRows[0].Tag
    return ($script:projectData.models | Where-Object { $_.id -ceq $id } | Select-Object -First 1)
}
function Edit-ProjectModel($model) {
    $dialog = New-Object System.Windows.Forms.Form
    $dialog.Text = 'Model registration'; $dialog.StartPosition = 'CenterParent'; $dialog.FormBorderStyle = 'FixedDialog'
    $dialog.ClientSize = [Drawing.Size]::new(600,239); $dialog.Font=$script:mainForm.Font
    $dialog.MinimizeBox=$false; $dialog.MaximizeBox=$false
    $nameBox = New-Object System.Windows.Forms.TextBox; $nameBox.SetBounds(12,35,576,27)
    $pathBox = New-Object System.Windows.Forms.TextBox; $pathBox.SetBounds(12,90,468,27)
    $browse = New-Button 'Browse...' 484 89 104 29
    $preset = New-Object System.Windows.Forms.ComboBox; $preset.DropDownStyle='DropDownList'; $preset.SetBounds(12,151,190,28)
    [void]$preset.Items.AddRange(@('Editor default','COLMAP','XGRIDS','No rotation','Custom'))
    $keys=@('editor-default','colmap','xgrids','none','custom')
    $angles=@()
    for($i=0;$i -lt 3;$i++) {
        $spin=New-Object System.Windows.Forms.NumericUpDown; $spin.Minimum=-360; $spin.Maximum=360; $spin.DecimalPlaces=3; $spin.Increment=1
        $spin.SetBounds((214+125*$i),151,116,28); $angles+= $spin
        $dialog.Controls.Add((New-Label (@('X (deg)','Y (deg)','Z (deg)')[$i]) (214+125*$i) 128 116 22)); $dialog.Controls.Add($spin)
    }
    $save=New-Button 'Save' 356 193 110 32; $cancel=New-Button 'Cancel' 478 193 110 32; $cancel.DialogResult='Cancel'; $dialog.CancelButton=$cancel
    $dialog.Controls.AddRange(@((New-Label 'Model name' 12 12 576 22),$nameBox,(New-Label 'Model file' 12 67 576 22),$pathBox,$browse,(New-Label 'Import rotation' 12 128 200 22),$preset,$save,$cancel))
    $preset.Add_SelectedIndexChanged({
        $custom=$preset.SelectedIndex -eq 4
        foreach($a in $angles){$a.Enabled=$custom}
        if(-not $custom){$angles[0].Value=0;$angles[1].Value=0;$angles[2].Value=0;if($preset.SelectedIndex -eq 1){$angles[2].Value=180};if($preset.SelectedIndex -eq 2){$angles[0].Value=-90}}
    }.GetNewClosure())
    $browse.Add_Click({
        $picker=New-Object System.Windows.Forms.OpenFileDialog
        try { $picker.Filter='Gaussian splat models|*.ply;*.splat;*.ksplat;*.spz;*.sog'; if($picker.ShowDialog($dialog) -eq 'OK'){$pathBox.Text=$picker.FileName;if(-not $nameBox.Text){$nameBox.Text=[IO.Path]::GetFileName($picker.FileName)}} }
        finally{$picker.Dispose()}
    }.GetNewClosure())
    $preset.SelectedIndex=0
    if($null -ne $model){
        $nameBox.Text=$model.name
        $pathBox.Text=if([IO.Path]::IsPathRooted($model.path)){$model.path}else{Join-Path ([IO.Path]::GetDirectoryName($script:projectFile)) $model.path}
        $preset.SelectedIndex=[Math]::Max(0,[Array]::IndexOf($keys,[string]$model.rotation.preset))
        if($preset.SelectedIndex -eq 4){$angles[0].Value=[decimal]$model.rotation.x;$angles[1].Value=[decimal]$model.rotation.y;$angles[2].Value=[decimal]$model.rotation.z}
    }
    $save.Add_Click({
        if(-not $nameBox.Text.Trim() -or -not $pathBox.Text.Trim() -or $pathBox.Text -notmatch '\.(ply|splat|ksplat|spz|sog)$' -or -not [IO.Path]::IsPathRooted($pathBox.Text) -or -not (Test-Path -LiteralPath $pathBox.Text -PathType Leaf)){
            [System.Windows.Forms.MessageBox]::Show($dialog,'Enter a name and select an existing supported model file.','Model','OK','Warning')|Out-Null;return
        }
        $dialog.DialogResult='OK';$dialog.Close()
    }.GetNewClosure())
    try {
        if($dialog.ShowDialog($script:mainForm) -ne 'OK'){return $null}
        return [pscustomobject]@{id=$(if($model){$model.id}else{[Guid]::NewGuid().ToString('N')});name=$nameBox.Text.Trim();path=(Project-ModelPath $pathBox.Text);enabled=$(if($null -ne $model){[bool]$model.enabled}else{$true});rotation=[pscustomobject]@{preset=$keys[$preset.SelectedIndex];x=[double]$angles[0].Value;y=[double]$angles[1].Value;z=[double]$angles[2].Value}}
    } finally {$dialog.Dispose()}
}
function Update-ProjectControls([bool]$idle) {
    if($null -eq $script:projectPanel){return}
    $script:projectPanel.Enabled=$idle
    $selected=$null -ne $script:projectData
    $script:modelGrid.Enabled=$selected; $script:autoRestore.Enabled=$selected
    $script:addModel.Enabled=$selected; $script:editModel.Enabled=$selected; $script:removeModel.Enabled=$selected
    $script:newProject.Enabled=[bool]$script:projectRoot
}
function New-ProjectPanel {
    $script:projectPanel=New-Object System.Windows.Forms.Panel
    $script:projectPanel.SetBounds(0,0,728,300); $script:projectPanel.Anchor='Top, Left, Right'
    $script:rootBox=New-Object System.Windows.Forms.TextBox; $script:rootBox.ReadOnly=$true; $script:rootBox.SetBounds(0,24,592,28);$script:rootBox.Anchor='Top, Left, Right'
    $rootButton=New-Button 'Browse...' 604 23 124 29;$rootButton.Anchor='Top, Right'
    $script:projectCombo=New-Object System.Windows.Forms.ComboBox; $script:projectCombo.DropDownStyle='DropDownList';$script:projectCombo.SetBounds(0,77,592,28);$script:projectCombo.Anchor='Top, Left, Right'
    $script:newProject=New-Button 'New Project' 604 76 124 29;$script:newProject.Anchor='Top, Right'
    $script:modelGrid=New-Object System.Windows.Forms.DataGridView; $script:modelGrid.SetBounds(0,112,728,122);$script:modelGrid.Anchor='Top, Left, Right';$script:modelGrid.ReadOnly=$false;$script:modelGrid.AllowUserToAddRows=$false;$script:modelGrid.AllowUserToDeleteRows=$false;$script:modelGrid.AllowUserToOrderColumns=$false;$script:modelGrid.RowHeadersVisible=$false;$script:modelGrid.MultiSelect=$false;$script:modelGrid.SelectionMode='FullRowSelect';$script:modelGrid.AutoSizeColumnsMode='None'
    # Only Load is editable. All registration details still use the Edit dialog.
    $loadColumn=New-Object System.Windows.Forms.DataGridViewCheckBoxColumn
    $loadColumn.Name='load';$loadColumn.HeaderText='Load';$loadColumn.Width=56;$loadColumn.ThreeState=$false
    $loadColumn.ValueType=[bool];$loadColumn.ReadOnly=$false;$loadColumn.SortMode='NotSortable'
    $loadColumn.ToolTipText='Load model on restore'
    [void]$script:modelGrid.Columns.Add($loadColumn)
    foreach($col in @(@('name','Model',150),@('path','Path',250),@('preset','Preset',110),@('rotation','X, Y, Z (deg)',150))){$i=$script:modelGrid.Columns.Add($col[0],$col[1]);$script:modelGrid.Columns[$i].Width=$col[2];$script:modelGrid.Columns[$i].SortMode='NotSortable';$script:modelGrid.Columns[$i].ReadOnly=$true}
    # Commit a checkbox click immediately, rather than when the user leaves the row.
    $script:modelGrid.Add_CurrentCellDirtyStateChanged({
        param($sender,$e)
        if(-not $script:projectUpdating -and $sender.Enabled -and $sender.IsCurrentCellDirty -and $null -ne $sender.CurrentCell -and $sender.CurrentCell.OwningColumn.Name -eq 'load'){
            [void]$sender.CommitEdit([System.Windows.Forms.DataGridViewDataErrorContexts]::Commit)
        }
    })
    $script:modelGrid.Add_CellValueChanged({
        param($sender,$e)
        if($script:projectUpdating -or -not $sender.Enabled -or -not $script:projectData -or $e.RowIndex -lt 0 -or $e.ColumnIndex -ne $sender.Columns['load'].Index){return}
        $row=$sender.Rows[$e.RowIndex]
        $model=$script:projectData.models | Where-Object {$_.id -ceq $row.Tag} | Select-Object -First 1
        if($null -eq $model){return}
        $previous=[bool]$model.enabled
        $next=[bool]$row.Cells['load'].Value
        if($previous -eq $next){return}
        try {
            $model.enabled=$next
            # Persist using the existing atomic save; do not rebuild the grid mid-edit.
            Save-ProjectJson $script:projectFile $script:projectData
        } catch {
            $model.enabled=$previous
            $script:projectUpdating=$true
            try {$row.Cells['load'].Value=$previous} finally {$script:projectUpdating=$false}
            Project-Error $_.Exception.Message
            return
        }
        Write-OutputLine ('Project saved: {0}; {1} (Load={2})' -f $script:projectData.name,$model.name,$next)
    })
    $script:addModel=New-Button 'Add Model' 0 239 112 29;$script:editModel=New-Button 'Edit' 120 239 90 29;$script:removeModel=New-Button 'Remove' 218 239 100 29
    $script:autoRestore=New-Object System.Windows.Forms.CheckBox;$script:autoRestore.Text='Automatically restore project models';$script:autoRestore.SetBounds(0,273,550,24)
    $script:projectPanel.Controls.AddRange(@((New-Label 'Project root' 0 0 500 22),$script:rootBox,$rootButton,(New-Label 'Project' 0 54 500 22),$script:projectCombo,$script:newProject,$script:modelGrid,$script:addModel,$script:editModel,$script:removeModel,$script:autoRestore))
    $rootButton.Add_Click({
        $picker=New-Object System.Windows.Forms.FolderBrowserDialog; $picker.ShowNewFolderButton=$true; $picker.Description='Select or create a project root directory'
        try{if($script:projectRoot){$picker.SelectedPath=$script:projectRoot};if($picker.ShowDialog($script:mainForm) -eq 'OK'){$script:projectRoot=$picker.SelectedPath;Reload-Projects $null}}catch{Project-Error $_.Exception.Message}finally{$picker.Dispose()}
    })
    $script:projectCombo.Add_SelectedIndexChanged({
        if($script:projectUpdating){return}
        try {if($script:projectCombo.SelectedIndex -le 0){Set-Project $null}else{Set-Project (Join-Path (Join-Path $script:projectRoot ([string]$script:projectCombo.SelectedItem)) 'project.json')}}catch{Project-Error $_.Exception.Message;Reload-Projects $null}
    })
    $script:newProject.Add_Click({
        try{
            Add-Type -AssemblyName Microsoft.VisualBasic
            $n=[Microsoft.VisualBasic.Interaction]::InputBox('Project name','New Project','').Trim()
            if(-not $n){return};if($n.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $n -in @('.','..') -or $n.EndsWith('.') -or $n -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)'){throw 'Invalid project folder name.'}
            $folder = '{0}_{1}' -f $n,(Get-Date -Format 'yyyyMMdd_HHmmss')
            $dir = Join-Path $script:projectRoot $folder
            $suffix = 1
            while (Test-Path -LiteralPath $dir) {
                $dir = Join-Path $script:projectRoot ('{0}_{1:D2}' -f $folder,$suffix)
                $suffix++
            }
            # No -Force: a concurrently created directory must never be reused.
            [void](New-Item -ItemType Directory -Path $dir -ErrorAction Stop)
            $file=Join-Path $dir 'project.json'
            Save-ProjectJson $file @{schema_version=1;name=$n;auto_restore=$true;models=@()};Reload-Projects $file
        }catch{Project-Error $_.Exception.Message}
    })
    $script:addModel.Add_Click({try{$m=Edit-ProjectModel $null;if($m){$script:projectData.models=@($script:projectData.models)+@($m);Save-CurrentProject}}catch{Project-Error $_.Exception.Message;Set-Project $script:projectFile}})
    $script:editModel.Add_Click({try{$old=Get-SelectedModel;if($old){$m=Edit-ProjectModel $old;if($m){$script:projectData.models=@(foreach($item in $script:projectData.models){if($item.id -ceq $old.id){$m}else{$item}});Save-CurrentProject}}}catch{Project-Error $_.Exception.Message;Set-Project $script:projectFile}})
    $script:removeModel.Add_Click({try{$m=Get-SelectedModel;if($m -and [System.Windows.Forms.MessageBox]::Show($script:mainForm,'Remove registration only? The source file will not be deleted.','Remove Model','YesNo','Question') -eq 'Yes'){$script:projectData.models=@($script:projectData.models|Where-Object{$_.id -cne $m.id});Save-CurrentProject}}catch{Project-Error $_.Exception.Message;Set-Project $script:projectFile}})
    $script:autoRestore.Add_CheckedChanged({if(-not $script:projectUpdating -and $script:projectData){try{$script:projectData.auto_restore=$script:autoRestore.Checked;Save-CurrentProject}catch{Project-Error $_.Exception.Message;Set-Project $script:projectFile}}})
    return $script:projectPanel
}
function Initialize-Projects {
    try {
        $last=$null
        if(Test-Path -LiteralPath $script:projectPrefs){$prefs=Get-Content -LiteralPath $script:projectPrefs -Raw -Encoding UTF8|ConvertFrom-Json;if($prefs.schema_version -eq 1 -and $prefs.root -and (Test-Path -LiteralPath $prefs.root -PathType Container)){$script:projectRoot=[string]$prefs.root;$last=$prefs.project}}
        Reload-Projects $last
    }catch{Project-Error $_.Exception.Message;Reload-Projects $null}
}
