/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { ChatBarButton } from "@api/ChatButtons";
import { ApplicationCommandInputType } from "@api/Commands";
import { Button } from "@components/Button";
import { Paragraph } from "@components/Paragraph";
import definePlugin, { IconComponent, PluginNative } from "@utils/types";
import { FluxDispatcher, MediaEngineStore, Modal, openModal, RTCConnectionStore, showToast, useEffect, useState } from "@webpack/common";

import { CAPTURE_REVISION, checkNativeVersion } from "./compatibility";
import { CaptureConnection, prepareVoiceJoin, voiceJoinPatch } from "./connection";
import { errorMessage } from "./errors";
import { settings } from "./settings";

const Native = VencordNative.pluginHelpers.ReCord as PluginNative<typeof import("./native")>;
type Status = Awaited<ReturnType<typeof Native.poll>>;
type VoiceConnection = { context?: string; channelId?: string; };

let token: string | undefined;
let ownsDump = false;
let captureConnection: CaptureConnection | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let enabled = false;
let polling = false;
let busy = false;
let operation = Promise.resolve();
let status: Status | undefined;
let errorText = "";
let waitingLogged = false;
let pausedCall: { rtc: VoiceConnection; channelId?: string; } | undefined;
const listeners = new Set<() => void>();

function refresh() {
    for (const listener of listeners) listener();
}

function enqueue<T>(action: () => Promise<T>) {
    const result = operation.then(action);
    operation = result.then(() => { }, () => { });
    return result;
}

function report(error: unknown) {
    errorText = errorMessage(error);
    console.error("[ReCord]", error);
    const summary = errorText.split("\n")[0];
    showToast({ text: `ReCord: ${summary.length > 140 ? "Capture failed. Open ReCord controls for details." : summary}`, variant: "critical" });
    refresh();
}

function notify(message: string) {
    showToast({ text: `ReCord: ${message}`, variant: "success" });
}

function micAllowed() {
    return !MediaEngineStore.isMute() && !MediaEngineStore.isSelfMute() && !MediaEngineStore.isServerMute()
        && !MediaEngineStore.isHardwareMute() && !MediaEngineStore.isSelfMutedTemporarily() && !MediaEngineStore.isDeaf();
}

function disableDump() {
    if (ownsDump) {
        FluxDispatcher.dispatch({ type: "MEDIA_ENGINE_SET_AEC_DUMP", enabled: false });
        ownsDump = false;
    }
}

async function endCapture() {
    clearInterval(timer);
    timer = undefined;
    disableDump();
    const id = token;
    token = undefined;
    captureConnection = undefined;
    try {
        if (id) return await Native.stopCapture(id);
    } finally {
        status = undefined;
        refresh();
    }
}

function shouldPrepareCapture(rtc: VoiceConnection) {
    return enabled && rtc.context === "default"
        && !(pausedCall?.rtc === rtc && pausedCall.channelId === rtc.channelId);
}

function beforeVoiceConnect(rtc: VoiceConnection) {
    return prepareVoiceJoin(signal => enqueue(async () => {
        if (signal.aborted || !shouldPrepareCapture(rtc) || RTCConnectionStore.getRTCConnection() !== rtc) return;
        const wasRecording = !!status?.recording;
        const result = await endCapture();
        if (wasRecording) notify(result?.recording?.seconds ? "Voice session changed. Recording saved." : "Voice session changed. No audio was received; no recording was saved.");
        if (signal.aborted || !shouldPrepareCapture(rtc) || RTCConnectionStore.getRTCConnection() !== rtc) return;
        await beginCapture(rtc, signal);
    }), report);
}

async function beginCapture(rtc: VoiceConnection, signal: AbortSignal) {
    if (!enabled) throw new Error("Plugin is disabled");
    if (token) return;
    await checkNativeVersion(Native);
    if (signal.aborted) return;
    if (!MediaEngineStore.isAecDumpSupported()) throw new Error("Discord's active voice engine does not support diagnostic audio capture. ReCord cannot record with this voice backend.");
    if (MediaEngineStore.getAecDump()) throw new Error("Discord audio diagnostics are already enabled. Stop the existing diagnostic capture first.");
    if (typeof MediaEngineStore.getMediaEngine()?.setAecDump !== "function") throw new Error("This Discord client does not support native audio capture");
    const currentChannel = rtc.channelId;
    if (!currentChannel || RTCConnectionStore.getRTCConnection() !== rtc) return;
    const id = await Native.startCapture(settings.store.includeMic, micAllowed());
    console.info("[ReCord] Preparing buffer before voice stream", JSON.stringify({ revision: CAPTURE_REVISION, aecSupported: MediaEngineStore.isAecDumpSupported(), audioSubsystem: MediaEngineStore.getAudioSubsystem() }));
    token = id;
    try {
        if (signal.aborted || !shouldPrepareCapture(rtc) || RTCConnectionStore.getRTCConnection() !== rtc || RTCConnectionStore.getChannelId() !== currentChannel)
            throw new Error("Voice connection changed while preparing capture");
        captureConnection = new CaptureConnection(currentChannel);
        ownsDump = true;
        FluxDispatcher.dispatch({ type: "MEDIA_ENGINE_SET_AEC_DUMP", enabled: true });
        status = await Native.poll(id);
        if (signal.aborted) {
            await endCapture();
            return;
        }
        waitingLogged = false;
        timer = setInterval(pollCapture, 250);
        errorText = "";
        refresh();
    } catch (error) {
        await endCapture().catch(cleanupError => console.error("[ReCord] Cleanup failed", cleanupError));
        throw error;
    }
}

