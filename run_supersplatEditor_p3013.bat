@echo off
setlocal EnableExtensions
rem Run Architecture C from the existing built/deployed Editor. Never clone/build/copy.
set "ROOT=%~dp0"
set "HELPER=%ROOT%start_architecture_c.ps1"
if not exist "%HELPER%" (
    echo ERROR: Missing start_architecture_c.ps1 at project root.
    goto fail
)
echo =============================================
echo  SuperSplat Editor - Architecture C
 echo  Editor:  http://127.0.0.1:3013
 echo  Manager: http://127.0.0.1:3014
 echo =============================================
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%HELPER%" -Action start -EditorPort 3013 -ManagementPort 3014
if errorlevel 1 goto fail
start "" "http://127.0.0.1:3013/"
echo.
echo Services started. Press any key to stop both, or use stop_supersplatEditor_p3013.bat.
pause >nul
call "%ROOT%stop_supersplatEditor_p3013.bat"
exit /b %ERRORLEVEL%
:fail
echo.
echo Startup failed. The Editor was not rebuilt or modified.
pause
exit /b 1
