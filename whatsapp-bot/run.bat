@echo off
cd /d "%~dp0"
:loop
call npm start >> bot.log 2>&1
timeout /t 5 /nobreak >nul
goto loop
