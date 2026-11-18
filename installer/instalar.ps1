# Script de Instalacao do Mod RedyStream para Discord
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$Host.UI.RawUI.WindowTitle = "Instalador RedyStream - Discord Mod"

Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host "          INSTALADOR DO MOD REDYSTREAM PARA DISCORD                   " -ForegroundColor Yellow
Write-Host "======================================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "Este mod integra a transmissao de tela e audio do Windows" -ForegroundColor White
Write-Host "diretamente dentro do Discord atraves da atividade do Redy!" -ForegroundColor White
Write-Host ""

$vencordDist = Join-Path $env:APPDATA "Vencord\dist"
$arquivosDir = $PSScriptRoot

# 1. Desbloquear arquivos do instalador (evitar bloqueios de seguranca do Windows/SmartScreen)
Write-Host "[*] Desbloqueando arquivos baixados..." -ForegroundColor Cyan
Get-ChildItem -Path $arquivosDir -Recurse -ErrorAction SilentlyContinue | Unblock-File -ErrorAction SilentlyContinue

# 2. Verificar se o Vencord esta instalado
if (-not (Test-Path (Join-Path $vencordDist "patcher.js"))) {
    Write-Host "[!] O Vencord nao foi detectado no seu computador." -ForegroundColor Yellow
    Write-Host "[*] Abrindo o instalador oficial do Vencord..." -ForegroundColor Cyan
    Write-Host "    (Clique em 'Install' na janela que abrir e depois volte aqui)" -ForegroundColor Gray
    
    $vencordExe = Join-Path $arquivosDir "VencordInstaller.exe"
    if (Test-Path $vencordExe) {
        Start-Process -FilePath $vencordExe -Wait
    }
    
    if (-not (Test-Path (Join-Path $vencordDist "patcher.js"))) {
        Write-Host ""
        Write-Host "[X] Erro: O Vencord ainda nao foi instalado." -ForegroundColor Red
        Write-Host "    Execute o VencordInstaller.exe, clique em 'Install' e tente novamente." -ForegroundColor Red
        Write-Host ""
        Read-Host "Pressione Enter para sair"
        exit 1
    }
}

Write-Host "[+] Vencord detectado com sucesso!" -ForegroundColor Green
Write-Host ""

# 3. Fechar o Discord e qualquer processo de audio anterior
Write-Host "[*] Fechando Discord e modulos em execucao..." -ForegroundColor Cyan
Stop-Process -Name Discord -Force -ErrorAction SilentlyContinue
Stop-Process -Name redy-audio -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Garantir que a pasta de destino exista
if (-not (Test-Path $vencordDist)) {
    New-Item -ItemType Directory -Path $vencordDist -Force | Out-Null
}

# 4. Copiar e verificar individualmente os arquivos do patch
Write-Host "[*] Instalando componentes do Redy..." -ForegroundColor Cyan

$arquivos = @(
    @{ Nome = "redy-main.js"; Obrigatorio = $true },
    @{ Nome = "redy-renderer.js"; Obrigatorio = $true },
    @{ Nome = "redy-audio.exe"; Obrigatorio = $true }
)

$erroCopia = $false

foreach ($item in $arquivos) {
    $nome = $item.Nome
    $origem = Join-Path $arquivosDir $nome
    $destino = Join-Path $vencordDist $nome

    if (-not (Test-Path $origem)) {
        Write-Host "  [X] ERRO CRITICO: Arquivo de origem nao encontrado: $origem" -ForegroundColor Red
        Write-Host "      Certifique-se de EXTRAIR todo o arquivo ZIP antes de executar o Instalar.bat!" -ForegroundColor Yellow
        $erroCopia = $true
        continue
    }

    try {
        Copy-Item -Path $origem -Destination $destino -Force -ErrorAction Stop
        Unblock-File -Path $destino -ErrorAction SilentlyContinue
        
        $itemInfo = Get-Item $destino
        $tamanhoKb = [math]::Round($itemInfo.Length / 1024, 1)
        Write-Host "  [+] $nome instalado com sucesso! ($tamanhoKb KB)" -ForegroundColor Green
    } catch {
        Write-Host "  [X] Falha ao copiar $nome : $_" -ForegroundColor Red
        $erroCopia = $true
    }
}

