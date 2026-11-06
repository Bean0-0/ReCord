/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

export type AudioPacket = { kind: "playout" | "mic"; time: number; pcm: Buffer; };

const HEADER_BYTES = 16;
const MAX_PACKET_BYTES = 384_000;
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

export class PacketDecoder {
    private pending = Buffer.alloc(0);

    push(chunk: Buffer, onPacket: (packet: AudioPacket) => void) {
        if (chunk.length + this.pending.length > MAX_BUFFERED_BYTES) throw new Error("Audio capture pipe overflow");
        const data = Buffer.concat([this.pending, chunk]);
        let offset = 0;
        while (data.length - offset >= HEADER_BYTES) {
            const size = data.readUInt32LE(offset);
            const kind = data.readUInt32LE(offset + 4);
            const timestamp = Number(data.readBigInt64LE(offset + 8));
            if (!size || size > MAX_PACKET_BYTES || size % 4 || kind > 1 || !Number.isSafeInteger(timestamp))
                throw new Error("Invalid audio capture packet");
            if (data.length - offset < HEADER_BYTES + size) break;
            onPacket({ kind: kind === 0 ? "playout" : "mic", time: timestamp, pcm: data.subarray(offset + HEADER_BYTES, offset + HEADER_BYTES + size) });
            offset += HEADER_BYTES + size;
        }
        this.pending = Buffer.from(data.subarray(offset));
    }
}

export interface AudioSource {
    start(onPacket: (packet: AudioPacket) => void, onError: (error: Error) => void): Promise<void>;
    stop(): Promise<void>;
}

export class LoopbackSource implements AudioSource {
    private child: ChildProcessWithoutNullStreams | undefined;
    private closed: Promise<void> | undefined;
    private stopping = false;
    private stopPromise: Promise<void> | undefined;

    constructor(private readonly executable: string, private readonly pid: number, private readonly microphoneId?: string) { }

    start(onPacket: (packet: AudioPacket) => void, onError: (error: Error) => void) {
        return new Promise<void>((resolve, reject) => {
            const args = [String(this.pid)];
            if (this.microphoneId !== undefined) args.push(this.microphoneId || "default");
            const child = spawn(this.executable, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
            this.child = child;
            child.stdin.on("error", () => { });
            let started = false;
            let settled = false;
            let stderr = "";
            const decoder = new PacketDecoder();
            const fail = (error: Error) => {
                if (!settled) { settled = true; clearTimeout(timer); reject(error); }
                else if (started && !this.stopping) onError(error);
            };
            const timer = setTimeout(() => {
                fail(new Error("Audio capture did not start. Check Windows audio devices and try again."));
                child.kill();
            }, 1500);
            this.closed = new Promise<void>(done => {
                child.once("close", (code, signal) => {
                    if (!this.stopping) fail(new Error(stderr.trim() || `Audio capture exited (${signal ?? code}).`));
                    done();
                });
            });
            child.once("error", error => fail(new Error(`Could not start audio capture: ${error.message}. Rebuild ReCord and restart Discord.`)));
            child.stderr.on("data", (chunk: Buffer) => {
                stderr = (stderr + chunk.toString("utf8")).slice(-4096);
                if (!settled && /(?:^|\r?\n)READY\r?\n/.test(stderr)) {
                    started = true;
                    settled = true;
                    clearTimeout(timer);
                    stderr = "";
                    resolve();
                }
            });
            child.stdout.on("data", (chunk: Buffer) => {
                try { decoder.push(chunk, onPacket); }
                catch (error) { fail(error instanceof Error ? error : new Error(String(error))); child.kill(); }
            });
        });
    }

    stop() {
        if (this.stopPromise) return this.stopPromise;
        this.stopPromise = this.stopChild();
        return this.stopPromise;
    }

    private async stopChild() {
        if (!this.child) return;
        this.stopping = true;
        const { child } = this;
        child.stdin.end();
        const timer = setTimeout(() => child.kill(), 2000);
        timer.unref();
        try { await this.closed; }
        finally { clearTimeout(timer); this.child = undefined; }
    }
}
