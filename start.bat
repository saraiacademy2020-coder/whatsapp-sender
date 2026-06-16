@echo off
cd /d "%~dp0"
echo Installing dependencies (if needed)...
call npm install
cls
echo ====================================
echo   WhatsApp Sender is starting...
echo ====================================
echo   Admin: http://localhost:3000/admin
echo   Client: http://localhost:3000/client
echo ====================================
echo.
timeout /t 3 /nobreak >nul
start http://localhost:3000/
call npm start
echo.
echo Server stopped. Press any key to close this window.
pause
