/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// This method is called by RTC's ready/SFU callbacks and its return value is unused.
// Start the in-memory capture stream before Discord creates the voice stream.
export const voiceJoinPatch = {
    find: '"media_engine_connect"',
    replacement: {
        match: /_connectMediaEngineWithEndpoint\(([\w$]+),([\w$]+)\)\{/,
        replace: "async $&if($self.shouldPrepareCapture(this)){await $self.beforeVoiceConnect(this);if($2.socket!==this._socket)return;}"
    }
};

export async function prepareVoiceJoin(prepare: (signal: AbortSignal) => Promise<unknown>, report: (error: unknown) => void, timeoutMs = 2000) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Audio buffer setup timed out. Your call will join normally; buffering will retry on your next join."));
        }, timeoutMs);
    });
    // Capture failures must not prevent the underlying voice connection from joining.
    try {
        await Promise.race([Promise.resolve().then(() => prepare(controller.signal)), timeout]);
    } catch (error) {
        controller.abort();
        try {
            report(error);
        } catch (reportError) {
            console.error("[ReCord] Failed to report buffer setup error", reportError);
        }
    } finally {
        clearTimeout(timer);
    }
}

export class CaptureConnection {
    connecting = true;

    constructor(readonly channelId: string) { }

    accepts(channelId: string | undefined, state: string) {
        // Permit initial join states only. A move or leave must end this session.
        if (channelId !== this.channelId) return false;
        if (state === "RTC_CONNECTED") {
            this.connecting = false;
            return true;
        }
        return this.connecting;
    }
}
