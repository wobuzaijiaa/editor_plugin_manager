@echo off
setlocal EnableExtensions
rem Standard Architecture C: run the existing supersplat/dist/; do not build or install.
set "ROOT=%~dp0"
set "HELPER=%ROOT%editor_services.mjs"
set "EDITOR_PORT=%~1"
set "MANAGEMENT_PORT=%~2"
if not defined EDITOR_PORT set "EDITOR_PORT=3013"
if not defined MANAGEMENT_PORT set "MANAGEMENT_PORT=3014"

if not "%~3"=="" (
    echo Usage: run_supersplatEditor_p3013.bat [EditorPort] [ManagementPort]
    exit /b 2
)
if not exist "%HELPER%" (
    echo ERROR: Missing editor_services.mjs next to this BAT.
    exit /b 1
)
if not exist "%ROOT%supersplat\dist\runtime\management-server.cjs" (
    echo ERROR: Missing supersplat\dist\runtime\management-server.cjs.
    exit /b 1
)
where node.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js is not available on PATH.
    exit /b 1
)
cd /d "%ROOT%" || exit /b 1

echo =============================================
echo  SuperSplat Editor - Plugin Manager v1.13 - Architecture C
echo  Editor:  http://127.0.0.1:%EDITOR_PORT%/
echo  Manager: http://127.0.0.1:%MANAGEMENT_PORT%/
echo =============================================
node "%HELPER%" start "%EDITOR_PORT%" "%MANAGEMENT_PORT%"
if errorlevel 1 (
    echo ERROR: Startup failed. See the latest logs\run_logs\ folder.
    pause
    exit /b 1
)
start "" "http://127.0.0.1:%EDITOR_PORT%/"
rem Read-only native listener monitoring shares this terminal; no fixed plugin ports.
start "" /B node "%HELPER%" watch
echo.
echo Services started. Press any key to stop both,
echo or use stop_supersplatEditor_p3013.bat in another terminal.
pause >nul
call "%ROOT%stop_supersplatEditor_p3013.bat" --no-pause
if errorlevel 1 (
    echo WARNING: Controlled shutdown did not complete. Check logs\run_logs\.
    exit /b 1
)
exit /b 0
