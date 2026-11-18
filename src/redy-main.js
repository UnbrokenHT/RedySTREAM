// RedyStream - Patch do Processo Principal (Electron / Discord)
// Mod Nativo com Isolamento Inteligente de Áudio (Process Loopback WASAPI)
// Elimina o eco do Discord na transmissão sem requerer VB-Cable
"use strict";

const { app, session, desktopCapturer, shell, BrowserWindow } = require("electron");
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");

// Ativação Completa de Aceleração por Hardware na GPU (NVIDIA NVENC / D3D11)
// Reduz drasticamente o uso de CPU transferindo a codificação de vídeo para a placa de vídeo
// Elimina micro-stuttering e quedas de FPS em segundo plano durante jogos
try {
    app.commandLine.appendSwitch("enable-gpu-rasterization");
    app.commandLine.appendSwitch("enable-zero-copy");
    app.commandLine.appendSwitch("ignore-gpu-blocklist");
    app.commandLine.appendSwitch("enable-hardware-overlays", "single-fullscreen,single-on-top,underlay");
    app.commandLine.appendSwitch("use-gl", "angle");
    app.commandLine.appendSwitch("use-angle", "d3d11");
    app.commandLine.appendSwitch("enable-accelerated-video-decode");
    app.commandLine.appendSwitch("enable-accelerated-video-encode");
    
    // Suavidade extrema (60 FPS fluidos, sem throttling em segundo plano ou oclusão)
    app.commandLine.appendSwitch("disable-renderer-backgrounding");
    app.commandLine.appendSwitch("disable-background-timer-throttling");
    app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
    app.commandLine.appendSwitch("max-gum-fps", "60");
    app.commandLine.appendSwitch("force_high_performance_gpu");
    app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion");
    app.commandLine.appendSwitch("enable-features", "WebRtcHWEncoding,WebRtcHWDecoding,CanvasOopRasterization,D3D11VideoDecoder,PlatformHEVCDecoderSupport,WebRtcAllowInputVolumeModification,WebRtcSendPacedInterval");
    app.commandLine.appendSwitch("force-webrtc-ip-handling-policy", "default_public_interface_only");
    app.commandLine.appendSwitch("webrtc-max-cpu-consumption-percentage", "100");
} catch (_) {}

const LOG_FILE = path.join(os.tmpdir(), "redy_debug.log");

function log(...args) {
    const timestamp = new Date().toLocaleTimeString();
    const msg = `[${timestamp}] [RedyMain] ${args.map(a => typeof a === "object" ? JSON.stringify(a) : a).join(" ")}\n`;
    try {
        fs.appendFileSync(LOG_FILE, msg);
    } catch (_) {}
    console.log(`[RedyMain]`, ...args);
}

log("==========================================");
log("Módulo RedyMain carregado com Suporte Nativo a Áudio Isolado (HTTP Stream).");
log("==========================================");

const REDY_AUDIO_EXE = path.join(__dirname, "redy-audio.exe");

let janelaTransmissao = null;
let ultimaEscolhaUsuario = null;
let timestampUltimaEscolha = 0;

let audioConfigAtual = {
    modo: "exclude_discord",
    hwnd: null
};

let redyAudioProcess = null;
let audioHttpPort = 0;
let clientesAtivos = new Set();

