@echo off
setlocal EnableExtensions
set "GUI=%~dp0EditorPluginManager.ps1"
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%GUI%" (
    echo ERROR: EditorPluginManager.ps1 is missing.
    pause
    exit /b 1
)
if not exist "%PS%" (
    echo ERROR: Windows PowerShell is unavailable.
    pause
    exit /b 1
)
start "" "%PS%" -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%GUI%"
exit /b %errorlevel%
