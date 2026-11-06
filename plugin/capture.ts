/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { BYTES_PER_SECOND, FRAME_BYTES, ReplayBuffer, TimelineMixer } from "./audio";
import { errorMessage } from "./errors";
import { type AudioPacket, type AudioSource } from "./loopback";
import { WavRecording } from "./recording";

const MAX_QUEUED_BYTES = 4 * 1024 * 1024;
const SILENCE_DELAY_MS = 500;

class FrameAssembler {
    private pending = Buffer.alloc(0);
    private nextTime: number | undefined;

    push(packet: AudioPacket, onFrame: (time: number, pcm: Buffer) => void) {
        const expected = (this.nextTime ?? packet.time) + this.pending.length / BYTES_PER_SECOND * 1000;
        if (this.nextTime === undefined || Math.abs(packet.time - expected) > 80) {
            this.pending = Buffer.alloc(0);
            this.nextTime = Math.floor(packet.time / 10) * 10;
        }
        const data = Buffer.concat([this.pending, packet.pcm]);
        let offset = 0;
        while (offset + FRAME_BYTES <= data.length) {
            const time: number = this.nextTime!;
            this.nextTime = time + 10;
            onFrame(time, data.subarray(offset, offset + FRAME_BYTES));
            offset += FRAME_BYTES;
        }
        this.pending = Buffer.from(data.subarray(offset));
    }
}

export class CaptureSession {
    private readonly replay = new ReplayBuffer();
    private readonly mixer: TimelineMixer;
    private readonly assemblers = { playout: new FrameAssembler(), mic: new FrameAssembler() };
    private packets: AudioPacket[] = [];
    private queuedBytes = 0;
    private recording: WavRecording | undefined;
    private failure: unknown;
    private ended = false;
    private started = false;
    private nextSilence: number;
    private framesDecoded = 0;
    private playoutFrames = 0;
    private microphoneFrames = 0;
    private latestFrameTime: number | undefined;
    private readonly startedAt: number;

    constructor(private readonly source: AudioSource, private readonly outputDirectory: string, includeMic: boolean, micAllowed: boolean, startedAt = Date.now()) {
        this.startedAt = Math.ceil(startedAt / 10) * 10;
        this.nextSilence = this.startedAt;
        this.mixer = new TimelineMixer(this.startedAt, includeMic, micAllowed, 50);
    }

    get status() {
        return {
            bufferedSeconds: this.replay.seconds,
            recording: this.recording?.status ?? null,
            receivingAudio: this.started && this.playoutFrames > 0 && !this.failure,
            outputDirectory: this.outputDirectory,
            diagnostics: { queuedBytes: this.queuedBytes, framesDecoded: this.framesDecoded, playoutFrames: this.playoutFrames, microphoneFrames: this.microphoneFrames, latestFrameTime: this.latestFrameTime }
        };
    }

    async prepare() {
        await this.source.start(packet => {
            if (this.ended || this.failure) return;
            if (this.queuedBytes + packet.pcm.length > MAX_QUEUED_BYTES) {
                this.failure = new Error("Audio capture fell behind; buffering stopped");
                void this.source.stop().catch(console.error);
                return;
            }
            this.packets.push(packet);
            this.queuedBytes += packet.pcm.length;
        }, error => { this.failure ??= error; });
        this.started = true;
    }

    setMicAllowed(time: number, allowed: boolean) {
        this.mixer.setMicAllowed(time, allowed);
    }

    async poll(now = Date.now()) {
        if (this.ended) throw new Error("Capture has ended");
        if (this.failure) throw this.failure;
        try {
            const { packets } = this;
            this.packets = [];
            this.queuedBytes = 0;
            const frames: { time: number; kind: AudioPacket["kind"]; pcm: Buffer; }[] = [];
            for (const packet of packets) {
                if (Math.abs(packet.time - now) > 120_000) throw new Error("Unsupported audio timestamp; capture stopped");
                this.assemblers[packet.kind].push(packet, (time, pcm) => frames.push({ time, kind: packet.kind, pcm }));
            }
            frames.sort((a, b) => a.time - b.time);
            let count = 0;
            for (const frame of frames) {
                await this.padSilence(Math.min(frame.time - SILENCE_DELAY_MS, now - SILENCE_DELAY_MS));
                this.mixer.add(frame.time, frame.kind, frame.pcm);
                this.framesDecoded++;
                if (frame.kind === "playout") this.playoutFrames++;
                else this.microphoneFrames++;
                this.latestFrameTime = frame.time;
                if (++count === 200) {
                    await this.consume(this.mixer.drain());
                    count = 0;
                }
            }
            await this.padSilence(now - SILENCE_DELAY_MS);
            await this.consume(this.mixer.drain());
            return this.status;
        } catch (error) {
            this.failure = error;
            throw error;
        }
    }

    private async padSilence(until: number) {
        if (until - this.nextSilence > 30_000) throw new Error("Audio timeline jumped; capture stopped");
        let count = 0;
        while (this.nextSilence <= until) {
            this.mixer.fillSilence(this.nextSilence);
            this.nextSilence += 10;
            if (++count === 500) {
                await this.consume(this.mixer.drain());
                count = 0;
            }
        }
    }

    private async consume(pcm: Buffer) {
        if (!pcm.length) return;
        this.replay.push(pcm);
        if (this.recording) await this.recording.append(pcm);
    }

    async saveClip() {
        const pcm = this.replay.snapshot();
        if (!pcm.length) throw new Error("No audio buffered yet. Wait a moment after starting capture.");
        const writer = new WavRecording(this.outputDirectory, "Clip");
        try {
            await writer.start();
            await writer.append(pcm);
        } finally {
            await writer.close();
        }
        return writer.status;
    }

    async startRecording() {
        if (this.recording) throw new Error("Already recording");
        await this.consume(this.mixer.drain(true));
        const writer = new WavRecording(this.outputDirectory);
        await writer.start();
        this.recording = writer;
        return this.status;
    }

    async stopRecording() {
        if (!this.recording) throw new Error("No recording is active");
        await this.readFinalAudio();
        await this.consume(this.mixer.drain(true));
        const writer = this.recording;
        this.recording = undefined;
        return writer.close();
    }

    async end() {
        if (this.ended) return;
        let recording: WavRecording["status"] | undefined;
        try {
            await this.source.stop();
            await this.readFinalAudio();
            await this.consume(this.mixer.drain(true));
        } finally {
            this.ended = true;
            const { recording: writer } = this;
            this.recording = undefined;
            recording = await writer?.close();
        }
        return { recording: recording ?? null, captureError: this.failure ? errorMessage(this.failure) : null };
    }

    private async readFinalAudio() {
        if (this.failure) return;
        try { await this.poll(); }
        catch { /* poll() retains the capture error; finalize known-good audio. */ }
    }
}
