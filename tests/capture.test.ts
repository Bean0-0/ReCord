import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { BYTES_PER_SECOND, FRAME_BYTES } from "../plugin/audio";
import { CaptureSession } from "../plugin/capture";
import { type AudioPacket, type AudioSource, PacketDecoder } from "../plugin/loopback";
import { WavRecording, writeAll } from "../plugin/recording";
import type { FileHandle } from "node:fs/promises";
import { pcmFrames } from "./fixtures";

class FakeSource implements AudioSource {
    private packet: ((packet: AudioPacket) => void) | undefined;
    private error: ((error: Error) => void) | undefined;
    stopped = false;
    async start(onPacket: (packet: AudioPacket) => void, onError: (error: Error) => void) { this.packet = onPacket; this.error = onError; }
    async stop() { this.stopped = true; }
    emit(kind: AudioPacket["kind"], time: number, pcm: Buffer) { this.packet?.({ kind, time, pcm }); }
    fail(error: Error) { this.error?.(error); }
}

async function workspace(t: { after: (fn: () => Promise<void>) => void; }) {
    const root = await mkdtemp(join(tmpdir(), "record-test-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return { root, output: join(root, "output") };
}

function packet(kind: number, time: number, pcm: Buffer) {
    const header = Buffer.alloc(16);
    header.writeUInt32LE(pcm.length, 0);
    header.writeUInt32LE(kind, 4);
    header.writeBigInt64LE(BigInt(time), 8);
    return Buffer.concat([header, pcm]);
}

test("capture packets decode correctly across arbitrary pipe boundaries", () => {
    const decoder = new PacketDecoder();
    const output: AudioPacket[] = [];
    const input = Buffer.concat([packet(0, 1234, pcmFrames(1, 1000)), packet(1, 1244, pcmFrames(2, 200))]);
    for (const byte of input) decoder.push(Buffer.from([byte]), value => output.push(value));
    assert.deepEqual(output.map(p => [p.kind, p.time, p.pcm.length, p.pcm.readInt16LE(0)]), [
        ["playout", 1234, FRAME_BYTES, 1000], ["mic", 1244, FRAME_BYTES * 2, 200]
    ]);
    const bad = Buffer.alloc(16);
    bad.writeUInt32LE(400_000);
    assert.throws(() => new PacketDecoder().push(bad, () => { }), /Invalid audio capture packet/);
});

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
        assert.equal(file.readUInt32LE(40), file.length - 44);
    }
    const result = await writer.close();
    assert.equal(result.seconds, 0.08);
    assert.equal(result.segments, 3);
});

