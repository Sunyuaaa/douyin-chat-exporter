@echo off
chcp 65001 >nul
title DouyinExporter
cd /d "%~dp0"

set "_PS1=%TEMP%\douyin_launcher_%RANDOM%.ps1"

rem === 1) Kill old instance: multi-instance grabs the WebView2 lock in Data\ and causes a white screen ===
> "%_PS1%" echo $p = Get-CimInstance Win32_Process ^| Where-Object { $_.Name -eq 'pythonw.exe' -and $_.CommandLine -match 'DouyinExporter' -and $_.CommandLine -match 'app\.py' }
>>"%_PS1%" echo if ($p) { $p ^| ForEach-Object { taskkill /PID $_.ProcessId /T /F ^| Out-Null } }
powershell -NoProfile -ExecutionPolicy Bypass -File "%_PS1%"
del "%_PS1%" >nul 2>&1
powershell -NoProfile -Command "Start-Sleep -Seconds 1"

rem === 2) First run: create .venv and install dependencies if missing ===
if not exist ".venv\Scripts\pythonw.exe" (
    where python >nul 2>nul
    if errorlevel 1 (
        echo [ERROR] .venv not found and system Python is missing.
        echo         Install Python 3.10+ first: https://www.python.org/downloads/
        pause
        exit /b 1
    )
    echo First run: installing dependencies ...
    python -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] pip install failed.
        pause
        exit /b 1
    )
    echo Starting with system Python ...
    start "" python app.py <nul >nul 2>&1
    goto :verify
)

rem === 3) Silent start (no console window; logs go to boot.log) ===
rem     Redirect child IO so it never holds the parent console/pipe open
start "" ".venv\Scripts\pythonw.exe" app.py <nul >nul 2>&1

:verify
rem === 4) One powershell call, poll internally up to 5s: pythonw needs a moment to spawn ===
> "%_PS1%" echo for ($i=0; $i -lt 10; $i++) { if (Get-CimInstance Win32_Process ^| Where-Object { $_.CommandLine -match 'DouyinExporter' -and $_.CommandLine -match 'app\.py' }) { exit 0 }; Start-Sleep -Milliseconds 500 }
>>"%_PS1%" echo exit 1
powershell -NoProfile -ExecutionPolicy Bypass -File "%_PS1%"
set _RC=%ERRORLEVEL%
del "%_PS1%" >nul 2>&1
if not "%_RC%"=="0" (
    echo [ERROR] App failed to start. Check boot.log in this folder.
    pause
    exit /b 1
)
echo OK: DouyinExporter started. Log: boot.log
endlocal
