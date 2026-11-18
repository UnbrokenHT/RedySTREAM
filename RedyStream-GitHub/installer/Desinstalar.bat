@echo off
setlocal
cd /d "%~dp0"
title Desinstalador RedyStream - Discord Mod
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0arquivos\desinstalar.ps1"
if %errorlevel% neq 0 (
    echo.
    echo Ocorreu um erro durante a desinstalacao.
    pause
)
endlocal
