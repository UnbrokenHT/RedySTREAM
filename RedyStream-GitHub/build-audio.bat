@echo off
setlocal
cd /d "%~dp0"

echo ===================================================
echo     Compilador do Modulo de Audio (redy-audio.exe)
echo ===================================================
echo.

where g++ >nul 2>nul
if %errorlevel% equ 0 (
    echo [*] MinGW g++ detectado. Compilando com otimizacoes e estatico...
    g++ -O3 -std=c++17 src\redy-audio.cpp -o dist\redy-audio.exe -static -lwinmm -lole32 -luuid -lkernel32 -luser32
    if %errorlevel% equ 0 (
        echo [+] Compilado com sucesso: dist\redy-audio.exe
        goto fim
    ) else (
        echo [X] Erro ao compilar com g++.
    )
)

where cl >nul 2>nul
if %errorlevel% equ 0 (
    echo [*] Microsoft Visual C++ (MSVC) detectado. Compilando...
    cl /O2 /EHsc /std:c++17 src\redy-audio.cpp /link /OUT:dist\redy-audio.exe winmm.lib ole32.lib uuid.lib kernel32.lib user32.lib
    if %errorlevel% equ 0 (
        echo [+] Compilado com sucesso: dist\redy-audio.exe
        goto fim
    ) else (
        echo [X] Erro ao compilar com MSVC.
    )
)

echo.
echo [!] Nenhum compilador C++ (g++ ou cl.exe) foi encontrado no PATH.
echo     Instale o MinGW-w64 ou o Visual Studio Build Tools para compilar.
echo.

:fim
pause
endlocal