// ==========================================
// Servidor de Streaming de Áudio Local (HTTP Chunked Stream)
// 100% Compatível com CSP e Políticas de Segurança do Navegador
// ==========================================
const audioServer = http.createServer((req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
    }

    if (req.url === "/audio.pcm") {
        log("[RedyAudioServer] Conexão HTTP para /audio.pcm recebida!");

        if (res.socket) {
            try {
                res.socket.setNoDelay(true); // Desativa algoritmo de Nagle (entrega imediata de frames sem delay de 40ms)
                res.socket.setKeepAlive(true, 1000);
            } catch (_) {}
        }

        res.writeHead(200, {
            "Content-Type": "application/octet-stream",
            "Transfer-Encoding": "chunked",
            "Cache-Control": "no-cache, no-store",
            "Connection": "keep-alive"
        });

        if (res.socket) {
            try {
                res.socket.setNoDelay(true);
                res.socket.setKeepAlive(true);
            } catch (_) {}
        }

        if (audioConfigAtual.modo === "mudo" || audioConfigAtual.modo === "loopback_padrao" || !fs.existsSync(REDY_AUDIO_EXE)) {
            log("[RedyAudioServer] Transmissão via helper inativa (Modo:", audioConfigAtual.modo, ")");
            res.end();
            return;
        }

        clientesAtivos.add(res);

        // Se o processo de captura em C++ ainda não estiver rodando, inicia agora
        if (!redyAudioProcess) {
            let args = [];
            if (audioConfigAtual.modo === "include_hwnd" && audioConfigAtual.hwnd) {
                args = ["--include-hwnd", String(audioConfigAtual.hwnd)];
                log("[RedyAudioServer] Iniciando captura isolada para janela HWND:", audioConfigAtual.hwnd);
            } else {
                args = ["--exclude-discord"];
                log("[RedyAudioServer] Iniciando captura isolada excluindo Discord.");
            }

            try {
                redyAudioProcess = spawn(REDY_AUDIO_EXE, args, {
                    stdio: ["ignore", "pipe", "pipe"]
                });

                redyAudioProcess.stdout.on("data", (chunk) => {
                    for (const cliente of clientesAtivos) {
                        try {
                            cliente.write(chunk);
                        } catch (_) {}
                    }
                });

                redyAudioProcess.stderr.on("data", (data) => {
                    log("[RedyAudioServer STDERR]", data.toString().trim());
                });

                redyAudioProcess.on("exit", (code) => {
                    log("[RedyAudioServer] redy-audio.exe finalizado com código:", code);
                    redyAudioProcess = null;
                });

                redyAudioProcess.on("error", (err) => {
                    log("[RedyAudioServer] Erro ao executar redy-audio.exe:", err);
                    redyAudioProcess = null;
                });
            } catch (err) {
                log("[RedyAudioServer] Falha fatal ao iniciar redy-audio.exe:", err);
            }
        }

        req.on("close", () => {
            log("[RedyAudioServer] Cliente desconectado de /audio.pcm.");
            clientesAtivos.delete(res);
            if (clientesAtivos.size === 0 && redyAudioProcess) {
                log("[RedyAudioServer] Nenhum cliente restante. Encerrando processo de áudio...");
                try { redyAudioProcess.kill(); } catch (_) {}
                redyAudioProcess = null;
            }
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

audioServer.listen(0, "127.0.0.1", () => {
    audioHttpPort = audioServer.address().port;
    log(`[RedyAudioServer] Servidor de streaming HTTP pronto na porta local ${audioHttpPort}`);
});

// ==========================================
// Script Injetado no DOM da Janela do Redy
// ==========================================
function gerarScriptDOM(httpPort) {
    return `
(function() {
    console.log("[RedyProAudio] Inicializando Motor de Áudio Contínuo e Estabilizador de Stream...");

    // 1. Estabilizador do Playout Buffer no Receptor (Trava jitterBufferTarget e playoutDelayHint)
    if (window.RTCRtpReceiver) {
        try {
            Object.defineProperty(RTCRtpReceiver.prototype, "playoutDelayHint", {
                get() { return 0.10; },
                set(v) { /* Travado em 100ms para estabilidade perfeita */ }
            });
        } catch (_) {}
        try {
            Object.defineProperty(RTCRtpReceiver.prototype, "jitterBufferTarget", {
                get() { return 100; },
                set(v) { /* Travado em 100ms para estabilidade perfeita */ }
            });
        } catch (_) {}
    }

    // 2. Jitter Buffer Inteligente no AudioContext (Elimina o buraco de 100ms de silêncio do agendador nativo do Redy)
    if (window.AudioBufferSourceNode && !window.__redyAudioJitterFixed) {
        window.__redyAudioJitterFixed = true;
        const origStart = AudioBufferSourceNode.prototype.start;

        AudioBufferSourceNode.prototype.start = function(when, offset, duration) {
            const ctx = this.context;
            if (!ctx) return origStart.call(this, when, offset, duration);

            const now = ctx.currentTime;
            // Se for início de stream ou após silêncio real (> 350ms):
            if (!ctx.__proximoTempoAudio || ctx.__proximoTempoAudio < now || (ctx.__proximoTempoAudio - now) > 0.45) {
                ctx.__proximoTempoAudio = now + 0.050; // Buffer seguro e imperceptível de 50ms
            }

            const tempo = ctx.__proximoTempoAudio;
            const dur = (this.buffer && this.buffer.duration) ? this.buffer.duration : 0.020;
            ctx.__proximoTempoAudio += dur;

            return origStart.call(this, tempo, offset, duration);
        };
        console.log("[RedyProAudio] Jitter Buffer de Áudio Contínuo ativado!");
    }

    // 3. Travar configurações de estabilidade e taxa moderada no Redy (evita sobrecarga no SFU)
    try {
        localStorage.setItem("redylive:shareFps", "60");
        localStorage.setItem("redylive:shareBitrate", "high");
        localStorage.setItem("redylive:qualidadeAutomatica", "false");
        localStorage.setItem("redylive:degradacao", "movimento");
    } catch (_) {}

    // 4. Hook no WebRTC: Prioridade Absoluta para Áudio e Degradação de Vídeo em Quedas de Rede
    if (window.RTCPeerConnection && !window.__redyRtcHooked) {
        window.__redyRtcHooked = true;
        const OrigPC = window.RTCPeerConnection;
        window.RTCPeerConnection = function(...args) {
            const pc = new OrigPC(...args);
            const origAddTrack = pc.addTrack.bind(pc);

            pc.addTrack = function(track, ...streams) {
                if (track) {
                    if (track.kind === "video") {
                        try { track.contentHint = "motion"; } catch (_) {}
                    } else if (track.kind === "audio") {
                        try { track.contentHint = "music"; } catch (_) {}
                    }
                }
                const sender = origAddTrack(track, ...streams);
                
                setTimeout(() => {
                    try {
                        const params = sender.getParameters();
                        if (params && params.encodings && params.encodings.length > 0) {
                            if (track && track.kind === "video") {
                                // Vídeo com taxa cravada em 3.8 Mbps e degradação de resolução suave em picos (estilo Discord)
                                params.degradationPreference = "maintain-framerate";
                                params.encodings[0].priority = "low";
                                params.encodings[0].maxBitrate = 3800000;
                            } else if (track && track.kind === "audio") {
                                // Áudio tem PRIORIDADE MÁXIMA ininterrupta na rede
                                params.encodings[0].priority = "high";
                                params.encodings[0].maxBitrate = 128000;
                            }
                            sender.setParameters(params).catch(() => {});
                        }
                    } catch (_) {}
                }, 400);

                return sender;
            };

            // Otimização de SDP para ativar Forward Error Correction (Opus FEC) e CBR
            const origSetLocal = pc.setLocalDescription.bind(pc);
            pc.setLocalDescription = function(desc) {
                if (desc && desc.sdp) {
                    desc.sdp = desc.sdp.replace(
                        /useinbandfec=1/g,
                        "useinbandfec=1;cbr=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000"
                    );
                }
                return origSetLocal(desc);
            };

            return pc;
        };
        window.RTCPeerConnection.prototype = OrigPC.prototype;
    }

    // 5. API Desktop Nativa com entrega alinhada e contínua
    if (!window.redyliveDesktop) {
        window.redyliveDesktop = {};
    }

    window.redyliveDesktop.audioDoSistema = {
        disponivel: async () => {
            console.log("[RedyDesktopAudio] Checando disponibilidade do áudio nativo... (Porta: ${httpPort})");
            if (window.__redyModoAudioEscolhido === "loopback_padrao" || window.__redyModoAudioEscolhido === "mudo") {
                console.log("[RedyDesktopAudio] Modo é loopback_padrao ou mudo. Entregando via Chromium.");
                return false;
            }
            return true;
        },
        motivoDaFalha: async () => null,
        ouvir: (callbackReal) => {
            console.log("[RedyDesktopAudio] Canal de áudio aberto. Conectando leitor de fluxo direto!");
            const abortCtrl = new AbortController();
            let ativo = true;

            async function iniciarStream() {
                try {
                    const streamUrl = "http://127.0.0.1:${httpPort}/audio.pcm";
                    console.log("[RedyDesktopAudio] Conectando ao fluxo HTTP de áudio:", streamUrl);
                    const resp = await fetch(streamUrl, { signal: abortCtrl.signal });
                    if (!resp.ok || !resp.body) return;

                    const reader = resp.body.getReader();
                    console.log("[RedyDesktopAudio] Leitor de fluxo HTTP pronto!");
                    
                    let sobra = new Uint8Array(0);

                    while (ativo) {
                        const { done, value } = await reader.read();
                        if (done) break;
                        if (value && value.length > 0) {
                            let dados;
                            if (sobra.length > 0) {
                                dados = new Uint8Array(sobra.length + value.length);
                                dados.set(sobra, 0);
                                dados.set(value, sobra.length);
                            } else {
                                dados = value;
                            }

                            // Alinhamento exato de 4 bytes (amostras estéreo 16-bit)
                            const resto = dados.length % 4;
                            if (resto !== 0) {
                                const corte = dados.length - resto;
                                sobra = dados.slice(corte);
                                dados = dados.subarray(0, corte);
                            } else {
                                sobra = new Uint8Array(0);
                            }

                            if (dados.length > 0) {
                                try {
                                    callbackReal(dados);
                                } catch (_) {}
                            }
                        }
                    }
                } catch (e) {
                    if (ativo) console.error("[RedyDesktopAudio] Erro no stream:", e);
                }
            }

            iniciarStream();

            return () => {
                ativo = false;
                abortCtrl.abort();
                console.log("[RedyDesktopAudio] Canal de áudio encerrado.");
            };
        },
        parar: () => {
            console.log("[RedyDesktopAudio] parar() chamado pelo Redy.");
        },
        aoTerminar: (cb) => {
            return () => {};
        }
    };

    if (window.__redySeletorInstalado) return;
    window.__redySeletorInstalado = true;

    console.log("[RedyDOM] Instalando overlay do Seletor com Isolamento de Áudio...");

    if (!document.getElementById("redy-estilo-seletor")) {
        const style = document.createElement("style");
        style.id = "redy-estilo-seletor";
        style.textContent = \`
            #redy-seletor-tela {
                position: fixed;
                top: 0;
                left: 0;
                width: 100vw;
                height: 100vh;
                background-color: #1e1f22;
                color: #dbdee1;
                z-index: 2147483647;
                display: none;
                flex-direction: column;
                padding: 16px;
                box-sizing: border-box;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
                user-select: none;
            }
            .redy-topo {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 12px;
            }
            .redy-btn-voltar {
                background: rgba(255, 255, 255, 0.08);
                border: none;
                color: #f2f3f5;
                padding: 7px 16px;
                border-radius: 6px;
                font-weight: 600;
                font-size: 13px;
                cursor: pointer;
                display: flex;
                align-items: center;
                gap: 6px;
                transition: background 0.15s;
            }
            .redy-btn-voltar:hover {
                background: rgba(255, 255, 255, 0.16);
            }
            .redy-abas {
                display: flex;
                gap: 16px;
                border-bottom: 1px solid rgba(255, 255, 255, 0.08);
                margin-bottom: 12px;
            }
            .redy-aba {
                padding: 8px 4px 10px 4px;
                font-size: 13px;
                font-weight: 600;
                color: #949ba4;
                cursor: pointer;
                border-bottom: 2px solid transparent;
                transition: color 0.15s, border-color 0.15s;
            }
            .redy-aba.ativa {
                color: #f2f3f5;
                border-bottom-color: #5865f2;
            }
            .redy-grade {
                flex: 1;
                overflow-y: auto;
                display: grid;
                grid-template-columns: repeat(2, 1fr);
                gap: 10px;
                padding-right: 4px;
            }
            .redy-grade::-webkit-scrollbar {
                width: 6px;
            }
            .redy-grade::-webkit-scrollbar-thumb {
                background: #111214;
                border-radius: 3px;
            }
            .redy-card-item {
                background-color: #2b2d31;
                border: 2px solid transparent;
                border-radius: 8px;
                overflow: hidden;
                cursor: pointer;
                display: flex;
                flex-direction: column;
                transition: background 0.15s, border-color 0.15s;
            }
            .redy-card-item:hover {
                background-color: #35373c;
            }
            .redy-card-item.selecionado {
                border-color: #5865f2;
                background-color: #383a40;
            }
            .redy-preview-area {
                width: 100%;
                height: 105px;
                background-color: #111214;
                display: flex;
                align-items: center;
                justify-content: center;
                overflow: hidden;
            }
            .redy-preview-area img {
                max-width: 100%;
                max-height: 100%;
                object-fit: contain;
            }
            .redy-info-area {
                padding: 8px 10px;
                display: flex;
                align-items: center;
                gap: 6px;
            }
            .redy-nome-item {
                font-size: 12px;
                font-weight: 500;
                color: #f2f3f5;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .redy-rodape {
                background-color: #2b2d31;
                margin: -16px;
                padding: 12px 16px;
                margin-top: 12px;
                display: flex;
                flex-direction: column;
                gap: 8px;
                border-top: 1px solid rgba(255, 255, 255, 0.06);
            }
            .redy-rodape-linha1 {
                display: flex;
                align-items: center;
                justify-content: space-between;
                gap: 12px;
            }
            .redy-audio-controls {
                display: flex;
                align-items: center;
                gap: 10px;
                flex: 1;
            }
            .redy-select-audio {
                background: #1e1f22;
                color: #f2f3f5;
                border: 1px solid rgba(255, 255, 255, 0.15);
                border-radius: 6px;
                padding: 7px 10px;
                font-size: 12px;
                outline: none;
                cursor: pointer;
                flex: 1;
                max-width: 380px;
                text-overflow: ellipsis;
            }
            .redy-select-audio:focus {
                border-color: #5865f2;
            }
            .redy-btn-confirmar {
                background-color: #5865f2;
                color: white;
                border: none;
                padding: 9px 24px;
                border-radius: 4px;
                font-size: 13px;
                font-weight: 600;
                cursor: not-allowed;
                opacity: 0.5;
                transition: background 0.15s, opacity 0.15s;
                white-space: nowrap;
            }
            .redy-btn-confirmar.habilitado {
                cursor: pointer;
                opacity: 1;
            }
            .redy-btn-confirmar.habilitado:hover {
                background-color: #4752c4;
            }
            .redy-badge-info {
                font-size: 11px;
                color: #57f287;
                display: flex;
                align-items: center;
                gap: 4px;
            }
        \`;
        document.head.appendChild(style);
    }

    let overlay = document.getElementById("redy-seletor-tela");
    if (!overlay) {
        overlay = document.createElement("div");
        overlay.id = "redy-seletor-tela";
        overlay.innerHTML = \`
            <div class="redy-topo">
                <button class="redy-btn-voltar" id="redy-voltar-btn">
                    ← Voltar
                </button>
                <span style="font-weight: 700; font-size: 15px; color: #f2f3f5;">Transmitir no Discord (Redy)</span>
                <div style="width: 70px;"></div>
            </div>
            <div class="redy-abas">
                <div class="redy-aba ativa" id="redy-aba-apps">Aplicativos</div>
                <div class="redy-aba" id="redy-aba-telas">Telas Inteiras</div>
            </div>
            <div class="redy-grade" id="redy-grade-itens"></div>
            <div class="redy-rodape">
                <div class="redy-rodape-linha1">
                    <div class="redy-audio-controls">
                        <label style="display: flex; align-items: center; gap: 6px; cursor: pointer; font-size: 13px; color: #dbdee1; font-weight: 500; white-space: nowrap;">
                            <input type="checkbox" id="redy-check-audio" checked style="accent-color: #5865f2; width: 16px; height: 16px; cursor: pointer;">
                            <span>Áudio:</span>
                        </label>
                        <select class="redy-select-audio" id="redy-select-audio-device" title="Escolha como o áudio será transmitido">
                            <option value="exclude_discord" selected>🎧 Som do PC (Isolado - Sem voz do Discord)</option>
                            <option value="app_only">🎮 Apenas o aplicativo selecionado</option>
                            <option value="loopback_padrao">🔊 Todo o Som do PC (Padrão Windows)</option>
                            <option value="mudo">🔇 Sem Áudio</option>
                        </select>
                    </div>
                    <button class="redy-btn-confirmar" id="redy-btn-transmitir" disabled>Transmitir</button>
                </div>
                <div class="redy-badge-info">
                    ✨ <b>Isolamento Nativo:</b> Seus amigos ouvem seus jogos/vídeos com alta definição, sem ouvir a própria voz de volta!
                </div>
            </div>
        \`;
        document.body.appendChild(overlay);
    }

    let fontesDisponiveis = [];
    let itemSelecionado = null;
    let abaAtual = "apps";
    let resolverPromessa = null;

    const abaApps = document.getElementById("redy-aba-apps");
    const abaTelas = document.getElementById("redy-aba-telas");
    const btnVoltar = document.getElementById("redy-voltar-btn");
    const btnTransmitir = document.getElementById("redy-btn-transmitir");
    const checkAudio = document.getElementById("redy-check-audio");
    const selectAudio = document.getElementById("redy-select-audio-device");
    const grade = document.getElementById("redy-grade-itens");

    checkAudio.onchange = () => {
        selectAudio.disabled = !checkAudio.checked;
        selectAudio.style.opacity = checkAudio.checked ? "1" : "0.5";
    };

    abaApps.onclick = () => {
        abaAtual = "apps";
        abaApps.classList.add("ativa");
        abaTelas.classList.remove("ativa");
        renderizar();
    };

    abaTelas.onclick = () => {
        abaAtual = "telas";
        abaTelas.classList.add("ativa");
        abaApps.classList.remove("ativa");
        renderizar();
    };

    btnVoltar.onclick = () => {
        overlay.style.display = "none";
        if (resolverPromessa) {
            resolverPromessa(null);
            resolverPromessa = null;
        }
    };

    btnTransmitir.onclick = () => {
        if (!itemSelecionado) return;
        const modoAudio = checkAudio.checked ? selectAudio.value : "mudo";
        window.__redyModoAudioEscolhido = modoAudio;
        const resposta = {
            id: itemSelecionado.id,
            name: itemSelecionado.name,
            audio: checkAudio.checked,
            audioModo: modoAudio
        };
        overlay.style.display = "none";
        if (resolverPromessa) {
            resolverPromessa(resposta);
            resolverPromessa = null;
        }
    };

    function renderizar() {
        grade.innerHTML = "";
        const filtradas = fontesDisponiveis.filter(s => abaAtual === "telas" ? s.isScreen : !s.isScreen);

        if (filtradas.length === 0) {
            grade.innerHTML = \`<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #949ba4; font-size: 13px;">Nenhuma janela encontrada nesta aba.</div>\`;
            return;
        }

        filtradas.forEach(s => {
            const card = document.createElement("div");
            const selecionado = itemSelecionado && itemSelecionado.id === s.id;
            card.className = "redy-card-item" + (selecionado ? " selecionado" : "");

            card.innerHTML = \`
                <div class="redy-preview-area">
                    <img src="\${s.thumbnail}">
                </div>
                <div class="redy-info-area">
                    \${s.appIcon ? \`<img src="\${s.appIcon}" style="width: 16px; height: 16px; flex-shrink: 0; object-fit: contain;">\` : ""}
                    <span class="redy-nome-item" title="\${s.name}">\${s.name}</span>
                </div>
            \`;

            card.onclick = () => {
                itemSelecionado = s;
                btnTransmitir.disabled = false;
                btnTransmitir.classList.add("habilitado");
                renderizar();
            };

            card.ondblclick = () => {
                itemSelecionado = s;
                btnTransmitir.click();
            };

            grade.appendChild(card);
        });
    }

    window.__redyAbrirSeletor = function(fontes) {
        return new Promise((resolve) => {
            fontesDisponiveis = fontes || [];
            itemSelecionado = null;
            resolverPromessa = resolve;

            btnTransmitir.disabled = true;
            btnTransmitir.classList.remove("habilitado");

            overlay.style.display = "flex";
            renderizar();
        });
    };

    console.log("[RedyDOM] window.__redyAbrirSeletor e Seletor de Áudio Isolado prontos!");
})();
    `;
}

// ==========================================
// Handlers de Sessão e Captura de Mídia
// ==========================================
function configurarSessaoCaptura(ses) {
    if (!ses) return;

    try {
        // Desativa restrições de CSP (Content-Security-Policy) para *.redy.lat
        if (ses.webRequest && typeof ses.webRequest.onHeadersReceived === "function") {
            ses.webRequest.onHeadersReceived({ urls: ["*://*.redy.lat/*"] }, (details, callback) => {
                const responseHeaders = Object.assign({}, details.responseHeaders);
                for (const key of Object.keys(responseHeaders)) {
                    if (key.toLowerCase().startsWith("content-security-policy")) {
                        delete responseHeaders[key];
                    }
                }
                callback({ responseHeaders });
            });
        }

        ses.setPermissionRequestHandler((webContents, permission, callback) => {
            log("[PermissionRequest]", permission, "para URL:", webContents.getURL());
            callback(true);
        });

        ses.setPermissionCheckHandler((webContents, permission) => {
            return true;
        });

        if (typeof ses.setDisplayMediaRequestHandler === "function") {
            ses.setDisplayMediaRequestHandler(async (request, callback) => {
                log("[DisplayMediaRequest] Interceptado pelo Electron!", {
                    videoRequested: request.videoRequested,
                    audioRequested: request.audioRequested,
                    userGesture: request.userGesture
                });

                try {
                    const agora = Date.now();
                    if (ultimaEscolhaUsuario && (agora - timestampUltimaEscolha < 4000)) {
                        log("[DisplayMediaRequest] Reutilizando escolha recente:", ultimaEscolhaUsuario.id);
                        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
                        const s = sources.find(x => x.id === ultimaEscolhaUsuario.id) || sources[0];
                        const payload = { video: s };
                        if (ultimaEscolhaUsuario.audioModo === "loopback_padrao") {
                            payload.audio = "loopback";
                        }
                        return callback(payload);
                    }

                    log("[DisplayMediaRequest] Buscando janelas e telas abertas...");
                    const sources = await desktopCapturer.getSources({
                        types: ["screen", "window"],
                        thumbnailSize: { width: 320, height: 180 },
                        fetchWindowIcons: true
                    });

                    log(`[DisplayMediaRequest] ${sources.length} fontes encontradas.`);

                    const dadosFormatados = sources.map(s => ({
                        id: s.id,
                        name: s.name,
                        thumbnail: s.thumbnail.toDataURL(),
                        appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
                        isScreen: s.id.startsWith("screen:")
                    }));

                    if (!janelaTransmissao || janelaTransmissao.isDestroyed()) {
                        log("[DisplayMediaRequest] Janela não está disponível.");
                        return callback(null);
                    }

                    await janelaTransmissao.webContents.executeJavaScript(gerarScriptDOM(audioHttpPort));

                    log("[DisplayMediaRequest] Exibindo seletor visual na janela...");
                    const escolha = await janelaTransmissao.webContents.executeJavaScript(`
                        window.__redyAbrirSeletor(${JSON.stringify(dadosFormatados)})
                    `);

                    log("[DisplayMediaRequest] Resposta da seleção:", escolha);

                    if (!escolha || !escolha.id) {
                        log("[DisplayMediaRequest] Usuário cancelou ou voltou.");
                        ultimaEscolhaUsuario = null;
                        return callback(null);
                    }

                    ultimaEscolhaUsuario = escolha;
                    timestampUltimaEscolha = Date.now();

                    if (escolha.audioModo === "app_only" && escolha.id.startsWith("window:")) {
                        const partes = escolha.id.split(":");
                        const hwnd = partes[1];
                        audioConfigAtual = {
                            modo: "include_hwnd",
                            hwnd: hwnd
                        };
                        log(`[DisplayMediaRequest] Modo de áudio: Apenas App (HWND ${hwnd})`);
                    } else if (escolha.audioModo === "exclude_discord") {
                        audioConfigAtual = {
                            modo: "exclude_discord",
                            hwnd: null
                        };
                        log("[DisplayMediaRequest] Modo de áudio: Som do PC excluindo Discord (Process Loopback)");
                    } else if (escolha.audioModo === "mudo") {
                        audioConfigAtual = {
                            modo: "mudo",
                            hwnd: null
                        };
                        log("[DisplayMediaRequest] Modo de áudio: Mudo");
                    } else {
                        audioConfigAtual = {
                            modo: "loopback_padrao",
                            hwnd: null
                        };
                        log("[DisplayMediaRequest] Modo de áudio: Loopback Padrão");
                    }

                    const sourceEscolhida = sources.find(x => x.id === escolha.id) || sources[0];
                    log(`[DisplayMediaRequest] Sucesso! Entregando: ${sourceEscolhida.name} (Modo de áudio: ${escolha.audioModo})`);

                    const payload = { video: sourceEscolhida };
                    if (escolha.audioModo === "loopback_padrao" && request.audioRequested) {
                        payload.audio = "loopback";
                    }

                    callback(payload);
                } catch (err) {
                    log("[DisplayMediaRequest] Erro ao processar requisição de captura:", err);
                    callback(null);
                }
            });
            log("[RedyMain] setDisplayMediaRequestHandler configurado com sucesso.");
        }
    } catch (e) {
        log("[RedyMain] Erro ao configurar sessão:", e);
    }
}

function abrirJanelaTransmissao(url) {
    try {
        log("[RedyMain] Solicitada abertura de janela para URL:", url);

        if (janelaTransmissao && !janelaTransmissao.isDestroyed()) {
            janelaTransmissao.focus();
            janelaTransmissao.loadURL(url);
            return;
        }

        janelaTransmissao = new BrowserWindow({
            width: 560,
            height: 740,
            title: "Sala discord | Redylive",
            backgroundColor: "#111214",
            autoHideMenuBar: true,
            alwaysOnTop: false,
            webPreferences: {
                nodeIntegration: false,
                contextIsolation: false,
                sandbox: false,
                webSecurity: false,
                backgroundThrottling: false
            }
        });

        configurarSessaoCaptura(janelaTransmissao.webContents.session);

        janelaTransmissao.webContents.on("console-message", (event, level, message, line, sourceId) => {
            log(`[PageConsole L${level}] ${message}`);
        });

        janelaTransmissao.webContents.on("did-finish-load", () => {
            log("[RedyMain] Página carregada! Injetando API nativa e UI do seletor...");
            janelaTransmissao.webContents.executeJavaScript(gerarScriptDOM(audioHttpPort)).catch(e => {
                log("[RedyMain] Erro na injeção da UI:", e);
            });
        });

        janelaTransmissao.on("closed", () => {
            log("[RedyMain] Janela fechada pelo usuário.");
            if (redyAudioProcess) {
                try { redyAudioProcess.kill(); } catch (_) {}
                redyAudioProcess = null;
            }
            clientesAtivos.clear();
            janelaTransmissao = null;
        });

        janelaTransmissao.loadURL(url);
    } catch (e) {
        log("[RedyMain] Erro ao criar janela de transmissão:", e);
    }
}

// 1. Hook no shell.openExternal
const originalOpenExternal = shell.openExternal;
shell.openExternal = function (targetUrl, options) {
    if (typeof targetUrl === "string" && (targetUrl.includes("redy.lat/watch/") || targetUrl.includes("redy.lat/c/"))) {
        log("[RedyMain] Interceptado shell.openExternal para Redy:", targetUrl);
        abrirJanelaTransmissao(targetUrl);
        return Promise.resolve();
    }
    return originalOpenExternal.apply(this, arguments);
};

// 2. Hook no window.open
app.on("web-contents-created", (event, contents) => {
    contents.setWindowOpenHandler((details) => {
        const targetUrl = details.url || "";
        if (targetUrl.includes("redy.lat/watch/") || targetUrl.includes("redy.lat/c/")) {
            log("[RedyMain] Interceptado window.open para Redy:", targetUrl);
            abrirJanelaTransmissao(targetUrl);
            return { action: "deny" };
        }
        return { action: "allow" };
    });
});

// Configuração inicial no defaultSession
if (app.isReady()) {
    configurarSessaoCaptura(session.defaultSession);
} else {
    app.whenReady().then(() => configurarSessaoCaptura(session.defaultSession));
}
