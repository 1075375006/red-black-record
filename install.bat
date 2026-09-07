@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo 部署失败，请查看上面的提示。
  pause
  exit /b 1
)
echo.
pause
