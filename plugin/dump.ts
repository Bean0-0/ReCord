/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { FRAME_SAMPLES } from "./audio";

// WebRTC modules/audio_processing/debug.proto; Discord currently uses this format.
const MAX_RECORD_BYTES = 64 * 1024;
type Field = { number: number; value: number | Buffer; };
export type AudioFrame = { time: number; kind: "playout" | "mic"; pcm: Buffer; };

function varint(data: Buffer, start: number): [number, number] {
    let value = 0n;
    for (let i = start, shift = 0n; i < data.length && shift <= 63n; i++, shift += 7n) {
        if (shift === 63n && data[i] > 1) break;
        value |= BigInt(data[i] & 127) << shift;
        if (!(data[i] & 128)) return [value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : NaN, i + 1];
    }
    throw new Error("Malformed dump varint");
}

function fields(data: Buffer): Field[] {
    const result: Field[] = [];
    let position = 0;
    while (position < data.length) {
        const [key, next] = varint(data, position);
        position = next;
        const number = Math.floor(key / 8);
        const wire = key % 8;
        if (!Number.isSafeInteger(key) || !number) throw new Error("Invalid dump field");
        if (wire === 0) {
            const [value, end] = varint(data, position);
            result.push({ number, value });
            position = end;
        } else if (wire === 2) {
            const [length, begin] = varint(data, position);
            if (!Number.isSafeInteger(length) || length > data.length - begin) throw new Error("Truncated dump field");
            result.push({ number, value: data.subarray(begin, begin + length) });
            position = begin + length;
        } else if (wire === 1 || wire === 5) {
            position += wire === 1 ? 8 : 4;
            if (position > data.length) throw new Error("Truncated dump field");
        } else {
            throw new Error("Unsupported dump wire type");
        }
    }
    return result;
}

function integer(list: Field[], number: number, fallback?: number) {
    const value = list.find(field => field.number === number)?.value;
    return typeof value === "number" ? value : fallback;
}

function bytes(list: Field[], number: number) {
    const value = list.find(field => field.number === number)?.value;
    return Buffer.isBuffer(value) ? value : undefined;
}

function normalize(data: Buffer | undefined, planes: Buffer[], rate: number, channels: number) {
    const samples = rate / 100;
    if (data ? data.length !== samples * channels * 2 : planes.length !== channels || planes.some(p => p.length !== samples * 4))
        throw new Error("Unsupported dump audio layout; capture stopped");

    const output = Buffer.alloc(FRAME_SAMPLES * 4);
    const sample = (frame: number, channel: number) => {
        const value = data ? data.readInt16LE((frame * channels + channel) * 2) : planes[channel].readFloatLE(frame * 4) * 32768;
        if (!Number.isFinite(value)) throw new Error("Invalid dump audio sample");
        return value;
    };
    for (let frame = 0; frame < FRAME_SAMPLES; frame++) {
        const position = frame * samples / FRAME_SAMPLES;
        const low = Math.floor(position);
        const high = Math.min(samples - 1, low + 1);
        const read = (channel: number) => sample(low, channel) * (1 - position + low) + sample(high, channel) * (position - low);
        let left = read(0);
        let right = read(channels === 1 ? 0 : 1);
        if (channels > 2) {
            left += read(2) * 0.707;
            right += read(2) * 0.707;
            for (let channel = 4; channel < channels; channel++) {
                if (channel % 2) right += read(channel) * 0.707;
                else left += read(channel) * 0.707;
            }
        }
        output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(left))), frame * 4);
        output.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(right))), frame * 4 + 2);
    }
    return output;
}

export class DumpDecoder {
    private pending = Buffer.alloc(0);
    private initialized = false;
    private reverseRate = 48_000;
    private micRate = 48_000;
    private reverseChannels = 2;
    private micChannels = 1;
    private reverseTime = 0;
    private micTime = 0;

    push(data: Buffer, onFrame: (frame: AudioFrame) => void) {
        const input = Buffer.concat([this.pending, data]);
        let offset = 0;
        while (offset + 4 <= input.length) {
            const length = input.readUInt32LE(offset);
            if (!length || length > MAX_RECORD_BYTES) throw new Error("Unsupported dump record size");
            if (offset + 4 + length > input.length) break;
            this.event(input.subarray(offset + 4, offset + 4 + length), onFrame);
            offset += 4 + length;
        }
        this.pending = Buffer.from(input.subarray(offset));
    }

    private event(data: Buffer, onFrame: (frame: AudioFrame) => void) {
        const event = fields(data);
        const type = integer(event, 1);
        if (type === 0) {
            const initData = bytes(event, 2);
            if (!initData) throw new Error("Missing dump initialization");
            const init = fields(initData);
            this.reverseRate = integer(init, 6, this.reverseRate)!;
            this.micRate = integer(init, 7, integer(init, 1, this.micRate))!;
            this.reverseChannels = integer(init, 5, this.reverseChannels)!;
            this.micChannels = integer(init, 4, this.micChannels)!;
            for (const rate of [this.reverseRate, this.micRate]) {
                if (![8000, 16000, 32000, 44100, 48000].includes(rate)) throw new Error(`Unsupported audio rate: ${rate}`);
            }
            for (const channels of [this.reverseChannels, this.micChannels]) {
                if (![1, 2, 6, 8].includes(channels)) throw new Error(`Unsupported audio channels: ${channels}`);
            }
            const timestamp = integer(init, 10);
            if (timestamp !== undefined) this.reverseTime = this.micTime = timestamp;
            if (!this.reverseTime) throw new Error("Dump has no audio timestamp");
            this.initialized = true;
        } else if (type === 1 || type === 2) {
            if (!this.initialized) throw new Error("Audio arrived before dump initialization");
            const kind = type === 1 ? "playout" : "mic";
            const payload = bytes(event, type === 1 ? 3 : 4);
            if (!payload) throw new Error("Missing dump audio payload");
            const stream = fields(payload);
            // Never substitute raw microphone input when processed output is absent.
            const audio = bytes(stream, type === 1 ? 1 : 2);
            const planes = stream.filter(f => f.number === (type === 1 ? 2 : 8) && Buffer.isBuffer(f.value)).map(f => f.value as Buffer);
            const time = type === 1 ? this.reverseTime : this.micTime;
            if (type === 1) this.reverseTime += 10;
            else this.micTime += 10;
            if (audio || planes.length) {
                const pcm = normalize(audio, planes, type === 1 ? this.reverseRate : this.micRate, type === 1 ? this.reverseChannels : this.micChannels);
                onFrame({ time, kind, pcm });
            }
        }
    }
}
