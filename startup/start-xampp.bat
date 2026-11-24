@echo off
setlocal
TITLE Exam Scanner - Start XAMPP
set "LOG_DIR=C:\xampp\htdocs\exam-scanner\startup\logs"
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"
set "LOG_FILE=%LOG_DIR%\startup-xampp.log"
echo [%date% %time%] Checking Apache and MySQL startup.>> "%LOG_FILE%"

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [%date% %time%] Apache not listening on port 80. Starting Apache...>> "%LOG_FILE%"
  start "XAMPP Apache" /min cmd /c "cd /d C:\xampp && apache_start.bat"
  ping -n 6 127.0.0.1 >nul
) else (
  echo [%date% %time%] Apache already listening on port 80.>> "%LOG_FILE%"
)

powershell -NoProfile -Command "if (Get-NetTCPConnection -LocalPort 3306 -State Listen -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }"
if errorlevel 1 (
  echo [%date% %time%] MySQL not listening on port 3306. Starting MySQL...>> "%LOG_FILE%"
  start "XAMPP MySQL" /min cmd /c "cd /d C:\xampp && mysql_start.bat"
  ping -n 6 127.0.0.1 >nul
) else (
  echo [%date% %time%] MySQL already listening on port 3306.>> "%LOG_FILE%"
)

echo [%date% %time%] XAMPP startup check complete.>> "%LOG_FILE%"
exit /b 0

