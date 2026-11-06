/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { lstat, open, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import { ReplayBuffer, TimelineMixer } from "./audio";
import { DumpDecoder } from "./dump";
import { errorMessage } from "./errors";
import { WavRecording } from "./recording";

const DUMP_NAME = /^aecdump\d+$/;
const CAPTURE_NAME = /^capture\d+\.wav$/;
const MAX_TEMP_BYTES = 128 * 1024 * 1024;
const READ_BUDGET = 4 * 1024 * 1024;

type Cursor = { decoder: DumpDecoder; offset: number; birthtimeMs: number; modified: number; };

export class CaptureSession {
    private readonly baseline = new Set<string>();
    private readonly owned = new Map<string, number>();
    private readonly cursors = new Map<string, Cursor>();
    private readonly replay = new ReplayBuffer();
    private readonly mixer: TimelineMixer;
    private recording: WavRecording | undefined;
    private lastAudio = 0;
    private ended = false;
    private failure: unknown;
    private bytesRead = 0;
    private framesDecoded = 0;
    private latestFrameTime: number | undefined;
    private readonly startedAt: number;

    constructor(private readonly dumpDirectory: string, private readonly outputDirectory: string, includeMic: boolean, micAllowed: boolean, startedAt = Date.now()) {
        this.startedAt = startedAt;
        this.mixer = new TimelineMixer(startedAt, includeMic, micAllowed);
    }

    get status() {
        return {
            bufferedSeconds: this.replay.seconds,
            recording: this.recording?.status ?? null,
            receivingAudio: !!this.lastAudio,
            outputDirectory: this.outputDirectory,
            diagnostics: {
                dumpDirectory: this.dumpDirectory,
                baselineFiles: this.baseline.size,
                dumpFiles: this.cursors.size,
                bytesRead: this.bytesRead,
                framesDecoded: this.framesDecoded,
                latestFrameTime: this.latestFrameTime
            }
        };
    }

    get hasTemporaryFiles() { return this.owned.size > 0; }

    async prepare() {
        for (const name of await this.names()) this.baseline.add(name);
    }

    setMicAllowed(time: number, allowed: boolean) {
        this.mixer.setMicAllowed(time, allowed);
    }

    private async names() {
        try {
            return (await readdir(this.dumpDirectory)).filter(name => DUMP_NAME.test(name) || CAPTURE_NAME.test(name));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
    }

    async poll(now = Date.now()) {
        if (this.ended) throw new Error("Capture has ended");
        if (this.failure) throw this.failure;
        try {
            return await this.readPoll(now);
        } catch (error) {
            this.failure = error;
            throw error;
        }
    }

    private async readPoll(now: number) {
        const files: { name: string; size: number; birthtimeMs: number; modified: number; }[] = [];
        let totalBytes = 0;
        for (const name of await this.names()) {
            if (this.baseline.has(name)) continue;
            const info = await lstat(join(this.dumpDirectory, name));
            if (!info.isFile() || info.isSymbolicLink()) continue;
            const birthtime = this.owned.get(name);
            if (birthtime !== undefined && birthtime !== info.birthtimeMs) throw new Error("Diagnostic file was replaced; capture stopped");
            this.owned.set(name, info.birthtimeMs);
            totalBytes += info.size;
            if (DUMP_NAME.test(name)) files.push({ name, size: info.size, birthtimeMs: info.birthtimeMs, modified: info.mtimeMs });
        }
        if (totalBytes > MAX_TEMP_BYTES) throw new Error("Temporary audio exceeded 128 MiB; capture stopped");
        files.sort((a, b) => a.birthtimeMs - b.birthtimeMs || Number(a.name.slice(7)) - Number(b.name.slice(7)));
        let budget = READ_BUDGET;
        for (const entry of files) {
            if (!budget) break;
            const cursor = this.cursors.get(entry.name) ?? { decoder: new DumpDecoder(), offset: 0, birthtimeMs: entry.birthtimeMs, modified: entry.modified };
            this.cursors.set(entry.name, cursor);
            if (entry.size < cursor.offset) throw new Error("Diagnostic file was truncated; capture stopped");
            const file = await open(join(this.dumpDirectory, entry.name), "r");
            try {
                while (cursor.offset < entry.size && budget > 0) {
                    const buffer = Buffer.alloc(Math.min(64 * 1024, entry.size - cursor.offset, budget));
                    const { bytesRead } = await file.read(buffer, 0, buffer.length, cursor.offset);
                    if (!bytesRead) break;
                    cursor.offset += bytesRead;
                    this.bytesRead += bytesRead;
                    budget -= bytesRead;
                    cursor.decoder.push(buffer.subarray(0, bytesRead), frame => {
                        this.framesDecoded++;
                        this.latestFrameTime = frame.time;
                        if (Math.abs(frame.time - now) > 120_000) throw new Error("Unsupported diagnostic timestamp; capture stopped");
                        if (frame.time >= this.startedAt) {
                            this.lastAudio = now;
                            this.mixer.add(frame.time, frame.kind, frame.pcm);
                        }
                    });
                    await this.consume(this.mixer.drain());
                }
            } finally {
                await file.close();
            }
            // Keep the current writer's file. Remove only consumed, inactive files we observed being created.
            if (entry !== files[files.length - 1] && cursor.offset === entry.size && now - entry.modified > 2000) {
                await this.removeOwned(entry.name);
                await this.removeOwned(`capture${entry.name.slice(7)}.wav`);
                this.cursors.delete(entry.name);
            }
        }
        if (now - (this.lastAudio || this.startedAt) > 10_000)
            throw new Error(`No call audio received for 10 seconds. Capture stopped.\nDirectory: ${this.dumpDirectory}\nDump files: ${this.cursors.size}; pre-existing files ignored: ${this.baseline.size}; bytes read: ${this.bytesRead}; decoded frames: ${this.framesDecoded}; latest timestamp: ${this.latestFrameTime ?? "none"}.`);
        return this.status;
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
        // The replay buffer remains independent; recording begins at the current capture position.
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
            await this.readFinalAudio();
            await this.consume(this.mixer.drain(true));
        } finally {
            this.ended = true;
            const { recording: writer } = this;
            this.recording = undefined;
            try {
                recording = await writer?.close();
            } finally {
                await this.cleanup();
            }
        }
        return { recording: recording ?? null, captureError: this.failure ? errorMessage(this.failure) : null };
    }

    private async readFinalAudio() {
        if (this.failure) return;
        try {
            await this.poll();
        } catch {
            // poll() retains the capture error; closing must still finalize known-good audio.
        }
    }

    async cleanup() {
        for (const name of this.owned.keys()) await this.removeOwned(name);
    }

    private async removeOwned(name: string) {
        const birthtime = this.owned.get(name);
        if (birthtime === undefined) return;
        try {
            const path = join(this.dumpDirectory, name);
            const info = await lstat(path);
            if (info.isFile() && !info.isSymbolicLink() && info.birthtimeMs === birthtime) {
                await unlink(path);
                this.owned.delete(name);
            }
        } catch (error) {
            const { code } = error as NodeJS.ErrnoException;
            if (code === "ENOENT") this.owned.delete(name);
            else if (code !== "EBUSY" && code !== "EPERM") throw error;
        }
    }
}
