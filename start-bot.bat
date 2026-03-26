@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Запуск бота из: %CD%
node src/index.js
echo.
echo Бот остановлен. Нажми любую клавишу...
pause >nul
