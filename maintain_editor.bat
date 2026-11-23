@echo off
setlocal EnableExtensions
rem Plugin Manager v1.13.3 / Architecture C - no automatic maintenance on Run.
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
rem maintain_editor.ps1 owns the authoritative preflight: configured Editor port,
rem requested Manager port and the previous port recorded in dist/index.html.
rem For custom ports use maintain_editor.ps1 -EditorPort/-ManagementOrigin directly.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%maintain_editor.ps1" -Operation "%~1" -EditorPort 3013 -ManagementOrigin "%BACKEND%"
if errorlevel 1 exit /b %ERRORLEVEL%
rem maintain_editor.ps1 validates and deploys backend code as one atomic build/copy gate.
exit /b 0

:rollback
rem Identical PS1 idle-port gate also applies when switching to same-origin.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%maintain_editor.ps1" -Operation copy -EditorPort 3013 -ManagementOrigin "same-origin"
if errorlevel 1 exit /b %ERRORLEVEL%
echo Architecture A hook restored. Architecture C Run BAT will refuse to start until copy/build is rerun.
exit /b 0
