import { describe, expect, it } from 'vitest';
import { fileKind, linkKind, readShared, skipReason, timedTranscript, zipText } from '../../src/files/read.js';
import type { SpeechToTextApi } from '../../src/services/elevenlabs.js';
import type { GeminiApi, JsonRequest } from '../../src/services/gemini.js';
import { docx, makeZip, wp } from '../helpers/zip.js';

const note = { title: 'A file', summary: 'What it says.', details: '- detail', requirements: ['Must do X'], open_questions: [] };

function fakeGemini() {
  const requests: Array<JsonRequest<unknown>> = [];
  const gemini: GeminiApi = {
    async json<T>(request: JsonRequest<T>): Promise<T> {
      requests.push(request as JsonRequest<unknown>);
      return request.parse.parse(note);
    },
  };
  return { gemini, requests };
}

const context = { project: 'observv', who: 'Client (Laura)', at: new Date('2026-11-11T12:40:00Z'), message: 'Here is our roadmap' };

describe('fileKind and skipReason', () => {
  it('knows files by extension first, then by type', () => {
    expect(fileKind('Roadmap.PDF', null)).toBe('pdf');
    expect(fileKind('deck.pptx', 'application/octet-stream')).toBe('pptx');
    expect(fileKind('voice-message.ogg', 'audio/ogg')).toBe('audio');
    expect(fileKind('screen.mov', 'video/quicktime')).toBe('video');
    expect(fileKind('schema.prisma', null)).toBe('text');
    expect(fileKind('export', 'text/csv')).toBe('text');
    expect(fileKind('design.fig', null)).toBe('unsupported');
  });

  it('says why a file is skipped, in words the client can act on', () => {
    expect(skipReason('old.doc', null, 1000)).toMatch(/\.docx or PDF/);
    expect(skipReason('anim.gif', 'image/gif', 1000)).toMatch(/PNG, JPEG/);
    expect(skipReason('design.fig', null, 1000)).toMatch(/can't read this type/);
    expect(skipReason('huge.pdf', 'application/pdf', 20 * 1024 * 1024)).toMatch(/too large/);
    expect(skipReason('brief.pdf', 'application/pdf', 1000)).toBeUndefined();
  });

  it('treats an HTML page from a link as a web page', () => {
    expect(linkKind('text/html', 'https://observv.com/')).toBe('web');
    expect(linkKind('application/pdf', 'https://x.com/export')).toBe('pdf');
  });
});

describe('readShared', () => {
  it('sends a PDF as a document, with who shared it and why, fenced as data', async () => {
    const { gemini, requests } = fakeGemini();
    const result = await readShared({ gemini }, { name: 'roadmap.pdf', contentType: 'application/pdf', body: Buffer.from('%PDF-1.4 fake') }, context);
    expect(result.status).toBe('read');
    const input = requests[0]!.input;
    expect(input[0]).toMatchObject({ type: 'text' });
    expect((input[0] as { text: string }).text).toContain('<shared>');
    expect((input[0] as { text: string }).text).toContain('Message with it: Here is our roadmap');
    expect(input[1]).toMatchObject({ type: 'document', mime_type: 'application/pdf' });
  });

  it('sends a Word file as its text', async () => {
    const { gemini, requests } = fakeGemini();
    await readShared({ gemini }, { name: 'brief.docx', contentType: null, body: docx(wp('Must work offline')) }, context);
    expect((requests[0]!.input[0] as { text: string }).text).toContain('Must work offline');
    expect(requests[0]!.input).toHaveLength(1);
  });

  it('transcribes a voice note with ElevenLabs first, when it is set up', async () => {
    const { gemini, requests } = fakeGemini();
    const stt: SpeechToTextApi = {
      transcribe: async () => ({ text: 'Hello there.', languageCode: 'en', words: [{ text: 'Hello', type: 'word', start: 0, end: 0.5 }, { text: ' ', type: 'spacing' }, { text: 'there.', type: 'word', start: 0.5, end: 1 }] }),
    };
    const result = await readShared({ gemini, stt }, { name: 'voice-message.ogg', contentType: 'audio/ogg', body: Buffer.from('OggS') }, context);
    expect(result).toMatchObject({ status: 'read', via: 'elevenlabs' });
    expect((requests[0]!.input[0] as { text: string }).text).toContain('[00:00] Hello there.');
  });

  it('skips, without asking Gemini, what it cannot read', async () => {
    const { gemini, requests } = fakeGemini();
    const binary = await readShared({ gemini }, { name: 'notes.txt', contentType: 'text/plain', body: Buffer.from([0x41, 0x00, 0x42]) }, context);
    const broken = await readShared({ gemini }, { name: 'broken.docx', contentType: null, body: Buffer.from('not a zip, just text pretending to be a docx file') }, context);
    const empty = await readShared({ gemini }, { name: 'https://app.example/', contentType: 'text/html', body: Buffer.from('<html><body><div id="root"></div></body></html>'), kind: 'web' }, context);
    expect([binary.status, broken.status, empty.status]).toEqual(['skipped', 'skipped', 'skipped']);
    expect(empty.status === 'skipped' && empty.reason).toMatch(/almost no text/);
    expect(requests).toHaveLength(0);
  });
});

describe('zipText', () => {
  it('lists the archive and includes its text files, leaving out node_modules', () => {
    const text = zipText(makeZip({ 'app/README.md': '# Old app', 'app/node_modules/x/index.js': 'skip me', 'app/logo.png': Buffer.alloc(10) }));
    expect(text).toContain('3 file(s) in the archive');
    expect(text).toContain('<file path="app/README.md">\n# Old app');
    expect(text).not.toContain('skip me');
  });
});

describe('timedTranscript', () => {
  it('marks the start of each line of about 20 seconds', () => {
    const words = [
      { text: 'First', type: 'word' as const, start: 0, end: 1 },
      { text: ' ', type: 'spacing' as const },
      { text: 'part.', type: 'word' as const, start: 20, end: 21 },
      { text: ' ', type: 'spacing' as const },
      { text: 'Second.', type: 'word' as const, start: 75, end: 76 },
    ];
    expect(timedTranscript(words)).toBe('[00:00] First part.\n[01:15] Second.');
  });
});
