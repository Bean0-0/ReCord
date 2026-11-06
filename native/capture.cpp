/*
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 * Windows process loopback API: https://learn.microsoft.com/windows/win32/coreaudio/application-loopback-api-capture-sample
 */

#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>
#include <mmdeviceapi.h>
#include <propidl.h>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>

#pragma comment(lib, "ole32.lib")
#pragma comment(lib, "mmdevapi.lib")
#pragma comment(lib, "uuid.lib")

class ActivationHandler final : public IActivateAudioInterfaceCompletionHandler {
    std::atomic<ULONG> refs{1};
public:
    HANDLE event = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    HRESULT result = E_FAIL;
    IAudioClient* client = nullptr;
    ~ActivationHandler() { if (client) client->Release(); if (event) CloseHandle(event); }
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** out) override {
        if (!out) return E_POINTER;
        *out = nullptr;
        if (iid == __uuidof(IUnknown) || iid == __uuidof(IActivateAudioInterfaceCompletionHandler) || iid == __uuidof(IAgileObject)) {
            *out = static_cast<IActivateAudioInterfaceCompletionHandler*>(this); AddRef(); return S_OK;
        }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++refs; }
    ULONG STDMETHODCALLTYPE Release() override { auto n = --refs; if (!n) delete this; return n; }
    HRESULT STDMETHODCALLTYPE ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
        IUnknown* value = nullptr;
        HRESULT activation = E_FAIL;
        HRESULT hr = operation->GetActivateResult(&activation, &value);
        result = FAILED(hr) ? hr : activation;
        if (SUCCEEDED(result) && value) result = value->QueryInterface(IID_PPV_ARGS(&client));
        if (value) value->Release();
        SetEvent(event);
        return S_OK;
    }
};

struct Stream {
    IAudioClient* audio = nullptr;
    IAudioCaptureClient* capture = nullptr;
    HANDLE event = nullptr;
    ~Stream() {
        if (audio) audio->Stop();
        if (capture) capture->Release();
        if (audio) audio->Release();
        if (event) CloseHandle(event);
    }
    HRESULT start(bool loopback) {
        WAVEFORMATEX fmt{};
        fmt.wFormatTag = WAVE_FORMAT_PCM; fmt.nChannels = 2; fmt.nSamplesPerSec = 48000;
        fmt.wBitsPerSample = 16; fmt.nBlockAlign = 4; fmt.nAvgBytesPerSec = 192000;
        DWORD flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
        if (loopback) flags |= AUDCLNT_STREAMFLAGS_LOOPBACK;
        HRESULT hr = audio->Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 0, 0, &fmt, nullptr);
        if (FAILED(hr)) return hr;
        hr = audio->GetService(IID_PPV_ARGS(&capture));
        if (FAILED(hr)) return hr;
        event = CreateEventW(nullptr, FALSE, FALSE, nullptr);
        if (!event) return HRESULT_FROM_WIN32(GetLastError());
        hr = audio->SetEventHandle(event);
        if (FAILED(hr)) return hr;
        return audio->Start();
    }
};

HRESULT openOutput(DWORD pid, Stream& stream) {
    AUDIOCLIENT_ACTIVATION_PARAMS params{};
    params.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
    params.ProcessLoopbackParams.TargetProcessId = pid;
    params.ProcessLoopbackParams.ProcessLoopbackMode = PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE;
    PROPVARIANT variant{}; variant.vt = VT_BLOB;
    variant.blob.cbSize = sizeof(params); variant.blob.pBlobData = reinterpret_cast<BYTE*>(&params);
    auto handler = new ActivationHandler();
    if (!handler->event) { handler->Release(); return E_OUTOFMEMORY; }
    IActivateAudioInterfaceAsyncOperation* operation = nullptr;
    HRESULT hr = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &variant, handler, &operation);
    if (SUCCEEDED(hr)) {
        DWORD wait = WaitForSingleObject(handler->event, 5000);
        hr = wait == WAIT_OBJECT_0 ? handler->result : HRESULT_FROM_WIN32(ERROR_TIMEOUT);
        if (SUCCEEDED(hr)) { stream.audio = handler->client; handler->client = nullptr; }
        operation->Release();
    }
    handler->Release();
    return FAILED(hr) ? hr : stream.start(true);
}

