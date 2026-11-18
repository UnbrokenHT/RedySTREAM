# Script de Desinstalacao do Mod RedyStream
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Desinstalador RedyStream - Discord Mod"

Write-Host "======================================================================" -ForegroundColor Red
Write-Host "           DESINSTALADOR DO MOD REDYSTREAM PARA DISCORD               " -ForegroundColor Yellow
Write-Host "======================================================================" -ForegroundColor Red
Write-Host ""

$vencordDist = Join-Path $env:APPDATA "Vencord\dist"

Write-Host "[*] Fechando o Discord..." -ForegroundColor Cyan
Stop-Process -Name Discord -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$patcherBak = Join-Path $vencordDist "patcher.js.bak"
$patcherJs = Join-Path $vencordDist "patcher.js"
if (Test-Path $patcherBak) {
    Copy-Item -Path $patcherBak -Destination $patcherJs -Force
    Remove-Item -Path $patcherBak -Force -ErrorAction SilentlyContinue
}

$preloadBak = Join-Path $vencordDist "preload.js.bak"
$preloadJs = Join-Path $vencordDist "preload.js"
if (Test-Path $preloadBak) {
    Copy-Item -Path $preloadBak -Destination $preloadJs -Force
    Remove-Item -Path $preloadBak -Force -ErrorAction SilentlyContinue
}

$redyMain = Join-Path $vencordDist "redy-main.js"
if (Test-Path $redyMain) {
    Remove-Item -Path $redyMain -Force -ErrorAction SilentlyContinue
}

$redyRenderer = Join-Path $vencordDist "redy-renderer.js"
if (Test-Path $redyRenderer) {
    Remove-Item -Path $redyRenderer -Force -ErrorAction SilentlyContinue
}

$redyAudio = Join-Path $vencordDist "redy-audio.exe"
if (Test-Path $redyAudio) {
    Remove-Item -Path $redyAudio -Force -ErrorAction SilentlyContinue
}

Write-Host ""
Write-Host "[+] Mod removido com sucesso! Os arquivos originais foram restaurados." -ForegroundColor Green
Write-Host ""
Read-Host "Pressione Enter para finalizar"
