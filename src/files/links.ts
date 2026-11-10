// Links posted in a project channel: which ones the bot reads, and a fetch that only
// ever reaches public https addresses. The address check runs inside the connection's
// own DNS lookup, so a name can't resolve to a public address for the check and a
// private one for the request. Redirects are followed by hand and checked the same way.

import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import type { Readable } from 'node:stream';

export const LINK_LIMITS = { perMessage: 3, maxBytes: 14 * 1024 * 1024, timeoutMs: 20_000, maxRedirects: 4 };

// Links that aren't project material, or that have their own command (/review-repo).
const SKIP_HOSTS = [
  /(^|\.)discord(app)?\.(com|gg|net)$/,
  /(^|\.)discordapp\.net$/,
  /(^|\.)(tenor|giphy)\.com$/,
  /(^|\.)(explorer\.solana\.com|solscan\.io|solana\.fm)$/,
  /^(www\.)?github\.com$/,
  /^gist\.github\.com$/,
];

/** Pure: the https links in a message worth reading, at most a few, without duplicates. */
export function findLinks(text: string, max = LINK_LIMITS.perMessage): string[] {
  const links: string[] = [];
  // Discord wraps a link in <…> to hide its preview; it is still a link.
  for (const match of text.matchAll(/https:\/\/[^\s<>()"'`]+/g)) {
    const raw = match[0].replace(/[.,;:!?*_~|]+$/, '');
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.username || url.password || (url.port && url.port !== '443')) continue;
    if (SKIP_HOSTS.some((pattern) => pattern.test(url.hostname.toLowerCase()))) continue;
    url.hash = '';
    const clean = url.toString();
    if (!links.includes(clean)) links.push(clean);
    if (links.length >= max) break;
  }
  return links;
}

/** Pure: a public Google Docs, Sheets or Slides link turned into its export, which needs no sign-in when shared publicly. */
export function exportUrl(link: string): string {
  const url = new URL(link);
  if (url.hostname !== 'docs.google.com') return link;
  const match = /^\/(document|spreadsheets|presentation)\/d\/([A-Za-z0-9_-]{20,})/.exec(url.pathname);
  if (!match) return link;
  const [, kind, id] = match;
  if (kind === 'document') return `https://docs.google.com/document/d/${id}/export?format=txt`;
  if (kind === 'spreadsheets') return `https://docs.google.com/spreadsheets/d/${id}/export?format=csv`;
  return `https://docs.google.com/presentation/d/${id}/export/pdf`;
}

// Apps whose links show nothing readable without signing in or running the app.
const APPS: Array<[RegExp, string, string]> = [
  [/(^|\.)figma\.com$/, 'Figma', 'export the frames as PNG or PDF'],
  [/(^|\.)loom\.com$/, 'Loom', 'download the video and post it here'],
  [/(^|\.)miro\.com$/, 'Miro', 'export the board as a PDF or image'],
  [/(^|\.)canva\.com$/, 'Canva', 'download it as a PDF or PNG'],
  [/^drive\.google\.com$/, 'Google Drive', 'download the file and post it here'],
];

/** Pure: for a link the bot can't read, the app's name and what to send instead. */
export function unreadableApp(link: string): { app: string; instead: string } | undefined {
  const host = new URL(link).hostname.toLowerCase();
  const found = APPS.find(([pattern]) => pattern.test(host));
  return found ? { app: found[1], instead: found[2] } : undefined;
}

/** Hosts that answer a signed-out visitor with a sign-in page. */
const SIGN_IN_HOSTS = /^(accounts\.google\.com|www\.figma\.com|figma\.com|login\.microsoftonline\.com|www\.notion\.so|www\.dropbox\.com)$/;

function ipv4Number(address: string): number {
  return address.split('.').reduce((total, part) => total * 256 + Number(part), 0);
}

const V4_BLOCKED: Array<[string, number]> = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
];

