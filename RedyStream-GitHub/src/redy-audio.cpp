#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <mmsystem.h>
#include <tlhelp32.h>
#include <roapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <mmdeviceapi.h>
#include <psapi.h>
#include <io.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK L"VAD\\Process_Loopback"
static const GUID GUID_SUBTYPE_IEEE_FLOAT = { 0x00000003, 0x0000, 0x0010, { 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71 } };

typedef enum PROCESS_LOOPBACK_MODE {
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE = 0,
    PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE = 1
} PROCESS_LOOPBACK_MODE;

typedef struct AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
    DWORD TargetProcessId;
    PROCESS_LOOPBACK_MODE ProcessLoopbackMode;
} AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS;

typedef enum AUDIOCLIENT_ACTIVATION_TYPE {
    AUDIOCLIENT_ACTIVATION_TYPE_DEFAULT = 0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK = 1
} AUDIOCLIENT_ACTIVATION_TYPE;

typedef struct AUDIOCLIENT_ACTIVATION_PARAMS {
    AUDIOCLIENT_ACTIVATION_TYPE ActivationType;
    union {
        AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS ProcessLoopbackParams;
    };
} AUDIOCLIENT_ACTIVATION_PARAMS;

class AudioCompletionHandler : public IActivateAudioInterfaceCompletionHandler {
    LONG m_refCount;
    HANDLE m_event;
    HRESULT m_hr;
    IUnknown* m_punk;
public:
    AudioCompletionHandler(HANDLE ev) : m_refCount(1), m_event(ev), m_hr(E_FAIL), m_punk(NULL) {}
    
    STDMETHODIMP QueryInterface(REFIID riid, void** ppv) {
        if (riid == __uuidof(IUnknown) || 
            riid == __uuidof(IActivateAudioInterfaceCompletionHandler) ||
            riid == IID_IAgileObject) {
            *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
            AddRef();
            return S_OK;
        }
        *ppv = NULL;
        return E_NOINTERFACE;
    }
    STDMETHODIMP_(ULONG) AddRef() { return InterlockedIncrement(&m_refCount); }
    STDMETHODIMP_(ULONG) Release() {
        ULONG ul = InterlockedDecrement(&m_refCount);
        if (ul == 0) delete this;
        return ul;
    }
    STDMETHODIMP ActivateCompleted(IActivateAudioInterfaceAsyncOperation* op) {
        op->GetActivateResult(&m_hr, &m_punk);
        SetEvent(m_event);
        return S_OK;
    }
    HRESULT GetResult(IUnknown** ppunk) {
        *ppunk = m_punk;
        return m_hr;
    }
};

typedef HRESULT (WINAPI *RoInitialize_fn)(RO_INIT_TYPE);
typedef HRESULT (WINAPI *ActivateAudioInterfaceAsync_fn)(
    LPCWSTR, REFIID, PROPVARIANT*, IActivateAudioInterfaceCompletionHandler*, IActivateAudioInterfaceAsyncOperation**);

DWORD FindRootProcess(DWORD pid) {
    if (pid == 0) return 0;
    HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnap == INVALID_HANDLE_VALUE) return pid;
    
    PROCESSENTRY32W pe = {};
    pe.dwSize = sizeof(pe);
    
    WCHAR targetExe[MAX_PATH] = L"";
    if (Process32FirstW(hSnap, &pe)) {
        do {
            if (pe.th32ProcessID == pid) {
                wcscpy(targetExe, pe.szExeFile);
                break;
            }
        } while (Process32NextW(hSnap, &pe));
    }
    
    if (wcslen(targetExe) == 0) {
        CloseHandle(hSnap);
        return pid;
    }
    
    DWORD currPid = pid;
    bool foundParent = true;
    while (foundParent) {
        foundParent = false;
        if (Process32FirstW(hSnap, &pe)) {
            do {
                if (pe.th32ProcessID == currPid) {
                    DWORD parentPid = pe.th32ParentProcessID;
                    HANDLE hSnap2 = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
                    if (hSnap2 != INVALID_HANDLE_VALUE) {
                        PROCESSENTRY32W peParent = {};
                        peParent.dwSize = sizeof(peParent);
                        if (Process32FirstW(hSnap2, &peParent)) {
                            do {
                                if (peParent.th32ProcessID == parentPid && _wcsicmp(peParent.szExeFile, targetExe) == 0) {
                                    currPid = parentPid;
                                    foundParent = true;
                                    break;
                                }
                            } while (Process32NextW(hSnap2, &peParent));
                        }
                        CloseHandle(hSnap2);
                    }
                    break;
                }
            } while (Process32NextW(hSnap, &pe));
        }
    }
    CloseHandle(hSnap);
    return currPid;
}

