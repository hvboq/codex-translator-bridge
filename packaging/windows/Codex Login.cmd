@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\login.ps1"
if errorlevel 1 pause
exit /b %ERRORLEVEL%
