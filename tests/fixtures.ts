import { Buffer } from "node:buffer";

export function pcm(value: number, rate = 48000, channels = 2) {
    const data = Buffer.alloc(rate / 100 * channels * 2);
    for (let i = 0; i < data.length; i += 2) data.writeInt16LE(value, i);
    return data;
}

export function pcmFrames(count: number, value: number) {
    return Buffer.concat(Array.from({ length: count }, () => pcm(value)));
}
