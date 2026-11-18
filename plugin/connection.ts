/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

// Called by RTC's ready/SFU callbacks right before Discord creates the voice stream.
// The hook must stay synchronous: any await here lets voice gateway messages (client connects,
// DAVE/MLS) arrive before Discord's media connection exists, and the server then drops the call (4803).
export const voiceJoinPatch = {
    find: '"media_engine_connect"',
    replacement: {
        match: /_connectMediaEngineWithEndpoint\(([\w$]+),([\w$]+)\)\{/,
        replace: "$&$self.beforeVoiceConnect(this);"
    }
};

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
