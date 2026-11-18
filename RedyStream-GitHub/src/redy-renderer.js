// RedyStream - Patch do Renderizador (Discord DOM / Atividades)
// Habilita captura de tela e persistência de login nas Atividades do Redy
"use strict";

(function () {
    if (window.__redyPatchInjected) return;
    window.__redyPatchInjected = true;

    console.log("%c[RedyStream Patch]%c Ativo e monitorando atividades do Discord...", "color: #ff3366; font-weight: bold;", "color: inherit;");

    const ATRIBUTOS_PERMISSAO = "display-capture *; camera *; microphone *; autoplay *; fullscreen *; clipboard-write *; clipboard-read *";

    function patchIframes() {
        try {
            const iframes = document.querySelectorAll("iframe");
            iframes.forEach((iframe) => {
                const src = iframe.src || iframe.getAttribute("src") || "";
                if (
                    src.includes("1560103506386362419") ||
                    src.includes("discordsays.com") ||
                    src.includes("redy.lat")
                ) {
                    const currentAllow = iframe.getAttribute("allow") || "";
                    if (!currentAllow.includes("display-capture")) {
                        iframe.setAttribute("allow", ATRIBUTOS_PERMISSAO);
                        console.log("%c[RedyStream Patch]%c Atributo allow atualizado no iframe da Atividade!", "color: #00cc66; font-weight: bold;", "color: inherit;");
                    }
                }
            });
        } catch (e) {
            console.error("[RedyStream Patch] Erro ao monitorar iframes:", e);
        }
    }

    // Monitora mutações no DOM para novos iframes de atividades
    const observer = new MutationObserver(() => {
        patchIframes();
    });

    if (document.body) {
        observer.observe(document.body, { childList: true, subtree: true });
        patchIframes();
    } else {
        document.addEventListener("DOMContentLoaded", () => {
            observer.observe(document.body, { childList: true, subtree: true });
            patchIframes();
        });
    }

    // Intervalo de segurança a cada 2 segundos
    setInterval(patchIframes, 2000);
})();
