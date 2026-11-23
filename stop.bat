@echo off
setlocal EnableExtensions
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "GUI=%~dp0EditorPluginManager.ps1"
if not exist "%PS%" (echo ERROR: Windows PowerShell unavailable. & exit /b 1)
if not exist "%GUI%" (echo ERROR: EditorPluginManager.ps1 missing. & exit /b 1)
if /I "%~1"=="--no-pause" (
    "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%GUI%" -Mode Stop -NoPause
) else (
    "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%GUI%" -Mode Stop
)
exit /b %errorlevel%
