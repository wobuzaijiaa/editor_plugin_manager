@echo off
setlocal EnableExtensions
rem Stop only standard services owned by the matching launcher.
rem --no-pause is used internally when Start handles the keypress.
set "NO_PAUSE="
if /I "%~1"=="--no-pause" set "NO_PAUSE=1"
set "ROOT=%~dp0"
set "HELPER=%ROOT%editor_services.mjs"
set "RESULT=1"

if not exist "%HELPER%" (
    echo ERROR: Missing editor_services.mjs next to this BAT.
    goto :finish
)
where node.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not available on PATH.
    goto :finish
)
cd /d "%ROOT%"
if errorlevel 1 (
    echo ERROR: Cannot switch to project root.
    goto :finish
)

echo Stopping SuperSplat Editor and management backend...
node "%HELPER%" stop
if errorlevel 1 (
    echo ERROR: Controlled shutdown incomplete. Inspect logs\run_logs\.
    goto :finish
)
set "RESULT=0"

:finish
if not defined NO_PAUSE (
    echo.
    if "%RESULT%"=="0" (
        echo Shutdown completed. Press any key to close this window.
    ) else (
        echo Shutdown was not confirmed. Review the error above.
        echo Press any key to close this window.
    )
    pause >nul
)
endlocal & exit /b %RESULT%
