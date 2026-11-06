import { Buffer } from "node:buffer";

export function varint(value: number) {
    const data: number[] = [];
    do {
        const byte = value % 128;
        value = Math.floor(value / 128);
        data.push(byte | (value ? 128 : 0));
    } while (value);
    return Buffer.from(data);
}

export const numberField = (key: number, value: number) => Buffer.concat([varint(key * 8), varint(value)]);
export const byteField = (key: number, value: Buffer) => Buffer.concat([varint(key * 8 + 2), varint(value.length), value]);

export function record(type: number, key: number, data: Buffer) {
    const body = Buffer.concat([numberField(1, type), byteField(key, data)]);
    const size = Buffer.alloc(4);
    size.writeUInt32LE(body.length);
    return Buffer.concat([size, body]);
}

export function init(time: number, rate = 48000, channels = 2) {
    return record(0, 2, Buffer.concat([
        numberField(1, rate), numberField(4, 1), numberField(5, channels), numberField(6, rate), numberField(7, rate), numberField(10, time)
    ]));
}

export function pcm(value: number, rate = 48000, channels = 2) {
    const data = Buffer.alloc(rate / 100 * channels * 2);
    for (let i = 0; i < data.length; i += 2) data.writeInt16LE(value, i);
    return data;
}

export const playout = (value: number, rate = 48000, channels = 2) => record(1, 3, byteField(1, pcm(value, rate, channels)));
export const mic = (value: number) => record(2, 4, byteField(2, pcm(value, 48000, 1)));

export function frames(count: number, value: number) {
    return Buffer.concat(Array.from({ length: count }, () => Buffer.concat([playout(value), mic(100)])));
}