DWORD FindRootDiscordPid() {
    HANDLE hSnap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnap == INVALID_HANDLE_VALUE) return 0;
    PROCESSENTRY32W pe = {};
    pe.dwSize = sizeof(pe);
    
    DWORD discordPid = 0;
    if (Process32FirstW(hSnap, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, L"Discord.exe") == 0) {
                discordPid = pe.th32ProcessID;
                break;
            }
        } while (Process32NextW(hSnap, &pe));
    }
    CloseHandle(hSnap);
    
    if (discordPid > 0) {
        return FindRootProcess(discordPid);
    }
    return 0;
}

// Buffer estático de 64 KB (até 16.384 amostras estéreo) - Elimina malloc/free e fragmentação de heap
static short s_convertBuffer[32768];

// Converte amostras de formato arbitrário (IEEE Float ou PCM 16/24/32) para PCM 16-bit estéreo 48kHz
void WriteConvertedAudio(BYTE* pData, UINT32 numFrames, WAVEFORMATEX* pwfx) {
    if (!pData || numFrames == 0 || !pwfx) return;

    if (pwfx->wFormatTag == WAVE_FORMAT_PCM && pwfx->nChannels == 2 && pwfx->wBitsPerSample == 16) {
        fwrite(pData, 1, numFrames * 4, stdout);
        return;
    }

    bool isFloat = false;
    if (pwfx->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
        isFloat = true;
    } else if (pwfx->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
        WAVEFORMATEXTENSIBLE* pExt = (WAVEFORMATEXTENSIBLE*)pwfx;
        if (memcmp(&pExt->SubFormat, &GUID_SUBTYPE_IEEE_FLOAT, sizeof(GUID)) == 0) {
            isFloat = true;
        }
    }

    int channels = pwfx->nChannels;
    short* outBuf = s_convertBuffer;
    bool allocated = false;
    if (numFrames * 2 > sizeof(s_convertBuffer) / sizeof(short)) {
        outBuf = (short*)malloc(numFrames * 2 * sizeof(short));
        if (!outBuf) return;
        allocated = true;
    }

    if (isFloat && pwfx->wBitsPerSample == 32) {
        float* inFloat = (float*)pData;
        for (UINT32 i = 0; i < numFrames; i++) {
            float left = inFloat[i * channels + 0];
            float right = (channels > 1) ? inFloat[i * channels + 1] : left;
            
            if (left > 1.0f) left = 1.0f; else if (left < -1.0f) left = -1.0f;
            if (right > 1.0f) right = 1.0f; else if (right < -1.0f) right = -1.0f;
            
            outBuf[i * 2 + 0] = (short)(left * 32767.0f);
            outBuf[i * 2 + 1] = (short)(right * 32767.0f);
        }
    } else if (pwfx->wBitsPerSample == 16) {
        short* inShort = (short*)pData;
        for (UINT32 i = 0; i < numFrames; i++) {
            outBuf[i * 2 + 0] = inShort[i * channels + 0];
            outBuf[i * 2 + 1] = (channels > 1) ? inShort[i * channels + 1] : inShort[i * channels + 0];
        }
    } else {
        UINT32 bytes = numFrames * 4;
        fwrite(pData, 1, bytes, stdout);
        if (allocated) free(outBuf);
        return;
    }

    fwrite(outBuf, 1, numFrames * 4, stdout);
    if (allocated) free(outBuf);
}

