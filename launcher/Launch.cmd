@echo off
setlocal EnableDelayedExpansion

REM ============================================================================
REM  Personal Finance Analyser - Launch.cmd
REM  ============================================================================
REM  This is the true entry point into the app. A person just double-clicks
REM  this file. Everything below exists to catch the handful of ways that can
REM  go wrong BEFORE anything appears on screen, so the first thing a person
REM  ever sees is either the app itself, or one plain sentence telling them
REM  exactly what to do next. Nobody should ever see a PowerShell window,
REM  a stack trace, or a silent nothing-happened.
REM
REM  What this file checks, in order, and why:
REM    1. Is the app still inside a ZIP file that was never extracted?
REM       (The single most common first-run mistake - Windows runs it from a
REM       temporary folder that gets deleted, so nothing will work reliably.)
REM    2. Is launch.ps1 actually here? (Catches an incomplete download, a
REM       half-finished OneDrive sync, or someone copying only part of the
REM       folder.)
REM    3. Does this computer have PowerShell at all? (Built into Windows since
REM       Windows 7, so missing almost always means a heavily locked-down or
REM       stripped-down machine.)
REM    4. Is PowerShell allowed to run scripts here? This is different from
REM       (3): PowerShell can be present but blocked by the organisation's own
REM       security policy, which -ExecutionPolicy Bypass cannot override when
REM       that policy is set centrally. This is tested directly rather than
REM       guessed at.
REM    5. Is the app already open? (Stops a second double-click from opening
REM       two copies side by side.)
REM
REM  Only once all five pass does the real app start, with its console window
REM  hidden immediately so the person only ever sees the app's own window.
REM
REM  Every check writes one line to a dated log in the logs folder next to
REM  this file, so a mis-set-up machine can be diagnosed after the fact
REM  without asking the person what happened. If the logs folder cannot be
REM  written to (for example, a read-only USB drive), the app still opens;
REM  logging is a convenience, never a requirement to start.
REM
REM  Locked-down corporate machines: if step 4 fails, this points to
REM  setup.bat in the main folder, which carries the fuller work-network
REM  fallback steps and is intended to be run once with IT's help.
REM ============================================================================

title Personal Finance Analyser

set "APP_TITLE=Personal Finance Analyser"
set "SCRIPT_DIR=%~dp0"
set "PS1_PATH=%SCRIPT_DIR%launch.ps1"
set "LOG_DIR=%SCRIPT_DIR%logs"
set "SETUP_BAT=%SCRIPT_DIR%..\setup.bat"