HRESULT findCaptureDevice(IMMDeviceEnumerator* enumerator, const wchar_t* id, IMMDevice** result) {
    HRESULT hr = enumerator->GetDevice(id, result);
    if (SUCCEEDED(hr)) return hr;
    // Discord may expose only the endpoint GUID; match it to a single active capture device.
    const wchar_t* wanted = wcsrchr(id, L'{');
    if (!wanted) return hr;
    IMMDeviceCollection* devices = nullptr;
    if (FAILED(enumerator->EnumAudioEndpoints(eCapture, DEVICE_STATE_ACTIVE, &devices))) return hr;
    UINT count = 0;
    devices->GetCount(&count);
    IMMDevice* match = nullptr;
    for (UINT index = 0; index < count; index++) {
        IMMDevice* candidate = nullptr;
        if (FAILED(devices->Item(index, &candidate))) continue;
        LPWSTR endpoint = nullptr;
        if (SUCCEEDED(candidate->GetId(&endpoint))) {
            const wchar_t* suffix = wcsrchr(endpoint, L'{');
            if (suffix && _wcsicmp(suffix, wanted) == 0) {
                if (match) { match->Release(); match = nullptr; hr = HRESULT_FROM_WIN32(ERROR_DUP_NAME); }
                else { match = candidate; candidate = nullptr; hr = S_OK; }
            }
            CoTaskMemFree(endpoint);
        }
        if (candidate) candidate->Release();
        if (hr == HRESULT_FROM_WIN32(ERROR_DUP_NAME)) break;
    }
    devices->Release();
    if (match) *result = match;
    return hr;
}

HRESULT openMic(const wchar_t* id, Stream& stream) {
    IMMDeviceEnumerator* enumerator = nullptr;
    HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL, IID_PPV_ARGS(&enumerator));
    if (FAILED(hr)) return hr;
    IMMDevice* device = nullptr;
    if (!id || !*id || _wcsicmp(id, L"default") == 0) hr = enumerator->GetDefaultAudioEndpoint(eCapture, eConsole, &device);
    else if (_wcsicmp(id, L"communications") == 0) hr = enumerator->GetDefaultAudioEndpoint(eCapture, eCommunications, &device);
    else hr = findCaptureDevice(enumerator, id, &device);
    enumerator->Release();
    if (FAILED(hr)) return hr;
    hr = device->Activate(__uuidof(IAudioClient), CLSCTX_ALL, nullptr, reinterpret_cast<void**>(&stream.audio));
    device->Release();
    return FAILED(hr) ? hr : stream.start(false);
}

struct PacketHeader { uint32_t bytes; uint32_t kind; int64_t timestampMs; };
static_assert(sizeof(PacketHeader) == 16);

bool writeAll(HANDLE output, const void* data, DWORD bytes) {
    auto ptr = static_cast<const BYTE*>(data);
    while (bytes) {
        DWORD written = 0;
        if (!WriteFile(output, ptr, bytes, &written, nullptr) || !written) return false;
        ptr += written; bytes -= written;
    }
    return true;
}

