@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0clean-runtime.ps1" %*
exit /b %ERRORLEVEL%
