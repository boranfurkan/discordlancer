// Pure: wraps Discord's Opus packets in an Ogg file (RFC 7845), so one speaker's turn
// becomes a normal audio file for transcription. Written here rather than taken from
// prism-media's alpha release; it needs no native code and no decoding.

const OGG_CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let crc = i << 24;
    for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
    table[i] = crc >>> 0;
  }
  return table;
})();

/** Ogg's CRC-32: polynomial 0x04C11DB7, not reflected, starting at 0. */
export function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) crc = ((crc << 8) ^ OGG_CRC_TABLE[((crc >>> 24) ^ byte) & 0xff]!) >>> 0;
  return crc >>> 0;
}

/** How many 48 kHz samples an Opus packet holds, from its TOC byte (RFC 6716, 3.1). */
export function opusPacketSamples(packet: Uint8Array): number {
  const toc = packet[0];
  if (toc === undefined) return 0;
  const config = toc >> 3;
  let frameMs: number;
  if (config < 12) frameMs = [10, 20, 40, 60][config % 4]!;
  else if (config < 16) frameMs = [10, 20][config % 2]!;
  else frameMs = [2.5, 5, 10, 20][config % 4]!;
  const code = toc & 0x03;
  const frames = code === 0 ? 1 : code === 3 ? (packet[1] ?? 0) & 0x3f : 2;
  return frameMs * 48 * frames;
}

const FLAG_BOS = 0x02;
const FLAG_EOS = 0x04;
const MAX_SEGMENTS = 255;

function page(flags: number, granule: bigint, serial: number, sequence: number, packets: readonly Uint8Array[]): Buffer {
  const lacing: number[] = [];
  for (const packet of packets) {
    for (let left = packet.length; ; left -= 255) {
      if (left >= 255) lacing.push(255);
      else {
        lacing.push(left);
        break;
      }
    }
  }
  const header = Buffer.alloc(27 + lacing.length);
  header.write('OggS', 0, 'ascii');
  header.writeUInt8(0, 4);
  header.writeUInt8(flags, 5);
  header.writeBigInt64LE(granule, 6);
  header.writeUInt32LE(serial >>> 0, 14);
  header.writeUInt32LE(sequence, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt8(lacing.length, 26);
  Buffer.from(lacing).copy(header, 27);
  const full = Buffer.concat([header, ...packets]);
  full.writeUInt32LE(oggCrc(full), 22);
  return full;
}

/** How many lacing values a packet needs. */
const lacingCount = (packet: Uint8Array) => Math.floor(packet.length / 255) + 1;

export interface OggOptions {
  channels?: number;
  serial?: number;
}

/** An Ogg Opus file holding these packets, in order. */
export function oggOpusFile(packets: readonly Uint8Array[], options: OggOptions = {}): Buffer {
  const channels = options.channels ?? 2;
  const serial = options.serial ?? 0x44_4c_4e_43; // "DLNC"
  const head = Buffer.alloc(19);
  head.write('OpusHead', 0, 'ascii');
  head.writeUInt8(1, 8); // version
  head.writeUInt8(channels, 9);
  head.writeUInt16LE(0, 10); // pre-skip: Discord's packets start mid-stream
  head.writeUInt32LE(48_000, 12);
  head.writeInt16LE(0, 16); // output gain
  head.writeUInt8(0, 18); // channel mapping family
  const vendor = Buffer.from('discordlancer', 'ascii');
  const tags = Buffer.alloc(8 + 4 + vendor.length + 4);
  tags.write('OpusTags', 0, 'ascii');
  tags.writeUInt32LE(vendor.length, 8);
  vendor.copy(tags, 12);
  tags.writeUInt32LE(0, 12 + vendor.length);

  const pages = [page(FLAG_BOS, 0n, serial, 0, [head]), page(0, 0n, serial, 1, [tags])];
  let sequence = 2;
  let granule = 0n;
  let current: Uint8Array[] = [];
  let segments = 0;
  const audio = packets.filter((packet) => packet.length > 0 && packet.length < 255 * 255);
  audio.forEach((packet, index) => {
    if (segments + lacingCount(packet) > MAX_SEGMENTS) {
      pages.push(page(0, granule, serial, sequence++, current));
      current = [];
      segments = 0;
    }
    current.push(packet);
    segments += lacingCount(packet);
    granule += BigInt(opusPacketSamples(packet));
    if (index === audio.length - 1) pages.push(page(FLAG_EOS, granule, serial, sequence++, current));
  });
  if (audio.length === 0) pages.push(page(FLAG_EOS, 0n, serial, sequence, []));
  return Buffer.concat(pages);
}
