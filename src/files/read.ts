// Reads one shared file or link into notes: works out what it is, turns it into
// something Gemini can read (its pages, pictures, audio or video as they are; Office
// files, archives and web pages as text), and asks Gemini for the notes. A file the bot
// can't read is "skipped" with a reason the person can act on; a temporary failure
// (Gemini or a download) throws, so the file can be tried again later.

import { createHash } from 'node:crypto';
import { FILE_NOTE_SCHEMA, FILE_SYSTEM, FILES_PROMPT_VERSION, FileNoteOutput } from '../prompts/files.js';
import type { SpeechToTextApi, SttWord } from '../services/elevenlabs.js';
import { SPEC_MODEL, type GeminiApi, type Part } from '../services/gemini.js';
import { docxText, htmlText, pptxText, xlsxText, type OfficeText } from './office.js';
import { readZip, ZipError } from './zip.js';

export type FileKind = 'image' | 'pdf' | 'text' | 'docx' | 'pptx' | 'xlsx' | 'audio' | 'video' | 'zip' | 'web' | 'unsupported';

const EXTENSIONS: Record<string, FileKind> = {
  png: 'image', jpg: 'image', jpeg: 'image', webp: 'image', heic: 'image', heif: 'image',
  pdf: 'pdf',
  docx: 'docx', pptx: 'pptx', xlsx: 'xlsx',
  mp3: 'audio', wav: 'audio', m4a: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', aac: 'audio', flac: 'audio',
  mp4: 'video', mov: 'video', webm: 'video', mpeg: 'video', mpg: 'video', avi: 'video', '3gp': 'video', wmv: 'video', m4v: 'video',
  zip: 'zip',
};

const TEXT_EXTENSIONS = new Set(
  'txt md markdown csv tsv json yaml yml xml html htm log ini toml env.example sql graphql gql ts tsx js jsx mjs cjs py rb go rs java kt swift php cs c h cpp hpp css scss vue svelte sh prisma rtf'.split(' '),
);

/** Old binary Office formats, which need saving in the new format first. */
const OLD_OFFICE: Record<string, string> = { doc: '.docx or PDF', ppt: '.pptx or PDF', xls: '.xlsx or CSV', pages: 'PDF', key: 'PDF', numbers: 'CSV or .xlsx' };

