/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 ReCord contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { app, type IpcMainInvokeEvent, shell } from "electron";

import { CaptureSession } from "./capture";
import { CAPTURE_REVISION } from "./compatibility";
import { voiceDumpDirectory } from "./paths";

let session: CaptureSession | undefined;
let owner: number | undefined;
let token = "";
let lastPoll = 0;
let queue = Promise.resolve();
const retired = new Set<CaptureSession>();

const outputDirectory = () => join(app.getPath("videos"), "ReCord");

function serialize<T>(action: () => Promise<T>) {
    const result = queue.then(action);
    queue = result.then(() => { }, () => { });
    return result;
}

function owned(event: IpcMainInvokeEvent, id: string) {
    if (!session || owner !== event.sender.id || id !== token) throw new Error("Capture session ended. Buffering will restart on your next voice join.");
    return session;
}

async function closeSession() {
    const current = session;
    session = undefined;
    try {
        return await current?.end();
    } finally {
        if (current?.hasTemporaryFiles) retired.add(current);
    }
}

async function cleanupRetired() {
    for (const current of retired) {
        await current.cleanup();
        if (!current.hasTemporaryFiles) retired.delete(current);
    }
}

// If the renderer stops polling, finalize the WAV instead of leaving the writer open.
const watchdog = setInterval(() => {
    if (session && Date.now() - lastPoll > 5000) void serialize(closeSession).catch(console.error);
    if (retired.size) void serialize(cleanupRetired).catch(console.error);
}, 1000);
watchdog.unref();

export function getCaptureRevision(_event: IpcMainInvokeEvent) {
    return CAPTURE_REVISION;
}

export function recover(event: IpcMainInvokeEvent) {
    return serialize(async () => {
        if (owner !== event.sender.id) return false;
        try {
            await closeSession();
        } finally {
            owner = undefined;
            token = "";
        }
        return true;
    });
}

export function startCapture(event: IpcMainInvokeEvent, includeMic: boolean, micAllowed: boolean) {
    return serialize(async () => {
        if (session || owner !== undefined) throw new Error("Another ReCord capture session is active");
        await cleanupRetired();
        if (retired.size) throw new Error("Previous temporary audio files are still in use. Wait before starting capture again.");
        if (typeof includeMic !== "boolean" || typeof micAllowed !== "boolean") throw new Error("Invalid capture options");
        const discordPaths = globalThis as typeof globalThis & { moduleDataPath?: string; modulePath?: string; };
        const next = new CaptureSession(voiceDumpDirectory(app.getPath("userData"), discordPaths), outputDirectory(), includeMic, micAllowed);
        await next.prepare();
        session = next;
        owner = event.sender.id;
        token = randomUUID();
        lastPoll = Date.now();
        return token;
    });
}

export function poll(event: IpcMainInvokeEvent, id: string) {
    return serialize(async () => {
        const current = owned(event, id);
        lastPoll = Date.now();
        return current.poll();
    });
}

export function setMicAllowed(event: IpcMainInvokeEvent, id: string, time: number, allowed: boolean) {
    return serialize(async () => {
        if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 5000 || typeof allowed !== "boolean") throw new Error("Invalid microphone state");
        owned(event, id).setMicAllowed(time, allowed);
    });
}

export function saveClip(event: IpcMainInvokeEvent, id: string) {
    return serialize(async () => {
        const current = owned(event, id);
        await current.poll();
        return current.saveClip();
    });
}

export function startRecording(event: IpcMainInvokeEvent, id: string) {
    return serialize(async () => {
        const current = owned(event, id);
        await current.poll();
        return current.startRecording();
    });
}

export function stopRecording(event: IpcMainInvokeEvent, id: string) {
    return serialize(async () => {
        const current = owned(event, id);
        return current.stopRecording();
    });
}

export function stopCapture(event: IpcMainInvokeEvent, id: string) {
    return serialize(async () => {
        if (owner !== event.sender.id || id !== token) throw new Error("Invalid capture owner");
        try {
            return await closeSession();
        } finally {
            owner = undefined;
            token = "";
        }
    });
}

export async function openOutputFolder(_event: IpcMainInvokeEvent) {
    const directory = outputDirectory();
    await mkdir(directory, { recursive: true });
    const error = await shell.openPath(directory);
    if (error) throw new Error(error);
}
