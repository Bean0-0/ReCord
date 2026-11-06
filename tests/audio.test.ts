import assert from "node:assert/strict";
import { test } from "node:test";

import { BYTES_PER_SECOND, FRAME_BYTES, ReplayBuffer, TimelineMixer } from "../plugin/audio";
import { DumpDecoder } from "../plugin/dump";
import type { AudioFrame } from "../plugin/dump";
import { byteField, init, mic, pcm, playout, record } from "./fixtures";

test("replay retains exactly the latest 30 seconds through wraparound and oversized writes", () => {
    const buffer = new ReplayBuffer();
    for (let second = 0; second < 45; second++) buffer.push(Buffer.alloc(BYTES_PER_SECOND, second));
    assert.equal(buffer.seconds, 30);
    const snapshot = buffer.snapshot();
    assert.equal(snapshot[0], 15);
    assert.equal(snapshot.at(-1), 44);
    buffer.push(Buffer.alloc(BYTES_PER_SECOND * 31, 55));
    assert.equal(buffer.snapshot().length, 30 * BYTES_PER_SECOND);
    assert.ok(buffer.snapshot().every(value => value === 55));
    assert.equal(snapshot[0], 15, "snapshot must not share writable ring memory");
});

test("partial early clips return only the available duration", () => {
    const buffer = new ReplayBuffer();
    buffer.push(Buffer.alloc(BYTES_PER_SECOND / 2));
    assert.equal(buffer.seconds, 0.5);
    assert.equal(buffer.snapshot().length, BYTES_PER_SECOND / 2);
});

test("decoder handles every byte boundary and initializes sample rate/channel changes", () => {
    const decoder = new DumpDecoder();
    const output: AudioFrame[] = [];
    const data = Buffer.concat([init(1_000_000), playout(1200), mic(500), init(1_000_010, 16000, 1), playout(800, 16000, 1)]);
    for (const byte of data) decoder.push(Buffer.from([byte]), frame => output.push(frame));
    assert.deepEqual(output.map(f => [f.kind, f.time, f.pcm.length, f.pcm.readInt16LE(0)]), [
        ["playout", 1_000_000, FRAME_BYTES, 1200], ["mic", 1_000_000, FRAME_BYTES, 500], ["playout", 1_000_010, FRAME_BYTES, 800]
    ]);
    assert.equal(output[2].pcm.readInt16LE(2), 800);
});

test("decoder handles float planes and never substitutes raw microphone input", () => {
    const decoder = new DumpDecoder();
    const output: AudioFrame[] = [];
    const plane = Buffer.alloc(480 * 4);
    for (let i = 0; i < plane.length; i += 4) plane.writeFloatLE(0.25, i);
    decoder.push(Buffer.concat([
        init(1000), record(1, 3, Buffer.concat([byteField(2, plane), byteField(2, plane)])),
        record(2, 4, byteField(1, pcm(10000, 48000, 1))), mic(42)
    ]), frame => output.push(frame));
    assert.equal(output.length, 2);
    assert.equal(output[0].pcm.readInt16LE(0), 8192);
    assert.equal(output[1].time, 1010);
    assert.equal(output[1].pcm.readInt16LE(0), 42);
});

test("decoder rejects malformed lengths, invalid layouts, and unsupported rates", () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32LE(1_000_000);
    assert.throws(() => new DumpDecoder().push(oversized, () => { }), /record size/);
    assert.throws(() => new DumpDecoder().push(Buffer.concat([init(1000), record(1, 3, byteField(1, Buffer.alloc(3)))]), () => { }), /audio layout/);
    assert.throws(() => new DumpDecoder().push(init(1000, 96000), () => { }), /audio rate/);
    const malformed = Buffer.from([4, 0, 0, 0, 8, 0, 18, 50]);
    assert.throws(() => new DumpDecoder().push(malformed, () => { }), /Truncated/);
});

test("decoder skips signed diagnostic metadata encoded as a ten-byte varint", () => {
    const decoder = new DumpDecoder();
    const output: AudioFrame[] = [];
    const negativeDelay = Buffer.from([24, 255, 255, 255, 255, 255, 255, 255, 255, 255, 1]);
    decoder.push(Buffer.concat([init(1000), record(2, 4, Buffer.concat([byteField(2, pcm(500, 48000, 1)), negativeDelay]))]), frame => output.push(frame));
    assert.equal(output.length, 1);
    assert.equal(output[0].pcm.readInt16LE(0), 500);
});

test("mixer preserves gaps and applies microphone mute policy to audio timestamps", () => {
    const mixer = new TimelineMixer(1000, true, true);
    mixer.setMicAllowed(1010, false);
    mixer.setMicAllowed(1030, true);
    for (const time of [1000, 1010, 1030]) {
        mixer.add(time, "playout", pcm(1000));
        mixer.add(time, "mic", pcm(100));
    }
    const output = mixer.drain(true);
    assert.equal(output.length, 4 * FRAME_BYTES);
    assert.deepEqual([0, 1, 2, 3].map(i => output.readInt16LE(i * FRAME_BYTES)), [1100, 1000, 0, 1100]);
    const excluded = new TimelineMixer(1000, false, true);
    excluded.add(1000, "playout", pcm(1000));
    excluded.add(1000, "mic", pcm(100));
    assert.equal(excluded.drain(true).readInt16LE(0), 1000);
});

test("mixer bounds pending work and clips mixed samples without integer wrap", () => {
    const mixer = new TimelineMixer(1000, true, true);
    mixer.add(1000, "playout", pcm(32000));
    mixer.add(1000, "mic", pcm(2000));
    assert.equal(mixer.drain(true).readInt16LE(0), 32767);
    assert.throws(() => mixer.add(5000, "playout", pcm(0)), /timeline gap/);
});