int LoopCapture(IAudioClient* client) {
    // 1. Resolução do temporizador do Windows para 1ms e prioridade crítica de tempo
    timeBeginPeriod(1);
    SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);

    // 2. Registro no MMCSS ("Pro Audio") para imunidade a picos de CPU do jogo/GPU
    DWORD taskIndex = 0;
    HANDLE hAvrt = NULL;
    HMODULE avrtDll = LoadLibraryW(L"avrt.dll");
    if (avrtDll) {
        typedef HANDLE (WINAPI *AvSetMmThreadCharacteristicsW_fn)(LPCWSTR, LPDWORD);
        AvSetMmThreadCharacteristicsW_fn pfnAvSet = (AvSetMmThreadCharacteristicsW_fn)GetProcAddress(avrtDll, "AvSetMmThreadCharacteristicsW");
        if (pfnAvSet) {
            hAvrt = pfnAvSet(L"Pro Audio", &taskIndex);
        }
    }

    WAVEFORMATEX wfx = {};
    wfx.wFormatTag = WAVE_FORMAT_PCM;
    wfx.nChannels = 2;
    wfx.nSamplesPerSec = 48000;
    wfx.wBitsPerSample = 16;
    wfx.nBlockAlign = 4;
    wfx.nAvgBytesPerSec = 48000 * 4;

    WAVEFORMATEX* pActiveFormat = &wfx;
    WAVEFORMATEX* pDeviceFormat = NULL;
    
    HANDLE hSampleEvent = CreateEvent(NULL, FALSE, FALSE, NULL);
    HRESULT hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        0, 0, &wfx, NULL);

    if (FAILED(hr)) {
        hr = client->GetMixFormat(&pDeviceFormat);
        if (SUCCEEDED(hr) && pDeviceFormat) {
            hr = client->Initialize(AUDCLNT_SHAREMODE_SHARED,
                AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                0, 0, pDeviceFormat, NULL);
            if (SUCCEEDED(hr)) {
                pActiveFormat = pDeviceFormat;
                fprintf(stderr, "[RedyAudio] Usando MixFormat nativo (%u Hz, %u ch)\n", 
                    (unsigned int)pDeviceFormat->nSamplesPerSec, pDeviceFormat->nChannels);
            }
        }
    }

    if (FAILED(hr)) {
        fprintf(stderr, "[RedyAudio] Falha ao inicializar IAudioClient: 0x%08X\n", (unsigned int)hr);
        client->Release();
        CloseHandle(hSampleEvent);
        if (pDeviceFormat) CoTaskMemFree(pDeviceFormat);
        if (hAvrt && avrtDll) {
            typedef BOOL (WINAPI *AvRevertMmThreadCharacteristics_fn)(HANDLE);
            AvRevertMmThreadCharacteristics_fn pfnAvRev = (AvRevertMmThreadCharacteristics_fn)GetProcAddress(avrtDll, "AvRevertMmThreadCharacteristics");
            if (pfnAvRev) pfnAvRev(hAvrt);
        }
        if (avrtDll) FreeLibrary(avrtDll);
        timeEndPeriod(1);
        return 4;
    }

    client->SetEventHandle(hSampleEvent);
    IAudioCaptureClient* pCapture = NULL;
    hr = client->GetService(__uuidof(IAudioCaptureClient), (void**)&pCapture);
    if (FAILED(hr) || !pCapture) {
        client->Release();
        CloseHandle(hSampleEvent);
        if (pDeviceFormat) CoTaskMemFree(pDeviceFormat);
        if (hAvrt && avrtDll) {
            typedef BOOL (WINAPI *AvRevertMmThreadCharacteristics_fn)(HANDLE);
            AvRevertMmThreadCharacteristics_fn pfnAvRev = (AvRevertMmThreadCharacteristics_fn)GetProcAddress(avrtDll, "AvRevertMmThreadCharacteristics");
            if (pfnAvRev) pfnAvRev(hAvrt);
        }
        if (avrtDll) FreeLibrary(avrtDll);
        timeEndPeriod(1);
        return 5;
    }

    _setmode(_fileno(stdout), _O_BINARY);
    hr = client->Start();
    if (FAILED(hr)) {
        pCapture->Release();
        client->Release();
        CloseHandle(hSampleEvent);
        if (pDeviceFormat) CoTaskMemFree(pDeviceFormat);
        if (hAvrt && avrtDll) {
            typedef BOOL (WINAPI *AvRevertMmThreadCharacteristics_fn)(HANDLE);
            AvRevertMmThreadCharacteristics_fn pfnAvRev = (AvRevertMmThreadCharacteristics_fn)GetProcAddress(avrtDll, "AvRevertMmThreadCharacteristics");
            if (pfnAvRev) pfnAvRev(hAvrt);
        }
        if (avrtDll) FreeLibrary(avrtDll);
        timeEndPeriod(1);
        return 6;
    }

    static const BYTE silenceBuf[1920] = {0};

    while (true) {
        DWORD waitRes = WaitForSingleObject(hSampleEvent, 1000);
        if (waitRes == WAIT_FAILED) break;

        UINT32 framesAvailable = 0;
        bool hasData = false;
        while (SUCCEEDED(pCapture->GetNextPacketSize(&framesAvailable)) && framesAvailable > 0) {
            BYTE* pData = NULL;
            DWORD flags = 0;
            if (SUCCEEDED(pCapture->GetBuffer(&pData, &framesAvailable, &flags, NULL, NULL))) {
                if (framesAvailable > 0) {
                    hasData = true;
                    if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                        UINT32 bytes = framesAvailable * 4;
                        while (bytes > sizeof(silenceBuf)) {
                            if (fwrite(silenceBuf, 1, sizeof(silenceBuf), stdout) <= 0) goto exit_loop;
                            bytes -= sizeof(silenceBuf);
                        }
                        if (bytes > 0) {
                            if (fwrite(silenceBuf, 1, bytes, stdout) <= 0) goto exit_loop;
                        }
                    } else {
                        WriteConvertedAudio(pData, framesAvailable, pActiveFormat);
                    }
                }
                pCapture->ReleaseBuffer(framesAvailable);
            } else {
                break;
            }
        }

        if (hasData) {
            fflush(stdout);
        } else if (waitRes == WAIT_TIMEOUT) {
            // Heartbeat de silêncio apenas se passar 1 segundo inteiro sem nenhum evento
            if (fwrite(silenceBuf, 1, sizeof(silenceBuf), stdout) <= 0) {
                break;
            }
            fflush(stdout);
        }
    }

