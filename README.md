# RedyStream - Transmissão de Tela e Áudio Isolado no Discord

Projeto de código aberto que integra captura de tela de alta performance e isolamento nativo de áudio para transmissões no Discord através da plataforma Redy.

---

## 🎯 Objetivo

Com a indisponibilidade temporária de compartilhamento nativo de tela no aplicativo oficial do Discord para usuários no Brasil, a comunidade adotou o uso de Atividades integradas (como o Redy). 

Este projeto resolve os dois principais desafios técnicos dessa solução:
1. **Isolamento de Áudio Sem Drivers Virtuais:** Transmite o som de jogos, navegadores e mídias sem capturar a voz dos amigos na chamada do Discord, dispensando completamente programas adicionais como VB-Cable, Voicemeeter ou Virtual Audio Cable.
2. **Integração Direta no Cliente Desktop:** Adiciona seleção visual de janelas e telas diretamente pela interface do aplicativo desktop sem necessidade de abrir janelas avulsas no navegador.

---

## 🧠 Arquitetura Técnica

O projeto é dividido em três camadas modulares:

```
                  ┌───────────────────────────────────────────────┐
                  │            Jogo / Janela / Windows            │
                  └───────────────────────┬───────────────────────┘
                                          │ Áudio do Sistema (WASAPI)
                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  Módulo C++: redy-audio.exe                                                     │
│  - Captura via Windows Audio Session API (WASAPI Loopback)                      │
│  - Filtragem por Process Tree (Exclusão da árvore PID do Discord)               │
│  - Conversão PCM 48.000 Hz, 16-bit, estéreo em buffer contínuo sem alocação     │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ Pipe Local (stdout -> Node.js)
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│  Patch Electron: redy-main.js & redy-renderer.js                                │
│  - Servidor HTTP de streaming local (localhost) com TCP_NODELAY ativado         │
│  - Jitter Buffer adaptativo para evitar lacunas de agendamento WebAudio         │
│  - Aceleração por hardware na GPU (D3D11 / NVENC)                               │
│  - Priorização WebRTC (Áudio com prioridade máxima na rede)                    │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │ WebRTC / Opus
                                         ▼
                                Servidor SFU / Espectadores
```

### 1. Captura em Baixo Nível (`src/redy-audio.cpp`)
- Implementado em C++17 com a API `AUDIOCLIENT_ACTIVATION_PARAMS` (`PROCESS_LOOPBACK`).
- Permite filtrar e excluir especificamente a árvore de processos do Discord (`--exclude-discord`) ou capturar exclusivamente uma janela alvo (`--include-hwnd <HWND>`).
- Fallback automático para Standard WASAPI Loopback caso o sistema operacional seja Windows 10 legado.
- Priorização de thread multimídia via `AvSetMmThreadCharacteristicsW` ("Pro Audio").

### 2. Extensão do Processo Principal (`src/redy-main.js`)
- Executado dentro do contexto do Electron (via Vencord).
- Intercepta `desktopCapturer` e chamadas WebRTC da janela do Redy.
- Alinha fluxos PCM em 4 bytes (amostras estéreo 16-bit) e fornece entrega contínua ao motor WebAudio.

### 3. Gerenciamento de Permissões (`src/redy-renderer.js`)
- Monitora os iframes das atividades do Discord e injeta os atributos de política de permissão (`display-capture *`) para permitir a captura de tela nativa.

---

## 📁 Estrutura do Repositório

```text
├── src/
│   ├── redy-audio.cpp       # Código-fonte C++ da captura WASAPI
│   ├── redy-main.js         # Patch do processo principal (Electron)
│   └── redy-renderer.js     # Patch do DOM / renderizador do Discord
├── installer/
│   ├── Instalar.bat         # Inicializador do instalador (1 clique)
│   ├── Desinstalar.bat      # Restaurador do Discord original
│   ├── instalar.ps1         # Lógica de validação e cópia do patch
│   ├── desinstalar.ps1      # Lógica de remoção limpa
│   └── LEIA-ME.txt          # Manual operacional do usuário final
├── build-audio.bat          # Script para compilar o executável C++
├── .gitignore               # Arquivos ignorados no versionamento
└── README.md                # Esta documentação
```

---

## 🔨 Como Compilar

Para compilar o módulo de áudio a partir do código-fonte:

### Usando MinGW (g++):
```bash
g++ -O3 -std=c++17 src/redy-audio.cpp -o dist/redy-audio.exe -static -lwinmm -lole32 -luuid -lkernel32 -luser32
```

### Usando MSVC (cl.exe):
```cmd
cl /O2 /EHsc /std:c++17 src/redy-audio.cpp /link /OUT:dist/redy-audio.exe winmm.lib ole32.lib uuid.lib kernel32.lib user32.lib
```

Ou execute diretamente o script auxiliar:
```cmd
build-audio.bat
```

---

## 🚀 Como Utilizar

1. Obtenha a versão distribuível na aba de **Releases** do repositório.
2. Extraia o pacote e execute `Instalar.bat`.
3. Abra o Discord, acesse um canal de voz e inicie a Atividade **Redy**.
4. Clique em **"Escolher janela ou tela"**, selecione o aplicativo desejado e marque a opção de áudio isolado.

---

## ⚖️ Licença

Este projeto é disponibilizado para fins educacionais e de interoperabilidade. Você é livre para utilizar, estudar e modificar o código conforme suas necessidades.
