@echo off
setlocal EnableExtensions
rem Stop ONLY Architecture C processes started by our Run BAT / helper.
set "ROOT=%~dp0"
set "HELPER=%ROOT%start_architecture_c.ps1"
if not exist "%HELPER%" (
    echo ERROR: Missing start_architecture_c.ps1 at project root.
    exit /b 1
)
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -Action stop -EditorPort 3013 -ManagementPort 3014
exit /b %ERRORLEVEL%