exit_loop:
    client->Stop();
    pCapture->Release();
    client->Release();
    CloseHandle(hSampleEvent);
    if (pDeviceFormat) CoTaskMemFree(pDeviceFormat);
    if (hAvrt && avrtDll) {
        typedef BOOL (WINAPI *AvRevertMmThreadCharacteristics_fn)(HANDLE);
        AvRevertMmThreadCharacteristics_fn pfnAvRev = (AvRevertMmThreadCharacteristics_fn)GetProcAddress(avrtDll, "AvRevertMmThreadCharacteristics");
        if (pfnAvRev) pfnAvRev(hAvrt);
    }
    if (avrtDll) FreeLibrary(avrtDll);
    timeEndPeriod(1);
    return 0;
}

int RunStandardLoopbackCapture() {
    fprintf(stderr, "[RedyAudio] Iniciando Standard WASAPI Loopback Fallback...\n");
    CoInitialize(NULL);
    IMMDeviceEnumerator* pEnumerator = NULL;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), NULL, CLSCTX_ALL, __uuidof(IMMDeviceEnumerator), (void**)&pEnumerator);
    if (FAILED(hr)) return 10;

    IMMDevice* pDevice = NULL;
    hr = pEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &pDevice);
    if (FAILED(hr)) {
        pEnumerator->Release();
        return 11;
    }

    IAudioClient* client = NULL;
    hr = pDevice->Activate(__uuidof(IAudioClient), CLSCTX_ALL, NULL, (void**)&client);
    pDevice->Release();
    pEnumerator->Release();
    if (FAILED(hr) || !client) return 12;

    int res = LoopCapture(client);
    CoUninitialize();
    return res;
}