bool drain(Stream& stream, uint32_t kind, HANDLE output) {
    UINT32 available = 0;
    while (true) {
        HRESULT next = stream.capture->GetNextPacketSize(&available);
        if (FAILED(next)) { std::fprintf(stderr, "Audio packet query failed: 0x%08lx\n", next); return false; }
        if (!available) return true;
        BYTE* data = nullptr; UINT32 frames = 0; DWORD flags = 0; UINT64 qpc = 0;
        HRESULT hr = stream.capture->GetBuffer(&data, &frames, &flags, nullptr, &qpc);
        if (FAILED(hr)) return false;
        if (!frames) { stream.capture->ReleaseBuffer(frames); continue; }
        LARGE_INTEGER nowQpc{}, frequency{}; FILETIME ft{};
        QueryPerformanceCounter(&nowQpc); QueryPerformanceFrequency(&frequency); GetSystemTimePreciseAsFileTime(&ft);
        ULARGE_INTEGER wall{}; wall.LowPart = ft.dwLowDateTime; wall.HighPart = ft.dwHighDateTime;
        double currentQpc100ns = static_cast<double>(nowQpc.QuadPart) * 10000000.0 / frequency.QuadPart;
        double delta = (flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR) || !qpc ? frames * (10000000.0 / 48000.0) : currentQpc100ns - static_cast<double>(qpc);
        int64_t timestamp = static_cast<int64_t>((static_cast<double>(wall.QuadPart) - 116444736000000000.0 - delta) / 10000.0);
        PacketHeader header{frames * 4, kind, timestamp};
        std::vector<BYTE> silence;
        if (flags & AUDCLNT_BUFFERFLAGS_SILENT) { silence.resize(header.bytes); data = silence.data(); }
        bool ok = writeAll(output, &header, sizeof(header)) && writeAll(output, data, header.bytes);
        HRESULT released = stream.capture->ReleaseBuffer(frames);
        if (!ok || FAILED(released)) return false;
    }
}

DWORD WINAPI stopReader(void* context) {
    BYTE data;
    DWORD read = 0;
    ReadFile(GetStdHandle(STD_INPUT_HANDLE), &data, 1, &read, nullptr);
    SetEvent(static_cast<HANDLE>(context));
    return 0;
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 2 || argc > 3) { std::fprintf(stderr, "Usage: ReCordCapture <pid> [microphone-id]\n"); return 2; }
    wchar_t* end = nullptr; unsigned long pid = wcstoul(argv[1], &end, 10);
    if (!pid || !end || *end) { std::fprintf(stderr, "Invalid process ID\n"); return 2; }
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) { std::fprintf(stderr, "COM initialization failed: 0x%08lx\n", hr); return 1; }
    int exitCode = 0;
    {
        Stream output, mic;
        hr = openOutput(pid, output);
        if (FAILED(hr)) { std::fprintf(stderr, "Discord audio capture failed: 0x%08lx\n", hr); exitCode = 1; }
        if (!exitCode && argc == 3) {
            hr = openMic(argv[2], mic);
            if (FAILED(hr)) { std::fprintf(stderr, "Microphone capture failed: 0x%08lx\n", hr); exitCode = 1; }
        }
        if (!exitCode) {
            HANDLE stop = CreateEventW(nullptr, TRUE, FALSE, nullptr);
            if (!stop) { std::fprintf(stderr, "Could not create stop event\n"); exitCode = 1; }
            else {
                HANDLE thread = CreateThread(nullptr, 0, stopReader, stop, 0, nullptr);
                if (!thread) { std::fprintf(stderr, "Could not create stop thread\n"); exitCode = 1; }
                else {
                    CloseHandle(thread);
                    std::fprintf(stderr, "READY\n"); std::fflush(stderr);
                    HANDLE events[3] = {stop, output.event, mic.event};
                    DWORD count = mic.event ? 3 : 2;
                    while (true) {
                        DWORD wait = WaitForMultipleObjects(count, events, FALSE, INFINITE);
                        if (wait == WAIT_OBJECT_0) break;
                        if (wait == WAIT_OBJECT_0 + 1) { if (!drain(output, 0, GetStdHandle(STD_OUTPUT_HANDLE))) { exitCode = 1; break; } }
                        else if (wait == WAIT_OBJECT_0 + 2 && mic.event) { if (!drain(mic, 1, GetStdHandle(STD_OUTPUT_HANDLE))) { exitCode = 1; break; } }
                        else { std::fprintf(stderr, "Audio wait failed\n"); exitCode = 1; break; }
                    }
                }
            }
        }
    }
    CoUninitialize();
    return exitCode;
}
