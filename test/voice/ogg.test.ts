import { describe, expect, it } from 'vitest';
import { oggCrc, oggOpusFile, opusPacketSamples } from '../../src/voice/ogg.js';

/** An independent, bit-by-bit Ogg CRC, to check the table-driven one. */
function slowCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? ((crc << 1) ^ 0x04c11db7) >>> 0 : (crc << 1) >>> 0;
  }
  return crc >>> 0;
}

interface Page {
  flags: number;
  granule: bigint;
  sequence: number;
  packets: Buffer[];
  crcOk: boolean;
}

/** Reads an Ogg file back into pages and whole packets. */
function readOgg(file: Buffer): Page[] {
  const pages: Page[] = [];
  let offset = 0;
  while (offset < file.length) {
    expect(file.toString('ascii', offset, offset + 4)).toBe('OggS');
    const count = file.readUInt8(offset + 26);
    const lacing = [...file.subarray(offset + 27, offset + 27 + count)];
    const size = 27 + count + lacing.reduce((sum, value) => sum + value, 0);
    const raw = Buffer.from(file.subarray(offset, offset + size));
    const crc = raw.readUInt32LE(22);
    raw.writeUInt32LE(0, 22);
    const packets: Buffer[] = [];
    let at = offset + 27 + count;
    let current: Buffer[] = [];
    for (const value of lacing) {
      current.push(file.subarray(at, at + value));
      at += value;
      if (value < 255) {
        packets.push(Buffer.concat(current));
        current = [];
      }
    }
    pages.push({ flags: file.readUInt8(offset + 5), granule: file.readBigInt64LE(offset + 6), sequence: file.readUInt32LE(offset + 18), packets, crcOk: crc === slowCrc(raw) });
    offset += size;
  }
  return pages;
}

// A 20 ms CELT stereo frame's TOC byte: config 31 (CELT FB 20 ms), stereo, one frame.
const frame = (size: number, fill = 7) => Buffer.concat([Buffer.from([0xfc]), Buffer.alloc(size - 1, fill)]);

describe('Ogg Opus files', () => {
  it('compute the Ogg CRC the same as a bit-by-bit version', () => {
    const data = Buffer.from('OggS discordlancer test data 0123456789');
    expect(oggCrc(data)).toBe(slowCrc(data));
    expect(oggCrc(new Uint8Array())).toBe(0);
  });

  it('know how long an Opus packet is from its first byte', () => {
    expect(opusPacketSamples(Buffer.from([0xfc]))).toBe(960); // CELT 20 ms
    expect(opusPacketSamples(Buffer.from([0x78]))).toBe(960); // config 15, Hybrid 20 ms
    expect(opusPacketSamples(Buffer.from([0x08]))).toBe(960); // SILK 20 ms
    expect(opusPacketSamples(Buffer.from([0xfd]))).toBe(1920); // two 20 ms frames
    expect(opusPacketSamples(Buffer.from([0xfb, 0x03]))).toBe(2880); // code 3, three 20 ms frames
    expect(opusPacketSamples(Buffer.alloc(0))).toBe(0);
  });

  it('hold the headers, then every packet in order, with valid CRCs, granules and flags', () => {
    const packets = Array.from({ length: 600 }, (_, index) => frame(60 + (index % 300), index % 250));
    const pages = readOgg(oggOpusFile(packets));
    expect(pages.every((page) => page.crcOk)).toBe(true);
    expect(pages.map((page) => page.sequence)).toEqual(pages.map((_, index) => index));
    expect(pages[0]!.flags).toBe(0x02);
    expect(pages[0]!.packets[0]!.toString('ascii', 0, 8)).toBe('OpusHead');
    expect(pages[0]!.packets[0]!.readUInt8(9)).toBe(2);
    expect(pages[1]!.packets[0]!.toString('ascii', 0, 8)).toBe('OpusTags');
    expect(pages.at(-1)!.flags).toBe(0x04);
    expect(pages.at(-1)!.granule).toBe(600n * 960n);
    expect(pages.slice(2).flatMap((page) => page.packets)).toEqual(packets);
    // A packet of 255 bytes or more needs several lacing values; it must still come back whole.
    const big = [frame(700), frame(255), frame(510)];
    expect(readOgg(oggOpusFile(big)).slice(2).flatMap((page) => page.packets)).toEqual(big);
  });

  it('is still a valid file with no audio', () => {
    const pages = readOgg(oggOpusFile([]));
    expect(pages).toHaveLength(3);
    expect(pages.every((page) => page.crcOk)).toBe(true);
  });
});
