import assert from "node:assert/strict";
import { test } from "node:test";

import { BYTES_PER_SECOND, FRAME_BYTES, ReplayBuffer, TimelineMixer } from "../plugin/audio";
import { pcm } from "./fixtures";

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

test("silence fills gaps without overwriting received audio", () => {
    const mixer = new TimelineMixer(1000, false, false);
    mixer.add(1000, "playout", pcm(1000));
    mixer.fillSilence(1000);
    mixer.fillSilence(1010);
    const output = mixer.drain(true);
    assert.equal(output.readInt16LE(0), 1000);
    assert.equal(output.readInt16LE(FRAME_BYTES), 0);
});
