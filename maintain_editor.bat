@echo off
setlocal EnableExtensions
rem API-first SuperSplat maintenance. Requires Windows PowerShell 5.1+.
rem Implementation, verification and timestamped logs live in maintain_editor.ps1.
set "ROOT=%~dp0"
if not exist "%ROOT%maintain_editor.ps1" (
    echo ERROR: Missing maintain_editor.ps1 next to maintain_editor.bat.
    exit /b 1
)
if /I "%~1"=="clone" goto run
if /I "%~1"=="build" goto run
if /I "%~1"=="copy" goto run
echo Usage: .\maintain_editor.bat clone ^| build ^| copy
exit /b 2
:run
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%maintain_editor.ps1" -Operation "%~1"
exit /b %ERRORLEVEL%
