/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { BYTES_PER_SECOND, wavHeader } from "./audio";

export async function writeAll(file: FileHandle, data: Buffer, position: number) {
    let offset = 0;
    while (offset < data.length) {
        const { bytesWritten } = await file.write(data, offset, data.length - offset, position + offset);
        if (!bytesWritten) throw new Error("Recording write made no progress");
        offset += bytesWritten;
    }
}

export class WavRecording {
    private file: FileHandle | undefined;
    private started = false;
    private segmentBytes = 0;
    private totalBytes = 0;
    private segments = 0;
    private firstPath = "";
    private readonly name = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;

    constructor(private readonly directory: string, private readonly prefix = "Recording", private readonly segmentLimit = 256 * 1024 * 1024) {
        if (segmentLimit < 4 || segmentLimit % 4 || segmentLimit > 0xffffffff - 36) throw new Error("Invalid segment limit");
    }

    get status() {
        return { seconds: this.totalBytes / BYTES_PER_SECOND, segments: this.segments, path: this.firstPath };
    }

    async start() {
        if (this.started) throw new Error("Recording already open");
        await mkdir(this.directory, { recursive: true });
        this.started = true;
    }

    private async openSegment() {
        const path = join(this.directory, `${this.prefix}-${this.name}-${String(++this.segments).padStart(3, "0")}.wav`);
        const file = await open(path, "wx");
        try {
            await writeAll(file, wavHeader(0), 0);
        } catch (error) {
            await file.close();
            throw error;
        }
        this.file = file;
        this.firstPath ||= path;
        this.segmentBytes = 0;
    }

    async append(pcm: Buffer) {
        if (!this.started) throw new Error("Recording is not open");
        if (pcm.length % 4) throw new Error("Unaligned recording audio");
        let offset = 0;
        while (offset < pcm.length) {
            if (this.segmentBytes === this.segmentLimit) {
                await this.closeSegment();
            }
            if (!this.file) await this.openSegment();
            const length = Math.min(pcm.length - offset, this.segmentLimit - this.segmentBytes);
            await writeAll(this.file!, pcm.subarray(offset, offset + length), 44 + this.segmentBytes);
            this.segmentBytes += length;
            this.totalBytes += length;
            // Keep the file playable if Discord exits before Stop is pressed.
            await writeAll(this.file!, wavHeader(this.segmentBytes), 0);
            offset += length;
        }
    }

    private async closeSegment() {
        const { file } = this;
        this.file = undefined;
        if (file) {
            try {
                await writeAll(file, wavHeader(this.segmentBytes), 0);
                await file.sync();
            } finally {
                await file.close();
            }
        }
    }

    async close() {
        this.started = false;
        await this.closeSegment();
        return this.status;
    }
}