function pollCapture() {
    if (polling || busy || !token) return;
    polling = true;
    void enqueue(async () => {
        if (!token) return;
        try {
            if (!MediaEngineStore.getAecDump()) throw new Error("Discord audio diagnostics were turned off");
            status = await Native.poll(token);
            if (!status.receivingAudio && !waitingLogged) {
                console.info("[ReCord] Waiting for audio", JSON.stringify(status.diagnostics));
                waitingLogged = true;
            }
            refresh();
        } catch (error) {
            await endCapture().catch(cleanupError => console.error("[ReCord] Cleanup failed", cleanupError));
            report(error);
        }
    }).finally(() => { polling = false; });
}

function action(run: () => Promise<void>) {
    if (busy) return;
    busy = true;
    refresh();
    void enqueue(run).catch(report).finally(() => {
        busy = false;
        refresh();
    });
}

function stopBuffering() {
    action(async () => {
        const rtc = RTCConnectionStore.getRTCConnection() as VoiceConnection | null;
        if (rtc) pausedCall = { rtc, channelId: rtc.channelId };
        const wasRecording = !!status?.recording;
        const result = await endCapture();
        if (wasRecording && !result?.recording?.seconds) throw new Error("No audio was received. No recording was saved.");
        notify(wasRecording ? "Recording saved and buffering stopped" : "Buffering stopped");
    });
}

function saveClip() {
    action(async () => {
        if (!token) throw new Error("Buffering starts automatically when you join a call. Join with ReCord enabled first.");
        const result = await Native.saveClip(token);
        notify(`Saved ${result.seconds.toFixed(1)} seconds to Videos/ReCord`);
    });
}

function toggleRecording() {
    action(async () => {
        if (status?.recording && token) {
            const result = await Native.stopRecording(token);
            if (status) status = { ...status, recording: null };
            if (!result.seconds) throw new Error("No audio was received. No recording was saved.");
            notify(`Saved ${formatTime(result.seconds)} recording to Videos/ReCord`);
        } else {
            if (!token) throw new Error("Buffering starts automatically on join. Enable ReCord before joining a call to record.");
            status = await Native.startRecording(token);
        }
    });
}

function connectionChanged() {
    if (!token) return;
    if (captureConnection?.accepts(RTCConnectionStore.getChannelId(), RTCConnectionStore.getState())) {
        refresh();
    } else {
        const id = token;
        void enqueue(async () => {
            if (token !== id) return;
            const wasRecording = !!status?.recording;
            const result = await endCapture();
            if (wasRecording && !result?.recording?.seconds) throw new Error("Connection changed. No audio was received; no recording was saved.");
            notify(wasRecording ? "Connection changed. Recording saved; start again in the new call." : "Connection changed. Buffering stopped.");
        }).catch(report);
    }
}

function microphoneChanged() {
    const id = token;
    if (id) void Native.setMicAllowed(id, Date.now(), micAllowed()).catch(report);
}

function onKeyDown(event: KeyboardEvent) {
    if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.code === "KeyS" && !event.repeat) {
        event.preventDefault();
        saveClip();
    }
}

function unload() {
    disableDump();
    if (token) void Native.stopCapture(token).catch(console.error);
}

