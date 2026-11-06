/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const SAMPLE_RATE = 48_000;
export const CHANNELS = 2;
export const FRAME_SAMPLES = SAMPLE_RATE / 100;
export const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;
export const BYTES_PER_SECOND = SAMPLE_RATE * CHANNELS * 2;

export class ReplayBuffer {
    private readonly data: Buffer;
    private offset = 0;
    private length = 0;

    constructor(seconds = 30) {
        this.data = Buffer.alloc(seconds * BYTES_PER_SECOND);
    }

    get seconds() { return this.length / BYTES_PER_SECOND; }

    push(pcm: Buffer) {
        if (pcm.length % 4) throw new Error("Unaligned stereo PCM");
        if (pcm.length >= this.data.length) {
            pcm.copy(this.data, 0, pcm.length - this.data.length);
            this.offset = 0;
            this.length = this.data.length;
            return;
        }
        const first = Math.min(pcm.length, this.data.length - this.offset);
        pcm.copy(this.data, this.offset, 0, first);
        pcm.copy(this.data, 0, first);
        this.offset = (this.offset + pcm.length) % this.data.length;
        this.length = Math.min(this.data.length, this.length + pcm.length);
    }

    snapshot() {
        const result = Buffer.alloc(this.length);
        const start = (this.offset - this.length + this.data.length) % this.data.length;
        const first = Math.min(this.length, this.data.length - start);
        this.data.copy(result, 0, start, start + first);
        this.data.copy(result, first, 0, this.length - first);
        return result;
    }
}

export class TimelineMixer {
    private readonly pending = new Map<number, { playout?: Buffer; mic?: Buffer; }>();
    private readonly micPolicy: { time: number; allowed: boolean; }[];
    private next: number | undefined;
    private latest = 0;

    constructor(private readonly startedAt: number, private readonly includeMic: boolean, micAllowed: boolean, private readonly lagFrames = 20) {
        this.micPolicy = [{ time: startedAt, allowed: micAllowed }];
    }

    setMicAllowed(time: number, allowed: boolean) {
        if (this.micPolicy[this.micPolicy.length - 1].allowed !== allowed)
            this.micPolicy.push({ time, allowed });
    }

    add(time: number, kind: "playout" | "mic", pcm: Buffer) {
        if (time < this.startedAt || (this.next !== undefined && Math.floor(time / 10) < this.next)) return;
        if (pcm.length !== FRAME_BYTES) throw new Error("Invalid audio frame size");
        if (this.latest && time - this.latest > 2000) throw new Error("Audio timeline gap; capture stopped");
        const key = Math.floor(time / 10);
        const entry = this.pending.get(key) ?? {};
        entry[kind] = pcm;
        this.pending.set(key, entry);
        this.latest = Math.max(this.latest, time);
        if (this.pending.size > 1000) throw new Error("Audio backlog exceeded its limit");
    }

    fillSilence(time: number) {
        const key = Math.floor(time / 10);
        if (time < this.startedAt || (this.next !== undefined && key < this.next)) return;
        const entry = this.pending.get(key) ?? {};
        entry.playout ??= Buffer.alloc(FRAME_BYTES);
        this.pending.set(key, entry);
        this.latest = Math.max(this.latest, time);
        if (this.pending.size > 1000) throw new Error("Audio backlog exceeded its limit");
    }

    drain(final = false) {
        if (!this.pending.size) return Buffer.alloc(0);
        const keys = Array.from(this.pending.keys());
        const last = Math.max(...keys) - (final ? 0 : this.lagFrames);
        this.next ??= Math.min(...keys);
        if (last < this.next) return Buffer.alloc(0);
        if (last - this.next > 1000) throw new Error("Audio timeline exceeded its limit");
        const output = Buffer.alloc((last - this.next + 1) * FRAME_BYTES);
        let offset = 0;
        for (; this.next <= last; this.next++, offset += FRAME_BYTES) {
            const frame = this.pending.get(this.next);
            this.pending.delete(this.next);
            const time = this.next * 10;
            while (this.micPolicy.length > 1 && this.micPolicy[1].time <= time) this.micPolicy.shift();
            const mutedDuringFrame = this.micPolicy[1] && !this.micPolicy[1].allowed && this.micPolicy[1].time < time + 10;
            const mic = this.includeMic && this.micPolicy[0].allowed && !mutedDuringFrame ? frame?.mic : undefined;
            for (let sample = 0; sample < FRAME_BYTES; sample += 2) {
                const mixed = (frame?.playout?.readInt16LE(sample) ?? 0) + (mic?.readInt16LE(sample) ?? 0);
                output.writeInt16LE(Math.max(-32768, Math.min(32767, mixed)), offset + sample);
            }
        }
        return output;
    }
}

export function wavHeader(bytes: number) {
    if (bytes < 0 || bytes > 0xffffffff - 36 || bytes % 4) throw new Error("Invalid WAV size");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0);
    header.writeUInt32LE(bytes + 36, 4);
    header.write("WAVEfmt ", 8);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(CHANNELS, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(BYTES_PER_SECOND, 28);
    header.writeUInt16LE(4, 32);
    header.writeUInt16LE(16, 34);
    header.write("data", 36);
    header.writeUInt32LE(bytes, 40);
    return header;
}