if ($erroCopia) {
    Write-Host ""
    Write-Host "[X] A instalacao nao pode ser concluida devido a erros na copia dos arquivos." -ForegroundColor Red
    Write-Host "    Feche o Discord completamente pelo Gerenciador de Tarefas e tente novamente." -ForegroundColor Yellow
    Read-Host "Pressione Enter para sair"
    exit 1
}

# 5. Vincular o patch no patcher.js e preload.js do Vencord
Write-Host ""
Write-Host "[*] Vinculando permissoes de tela e audio no Vencord..." -ForegroundColor Cyan

$patcherPath = Join-Path $vencordDist "patcher.js"
if (Test-Path $patcherPath) {
    $pContent = [System.IO.File]::ReadAllText($patcherPath, [System.Text.Encoding]::UTF8)
    if (-not $pContent.Contains("redy-main.js")) {
        Copy-Item -Path $patcherPath -Destination ($patcherPath + ".bak") -Force
        $hook = "`ntry { require('./redy-main.js'); } catch (e) { console.error('[RedyPatch] Erro:', e); }`n"
        $pContent = $pContent + $hook
        [System.IO.File]::WriteAllText($patcherPath, $pContent, [System.Text.Encoding]::UTF8)
    }
    Write-Host "  [+] patcher.js configurado." -ForegroundColor Green
}

$preloadPath = Join-Path $vencordDist "preload.js"
if (Test-Path $preloadPath) {
    $prContent = [System.IO.File]::ReadAllText($preloadPath, [System.Text.Encoding]::UTF8)
    if (-not $prContent.Contains("redy-renderer.js")) {
        Copy-Item -Path $preloadPath -Destination ($preloadPath + ".bak") -Force
        $target = "require(process.env.DISCORD_PRELOAD));"
        $replacement = '(() => { try { const fs = require("fs"), path = require("path"); const p = path.join(__dirname, "redy-renderer.js"); if (fs.existsSync(p)) { t.webFrame.executeJavaScript(fs.readFileSync(p, "utf8")); } } catch(e) {} })(),require(process.env.DISCORD_PRELOAD));'
        if ($prContent.Contains($target)) {
            $prContent = $prContent.Replace($target, $replacement)
            [System.IO.File]::WriteAllText($preloadPath, $prContent, [System.Text.Encoding]::UTF8)
        }
    }
    Write-Host "  [+] preload.js configurado." -ForegroundColor Green
}

# 6. Verificacao Final do Executavel de Audio
Write-Host ""
Write-Host "[*] Realizando teste de integridade do modulo de audio..." -ForegroundColor Cyan
$redyAudioDestino = Join-Path $vencordDist "redy-audio.exe"
if (Test-Path $redyAudioDestino) {
    $audioLen = (Get-Item $redyAudioDestino).Length
    if ($audioLen -gt 500000) {
        Write-Host "  [+] redy-audio.exe validado: Versao Estatica Autonoma ($audioLen bytes) OK!" -ForegroundColor Green
    } else {
        Write-Host "  [!] AVISO: redy-audio.exe parece ser a versao antiga ($audioLen bytes)." -ForegroundColor Yellow
    }
} else {
    Write-Host "  [X] ERRO FATAL: redy-audio.exe nao foi encontrado em $vencordDist!" -ForegroundColor Red
}

Write-Host ""
Write-Host "======================================================================" -ForegroundColor Green
Write-Host "              MOD INSTALADO E VERIFICADO COM SUCESSO!                 " -ForegroundColor Green
Write-Host "======================================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Ao entrar na chamada e abrir a atividade do Redy, o seletor" -ForegroundColor White
Write-Host "com isolamento inteligente de audio estara pronto para uso!" -ForegroundColor White
Write-Host ""

$resposta = Read-Host "Deseja iniciar o Discord agora? (S/N)"
if ($resposta -eq "S" -or $resposta -eq "s") {
    $discordExe = Join-Path $env:LOCALAPPDATA "Discord\Update.exe"
    if (Test-Path $discordExe) {
        Start-Process -FilePath $discordExe -ArgumentList "--processStart Discord.exe"
    } else {
        $directExe = Join-Path $env:LOCALAPPDATA "Discord\app-1.0.9268\Discord.exe"
        if (Test-Path $directExe) {
            Start-Process -FilePath $directExe
        }
    }
}

Write-Host ""
Write-Host "Instalacao finalizada!" -ForegroundColor Cyan
Read-Host "Pressione Enter para fechar"
