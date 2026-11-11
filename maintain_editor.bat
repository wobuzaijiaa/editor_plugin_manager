@echo off
setlocal EnableExtensions
rem Architecture C - simple maintenance entry point; no automatic maintenance on Run.
rem Run these commands only while the Editor and management backend are stopped.
set "ROOT=%~dp0"
set "BACKEND=http://127.0.0.1:3014"
if not exist "%ROOT%maintain_editor.ps1" (
    echo ERROR: maintain_editor.ps1 is missing.
    exit /b 1
)
if /I "%~1"=="clone" goto clone
if /I "%~1"=="build" goto deploy
if /I "%~1"=="copy" goto deploy
if /I "%~1"=="rollback" goto rollback
echo Usage: maintain_editor.bat clone ^| build ^| copy ^| rollback
exit /b 2

:clone
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%maintain_editor.ps1" -Operation clone
exit /b %ERRORLEVEL%

:deploy
rem Do not rebuild/replace dist or inspect a mutable plugin store while it is served.
powershell.exe -NoProfile -Command "$ports=@(3013,3014); foreach($port in $ports) { if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { Write-Host ('ERROR: Port '+$port+' is active. Stop the Editor first.'); exit 1 } }"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%maintain_editor.ps1" -Operation "%~1" -ManagementOrigin "%BACKEND%"
if errorlevel 1 exit /b %ERRORLEVEL%
rem maintain_editor.ps1 validates and deploys backend code as one atomic build/copy gate.
exit /b 0

:rollback
powershell.exe -NoProfile -Command "$ports=@(3013,3014); foreach($port in $ports) { if (@(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue).Count -gt 0) { Write-Host ('ERROR: Port '+$port+' is active. Stop the Editor first.'); exit 1 } }"
if errorlevel 1 exit /b 1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%maintain_editor.ps1" -Operation copy -ManagementOrigin "same-origin"
if errorlevel 1 exit /b %ERRORLEVEL%
echo Architecture A hook restored. Architecture C Run BAT will refuse to start until copy/build is rerun.
exit /b 0