/** Pure: whether an IP address is private, local or otherwise not on the public internet. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const value = ipv4Number(address);
    return V4_BLOCKED.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      return ((value & mask) >>> 0) === ((ipv4Number(base) & mask) >>> 0);
    });
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
    if (mapped) return isPrivateAddress(mapped);
    if (lower === '::' || lower === '::1') return true;
    const first = parseInt(lower.split(':')[0] || '0', 16);
    // fc00::/7 (private), fe80::/10 (link-local), ff00::/8 (multicast), 2001:db8::/32 (examples), and 64:ff9b::/96 (NAT64).
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || lower.startsWith('2001:db8:') || lower.startsWith('64:ff9b:');
  }
  return true;
}

export class LinkError extends Error {
  override name = 'LinkError';
}

/** A DNS lookup that refuses names pointing anywhere private. */
function publicLookup(hostname: string, options: object, callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(error, '');
    const list = addresses as LookupAddress[];
    if (list.length === 0 || list.some((entry) => isPrivateAddress(entry.address))) {
      return callback(Object.assign(new Error('that address is not on the public internet'), { code: 'EPRIVATE' }), '');
    }
    const wantsAll = (options as { all?: boolean }).all;
    if (wantsAll) return callback(null, list);
    callback(null, list[0]!.address, list[0]!.family);
  });
}

export interface FetchedLink {
  /** Where the content finally came from, after redirects. */
  url: string;
  contentType: string;
  body: Buffer;
}

function decoded(stream: Readable, encoding: string | undefined): Readable {
  if (encoding === 'gzip' || encoding === 'x-gzip') return stream.pipe(createGunzip());
  if (encoding === 'br') return stream.pipe(createBrotliDecompress());
  if (encoding === 'deflate') return stream.pipe(createInflate());
  return stream;
}

function once(url: URL): Promise<{ status: number; location?: string | undefined; contentType: string; body?: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(
      url,
      {
        method: 'GET',
        lookup: publicLookup as never,
        timeout: LINK_LIMITS.timeoutMs,
        headers: {
          // A plain, generic name: nothing about who runs the bot.
          'user-agent': 'Mozilla/5.0 (compatible; DiscordlancerLinkReader/1.0)',
          accept: 'text/html,application/xhtml+xml,application/pdf,text/plain,text/csv,image/*;q=0.8,*/*;q=0.5',
          'accept-encoding': 'gzip, deflate, br',
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const contentType = String(response.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
        if (status >= 300 && status < 400) {
          response.resume();
          return resolve({ status, location: response.headers.location, contentType });
        }
        const declared = Number(response.headers['content-length'] ?? 0);
        if (declared > LINK_LIMITS.maxBytes) {
          response.destroy();
          return reject(new LinkError('the page is too large to read'));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        const body = decoded(response, String(response.headers['content-encoding'] ?? '').toLowerCase() || undefined);
        body.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > LINK_LIMITS.maxBytes) {
            response.destroy();
            body.destroy();
            reject(new LinkError('the page is too large to read'));
            return;
          }
          chunks.push(chunk);
        });
        body.on('end', () => resolve({ status, contentType, body: Buffer.concat(chunks) }));
        body.on('error', (error) => reject(error));
      },
    );
    request.on('timeout', () => request.destroy(new LinkError('the page took too long to answer')));
    request.on('error', (error: NodeJS.ErrnoException) => reject(error.code === 'EPRIVATE' ? new LinkError(error.message) : error instanceof LinkError ? error : new LinkError("the page couldn't be reached")));
    request.end();
  });
}

/** Fetches a public https page or file, following a few redirects, each checked. Throws LinkError. */
export async function fetchPublic(link: string): Promise<FetchedLink> {
  let url = new URL(link);
  for (let hop = 0; hop <= LINK_LIMITS.maxRedirects; hop++) {
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new LinkError('only public https links are read');
    if (isIP(url.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new LinkError('that address is not on the public internet');
    if (SIGN_IN_HOSTS.test(url.hostname) && hop > 0) throw new LinkError('the page needs a sign-in');
    const result = await once(url);
    if (result.location) {
      url = new URL(result.location, url);
      continue;
    }
    if (result.status === 401 || result.status === 403) throw new LinkError('the page needs a sign-in or blocks automated readers');
    if (result.status === 404 || result.status === 410) throw new LinkError('the page was not found');
    if (result.status < 200 || result.status >= 300) throw new LinkError(`the site answered with an error (${result.status})`);
    return { url: url.toString(), contentType: result.contentType, body: result.body ?? Buffer.alloc(0) };
  }
  throw new LinkError('the link redirects too many times');
}
