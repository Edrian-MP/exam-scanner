@echo off
setlocal
TITLE Exam Scanner - Web App

echo Waiting 15 seconds before opening the web app...
ping -n 16 127.0.0.1 >nul

for /f "delims=" %%I in ('powershell -NoProfile -Command "Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred' } | Select-Object -First 1 -ExpandProperty IPAddress"') do set "TPC_IP=%%I"

if "%TPC_IP%"=="" (
  echo.
  echo Could not detect network IP automatically.
  echo Check Wi-Fi connection, then reopen this window.
  echo.
  pause
  exit /b 1
)

set "WEBAPP_LOCAL=http://localhost/exam-scanner/dist/"
set "WEBAPP_NETWORK=http://%TPC_IP%/exam-scanner/dist/"

echo.
echo Exam Scanner web app ready
echo.
echo   Local:   %WEBAPP_LOCAL%
echo   Network: %WEBAPP_NETWORK%
echo.
echo Opening local web app...
start "" "%WEBAPP_LOCAL%"

echo.
echo Keep this window open to see the access links.
pause
exit /b 0