const MIME_KIND: Array<[RegExp, FileKind]> = [
  [/^image\/(png|jpeg|webp|heic|heif)$/, 'image'],
  [/^application\/pdf$/, 'pdf'],
  [/wordprocessingml\.document$/, 'docx'],
  [/presentationml\.presentation$/, 'pptx'],
  [/spreadsheetml\.sheet$/, 'xlsx'],
  [/^audio\//, 'audio'],
  [/^video\//, 'video'],
  [/^application\/(zip|x-zip-compressed)$/, 'zip'],
  [/^(text\/|application\/(json|xml|x-yaml|yaml|sql|javascript|x-sh))/, 'text'],
];

const extension = (name: string) => (name.includes('.') ? name.split('.').pop()!.toLowerCase() : '');
const baseType = (contentType: string | null | undefined) => (contentType ?? '').split(';')[0]!.trim().toLowerCase();

/** Pure: what kind of file this is, from its name and type. */
export function fileKind(name: string, contentType: string | null | undefined): FileKind {
  const type = baseType(contentType);
  const ext = extension(name);
  if (EXTENSIONS[ext]) return EXTENSIONS[ext];
  const byType = MIME_KIND.find(([pattern]) => pattern.test(type))?.[1];
  if (byType) return byType;
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unsupported';
}

/** Raw size limits per kind. Inline requests must stay under 20 MB once base64-encoded. */
export const KIND_LIMITS: Record<FileKind, number> = {
  image: 7 * 1024 * 1024,
  pdf: 14 * 1024 * 1024,
  video: 14 * 1024 * 1024,
  audio: 25 * 1024 * 1024,
  text: 2 * 1024 * 1024,
  docx: 25 * 1024 * 1024,
  pptx: 40 * 1024 * 1024,
  xlsx: 25 * 1024 * 1024,
  zip: 25 * 1024 * 1024,
  web: 14 * 1024 * 1024,
  unsupported: 0,
};
/** Audio Gemini hears itself (without ElevenLabs) is sent inline too. */
const GEMINI_AUDIO_LIMIT = 14 * 1024 * 1024;

const megabytes = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`;

/** Pure: why this file won't be read, before downloading it, or undefined if it will be. */
export function skipReason(name: string, contentType: string | null | undefined, size: number): string | undefined {
  const kind = fileKind(name, contentType);
  const old = OLD_OFFICE[extension(name)];
  if (old) return `this is an older file format the bot can't open; saving it as ${old} works`;
  if (kind === 'unsupported') {
    if (/^image\//.test(baseType(contentType)) || extension(name) === 'gif') return "the bot reads PNG, JPEG, WebP and HEIC pictures; a screenshot in one of those works";
    return "the bot can't read this type of file; a PDF, an image, or a Word, Excel or PowerPoint file works";
  }
  if (size > KIND_LIMITS[kind]) return `it's too large to read (over ${megabytes(KIND_LIMITS[kind])}); a smaller export or a shorter clip works`;
  return undefined;
}

export interface SharedContext {
  project: string;
  /** "Client (Laura)", "Furkan (owner)". */
  who: string;
  at: Date;
  /** The message the file came with, if any. */
  message: string;
}

export type ReadResult =
  | { status: 'read'; kind: FileKind; note: FileNoteOutput; sha256: string; size: number; model: string; promptVersion: string; via?: string | undefined }
  | { status: 'skipped'; kind: FileKind; reason: string; sha256?: string | undefined; size?: number | undefined };

export interface ReadDeps {
  gemini: GeminiApi;
  stt?: SpeechToTextApi | undefined;
}

const fence = (tag: string, text: string, attrs = '') => `<${tag}${attrs}>\n${text}\n</${tag}>`;

/** Pure: the "who shared it" block, fenced as data. */
export function sharedBlock(name: string, context: SharedContext): string {
  const when = context.at.toISOString().slice(0, 16).replace('T', ' ');
  return fence('shared', [`Project: ${context.project}`, `Shared by: ${context.who}`, `When: ${when} UTC`, `File: ${name}`, `Message with it: ${context.message.trim() || '(none)'}`].join('\n'));
}

/** Pure: an ElevenLabs transcript with a [mm:ss] mark at the start of each line of about 20 seconds. */
export function timedTranscript(words: readonly SttWord[]): string {
  const lines: string[] = [];
  let current = '';
  let lineStart: number | undefined;
  for (const word of words) {
    if (word.type === 'audio_event') continue;
    if (word.type === 'word' && lineStart === undefined) lineStart = word.start ?? 0;
    current += word.text;
    if (word.type === 'word' && lineStart !== undefined && (word.end ?? 0) - lineStart >= 20 && /[.!?]$/.test(word.text)) {
      lines.push(`[${clock(lineStart)}] ${current.trim()}`);
      current = '';
      lineStart = undefined;
    }
  }
  if (current.trim()) lines.push(`[${clock(lineStart ?? 0)}] ${current.trim()}`);
  return lines.join('\n');
}

const clock = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

const ZIP_TEXT = { maxFiles: 40, maxChars: 150_000, maxListed: 300 };
const SKIP_IN_ZIP = /(^|\/)(node_modules|\.git|dist|build|vendor|__pycache__|\.next|__MACOSX)\//;

/** Pure: an archive's file list and the text files inside it. */
export function zipText(file: Buffer): string {
  const zip = readZip(file);
  const files = zip.entries.filter((entry) => !entry.name.endsWith('/'));
  const listed = files.slice(0, ZIP_TEXT.maxListed).map((entry) => `- ${entry.name} (${entry.size} bytes)${entry.encrypted ? ' [encrypted]' : ''}`);
  const blocks: string[] = [];
  let used = 0;
  for (const entry of files) {
    if (blocks.length >= ZIP_TEXT.maxFiles || used >= ZIP_TEXT.maxChars) break;
    if (SKIP_IN_ZIP.test(entry.name) || !TEXT_EXTENSIONS.has(extension(entry.name)) || entry.size > 200_000) continue;
    const content = zip.read(entry.name);
    if (!content || content.subarray(0, 8_000).includes(0)) continue;
    const text = content.toString('utf8').slice(0, ZIP_TEXT.maxChars - used);
    used += text.length;
    blocks.push(fence('file', text, ` path="${entry.name}"`));
  }
  return [`${files.length} file(s) in the archive${files.length > ZIP_TEXT.maxListed ? `, the first ${ZIP_TEXT.maxListed} listed` : ''}:`, ...listed, '', ...blocks].join('\n');
}

const officeReaders: Record<'docx' | 'pptx' | 'xlsx', (file: Buffer) => OfficeText> = { docx: docxText, pptx: pptxText, xlsx: xlsxText };

const mimeFor = (kind: FileKind, name: string, contentType: string | null | undefined): string => {
  const type = baseType(contentType);
  if (type && type !== 'application/octet-stream') return type;
  const ext = extension(name);
  if (kind === 'image') return ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
  if (kind === 'audio') return ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : `audio/${ext}`;
  if (kind === 'video') return ext === 'mov' ? 'video/quicktime' : `video/${ext}`;
  return 'application/octet-stream';
};

/** A permanent reason not to read something, rather than a failure worth retrying. */
class Unreadable extends Error {}

/** Turns the file into Gemini input: text first (who shared it, then any text from the file), then media. */
async function toParts(kind: FileKind, name: string, contentType: string | null | undefined, body: Buffer, deps: ReadDeps): Promise<{ text: string; media: Part[]; via?: string }> {
  const base64 = () => body.toString('base64');
  switch (kind) {
    case 'image':
      return { text: 'The picture follows.', media: [{ type: 'image', data: base64(), mime_type: mimeFor(kind, name, contentType) }] };
    case 'pdf':
      return { text: 'The PDF follows.', media: [{ type: 'document', data: base64(), mime_type: 'application/pdf' }] };
    case 'video':
      return { text: 'The video follows.', media: [{ type: 'video', data: base64(), mime_type: mimeFor(kind, name, contentType) }] };
    case 'audio': {
      if (deps.stt) {
        const result = await deps.stt.transcribe(body, name, mimeFor(kind, name, contentType));
        const transcript = timedTranscript(result.words) || result.text;
        if (!transcript.trim()) throw new Unreadable('no speech could be heard in it');
        return { text: fence('transcript', transcript, ` language="${result.languageCode}" note="AI transcript by ElevenLabs"`), media: [], via: 'elevenlabs' };
      }
      if (body.length > GEMINI_AUDIO_LIMIT) throw new Unreadable(`it's too large to read (over ${megabytes(GEMINI_AUDIO_LIMIT)}); a shorter recording works`);
      return { text: 'The audio follows.', media: [{ type: 'audio', data: base64(), mime_type: mimeFor(kind, name, contentType) }] };
    }
    case 'text': {
      if (body.subarray(0, 8_000).includes(0)) throw new Unreadable("it isn't a text file, despite its name");
      const text = body.toString('utf8');
      return { text: fence('file_text', text.length > 150_000 ? `${text.slice(0, 150_000)}\n[…the rest was cut]` : text), media: [] };
    }
    case 'docx':
    case 'pptx':
    case 'xlsx': {
      let office: OfficeText;
      try {
        office = officeReaders[kind](body);
      } catch {
        throw new Unreadable("the file couldn't be opened (it may be damaged or password-protected); a PDF export works");
      }
      const label = kind === 'pptx' ? `${office.parts} slide(s)` : kind === 'xlsx' ? `${office.parts} sheet(s)` : 'document';
      const pictures = office.images.length ? `\n\nThe ${office.images.length} largest picture(s) in the file follow.` : '';
      return {
        text: `${fence('file_text', office.text, ` kind="${kind}" parts="${label}"${office.truncated ? ' truncated="true"' : ''}`)}${pictures}`,
        media: office.images.map((image) => ({ type: 'image' as const, data: image.data.toString('base64'), mime_type: image.mime })),
      };
    }
    case 'zip':
      try {
        return { text: fence('archive', zipText(body)), media: [] };
      } catch (error) {
        throw new Unreadable(error instanceof ZipError ? `the archive couldn't be opened (${error.message})` : "the archive couldn't be opened");
      }
    case 'web': {
      const page = htmlText(body.toString('utf8'));
      if (page.text.length < 200) throw new Unreadable('the page has almost no text without running its scripts, or needs a sign-in; a PDF or screenshots of it work');
      return { text: fence('web_page', page.text, ` title="${page.title.replace(/"/g, "'")}"`), media: [] };
    }
    default:
      throw new Unreadable("the bot can't read this type of file");
  }
}

/** Reads one file (already downloaded) into notes. Throws only for temporary failures. */
export async function readShared(
  deps: ReadDeps,
  file: { name: string; contentType: string | null | undefined; body: Buffer; kind?: FileKind },
  context: SharedContext,
): Promise<ReadResult> {
  const kind = file.kind ?? fileKind(file.name, file.contentType);
  const sha256 = createHash('sha256').update(file.body).digest('hex');
  const size = file.body.length;
  const early = kind === 'web' ? (size > KIND_LIMITS.web ? 'the page is too large to read' : undefined) : skipReason(file.name, file.contentType, size);
  if (early) return { status: 'skipped', kind, reason: early, sha256, size };

  let parts;
  try {
    parts = await toParts(kind, file.name, file.contentType, file.body, deps);
  } catch (error) {
    if (error instanceof Unreadable) return { status: 'skipped', kind, reason: error.message, sha256, size };
    throw error;
  }
  const note = await deps.gemini.json({
    model: SPEC_MODEL,
    system: FILE_SYSTEM,
    input: [{ type: 'text', text: `${sharedBlock(file.name, context)}\n\n${parts.text}` }, ...parts.media],
    schema: FILE_NOTE_SCHEMA,
    parse: FileNoteOutput,
    thinking: 'low',
    maxOutputTokens: 16_000,
  });
  return { status: 'read', kind, note, sha256, size, model: SPEC_MODEL, promptVersion: FILES_PROMPT_VERSION, via: parts.via };
}

/** Pure: what kind a fetched link is, from the type the site sent. */
export function linkKind(contentType: string, url: string): FileKind {
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') return 'web';
  const kind = fileKind(new URL(url).pathname.split('/').pop() ?? '', contentType);
  return kind;
}
