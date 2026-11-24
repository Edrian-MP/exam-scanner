@echo off
setlocal
TITLE Exam Scanner - Scanner Service
set "APP_DIR=C:\xampp\htdocs\exam-scanner"
set "PYTHON_EXE=C:\Users\Thesis\AppData\Local\Programs\Python\Python312\python.exe"
set "LOG_DIR=%APP_DIR%\startup\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LOG_FILE=%LOG_DIR%\startup-scanner.log"

echo [%date% %time%] Waiting for XAMPP services before scanner startup...>> "%LOG_FILE%"
ping -n 9 127.0.0.1 >nul

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 5001 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if not errorlevel 1 (
  echo [%date% %time%] scanner-service already listening on 127.0.0.1:5001.>> "%LOG_FILE%"
  echo scanner-service is already running on 127.0.0.1:5001.
  ping -n 6 127.0.0.1 >nul
  exit /b 0
)

cd /d "%APP_DIR%"
echo [%date% %time%] Starting scanner-service/main.py.>> "%LOG_FILE%"
echo Starting scanner-service/main.py...
echo Keep this window open while scanning. Close it only when shutting down the scanner service.
"%PYTHON_EXE%" scanner-service\main.py

echo [%date% %time%] scanner-service exited with code %errorlevel%.>> "%LOG_FILE%"
echo.
echo scanner-service stopped. Check the messages above for details.
pause