REM --- Step 1: still inside a ZIP file? ---------------------------------------
REM Windows Explorer opens ZIP contents "in place" from a temporary folder,
REM usually somewhere under AppData\Local\Temp. Running from there is the
REM classic "I double-clicked it straight from Downloads" mistake, and nothing
REM saved there will persist. This is a best-effort check on the folder path;
REM it will not catch every possible case, but it catches the common one.
echo(%SCRIPT_DIR% | findstr /I /C:"\Temp\" >nul
if not errorlevel 1 goto ErrZip

REM --- Step 2: is launch.ps1 actually here? ------------------------------------
if not exist "%PS1_PATH%" goto ErrMissingFile

REM --- Step 3: does this computer have PowerShell? -----------------------------
where powershell.exe >nul 2>&1
if errorlevel 1 goto ErrNoPowerShell

REM From here on PowerShell is confirmed present, so it is safe to use it for
REM a proper timestamp (locale-proof, unlike %date%/%time%) and for logging.
for /f "usebackq delims=" %%s in (`powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmmss"`) do set "STAMP=%%s"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
set "LOG_FILE=%LOG_DIR%\launcher-%STAMP%.log"
call :Log "Launch.cmd started."

REM --- Step 4: is PowerShell actually allowed to run scripts here? -------------
REM A machine-level security policy can block script execution regardless of
REM -ExecutionPolicy Bypass, which only ever wins at the per-process level.
REM The only reliable way to know is to try running a real, tiny script file
REM and see what happens, rather than guess from settings alone. The test
REM file lives in the user's own temp folder, not this app's folder, so the
REM check still works even if this folder is on read-only media.
set "SELFTEST=%TEMP%\pfa_selftest_%RANDOM%.ps1"
(echo exit 0) > "%SELFTEST%" 2>nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%SELFTEST%" >nul 2>&1
set "SELFTEST_RC=%ERRORLEVEL%"
del /f /q "%SELFTEST%" >nul 2>&1
if not "%SELFTEST_RC%"=="0" goto ErrPolicyBlocked

REM --- Step 5: is a copy already open? ------------------------------------------
REM The app's own window is always titled exactly "Personal Finance Analyser",
REM so this checks for that specific window rather than any PowerShell process,
REM which would otherwise also match unrelated PowerShell windows on screen.
tasklist /FI "WINDOWTITLE eq %APP_TITLE%" /FI "IMAGENAME eq powershell.exe" 2>nul | find /I "powershell.exe" >nul
if not errorlevel 1 goto ErrAlreadyRunning

REM --- All clear: start the app --------------------------------------------------
REM -WindowStyle Hidden keeps the console out of sight; the app's own window
REM opens independently and is unaffected by this, so the person only ever
REM sees the one window they care about. This does not wait for the app to
REM close, so double-clicking feels instant.
call :Log "All checks passed. Starting the app."
start "%APP_TITLE%" /MIN powershell.exe -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%PS1_PATH%"
exit /b 0


REM ============================================================================
REM  Error branches - one plain message each, always logged, always paused
REM  so the window stays on screen long enough to read before it closes.
REM ============================================================================

:ErrZip
echo.
echo   This app is still inside a ZIP file, so Windows is running it from a
echo   temporary folder that will be deleted later. Nothing will save properly
echo   from here.
echo.
echo   To fix this:
echo     1. Close this window.
echo     2. Right-click the ZIP file and choose "Extract All..."
echo     3. Open the extracted folder and double-click Launch.cmd there.
echo.
call :Log "Blocked: running from what looks like an unextracted ZIP (%SCRIPT_DIR%)."
pause
exit /b 1

:ErrMissingFile
echo.
echo   A required file is missing: launch.ps1
echo.
echo   This usually means the app folder is incomplete, perhaps a download or
echo   a OneDrive sync did not finish. Re-download or re-sync the whole folder,
echo   then try again.
echo.
call :Log "Blocked: launch.ps1 not found at %PS1_PATH%."
pause
exit /b 1

:ErrNoPowerShell
echo.
echo   Windows PowerShell was not found on this computer.
echo.
echo   PowerShell is normally built into Windows. Please contact your IT
echo   support so they can check why it is missing here.
echo.
REM PowerShell itself is unavailable, so a plain timestamp is used instead.
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%" >nul 2>&1
>> "%LOG_DIR%\launcher-fallback.log" echo [%date% %time%] Blocked: powershell.exe not found on PATH.
pause
exit /b 1

:ErrPolicyBlocked
echo.
echo   This computer's security settings are blocking PowerShell scripts from
echo   running, even for this app.
echo.
echo   Please contact your IT support and ask them to allow this app to run,
echo   or ask them to run setup.bat in the main folder, which has the fuller
echo   steps for locked-down company computers.
echo.
call :Log "Blocked: script execution self-test failed (exit code %SELFTEST_RC%), likely a machine-level PowerShell policy."
pause
exit /b 1

:ErrAlreadyRunning
echo.
echo   Personal Finance Analyser is already open.
echo.
echo   Check your taskbar, or press Alt+Tab, to find its window.
echo.
call :Log "Blocked: the app is already open (matching window found)."
pause
exit /b 1


REM ============================================================================
REM  Small helper: append one line to today's log. Failure to write is not
REM  treated as an error, since running the app must never depend on a log
REM  file, for example when this folder sits on read-only or portable media.
REM ============================================================================
:Log
>> "%LOG_FILE%" echo [%date% %time%] %~1 2>nul
goto :eof