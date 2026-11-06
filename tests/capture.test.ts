import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BYTES_PER_SECOND, FRAME_BYTES } from "../plugin/audio";
import { CaptureSession } from "../plugin/capture";
import { WavRecording, writeAll } from "../plugin/recording";
import type { FileHandle } from "node:fs/promises";
import { frames, init } from "./fixtures";

async function workspace(t: { after: (fn: () => Promise<void>) => void; }) {
    const root = await mkdtemp(join(tmpdir(), "record-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const dumps = join(root, "dumps");
    const output = join(root, "output");
    await mkdir(dumps);
    return { dumps, output };
}

test("WAV writer streams segments with valid recoverable headers", async t => {
    const { output } = await workspace(t);
    const writer = new WavRecording(output, "Test", FRAME_BYTES * 3);
    await writer.start();
    await writer.append(Buffer.alloc(FRAME_BYTES * 8, 4));
    const active = await readdir(output);
    assert.equal(active.length, 3);
    for (const name of active) {
        const file = await readFile(join(output, name));
        assert.equal(file.toString("ascii", 0, 4), "RIFF");
        assert.equal(file.readUInt32LE(40), file.length - 44, "header updates before close");
    }
    const result = await writer.close();
    assert.equal(result.seconds, 0.08);
    assert.equal(result.segments, 3);
});

test("writer retries short writes and surfaces stalled/disk-full writes", async () => {
    const written = Buffer.alloc(10);
    const fake = { write: async (data: Buffer, offset: number, length: number, position: number) => {
        const bytesWritten = Math.min(3, length);
        data.copy(written, position, offset, offset + bytesWritten);
        return { bytesWritten };
    } } as FileHandle;
    await writeAll(fake, Buffer.from("abcdefghij"), 0);
    assert.equal(written.toString(), "abcdefghij");
    await assert.rejects(writeAll({ write: async () => ({ bytesWritten: 0 }) } as unknown as FileHandle, Buffer.alloc(1), 0), /no progress/);
    await assert.rejects(writeAll({ write: async () => { throw new Error("ENOSPC"); } } as unknown as FileHandle, Buffer.alloc(1), 0), /ENOSPC/);
});

test("capture tails partial records, clips while recording, and preserves pre-existing diagnostics", async t => {
    const { dumps, output } = await workspace(t);
    const old = join(dumps, "aecdump0");
    await writeFile(old, "unrelated diagnostic data");
    const now = Math.floor(Date.now() / 10) * 10;
    const capture = new CaptureSession(dumps, output, false, true, now);
    await capture.prepare();
    const path = join(dumps, "aecdump1");
    const first = Buffer.concat([init(now), frames(100, 1000)]);
    await writeFile(path, first.subarray(0, first.length - 5));
    await capture.poll();
    const clip = await capture.saveClip();
    assert.ok(clip.seconds > 0 && clip.seconds < 1);
    await appendFile(path, first.subarray(first.length - 5));
    await capture.poll();
    await capture.startRecording();
    await appendFile(path, frames(100, 2000));
    await capture.poll();
    const during = await capture.saveClip();
    assert.ok(during.seconds > clip.seconds);
    const recording = await capture.stopRecording();
    assert.equal(recording.seconds, 1);
    const saved = await readFile(recording.path);
    assert.equal(saved.readUInt32LE(40), BYTES_PER_SECOND);
    assert.equal(saved.readInt16LE(44), 2000, "recording excludes pre-start replay audio");
    await capture.end();
    assert.equal(await readFile(old, "utf8"), "unrelated diagnostic data");
    assert.deepEqual(await readdir(dumps), ["aecdump0"]);
});

test("capture handles dump rotation and retains only 30 seconds in replay", async t => {
    const { dumps, output } = await workspace(t);
    const now = Math.floor(Date.now() / 10) * 10 - 40_000;
    const capture = new CaptureSession(dumps, output, false, false, now);
    await capture.prepare();
    for (let part = 0; part < 4; part++) {
        await writeFile(join(dumps, `aecdump${part}`), Buffer.concat([init(now + part * 10_000), frames(1000, 1000 + part)]));
        await capture.poll();
    }
    assert.equal(capture.status.bufferedSeconds, 30);
    const clip = await capture.saveClip();
    assert.equal(clip.seconds, 30);
    const audio = (await readFile(clip.path)).subarray(44);
    assert.equal(audio.length, 30 * BYTES_PER_SECOND);
    assert.equal(audio.readInt16LE(audio.length - 2), 1003);
    await capture.end();
});

test("unsupported capture fails clearly and closes recordings on teardown", async t => {
    const { dumps, output } = await workspace(t);
    const capture = new CaptureSession(dumps, output, false, false);
    await capture.prepare();
    await capture.startRecording();
    await writeFile(join(dumps, "aecdump2"), Buffer.from([255, 255, 255, 255]));
    await assert.rejects(capture.poll(), /record size/);
    const stopped = await capture.end();
    assert.match(stopped!.captureError!, /record size/);
    assert.equal(stopped!.recording!.seconds, 0);
    assert.deepEqual(await readdir(output), [], "a failed empty capture must not leave a zero-second WAV");
    assert.deepEqual(await readdir(dumps), []);
});

test("a no-audio timeout is reported once; teardown still succeeds without an empty WAV", async t => {
    const { dumps, output } = await workspace(t);
    const now = Date.now();
    const capture = new CaptureSession(dumps, output, false, false, now);
    await capture.prepare();
    await capture.startRecording();
    assert.deepEqual(await readdir(output), []);
    await assert.rejects(capture.poll(now + 10_001), /No call audio received[\s\S]*Dump files: 0/);
    const result = await capture.end();
    assert.match(result!.captureError!, /No call audio received/);
    assert.equal(result!.recording!.path, "");
    assert.deepEqual(await readdir(output), []);
    await capture.end();
});

test("stop finalizes already captured audio after a later capture failure", async t => {
    const { dumps, output } = await workspace(t);
    const now = Math.floor(Date.now() / 10) * 10;
    const capture = new CaptureSession(dumps, output, false, true, now);
    await capture.prepare();
    await capture.startRecording();
    const path = join(dumps, "aecdump3");
    await writeFile(path, Buffer.concat([init(now), frames(100, 1200)]));
    await capture.poll();
    await appendFile(path, Buffer.from([255, 255, 255, 255]));
    await assert.rejects(capture.poll(), /record size/);
    const result = await capture.end();
    assert.equal(result!.recording!.seconds, 1);
    const file = await readFile(result!.recording!.path);
    assert.equal(file.readUInt32LE(40), BYTES_PER_SECOND);
    assert.equal(file.readInt16LE(44), 1200);
});