test("writer retries short writes and surfaces stalled or failed writes", async () => {
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

test("buffering writes no audio files until saving; clips and recordings share the live stream", async t => {
    const { root, output } = await workspace(t);
    const now = Math.ceil(Date.now() / 10) * 10;
    const source = new FakeSource();
    const capture = new CaptureSession(source, output, false, false, now);
    await capture.prepare();
    source.emit("playout", now, pcmFrames(100, 1000));
    await capture.poll(now + 1000);
    assert.ok(capture.status.bufferedSeconds > 0);
    assert.equal(capture.status.receivingAudio, true);
    assert.deepEqual(await readdir(root), [], "the replay buffer must not create files");
    await capture.startRecording();
    assert.deepEqual(await readdir(output), [], "arming a recording must not create an empty file");
    source.emit("playout", now + 1000, pcmFrames(100, 2000));
    await capture.poll(now + 2000);
    const clip = await capture.saveClip();
    assert.ok(clip.seconds > 1);
    const recording = await capture.stopRecording();
    assert.equal(recording.seconds, 1);
    const saved = await readFile(recording.path);
    assert.equal(saved.readUInt32LE(40), BYTES_PER_SECOND);
    assert.equal(saved.readInt16LE(44), 2000);
    await capture.end();
    assert.equal(source.stopped, true);
});

test("selected microphone audio is mixed only when Discord permits it", async t => {
    const { output } = await workspace(t);
    const now = Math.ceil(Date.now() / 10) * 10;
    const source = new FakeSource();
    const capture = new CaptureSession(source, output, true, true, now);
    await capture.prepare();
    capture.setMicAllowed(now + 300, false);
    capture.setMicAllowed(now + 700, true);
    source.emit("playout", now, pcmFrames(100, 1000));
    source.emit("mic", now, pcmFrames(100, 100));
    await capture.poll(now + 1000);
    await capture.poll(now + 1800);
    const clip = await capture.saveClip();
    const samples = (await readFile(clip.path)).subarray(44);
    assert.deepEqual([25, 35, 75].map(i => samples.readInt16LE(i * FRAME_BYTES)), [1100, 1000, 1100]);
    await capture.end();
});

test("silence advances the in-memory buffer without writing files", async t => {
    const { root, output } = await workspace(t);
    const now = Math.ceil(Date.now() / 10) * 10;
    const capture = new CaptureSession(new FakeSource(), output, false, false, now);
    await capture.prepare();
    await capture.poll(now + 11_000);
    assert.ok(capture.status.bufferedSeconds >= 9);
    assert.equal(capture.status.receivingAudio, false, "silence padding must not imply Discord audio was received");
    assert.deepEqual(await readdir(root), []);
    await capture.end();
});

test("source failures finalize audio already recorded", async t => {
    const { output } = await workspace(t);
    const now = Math.ceil(Date.now() / 10) * 10;
    const source = new FakeSource();
    const capture = new CaptureSession(source, output, false, true, now);
    await capture.prepare();
    await capture.startRecording();
    source.emit("playout", now, pcmFrames(100, 1200));
    await capture.poll(now + 1000);
    source.fail(new Error("audio device failed"));
    await assert.rejects(capture.poll(now + 1010), /audio device failed/);
    const result = await capture.end();
    assert.equal(result!.recording!.seconds, 1);
    const file = await readFile(result!.recording!.path);
    assert.equal(file.readUInt32LE(40), BYTES_PER_SECOND);
    assert.equal(file.readInt16LE(44), 1200);
});

test("microphone mute transitions are applied before queued audio is saved", async t => {
    const { output } = await workspace(t);
    const now = Math.ceil(Date.now() / 10) * 10;
    const source = new FakeSource();
    const capture = new CaptureSession(source, output, true, true, now);
    await capture.prepare();
    source.emit("playout", now, pcmFrames(40, 1000));
    source.emit("mic", now, pcmFrames(40, 100));
    await capture.poll(now + 400);
    capture.setMicAllowed(now + 400, false);
    source.emit("playout", now + 400, pcmFrames(60, 1000));
    source.emit("mic", now + 400, pcmFrames(60, 100));
    await capture.poll(now + 1000);
    await capture.poll(now + 1800);
    const clip = await capture.saveClip();
    const audio = (await readFile(clip.path)).subarray(44);
    assert.equal(audio.readInt16LE(35 * FRAME_BYTES), 1100);
    assert.equal(audio.readInt16LE(45 * FRAME_BYTES), 1000);
    await capture.end();
});

test("capture stops on bounded-queue overflow and large clock jumps", async t => {
    const { output } = await workspace(t);
    const now = Math.ceil(Date.now() / 10) * 10;
    const source = new FakeSource();
    const capture = new CaptureSession(source, output, false, false, now);
    await capture.prepare();
    for (let i = 0; i < 23; i++) source.emit("playout", now + i * 1000, pcmFrames(100, 1));
    await assert.rejects(capture.poll(now), /fell behind/);
    assert.equal(source.stopped, true);
    await capture.end();
    const clockCapture = new CaptureSession(new FakeSource(), output, false, false, now);
    await clockCapture.prepare();
    await assert.rejects(clockCapture.poll(now + 32_000), /timeline jumped/);
    await clockCapture.end();
});

test("a long capture retains only the latest 30 seconds in memory", async t => {
    const { root, output } = await workspace(t);
    const now = Math.ceil(Date.now() / 10) * 10;
    const source = new FakeSource();
    const capture = new CaptureSession(source, output, false, false, now);
    await capture.prepare();
    for (let part = 0; part < 4; part++) {
        source.emit("playout", now + part * 10_000, pcmFrames(1000, 1000 + part * 1000));
        await capture.poll(now + (part + 1) * 10_000);
    }
    assert.equal(capture.status.bufferedSeconds, 30);
    assert.deepEqual(await readdir(root), []);
    const clip = await capture.saveClip();
    const audio = (await readFile(clip.path)).subarray(44);
    assert.equal(audio.length, 30 * BYTES_PER_SECOND);
    assert.equal(audio.readInt16LE(0), 1000);
    assert.equal(audio.readInt16LE(audio.length - 2), 4000);
    await capture.end();
});

test("a backlog mixes timestamped microphone and playout packets in order", async t => {
    const { output } = await workspace(t);
    const now = Math.ceil(Date.now() / 10) * 10;
    const source = new FakeSource();
    const capture = new CaptureSession(source, output, true, true, now);
    await capture.prepare();
    source.emit("playout", now, pcmFrames(300, 1000));
    source.emit("mic", now, pcmFrames(300, 100));
    await capture.poll(now + 4000);
    const clip = await capture.saveClip();
    const audio = (await readFile(clip.path)).subarray(44);
    assert.deepEqual([20, 150, 250].map(i => audio.readInt16LE(i * FRAME_BYTES)), [1100, 1100, 1100]);
    await capture.end();
});