int RunAudioCapture(DWORD targetPid, PROCESS_LOOPBACK_MODE mode) {
    HMODULE hComBase = LoadLibraryW(L"combase.dll");
    RoInitialize_fn fnRo = (RoInitialize_fn)GetProcAddress(hComBase, "RoInitialize");
    if (fnRo) fnRo(RO_INIT_MULTITHREADED);

    HMODULE hMmdevapi = LoadLibraryW(L"mmdevapi.dll");
    if (!hMmdevapi) return RunStandardLoopbackCapture();
    ActivateAudioInterfaceAsync_fn fnActivate = (ActivateAudioInterfaceAsync_fn)GetProcAddress(hMmdevapi, "ActivateAudioInterfaceAsync");
    if (!fnActivate) return RunStandardLoopbackCapture();

    HANDLE hEvent = CreateEvent(NULL, FALSE, FALSE, NULL);
    AudioCompletionHandler* handler = new AudioCompletionHandler(hEvent);

    AUDIOCLIENT_ACTIVATION_PARAMS params = {};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = targetPid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = mode;

    PROPVARIANT prop = {};
    prop.vt = VT_BLOB;
    prop.blob.cbSize = sizeof(params);
    prop.blob.pBlobData = (BYTE*)&params;

    IActivateAudioInterfaceAsyncOperation* asyncOp = NULL;
    HRESULT hr = fnActivate(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &prop, handler, &asyncOp);
    if (FAILED(hr)) {
        handler->Release();
        CloseHandle(hEvent);
        fprintf(stderr, "[RedyAudio] ActivateAudioInterfaceAsync falhou (0x%08X). Usando fallback standard...\n", (unsigned int)hr);
        return RunStandardLoopbackCapture();
    }

    WaitForSingleObject(hEvent, 3000);
    IUnknown* punk = NULL;
    HRESULT actHr = handler->GetResult(&punk);
    if (FAILED(actHr) || !punk) {
        if (asyncOp) asyncOp->Release();
        handler->Release();
        CloseHandle(hEvent);
        fprintf(stderr, "[RedyAudio] Async activation falhou (0x%08X). Usando fallback standard...\n", (unsigned int)actHr);
        return RunStandardLoopbackCapture();
    }

    IAudioClient* client = NULL;
    punk->QueryInterface(__uuidof(IAudioClient), (void**)&client);
    punk->Release();
    if (asyncOp) asyncOp->Release();
    handler->Release();
    CloseHandle(hEvent);

    if (!client) return RunStandardLoopbackCapture();

    fprintf(stderr, "[RedyAudio] Process Loopback ativado com sucesso para PID %u!\n", (unsigned int)targetPid);
    return LoopCapture(client);
}

int main(int argc, char* argv[]) {
    if (argc > 1) {
        if (strcmp(argv[1], "--standard-loopback") == 0) {
            return RunStandardLoopbackCapture();
        }
        if (strcmp(argv[1], "--exclude-discord") == 0) {
            DWORD discordPid = FindRootDiscordPid();
            if (discordPid == 0) discordPid = GetCurrentProcessId();
            return RunAudioCapture(discordPid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE);
        }
        if (strcmp(argv[1], "--exclude-pid") == 0 && argc > 2) {
            DWORD pid = (DWORD)atoi(argv[2]);
            return RunAudioCapture(FindRootProcess(pid), PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE);
        }
        if (strcmp(argv[1], "--include-pid") == 0 && argc > 2) {
            DWORD pid = (DWORD)atoi(argv[2]);
            return RunAudioCapture(FindRootProcess(pid), PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE);
        }
        if (strcmp(argv[1], "--include-hwnd") == 0 && argc > 2) {
            HWND hwnd = (HWND)(uintptr_t)strtoull(argv[2], NULL, 10);
            DWORD pid = 0;
            GetWindowThreadProcessId(hwnd, &pid);
            if (pid > 0) {
                return RunAudioCapture(FindRootProcess(pid), PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE);
            }
        }
    }

    DWORD discordPid = FindRootDiscordPid();
    if (discordPid > 0) {
        return RunAudioCapture(discordPid, PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE);
    }

    return RunStandardLoopbackCapture();
}