function formatTime(seconds: number) {
    return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function useCaptureUpdates() {
    const [, render] = useState(0);
    useEffect(() => {
        const listener = () => render(value => value + 1);
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    }, []);
}

const RecordIcon: IconComponent = ({ width = 20, height = 20, className }) => (
    <svg width={width} height={height} viewBox="0 0 24 24" className={className} aria-hidden="true">
        <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2" />
        <circle cx="12" cy="12" r="5" fill="currentColor" />
    </svg>
);

function CaptureButton() {
    useCaptureUpdates();
    const tooltip = status?.recording ? `ReCord: recording ${formatTime(status.recording.seconds)}` : token ? "ReCord: buffering call audio" : "Open ReCord controls";
    return (
        <ChatBarButton tooltip={tooltip} onClick={openControls}>
            <RecordIcon className={status?.recording ? "record-recording" : token ? "record-buffering" : undefined} />
        </ChatBarButton>
    );
}

function captureLabel() {
    if (!enabled) return "ReCord is disabled";
    if (captureConnection?.connecting) return "Preparing call audio buffer";
    if (status?.recording)
        return status.recording.seconds ? `Recording ${formatTime(status.recording.seconds)} (part ${status.recording.segments})` : "Recording armed - waiting for audio";
    if (token) return status?.receivingAudio ? "Buffering call audio" : "Buffering armed - waiting for audio";
    if (pausedCall && pausedCall.rtc === RTCConnectionStore.getRTCConnection()) return "Capture paused for this call";
    return "Buffering starts automatically on your next join";
}

function Controls() {
    useCaptureUpdates();
    return (
        <div className="record-controls">
            <Paragraph>
                {captureLabel()}
                {token && ` · ${Math.min(30, status?.bufferedSeconds ?? 0).toFixed(1)} / 30 seconds ready`}
            </Paragraph>
            <div className="record-actions">
                <Button disabled={busy || !token || !status?.bufferedSeconds} onClick={saveClip}>Clip last 30 seconds</Button>
                <Button disabled={busy || !enabled || !token} variant={status?.recording ? "dangerPrimary" : "primary"} onClick={toggleRecording}>
                    {status?.recording ? "Stop and save recording" : "Start recording"}
                </Button>
                <Button disabled={busy || !token} variant="secondary" onClick={stopBuffering}>Stop capture</Button>
                <Button variant="secondary" onClick={() => { void Native.openOutputFolder().catch(report); }}>Open recordings folder</Button>
            </div>
            {errorText && <Paragraph className="record-error" role="alert">{errorText}</Paragraph>}
            {status && !status.receivingAudio && <Paragraph>Waiting for Discord audio in {status.diagnostics.dumpDirectory}</Paragraph>}
            <Paragraph>
                ReCord buffers automatically when you join a voice call. Enable it before joining. Recording uses the active buffer without reconnecting voice.
                Stop capture pauses this call; buffering resumes on your next join. Clips and recordings save as WAV in Videos/ReCord.
                Ctrl+Shift+S saves a clip while Discord is focused.
            </Paragraph>
            <Paragraph>
                Let participants know before recording. Discord diagnostic files may temporarily contain your microphone even when it is excluded from saved audio.
            </Paragraph>
        </div>
    );
}

function openControls() {
    openModal(props => (
        <Modal {...props} title="ReCord" actions={[{ text: "Close", variant: "secondary", onClick: props.onClose }]}>
            <Controls />
        </Modal>
    ));
}

export default definePlugin({
    name: "ReCord",
    description: "Buffer voice audio automatically on join, save the last 30 seconds, and record calls from ReCord controls.",
    authors: [{ name: "Bean0-0", id: 0n }],
    tags: ["Voice", "Utility"],
    settings,
    patches: [voiceJoinPatch],
    shouldPrepareCapture,
    beforeVoiceConnect,
    chatBarButton: { icon: RecordIcon, render: CaptureButton },
    settingsAboutComponent: Controls,
    toolboxActions: {
        "ReCord controls": openControls,
        "Clip last 30 seconds": saveClip,
        "Start / stop recording": toggleRecording
    },
    commands: [
        { name: "record", description: "Open ReCord recording controls", inputType: ApplicationCommandInputType.BUILT_IN, execute: openControls },
        { name: "clip", description: "Save the last 30 seconds of buffered call audio", inputType: ApplicationCommandInputType.BUILT_IN, execute: saveClip }
    ],
    start() {
        enabled = true;
        RTCConnectionStore.addChangeListener(connectionChanged);
        MediaEngineStore.addChangeListener(microphoneChanged);
        window.addEventListener("keydown", onKeyDown);
        window.addEventListener("beforeunload", unload);
        void enqueue(async () => {
            await checkNativeVersion(Native);
            console.info("[ReCord] Capture revision", CAPTURE_REVISION);
            if (await Native.recover()) {
                ownsDump = true;
                disableDump();
            }
            refresh();
        }).catch(report);
    },
    stop() {
        enabled = false;
        pausedCall = undefined;
        RTCConnectionStore.removeChangeListener(connectionChanged);
        MediaEngineStore.removeChangeListener(microphoneChanged);
        window.removeEventListener("keydown", onKeyDown);
        window.removeEventListener("beforeunload", unload);
        clearInterval(timer);
        disableDump();
        void enqueue(endCapture).catch(report);
        refresh();
    }
});
