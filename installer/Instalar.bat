@echo off
setlocal
cd /d "%~dp0"
title Instalador RedyStream - Discord Mod
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0arquivos\instalar.ps1"
if %errorlevel% neq 0 (
    echo.
    echo Ocorreu um erro ou a instalacao foi interrompida.
    pause
)
endlocal
