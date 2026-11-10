// Pure: reads a zip file (Word, Excel and PowerPoint files are zips too) with Node's own
// zlib, so no library is needed. Limits keep a "zip bomb" from filling memory: every
// entry is checked against them before it is inflated, and inflating stops at the limit.

import { inflateRawSync } from 'node:zlib';

export const ZIP_LIMITS = { maxEntries: 5_000, maxEntryBytes: 20 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024 };

export class ZipError extends Error {
  override name = 'ZipError';
}

export interface ZipEntry {
  name: string;
  size: number;
  compressedSize: number;
  /** Encrypted entries can't be read; they are listed only. */
  encrypted: boolean;
}

export interface ZipFile {
  entries: ZipEntry[];
  /** An entry's contents, or undefined if it is missing, encrypted, too large or unreadable. */
  read(name: string): Buffer | undefined;
}

const END_OF_DIRECTORY = 0x06054b50;
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

/** Pure: the zip's directory, and a reader for its entries. Throws ZipError if it isn't a zip. */
export function readZip(buffer: Buffer, limits = ZIP_LIMITS): ZipFile {
  let end = -1;
  for (let at = buffer.length - 22; at >= Math.max(0, buffer.length - 22 - 65_535); at--) {
    if (buffer.readUInt32LE(at) === END_OF_DIRECTORY) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ZipError('not a zip file');
  const count = buffer.readUInt16LE(end + 10);
  const directoryOffset = buffer.readUInt32LE(end + 16);
  if (count === 0xffff || directoryOffset === 0xffffffff) throw new ZipError('zip64 files are not supported');
  if (count > limits.maxEntries) throw new ZipError(`too many entries (${count})`);

  const entries: Array<ZipEntry & { method: number; offset: number }> = [];
  let at = directoryOffset;
  for (let index = 0; index < count; index++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== DIRECTORY_ENTRY) throw new ZipError('broken zip directory');
    const flags = buffer.readUInt16LE(at + 8);
    const method = buffer.readUInt16LE(at + 10);
    const compressedSize = buffer.readUInt32LE(at + 20);
    const size = buffer.readUInt32LE(at + 24);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const offset = buffer.readUInt32LE(at + 42);
    const name = buffer.toString('utf8', at + 46, at + 46 + nameLength);
    entries.push({ name, size, compressedSize, encrypted: (flags & 1) === 1, method, offset });
    at += 46 + nameLength + extraLength + commentLength;
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry]));
  let inflated = 0;
  return {
    entries: entries.map(({ name, size, compressedSize, encrypted }) => ({ name, size, compressedSize, encrypted })),
    read(name) {
      const entry = byName.get(name);
      if (!entry || entry.encrypted || entry.size > limits.maxEntryBytes || inflated + entry.size > limits.maxTotalBytes) return undefined;
      if (entry.offset + 30 > buffer.length || buffer.readUInt32LE(entry.offset) !== LOCAL_HEADER) return undefined;
      const start = entry.offset + 30 + buffer.readUInt16LE(entry.offset + 26) + buffer.readUInt16LE(entry.offset + 28);
      const data = buffer.subarray(start, start + entry.compressedSize);
      try {
        const contents = entry.method === 0 ? Buffer.from(data) : entry.method === 8 ? inflateRawSync(data, { maxOutputLength: limits.maxEntryBytes }) : undefined;
        if (contents) inflated += contents.length;
        return contents;
      } catch {
        return undefined;
      }
    },
  };
}
