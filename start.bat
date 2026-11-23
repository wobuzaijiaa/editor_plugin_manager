@echo off
setlocal EnableExtensions
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "GUI=%~dp0EditorPluginManager.ps1"
if not exist "%PS%" (echo ERROR: Windows PowerShell unavailable. & exit /b 1)
if not exist "%GUI%" (echo ERROR: EditorPluginManager.ps1 missing. & exit /b 1)
if not "%~3"=="" (echo Usage: start.bat [EditorPort] [ManagementPort] & exit /b 2)
if "%~1"=="" (
    if "%~2"=="" (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%GUI%" -Mode Start
    ) else (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%GUI%" -Mode Start -ManagementPort "%~2"
    )
) else (
    if "%~2"=="" (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%GUI%" -Mode Start -EditorPort "%~1"
    ) else (
        "%PS%" -NoProfile -ExecutionPolicy Bypass -File "%GUI%" -Mode Start -EditorPort "%~1" -ManagementPort "%~2"
    )
)
exit /b %errorlevel%
