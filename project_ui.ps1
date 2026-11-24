# Dot-sourced by the original WinForms launcher. No service or deployment-profile logic.
$script:projectRoot = ''
$script:projectFile = $null
$script:projectData = $null
$script:projectUpdating = $false
$script:projectPaths = @($null)
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
function Project-Now { return ([DateTime]::UtcNow).ToString('yyyy-MM-ddTHH:mm:ss.fffZ',[Globalization.CultureInfo]::InvariantCulture) }
function Project-Name($data) { if ($data.schema_version -eq 2) { return [string]$data.project_name }; return [string]$data.name }
function Model-Name($model) { if ($model.PSObject.Properties.Name -contains 'model_name') { return [string]$model.model_name }; return [string]$model.name }
function Project-Directory { if (-not $script:projectFile) { throw 'No current project.' }; return [IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($script:projectFile)) }
function Project-AbsoluteModelPath($file,$model) {
    $source=[string]$model.path
    if([IO.Path]::IsPathRooted($source)){return [IO.Path]::GetFullPath($source)}
    return [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetDirectoryName($file)) $source))
}
function Assert-ProjectRegularDirectory($directory) {
    $item=Get-Item -LiteralPath $directory -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw ('Unsafe project-managed directory: ' + $directory) }
}
function Assert-ProjectTreeRegular($directory) {
    Assert-ProjectRegularDirectory $directory
    foreach($item in (Get-ChildItem -LiteralPath $directory -Force -ErrorAction Stop)) {
        if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw ('Reparse point in model directory: ' + $item.FullName)}
        if($item.PSIsContainer){Assert-ProjectTreeRegular $item.FullName}
    }
}
function Get-ManagedModelDirectory($model,$file) {
    # Migrated v1 references remain external even if their path resembles the new layout.
    if($model.PSObject.Properties.Name -contains 'legacy_external' -and $model.legacy_external -eq $true){return $null}
    # Only this exact ID-folder convention conveys deletion ownership.
    $s=([string]$model.path).Replace('\','/')
    if($s -notmatch '^models/([a-f0-9]{32})/([^/]+)$' -or $Matches[1] -cne [string]$model.id -or $Matches[2] -in @('.','..')) { return $null }
    $base=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($file))
    $models=Join-Path $base 'models'
    $dir=Join-Path $models ([string]$model.id)
    if(Test-Path -LiteralPath $models){Assert-ProjectRegularDirectory $models}
    if(Test-Path -LiteralPath $dir){Assert-ProjectRegularDirectory $dir}
    return $dir
}
# The root registry owns project discovery; project.json owns project metadata.
# Launcher preferences only remember the selected root and current manifest.
function Root-RegistryFile {
    if(-not $script:projectRoot){throw 'Select a project root first.'}
    $root=[IO.Path]::GetFullPath($script:projectRoot)
    Assert-ProjectRegularDirectory $root
    return (Join-Path $root 'project_root.json')
}
function Assert-RegisteredFolderName([string]$folder) {
    if([string]::IsNullOrWhiteSpace($folder) -or $folder -ne $folder.Trim() -or
       $folder -in @('.','..') -or $folder.EndsWith('.') -or
       $folder.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or
       $folder -match '[\\/:]' -or $folder -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') {
        throw ('Invalid registered project folder: ' + $folder)
    }
}
function Registered-ProjectDirectory([string]$folder) {
    Assert-RegisteredFolderName $folder
    $root=[IO.Path]::GetFullPath($script:projectRoot)
    $project=[IO.Path]::GetFullPath((Join-Path $root $folder))
    if(-not [string]::Equals([IO.Path]::GetDirectoryName($project).TrimEnd([char[]]'\/'),$root.TrimEnd([char[]]'\/'),[StringComparison]::OrdinalIgnoreCase)){
        throw 'Registered project path escapes its root.'
    }
    return $project
}
function Read-RootRegistry {
    $file=Root-RegistryFile
    if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'project_root.json is missing; import or initialize the root first.'}
    $item=Get-Item -LiteralPath $file -Force
    if($item.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unsafe root registry link.'}
    $data=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if($data.schema_version -ne 1 -or $data.projects -isnot [array]){throw 'Invalid project_root.json schema.'}
    $ids=@{};$folders=@{}
    foreach($entry in $data.projects){
        $id=[string]$entry.project_id;$folder=[string]$entry.folder
        if($id -cnotmatch '^[a-f0-9]{32}$'){throw 'Invalid registered project ID.'}
        Assert-RegisteredFolderName $folder
        if($ids.ContainsKey($id) -or $folders.ContainsKey($folder)){throw 'Duplicate project ID or folder in project_root.json.'}
        $ids[$id]=$true;$folders[$folder]=$true
    }
    return $data
}
function Save-RootRegistry($data) {
    # Validate the complete registry before a single atomic file replacement.
    if($data.schema_version -ne 1 -or $data.projects -isnot [array]){throw 'Invalid root registry update.'}
    $ids=@{};$folders=@{}
    foreach($entry in $data.projects){
        $id=[string]$entry.project_id;$folder=[string]$entry.folder
        if($id -cnotmatch '^[a-f0-9]{32}$'){throw 'Invalid project ID in registry update.'}
        Assert-RegisteredFolderName $folder
        if($ids.ContainsKey($id) -or $folders.ContainsKey($folder)){throw 'Duplicate project registry entry.'}
        $ids[$id]=$true;$folders[$folder]=$true
    }
    $target=Root-RegistryFile
    if(Test-Path -LiteralPath $target){
        $info=Get-Item -LiteralPath $target -Force -ErrorAction Stop
        if($info.Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Unsafe root registry link.'}
    }
    Save-ProjectJson $target $data
}
function Convert-LegacyProjectFile($file) {
    $source=Read-Project $file
    if($source.schema_version -eq 2){return $source}
    $backup=$file+'.schema-v1.bak'
    if(-not (Test-Path -LiteralPath $backup)){[IO.File]::Copy($file,$backup,$false)}
    $data=[pscustomobject]@{
        schema_version=2;project_id=[Guid]::NewGuid().ToString('N')
        project_name=[string]$source.name;project_path=[IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($file))
        created_at=$null;updated_at=(Project-Now);auto_restore=[bool]$source.auto_restore
        models=@(foreach($m in $source.models){
            [pscustomobject]@{id=[string]$m.id;model_name=[string]$m.name;path=[string]$m.path;enabled=[bool]$m.enabled;rotation=$m.rotation;legacy_external=$true}
        })
    }
    Save-ProjectJson $file $data
    return (Read-Project $file)
}
function Ensure-RootRegistry {
    $file=Root-RegistryFile
    if(Test-Path -LiteralPath $file){return (Read-RootRegistry)}
    $candidates=@(Get-ChildItem -LiteralPath $script:projectRoot -Directory -ErrorAction Stop | Where-Object {
        -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -and (Test-Path -LiteralPath (Join-Path $_.FullName 'project.json') -PathType Leaf)
    })
    $entries=@();$importOld=$false
    if($candidates.Count -gt 0) {
        $answer=[System.Windows.Forms.MessageBox]::Show($script:mainForm,
            ('This root has '+$candidates.Count+' existing project folder(s) but no project_root.json.'+[Environment]::NewLine+
             'Register existing valid projects now? Choosing No starts an empty registry; projects can later be imported individually.'),
            'Initialize Project Root','YesNo','Question')
        $importOld=($answer -eq 'Yes')
    }
    if($importOld){
        $used=@{}
        foreach($dir in $candidates){
            try {
                Assert-RegisteredFolderName $dir.Name
                $manifest=Join-Path $dir.FullName 'project.json'
                $data=Read-Project $manifest
                Assert-ProjectImportModels $manifest $data
                $data=Convert-LegacyProjectFile $manifest
                if($used.ContainsKey([string]$data.project_id)){throw 'Duplicate project identity.'}
                $used[[string]$data.project_id]=$true
                $entries+=@([pscustomobject]@{project_id=[string]$data.project_id;folder=$dir.Name})
            } catch {Write-OutputLine ('Existing project not registered: '+$dir.FullName+' — '+$_.Exception.Message)}
        }
    }
    Save-RootRegistry ([pscustomobject]@{schema_version=1;projects=@($entries)})
    return (Read-RootRegistry)
}
function Assert-RegisteredProject($file,$id) {
    $reg=Read-RootRegistry
    $found=@($reg.projects | Where-Object {$_.project_id -ceq $id})
    if($found.Count -ne 1){throw 'Project is not registered in project_root.json.'}
    $directory=Registered-ProjectDirectory ([string]$found[0].folder)
    $expected=Join-Path $directory 'project.json'
    if(-not [string]::Equals([IO.Path]::GetFullPath($file),[IO.Path]::GetFullPath($expected),[StringComparison]::OrdinalIgnoreCase)){
        throw 'Registered project directory and selected manifest do not match.'
    }
    Assert-ProjectRegularDirectory $directory
    $manifest=Read-Project $expected
    if($manifest.schema_version -ne 2 -or $manifest.project_id -cne $id){throw 'Project ID mismatch between registry and project manifest.'}
    return $found[0]
}
function Copy-ProjectTree($source,$target) {
    Assert-ProjectTreeRegular $source
    [void](New-Item -ItemType Directory -Path $target -ErrorAction Stop)
    foreach($item in (Get-ChildItem -LiteralPath $source -Force -ErrorAction Stop)){
        $dest=Join-Path $target $item.Name
        if($item.PSIsContainer){Copy-ProjectTree $item.FullName $dest}
        else{[IO.File]::Copy($item.FullName,$dest,$false)}
    }
}
function New-RegisteredProject([string]$name) {
    $registry=Ensure-RootRegistry
    if(-not $name.Trim()){throw 'Enter a project name.'}
    if($name.IndexOfAny([IO.Path]::GetInvalidFileNameChars()) -ge 0 -or $name -in @('.','..') -or $name.EndsWith('.') -or $name -match '[\\/:]' -or $name -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)'){throw 'Invalid project name.'}
    $base='{0}_{1}' -f $name,(Get-Date -Format 'yyyyMMdd_HHmmss');$folder=$base;$count=1
    while(Test-Path -LiteralPath (Join-Path $script:projectRoot $folder)){$folder=('{0}_{1:D2}' -f $base,$count);$count++}
    $dir=Registered-ProjectDirectory $folder;$id=[Guid]::NewGuid().ToString('N');$created=$false;$saved=$false
    try {
        [void](New-Item -ItemType Directory -Path $dir -ErrorAction Stop);$created=$true
        [void](New-Item -ItemType Directory -Path (Join-Path $dir 'models') -ErrorAction Stop)
        $now=Project-Now;$file=Join-Path $dir 'project.json'
        Save-ProjectJson $file ([pscustomobject]@{schema_version=2;project_id=$id;project_name=$name;project_path=$dir;created_at=$now;updated_at=$now;auto_restore=$true;models=@()})
        $registry.projects=@($registry.projects)+@([pscustomobject]@{project_id=$id;folder=$folder})
        Save-RootRegistry $registry;$saved=$true
        return $file
    } finally {
        if($created -and -not $saved -and (Test-Path -LiteralPath $dir)){Assert-ProjectTreeRegular $dir;Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop}
    }
}
function Import-RegisteredProject($file) {
    $registry=Ensure-RootRegistry
    $source=[IO.Path]::GetFullPath($file)
    if([IO.Path]::GetFileName($source) -cne 'project.json'){throw 'Import requires an ordinary project.json file.'}
    $sourceDir=[IO.Path]::GetDirectoryName($source)
    if([string]::Equals($sourceDir.TrimEnd([char[]]'\/'),[IO.Path]::GetPathRoot($sourceDir).TrimEnd([char[]]'\/'),[StringComparison]::OrdinalIgnoreCase)){
        throw 'A project.json at a drive root cannot be imported as a project folder.'
    }
    if(Test-Path -LiteralPath (Join-Path $sourceDir 'project_root.json')){throw 'Select a project manifest inside a project folder, not a project root.'}
    Assert-ProjectTreeRegular $sourceDir
    $data=Read-Project $source
    Assert-ProjectImportModels $source $data
    $root=[IO.Path]::GetFullPath($script:projectRoot)
    $isLocal=[string]::Equals([IO.Path]::GetDirectoryName($sourceDir).TrimEnd([char[]]'\/'),$root.TrimEnd([char[]]'\/'),[StringComparison]::OrdinalIgnoreCase)
    if($data.schema_version -eq 2){
        $existing=@($registry.projects | Where-Object {$_.project_id -ceq [string]$data.project_id})
        if($existing.Count){
            if($isLocal -and $existing[0].folder -ieq [IO.Path]::GetFileName($sourceDir)){return $source}
            throw 'Project ID is already registered at another location.'
        }
    }
    $created=$false;$registered=$false;$targetDir=$sourceDir
    if(-not $isLocal){
        $base=[IO.Path]::GetFileName($sourceDir);Assert-RegisteredFolderName $base
        $folder=$base;$count=1
        while(Test-Path -LiteralPath (Join-Path $root $folder)){$folder=('{0}_import_{1:D2}' -f $base,$count);$count++}
        $targetDir=Registered-ProjectDirectory $folder
        $temporary=Join-Path $root ('.importing-'+[Guid]::NewGuid().ToString('N'))
        try{Copy-ProjectTree $sourceDir $temporary;[IO.Directory]::Move($temporary,$targetDir);$created=$true}
        finally{if(Test-Path -LiteralPath $temporary){Assert-ProjectTreeRegular $temporary;Remove-Item -LiteralPath $temporary -Recurse -Force -ErrorAction Stop}}
    } else {Assert-RegisteredFolderName ([IO.Path]::GetFileName($sourceDir))}
    $targetFile=Join-Path $targetDir 'project.json'
    try{
        $data=Convert-LegacyProjectFile $targetFile
        if(@($registry.projects|Where-Object {$_.project_id -ceq [string]$data.project_id -or $_.folder -ieq [IO.Path]::GetFileName($targetDir)}).Count){throw 'Project ID or folder is already registered.'}
        $changed=$false
        if($created){
            # Legacy relative references outside the original project folder are
            # not included in the copied directory. Preserve them as absolute
            # external references instead of leaving broken relative paths.
            foreach($m in $data.models){
                if($m.legacy_external -eq $true -and -not [IO.Path]::IsPathRooted([string]$m.path)){
                    $original=[IO.Path]::GetFullPath((Join-Path $sourceDir ([string]$m.path)))
                    $copied=[IO.Path]::GetFullPath((Join-Path $targetDir ([string]$m.path)))
                    if(-not (Test-Path -LiteralPath $copied -PathType Leaf)){
                        $m.path=$original;$changed=$true
                    }
                }
            }
        }
        if([string]$data.project_path -ine $targetDir){$data.project_path=$targetDir;$changed=$true}
        if($changed){$data.updated_at=Project-Now;Save-ProjectJson $targetFile $data}
        Assert-ProjectImportModels $targetFile $data
        $registry.projects=@($registry.projects)+@([pscustomobject]@{project_id=[string]$data.project_id;folder=[IO.Path]::GetFileName($targetDir)})
        Save-RootRegistry $registry;$registered=$true
        return $targetFile
    } finally {
        if($created -and -not $registered -and (Test-Path -LiteralPath $targetDir)){Assert-ProjectTreeRegular $targetDir;Remove-Item -LiteralPath $targetDir -Recurse -Force -ErrorAction Stop}
    }
}
function Commit-ProjectDeletion($file) {
    $data=Read-Project $file
    if($data.schema_version -ne 2){throw 'Legacy projects must be registered and migrated before deletion.'}
    $entry=Assert-RegisteredProject $file ([string]$data.project_id)
    $dir=Registered-ProjectDirectory ([string]$entry.folder)
    Assert-ProjectTreeRegular $dir
    $registry=Read-RootRegistry
    $stage=Join-Path $script:projectRoot ('.deleting-'+$data.project_id+'-'+[Guid]::NewGuid().ToString('N'))
    [IO.Directory]::Move($dir,$stage)
    $saved=$false
    try{
        Assert-ProjectTreeRegular $stage
        $staged=Read-Project (Join-Path $stage 'project.json')
        if($staged.project_id -cne $data.project_id){throw 'Project identity changed during deletion.'}
        $registry.projects=@($registry.projects|Where-Object {$_.project_id -cne [string]$data.project_id})
        Save-RootRegistry $registry;$saved=$true
    } finally {
        if(-not $saved -and (Test-Path -LiteralPath $stage)){[IO.Directory]::Move($stage,$dir)}
    }
    try {Assert-ProjectTreeRegular $stage;Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction Stop;return $null}
    catch {return ('Project was unregistered, but folder deletion is incomplete at '+$stage+': '+$_.Exception.Message)}
}

function Read-Project($file) {
    if(-not (Test-Path -LiteralPath $file -PathType Leaf)){throw 'Project manifest not found.'}
    $obj=Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json
    if($obj.schema_version -notin @(1,2) -or $obj.auto_restore -isnot [bool] -or $obj.models -isnot [array] -or -not (Project-Name $obj).Trim()) { throw 'Invalid project.json contract.' }
    if($obj.schema_version -eq 2) {
        if([string]$obj.project_id -cnotmatch '^[a-f0-9]{32}$' -or -not [IO.Path]::IsPathRooted([string]$obj.project_path) -or
           [string]$obj.updated_at -notmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$' -or
           ($null -ne $obj.created_at -and [string]$obj.created_at -notmatch '^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$')) { throw 'Invalid project identity or timestamps.' }
        foreach($value in @($obj.created_at,$obj.updated_at)){
            if($null -ne $value){try{[void][DateTimeOffset]::Parse([string]$value,[Globalization.CultureInfo]::InvariantCulture)}catch{throw 'Invalid project timestamp value.'}}
        }
    }
    $ids=@{}
    foreach($m in $obj.models) {
        $name=Model-Name $m
        if (-not $m.id -or $ids.ContainsKey([string]$m.id) -or -not $name.Trim() -or -not $m.path -or [string]$m.path -notmatch '\.(ply|splat|ksplat|spz|sog)$' -or -not $m.rotation -or $m.enabled -isnot [bool]) { throw 'Invalid or duplicate model registration.' }
        $ids[[string]$m.id]=$true
        if([string]$m.rotation.preset -notin @('editor-default','colmap','xgrids','none','custom')){throw ('Invalid rotation preset: ' + $name)}
        foreach($axis in @('x','y','z')){
            if($m.rotation.PSObject.Properties.Name -notcontains $axis){throw ('Missing rotation angle: '+$name)}
        }
        $angles=@([double]$m.rotation.x,[double]$m.rotation.y,[double]$m.rotation.z)
        if(($angles|Where-Object{[double]::IsNaN($_) -or [double]::IsInfinity($_) -or [Math]::Abs($_) -gt 360}).Count -gt 0){throw ('Invalid rotation: '+$name)}
        if(($m.rotation.preset -eq 'colmap' -and ($angles[0] -ne 0 -or $angles[1] -ne 0 -or $angles[2] -ne 180)) -or
           ($m.rotation.preset -eq 'xgrids' -and ($angles[0] -ne -90 -or $angles[1] -ne 0 -or $angles[2] -ne 0)) -or
           ($m.rotation.preset -eq 'none' -and ($angles|Where-Object{$_ -ne 0}).Count -gt 0)) {throw ('Preset angles disagree: '+$name)}
        if($obj.schema_version -eq 2){
            $parts=([string]$m.path).Replace('\','/').Split('/')
            if($m.legacy_external -ne $true -and ($parts -contains '..' -or $parts -contains '.')){throw ('Unsafe relative model path: '+$name)}
            if($parts.Count -eq 3 -and $parts[0] -eq 'models' -and $parts[1] -match '^[a-f0-9]{32}$' -and
               $parts[1] -cne [string]$m.id -and $m.legacy_external -ne $true){throw ('Managed model ID mismatch: '+$name)}
        }
    }
    return $obj
}
function Remember-Project {
    try {
        $id=if($null -ne $script:projectData -and $script:projectData.schema_version -eq 2){[string]$script:projectData.project_id}else{$null}
        Save-ProjectJson $script:projectPrefs @{schema_version=2;root=$script:projectRoot;project=$script:projectFile;project_id=$id}
    } catch { Write-OutputLine ('Could not remember current project: ' + $_.Exception.Message) }
}
function Ensure-ProjectV2 {
    if(-not $script:projectFile){throw 'Select a project first.'}
    if($script:projectData.schema_version -eq 2){return}
    $script:projectData=Convert-LegacyProjectFile $script:projectFile
    Remember-Project
}
function Save-CurrentProject([switch]$NoRefresh) {
    if(-not $script:projectFile){throw 'Select a project first.'}
    Ensure-ProjectV2
    $script:projectData.updated_at=Project-Now
    Save-ProjectJson $script:projectFile $script:projectData
    if(-not $NoRefresh){Refresh-ProjectModels}
    Write-OutputLine ('Project saved: ' + (Project-Name $script:projectData))
}
function Format-ProjectTime($value) {
    if(-not $value){return 'Unknown'}
    try {return ([DateTimeOffset]::Parse([string]$value,[Globalization.CultureInfo]::InvariantCulture)).ToLocalTime().ToString('yyyy-MM-dd HH:mm')}
    catch{return 'Invalid'}
}
function Refresh-ProjectModels {
    $script:projectUpdating=$true
    try {
        $script:modelGrid.Rows.Clear()
        $script:autoRestore.Checked=$null -ne $script:projectData -and [bool]$script:projectData.auto_restore
        if($null -ne $script:projectData) {
            $number=0
            foreach($m in $script:projectData.models) {
                $number++
                $i=$script:modelGrid.Rows.Add($number,[bool]$m.enabled,[string]$m.id,(Model-Name $m),[string]$m.path,[string]$m.rotation.preset,('{0}, {1}, {2}' -f $m.rotation.x,$m.rotation.y,$m.rotation.z))
                $script:modelGrid.Rows[$i].Tag=[string]$m.id
                $script:modelGrid.Rows[$i].Cells['id'].ToolTipText=[string]$m.id
            }
        }
        $script:projectInfo.Text=if(-not $script:projectData){'No project selected.'}else{
            'ID: {0}    Created: {1}    Modified: {2}{3}Path: {4}' -f $(if($script:projectData.schema_version -eq 2){$script:projectData.project_id}else{'Legacy (not assigned)'}),
                $(if($script:projectData.schema_version -eq 2){Format-ProjectTime $script:projectData.created_at}else{'Unknown'}),
                $(if($script:projectData.schema_version -eq 2){Format-ProjectTime $script:projectData.updated_at}else{'Unknown'}),[Environment]::NewLine,(Project-Directory)
        }
    } finally {$script:projectUpdating=$false}
    Update-Controls
}
function Set-Project($file) {
    $data=if($file){Read-Project $file}else{$null}
    $script:projectFile=$file
    $script:projectData=$data
    Refresh-ProjectModels
    Remember-Project
}
function Reload-Projects($selectedFile,$selectedId=$null) {
    $script:projectUpdating=$true
    $entries=@()
    try {
        $script:rootBox.Text=$script:projectRoot
        $script:projectCombo.Items.Clear()
        [void]$script:projectCombo.Items.Add('(Standalone)')
        $script:projectPaths=@($null);$index=0
        if($script:projectRoot -and (Test-Path -LiteralPath $script:projectRoot -PathType Container)) {
            $registry=Ensure-RootRegistry
            foreach($entry in $registry.projects){
                $dir=Registered-ProjectDirectory ([string]$entry.folder)
                $file=Join-Path $dir 'project.json'
                try {
                    Assert-ProjectRegularDirectory $dir
                    $data=Read-Project $file
                    if($data.schema_version -ne 2 -or $data.project_id -cne [string]$entry.project_id){throw 'Project ID mismatch.'}
                    $entries+=@([pscustomobject]@{file=$file;name=(Project-Name $data);folder=[string]$entry.folder;id=[string]$entry.project_id})
                } catch {Write-OutputLine ('Registered project unavailable: '+$file+' — '+$_.Exception.Message)}
            }
        }
        $counts=@{}
        foreach($entry in $entries){$key=$entry.name.ToLowerInvariant();if(-not $counts.ContainsKey($key)){$counts[$key]=0};$counts[$key]++}
        foreach($entry in ($entries|Sort-Object folder)) {
            $label=if($counts[$entry.name.ToLowerInvariant()] -gt 1){$entry.name+' ('+$entry.folder+')'}else{$entry.name}
            $i=$script:projectCombo.Items.Add($label)
            $script:projectPaths+=@($entry.file)
            if($selectedFile -and $entry.file -ieq $selectedFile){
                if($selectedId -and $entry.id -cne $selectedId){throw 'Last selected project ID differs from its manifest.'}
                $index=$i
            }
        }
        $script:projectCombo.SelectedIndex=$index
    } finally {$script:projectUpdating=$false}
    if($index -eq 0){Set-Project $null}else{Set-Project $script:projectPaths[$index]}
}
function Reset-ProjectSelection {
    # Invalid/missing registry must not leave a previously selected project active
    # under a different root, and must never trigger an unregistered fallback scan.
    $script:projectUpdating=$true
    try {
        $script:projectCombo.Items.Clear()
        [void]$script:projectCombo.Items.Add('(Standalone)')
        $script:projectCombo.SelectedIndex=0
        $script:projectPaths=@($null)
    } finally {$script:projectUpdating=$false}
    $script:projectFile=$null;$script:projectData=$null
    Refresh-ProjectModels
}
function Get-SelectedModel {
    if($script:modelGrid.SelectedRows.Count -ne 1){return $null}
    $id=$script:modelGrid.SelectedRows[0].Tag
    return ($script:projectData.models | Where-Object {$_.id -ceq $id} | Select-Object -First 1)
}
function Project-ModelPath([string]$filename) {
    $base=(Project-Directory).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
    $full=[IO.Path]::GetFullPath($filename)
    if($full.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){return $full.Substring($base.Length).Replace('\','/')}
    return $full
}
function Assert-ProjectImportModels($file,$data) {
    foreach($m in $data.models){
        $path=Project-AbsoluteModelPath $file $m
        if(-not (Test-Path -LiteralPath $path -PathType Leaf)){throw ('Missing registered model: '+(Model-Name $m)+' ('+$path+')')}
        $managed=if($data.schema_version -eq 2){Get-ManagedModelDirectory $m $file}else{$null}
        if($managed){Assert-ProjectTreeRegular $managed}
    }
}
function Edit-ProjectModel($model) {
    # Reuse v0.1.6's registration dialog and rotation presets.
    $dialog=New-Object System.Windows.Forms.Form
    $dialog.Text='Model registration';$dialog.StartPosition='CenterParent';$dialog.FormBorderStyle='FixedDialog'
    $dialog.ClientSize=[Drawing.Size]::new(600,239);$dialog.Font=$script:mainForm.Font
    $dialog.MinimizeBox=$false;$dialog.MaximizeBox=$false
    $nameBox=New-Object System.Windows.Forms.TextBox;$nameBox.SetBounds(12,35,576,27)
    $pathBox=New-Object System.Windows.Forms.TextBox;$pathBox.SetBounds(12,90,468,27)
    $browse=New-Button 'Browse...' 484 89 104 29
    $preset=New-Object System.Windows.Forms.ComboBox;$preset.DropDownStyle='DropDownList';$preset.SetBounds(12,151,190,28)
    [void]$preset.Items.AddRange(@('Editor default','COLMAP','XGRIDS','No rotation','Custom'))
    $keys=@('editor-default','colmap','xgrids','none','custom');$angles=@()
    for($i=0;$i -lt 3;$i++){
        $spin=New-Object System.Windows.Forms.NumericUpDown;$spin.Minimum=-360;$spin.Maximum=360;$spin.DecimalPlaces=3;$spin.Increment=1
        $spin.SetBounds((214+125*$i),151,116,28);$angles+=$spin
        $dialog.Controls.Add((New-Label (@('X (deg)','Y (deg)','Z (deg)')[$i]) (214+125*$i) 128 116 22));$dialog.Controls.Add($spin)
    }
    $save=New-Button 'Save' 356 193 110 32;$cancel=New-Button 'Cancel' 478 193 110 32;$cancel.DialogResult='Cancel';$dialog.CancelButton=$cancel
    $dialog.Controls.AddRange(@((New-Label 'Model name' 12 12 576 22),$nameBox,(New-Label 'Model file' 12 67 576 22),$pathBox,$browse,(New-Label 'Import rotation' 12 128 200 22),$preset,$save,$cancel))
    $preset.Add_SelectedIndexChanged({
        $custom=$preset.SelectedIndex -eq 4
        foreach($a in $angles){$a.Enabled=$custom}
        if(-not $custom){$angles[0].Value=0;$angles[1].Value=0;$angles[2].Value=0;if($preset.SelectedIndex -eq 1){$angles[2].Value=180};if($preset.SelectedIndex -eq 2){$angles[0].Value=-90}}
    }.GetNewClosure())
    $browse.Add_Click({
        $picker=New-Object System.Windows.Forms.OpenFileDialog
        try{$picker.Filter='Gaussian splat models|*.ply;*.splat;*.ksplat;*.spz;*.sog';if($picker.ShowDialog($dialog) -eq 'OK'){$pathBox.Text=$picker.FileName;if(-not $nameBox.Text){$nameBox.Text=[IO.Path]::GetFileName($picker.FileName)}}}
        finally{$picker.Dispose()}
    }.GetNewClosure())
    $preset.SelectedIndex=0
    if($null -ne $model){
        $nameBox.Text=Model-Name $model
        $pathBox.Text=Project-AbsoluteModelPath $script:projectFile $model
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
        return [pscustomobject]@{
            id=$(if($model){[string]$model.id}else{[Guid]::NewGuid().ToString('N')})
            model_name=$nameBox.Text.Trim()
            path=[IO.Path]::GetFullPath($pathBox.Text)
            enabled=$(if($null -ne $model){[bool]$model.enabled}else{$true})
            rotation=[pscustomobject]@{preset=$keys[$preset.SelectedIndex];x=[double]$angles[0].Value;y=[double]$angles[1].Value;z=[double]$angles[2].Value}
        }
    } finally {$dialog.Dispose()}
}
function Add-ManagedModel($model) {
    Ensure-ProjectV2
    $base=Project-Directory
    Assert-ProjectRegularDirectory $base
    $models=Join-Path $base 'models'
    if(Test-Path -LiteralPath $models){Assert-ProjectRegularDirectory $models}
    else{[void](New-Item -ItemType Directory -Path $models -ErrorAction Stop)}
    $dir=Join-Path $models ([string]$model.id)
    if(Test-Path -LiteralPath $dir){throw 'Model ID folder already exists; refusing to overwrite.'}
    $source=[string]$model.path
    $filename=[IO.Path]::GetFileName($source)
    [void](New-Item -ItemType Directory -Path $dir -ErrorAction Stop)
    $committed=$false
    try {
        $tmp=Join-Path $dir ('.'+[Guid]::NewGuid().ToString('N')+'.tmp')
        [IO.File]::Copy($source,$tmp,$false)
        [IO.File]::Move($tmp,(Join-Path $dir $filename))
        $model.path=('models/{0}/{1}' -f $model.id,$filename)
        $script:projectData.models=@($script:projectData.models)+@($model)
        Save-CurrentProject -NoRefresh
        $committed=$true
        Refresh-ProjectModels
    } finally {
        if(-not $committed){
            if(Test-Path -LiteralPath $dir){Assert-ProjectTreeRegular $dir;Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction Stop}
            $script:projectData=Read-Project $script:projectFile
        }
    }
}
function Update-ManagedModel($old,$changed) {
    $owned=if($script:projectData.schema_version -eq 2){Get-ManagedModelDirectory $old $script:projectFile}else{$null}
    if($old.legacy_external -eq $true){$changed | Add-Member -MemberType NoteProperty -Name legacy_external -Value $true -Force}
    $oldFile=Project-AbsoluteModelPath $script:projectFile $old
    if(-not $owned -or ([IO.Path]::GetFullPath([string]$changed.path) -ieq $oldFile)) {
        # Legacy external references remain external; an unchanged managed file stays put.
        $changed.path=$(if($owned){[string]$old.path}else{Project-ModelPath $changed.path})
        $script:projectData.models=@(foreach($m in $script:projectData.models){if($m.id -ceq $old.id){$changed}else{$m}})
        Save-CurrentProject
        return
    }
    Assert-ProjectTreeRegular $owned
    $filename=[IO.Path]::GetFileName([string]$changed.path)
    $dest=Join-Path $owned $filename
    $backup=Join-Path $owned ('.'+[Guid]::NewGuid().ToString('N')+'.old')
    $tmp=Join-Path $owned ('.'+[Guid]::NewGuid().ToString('N')+'.tmp')
    $newPlaced=$false;$oldMoved=$false;$saved=$false
    try {
        [IO.File]::Copy([string]$changed.path,$tmp,$false)
        if((Test-Path -LiteralPath $dest) -and $dest -ine $oldFile){throw 'Replacement filename already exists in this model folder.'}
        [IO.File]::Move($oldFile,$backup);$oldMoved=$true
        [IO.File]::Move($tmp,$dest);$newPlaced=$true
        $changed.path=('models/{0}/{1}' -f $old.id,$filename)
        $script:projectData.models=@(foreach($m in $script:projectData.models){if($m.id -ceq $old.id){$changed}else{$m}})
        Save-CurrentProject -NoRefresh
        $saved=$true
        Refresh-ProjectModels
    } finally {
        if($saved) {if(Test-Path -LiteralPath $backup){try{Remove-Item -LiteralPath $backup -Force -ErrorAction Stop}catch{Write-OutputLine ('Obsolete replacement backup remains: '+$backup)}}}
        else {
            if($newPlaced -and (Test-Path -LiteralPath $dest)){Remove-Item -LiteralPath $dest -Force -ErrorAction Stop}
            if($oldMoved -and (Test-Path -LiteralPath $backup)){[IO.File]::Move($backup,$oldFile)}
            if(Test-Path -LiteralPath $tmp){Remove-Item -LiteralPath $tmp -Force -ErrorAction Stop}
            $script:projectData=Read-Project $script:projectFile
        }
    }
}
function Remove-ProjectModel($model) {
    $owned=if($script:projectData.schema_version -eq 2){Get-ManagedModelDirectory $model $script:projectFile}else{$null}
    if($owned -and (Test-Path -LiteralPath $owned)){Assert-ProjectTreeRegular $owned}
    $message=if($owned){'Remove this model registration AND its project-owned model folder? Original external source files are unaffected.'}else{'Remove this legacy model registration? The external model file will be preserved.'}
    if([System.Windows.Forms.MessageBox]::Show($script:mainForm,$message,'Remove Model','YesNo','Warning') -ne 'Yes'){return}
    Commit-ProjectModelRemoval $model $owned
}
function Commit-ProjectModelRemoval($model,$owned) {
    # Filesystem work is separate from the confirmation UI for deterministic testing.
    Ensure-ProjectV2
    $quarantine=$null
    if($owned -and (Test-Path -LiteralPath $owned)){
        $quarantine=Join-Path (Split-Path -Parent $owned) ('.removed-'+$model.id+'-'+[Guid]::NewGuid().ToString('N'))
        [IO.Directory]::Move($owned,$quarantine)
    }
    $saved=$false
    try {
        $script:projectData.models=@($script:projectData.models|Where-Object{$_.id -cne $model.id})
        Save-CurrentProject -NoRefresh
        $saved=$true
        Refresh-ProjectModels
    } finally {
        if(-not $saved){
            if($quarantine -and (Test-Path -LiteralPath $quarantine)){[IO.Directory]::Move($quarantine,$owned)}
            $script:projectData=Read-Project $script:projectFile
        }
    }
    if($quarantine){
        try{Assert-ProjectTreeRegular $quarantine;Remove-Item -LiteralPath $quarantine -Recurse -Force -ErrorAction Stop}
        catch{Project-Error ('Registration removed, but owned files remain at '+$quarantine+': '+$_.Exception.Message)}
    }
}
function Update-ProjectControls([bool]$idle) {
    if($null -eq $script:projectPanel){return}
    $script:projectPanel.Enabled=$idle
    $selected=$null -ne $script:projectData
    $script:modelGrid.Enabled=$selected;$script:autoRestore.Enabled=$selected
    $script:addModel.Enabled=$selected;$script:editModel.Enabled=$selected;$script:removeModel.Enabled=$selected
    $script:editProject.Enabled=$selected;$script:removeProject.Enabled=$selected
    $script:newProject.Enabled=[bool]$script:projectRoot
}
function New-ProjectPanel {
    $script:projectPanel=New-Object System.Windows.Forms.Panel
    $script:projectPanel.SetBounds(0,0,728,406);$script:projectPanel.Anchor='Top, Left, Right'
    $script:rootBox=New-Object System.Windows.Forms.TextBox;$script:rootBox.ReadOnly=$true;$script:rootBox.SetBounds(0,24,592,28);$script:rootBox.Anchor='Top, Left, Right'
    $rootButton=New-Button 'Browse...' 604 23 124 29;$rootButton.Anchor='Top, Right'
    $script:projectCombo=New-Object System.Windows.Forms.ComboBox;$script:projectCombo.DropDownStyle='DropDownList';$script:projectCombo.SetBounds(0,77,592,28);$script:projectCombo.Anchor='Top, Left, Right'
    $script:newProject=New-Button 'New Project' 604 76 124 29;$script:newProject.Anchor='Top, Right'
    $script:importProject=New-Button 'Import Project' 0 111 128 29
    $script:editProject=New-Button 'Edit Project' 138 111 122 29
    $script:removeProject=New-Button 'Remove Project' 270 111 140 29
    $script:projectInfo=New-Label 'No project selected.' 0 146 728 52;$script:projectInfo.Anchor='Top, Left, Right';$script:projectInfo.AutoEllipsis=$true
    $script:modelGrid=New-Object System.Windows.Forms.DataGridView;$script:modelGrid.SetBounds(0,201,728,120);$script:modelGrid.Anchor='Top, Left, Right'
    $script:modelGrid.ReadOnly=$false;$script:modelGrid.AllowUserToAddRows=$false;$script:modelGrid.AllowUserToDeleteRows=$false;$script:modelGrid.AllowUserToOrderColumns=$false;$script:modelGrid.RowHeadersVisible=$false;$script:modelGrid.MultiSelect=$false;$script:modelGrid.SelectionMode='FullRowSelect';$script:modelGrid.AutoSizeColumnsMode='None'
    foreach($col in @(@('number','#',37),@('load','Load',50),@('id','Model ID',158),@('name','Model',120),@('path','Path',175),@('preset','Preset',87),@('rotation','X, Y, Z (deg)',143))){
        if($col[0] -eq 'load'){$c=New-Object System.Windows.Forms.DataGridViewCheckBoxColumn;$c.Name='load';$c.HeaderText='Load';$c.ThreeState=$false;$c.ValueType=[bool];$c.ReadOnly=$false;$c.SortMode='NotSortable';$c.ToolTipText='Load model on restore';[void]$script:modelGrid.Columns.Add($c)}
        else {$i=$script:modelGrid.Columns.Add($col[0],$col[1]);$script:modelGrid.Columns[$i].ReadOnly=$true;$script:modelGrid.Columns[$i].SortMode='NotSortable'}
        $script:modelGrid.Columns[$col[0]].Width=$col[2]
    }
    $script:addModel=New-Button 'Add Model' 0 328 112 29
    $script:editModel=New-Button 'Edit Model' 120 328 112 29
    $script:removeModel=New-Button 'Remove Model' 240 328 128 29
    $script:autoRestore=New-Object System.Windows.Forms.CheckBox;$script:autoRestore.Text='Automatically restore project models';$script:autoRestore.SetBounds(0,369,550,24)
    $script:projectPanel.Controls.AddRange(@((New-Label 'Project root' 0 0 500 22),$script:rootBox,$rootButton,(New-Label 'Project' 0 54 500 22),$script:projectCombo,$script:newProject,$script:importProject,$script:editProject,$script:removeProject,$script:projectInfo,$script:modelGrid,$script:addModel,$script:editModel,$script:removeModel,$script:autoRestore))
    $script:modelGrid.Add_CurrentCellDirtyStateChanged({
        param($sender,$e)
        if(-not $script:projectUpdating -and $sender.Enabled -and $sender.IsCurrentCellDirty -and $null -ne $sender.CurrentCell -and $sender.CurrentCell.OwningColumn.Name -eq 'load'){
            [void]$sender.CommitEdit([System.Windows.Forms.DataGridViewDataErrorContexts]::Commit)
        }
    })
    $script:modelGrid.Add_CellValueChanged({
        param($sender,$e)
        if($script:projectUpdating -or -not $sender.Enabled -or -not $script:projectData -or $e.RowIndex -lt 0 -or $e.ColumnIndex -ne $sender.Columns['load'].Index){return}
        $row=$sender.Rows[$e.RowIndex];$id=[string]$row.Tag
        $previous=$script:projectData.models|Where-Object{$_.id -ceq $id}|Select-Object -First 1
        if($null -eq $previous){return}
        $before=[bool]$previous.enabled;$next=[bool]$row.Cells['load'].Value
        if($before -eq $next){return}
        try{
            Ensure-ProjectV2
            $model=$script:projectData.models|Where-Object{$_.id -ceq $id}|Select-Object -First 1
            $model.enabled=$next
            Save-CurrentProject -NoRefresh
        } catch {
            $script:projectData=Read-Project $script:projectFile
            $script:projectUpdating=$true
            try{$row.Cells['load'].Value=$before}finally{$script:projectUpdating=$false}
            Project-Error $_.Exception.Message
        }
    })
    $rootButton.Add_Click({
        $picker=New-Object System.Windows.Forms.FolderBrowserDialog;$picker.ShowNewFolderButton=$true;$picker.Description='Select or create a project root directory'
        $previousRoot=$script:projectRoot;$previousFile=$script:projectFile
        try{
            if($script:projectRoot){$picker.SelectedPath=$script:projectRoot}
            if($picker.ShowDialog($script:mainForm) -eq 'OK'){$script:projectRoot=$picker.SelectedPath;Reload-Projects $null}
        }catch{
            $script:projectRoot=$previousRoot
            try{Reload-Projects $previousFile}catch{Reset-ProjectSelection}
            Project-Error $_.Exception.Message
        }finally{$picker.Dispose()}
    })
    $script:projectCombo.Add_SelectedIndexChanged({
        if($script:projectUpdating){return}
        try{if($script:projectCombo.SelectedIndex -le 0){Set-Project $null}else{Set-Project $script:projectPaths[$script:projectCombo.SelectedIndex]}}
        catch{
            Project-Error $_.Exception.Message
            try{Reload-Projects $null}catch{Reset-ProjectSelection}
        }
    })
    $script:newProject.Add_Click({
        try {
            Add-Type -AssemblyName Microsoft.VisualBasic
            $n=[Microsoft.VisualBasic.Interaction]::InputBox('Project name','New Project','').Trim()
            if(-not $n){return}
            $file=New-RegisteredProject $n
            Reload-Projects $file
        }catch{Project-Error $_.Exception.Message}
    })
    $script:importProject.Add_Click({
        $picker=New-Object System.Windows.Forms.OpenFileDialog
        try {
            $picker.Title='Import an existing project manifest'
            $picker.Filter='Project manifest|project.json'
            $picker.FileName='project.json'
            if($picker.ShowDialog($script:mainForm) -ne 'OK'){return}
            $selected=Import-RegisteredProject $picker.FileName
            Reload-Projects $selected
            Write-OutputLine ('Imported project: '+(Project-Name $script:projectData))
        }catch{Project-Error $_.Exception.Message}finally{$picker.Dispose()}
    })
    $script:editProject.Add_Click({
        try{
            if(-not $script:projectFile){return}
            Add-Type -AssemblyName Microsoft.VisualBasic
            $n=[Microsoft.VisualBasic.Interaction]::InputBox('Project name','Edit Project',(Project-Name $script:projectData)).Trim()
            if(-not $n -or $n -ceq (Project-Name $script:projectData)){return}
            Ensure-ProjectV2
            $script:projectData.project_name=$n
            Save-CurrentProject -NoRefresh
            Reload-Projects $script:projectFile
        }catch{Project-Error $_.Exception.Message;Set-Project $script:projectFile}
    })
    $script:removeProject.Add_Click({
        try {
            if(-not $script:projectFile){return}
            $data=Read-Project $script:projectFile
            $entry=Assert-RegisteredProject $script:projectFile ([string]$data.project_id)
            $folder=Registered-ProjectDirectory ([string]$entry.folder)
            $message='Permanently delete project "'+(Project-Name $data)+'"?'+[Environment]::NewLine+
                'Project ID: '+$data.project_id+[Environment]::NewLine+
                'Folder: '+$folder+[Environment]::NewLine+
                'ALL files inside this project folder will be deleted. External source models are not deleted.'
            if([System.Windows.Forms.MessageBox]::Show($script:mainForm,$message,'Delete Project','YesNo','Warning') -ne 'Yes'){return}
            $warning=Commit-ProjectDeletion $script:projectFile
            Reload-Projects $null
            if($warning){Project-Error $warning}else{Write-OutputLine ('Project folder deleted: '+$folder)}
        }catch{Project-Error $_.Exception.Message}
    })
    $script:addModel.Add_Click({
        try{$m=Edit-ProjectModel $null;if($m){Add-ManagedModel $m}}
        catch{Project-Error $_.Exception.Message;Set-Project $script:projectFile}
    })
    $script:editModel.Add_Click({
        try{$old=Get-SelectedModel;if($old){$m=Edit-ProjectModel $old;if($m){Ensure-ProjectV2;$old=($script:projectData.models|Where-Object{$_.id -ceq $m.id}|Select-Object -First 1);Update-ManagedModel $old $m}}}
        catch{Project-Error $_.Exception.Message;Set-Project $script:projectFile}
    })
    $script:removeModel.Add_Click({
        try{$m=Get-SelectedModel;if($m){Remove-ProjectModel $m}}
        catch{Project-Error $_.Exception.Message;Set-Project $script:projectFile}
    })
    $script:autoRestore.Add_CheckedChanged({
        if(-not $script:projectUpdating -and $script:projectData){
            try{Ensure-ProjectV2;$script:projectData.auto_restore=$script:autoRestore.Checked;Save-CurrentProject}
            catch{Project-Error $_.Exception.Message;Set-Project $script:projectFile}
        }
    })
    return $script:projectPanel
}
function Initialize-Projects {
    try{
        $last=$null;$lastId=$null
        if(Test-Path -LiteralPath $script:projectPrefs){
            $prefs=Get-Content -LiteralPath $script:projectPrefs -Raw -Encoding UTF8|ConvertFrom-Json
            if($prefs.schema_version -in @(1,2) -and $prefs.root -and (Test-Path -LiteralPath $prefs.root -PathType Container)){
                $script:projectRoot=[string]$prefs.root;$last=[string]$prefs.project
                if($prefs.schema_version -eq 2){$lastId=[string]$prefs.project_id}
            }
        }
        Reload-Projects $last $lastId
    }catch{Project-Error $_.Exception.Message;Reset-ProjectSelection}
}
