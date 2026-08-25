@echo off
setlocal

title PFA Notes Assistant

set "SCRIPT_DIR=%~dp0"
set "PS1_PATH=%SCRIPT_DIR%launch-assistant.ps1"

echo(%SCRIPT_DIR% | findstr /I /C:"\Temp\" >nul
if not errorlevel 1 goto ErrZip

if not exist "%PS1_PATH%" goto ErrMissingFile

where powershell.exe >nul 2>&1
if errorlevel 1 goto ErrNoPowerShell

set "SELFTEST=%TEMP%\pfa_notes_selftest_%RANDOM%.ps1"
(echo exit 0) > "%SELFTEST%" 2>nul

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SELFTEST%" >nul 2>&1
set "SELFTEST_RC=%ERRORLEVEL%"

del /f /q "%SELFTEST%" >nul 2>&1

if not "%SELFTEST_RC%"=="0" goto ErrPolicyBlocked

start "PFA Notes Assistant" /MIN powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%PS1_PATH%"
exit /b 0

:ErrZip
echo.
echo   The notes assistant is still inside a ZIP file.
echo.
echo   Extract the whole PFA folder, then open this shortcut again.
echo.
pause
exit /b 1

:ErrMissingFile
echo.
echo   A required file is missing:
echo.
echo   launch-assistant.ps1
echo.
echo   Restore or re-sync the complete assistant-launcher folder, then try again.
echo.
pause
exit /b 1

:ErrNoPowerShell
echo.
echo   Windows PowerShell was not found on this computer.
echo.
echo   Contact IT support so they can check why it is unavailable.
echo.
pause
exit /b 1

:ErrPolicyBlocked
echo.
echo   This computer is blocking PowerShell scripts.
echo.
echo   Contact IT support and ask them to allow this local PFA tool to run.
echo.
pause
exit /b 1
