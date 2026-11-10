// Pure: the text inside Word, PowerPoint and Excel files (and plain text pulled out of web
// pages), so Gemini can read files it can't open itself. Office files are zips of XML; this
// reads the parts that carry the words, plus up to a few of the pictures.

import { readZip, type ZipFile } from './zip.js';

export const OFFICE_LIMITS = { maxChars: 150_000, maxRowsPerSheet: 400, maxColumns: 40, maxImages: 8, maxImageBytes: 3 * 1024 * 1024, maxTotalImageBytes: 9 * 1024 * 1024 };

export interface OfficeImage {
  name: string;
  mime: string;
  data: Buffer;
}

export interface OfficeText {
  text: string;
  /** Slides, pages or sheets found. */
  parts: number;
  images: OfficeImage[];
  truncated: boolean;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Pure: XML and HTML entities as characters. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === '#') {
      const value = code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : '';
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

const tidy = (text: string) =>
  text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

function cap(text: string, max = OFFICE_LIMITS.maxChars): { text: string; truncated: boolean } {
  return text.length > max ? { text: `${text.slice(0, max)}\n[…the rest was cut]`, truncated: true } : { text, truncated: false };
}

/** Pure: the words in a WordprocessingML or DrawingML part, keeping paragraphs, tabs and table cells. */
export function xmlParagraphs(xml: string, prefix: 'w' | 'a'): string {
  const out: string[] = [];
  let inCell = 0;
  const pattern = new RegExp(`<${prefix}:t(?:\\s[^>]*)?>([^<]*)</${prefix}:t>|<${prefix}:tab\\s*/>|<${prefix}:br\\s*/>|</${prefix}:p>|<${prefix}:tc\\b[^>]*?/?>|</${prefix}:tc>|</${prefix}:tr>`, 'g');
  for (const match of xml.matchAll(pattern)) {
    const tag = match[0];
    if (match[1] !== undefined) out.push(decodeEntities(match[1]));
    else if (tag.includes(':tab')) out.push('\t');
    else if (tag.includes(':br')) out.push(inCell ? ' ' : '\n');
    else if (tag.startsWith(`<${prefix}:tc`)) {
      if (!tag.endsWith('/>')) inCell++;
    } else if (tag === `</${prefix}:tc>`) {
      inCell = Math.max(0, inCell - 1);
      out.push(' | ');
    } else if (tag === `</${prefix}:tr>`) out.push('\n');
    else out.push(inCell ? ' ' : '\n');
  }
  return tidy(
    out
      .join('')
      .replace(/[ \t]*\|[ \t]*\n/g, '\n')
      .replace(/ {2,}/g, ' '),
  );
}

const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };

function mediaImages(zip: ZipFile, folder: string): OfficeImage[] {
  const images: OfficeImage[] = [];
  let total = 0;
  const media = zip.entries
    .filter((entry) => entry.name.startsWith(folder) && IMAGE_MIME[entry.name.split('.').pop()?.toLowerCase() ?? ''])
    .filter((entry) => entry.size >= 8_000 && entry.size <= OFFICE_LIMITS.maxImageBytes)
    .sort((a, b) => b.size - a.size);
  for (const entry of media) {
    if (images.length >= OFFICE_LIMITS.maxImages || total + entry.size > OFFICE_LIMITS.maxTotalImageBytes) continue;
    const data = zip.read(entry.name);
    if (!data) continue;
    images.push({ name: entry.name.split('/').pop()!, mime: IMAGE_MIME[entry.name.split('.').pop()!.toLowerCase()]!, data });
    total += data.length;
  }
  return images;
}

const numbered = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);

/** Pure: a Word document's text, with its tables as "a | b" rows. */
export function docxText(file: Buffer): OfficeText {
  const zip = readZip(file);
  const body = zip.read('word/document.xml')?.toString('utf8');
  if (body === undefined) throw new Error('no document body');
  const notes = ['word/footnotes.xml', 'word/comments.xml']
    .map((name) => zip.read(name)?.toString('utf8'))
    .filter((xml): xml is string => Boolean(xml))
    .map((xml) => xmlParagraphs(xml, 'w'))
    .filter(Boolean);
  const text = [xmlParagraphs(body, 'w'), ...notes.map((note) => `--- Notes and comments ---\n${note}`)].join('\n\n');
  const { text: capped, truncated } = cap(text);
  return { text: capped, parts: 1, images: mediaImages(zip, 'word/media/'), truncated };
}

/** Pure: a slide deck's text, slide by slide, with the speaker notes. */
export function pptxText(file: Buffer): OfficeText {
  const zip = readZip(file);
  const slides = zip.entries
    .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry.name))
    .sort((a, b) => numbered(a.name) - numbered(b.name));
  if (slides.length === 0) throw new Error('no slides');
  const parts = slides.map((slide) => {
    const n = numbered(slide.name);
    const text = xmlParagraphs(zip.read(slide.name)?.toString('utf8') ?? '', 'a');
    const notesXml = zip.read(`ppt/notesSlides/notesSlide${n}.xml`)?.toString('utf8');
    // The notes page repeats the slide number as text; anything longer is a real note.
    const notes = notesXml ? xmlParagraphs(notesXml, 'a').replace(/^\d+$/m, '').trim() : '';
    return [`## Slide ${n}`, text || '(no text)', notes ? `Speaker notes: ${notes}` : ''].filter(Boolean).join('\n');
  });
  const { text, truncated } = cap(parts.join('\n\n'));
  return { text, parts: slides.length, images: mediaImages(zip, 'ppt/media/'), truncated };
}

/** Pure: "B" → 1, "AA" → 26. */
export function columnIndex(letters: string): number {
  let index = 0;
  for (const letter of letters.toUpperCase()) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

const csvCell = (value: string) => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** Pure: a spreadsheet as CSV, sheet by sheet (values as last calculated, not formulas). */
export function xlsxText(file: Buffer): OfficeText {
  const zip = readZip(file);
  const shared = [...(zip.read('xl/sharedStrings.xml')?.toString('utf8') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    decodeEntities([...match[1]!.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join('')),
  );
  const workbook = zip.read('xl/workbook.xml')?.toString('utf8') ?? '';
  const rels = zip.read('xl/_rels/workbook.xml.rels')?.toString('utf8') ?? '';
  const targets = new Map([...rels.matchAll(/<Relationship\b[^>]*>/g)].map((match) => [/\bId="([^"]+)"/.exec(match[0])?.[1], /\bTarget="([^"]+)"/.exec(match[0])?.[1]]));
  const sheets = [...workbook.matchAll(/<sheet\b[^>]*>/g)].map((match) => {
    const name = decodeEntities(/\bname="([^"]*)"/.exec(match[0])?.[1] ?? 'Sheet');
    const target = targets.get(/\br:id="([^"]+)"/.exec(match[0])?.[1]) ?? '';
    return { name, path: target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}` };
  });
  if (sheets.length === 0) throw new Error('no sheets');

  const blocks: string[] = [];
  let truncated = false;
  for (const sheet of sheets) {
    const xml = zip.read(sheet.path)?.toString('utf8');
    if (!xml) continue;
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      if (rows.length >= OFFICE_LIMITS.maxRowsPerSheet) {
        truncated = true;
        rows.push('[…more rows were cut]');
        break;
      }
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1] ?? '';
        const inner = cell[2] ?? '';
        const column = columnIndex(/\br="([A-Z]+)\d+"/.exec(attrs)?.[1] ?? 'A');
        if (column >= OFFICE_LIMITS.maxColumns) continue;
        const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
        const raw = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value = '';
        if (type === 's' && raw !== undefined) value = shared[Number(raw)] ?? '';
        else if (type === 'inlineStr') value = decodeEntities([...inner.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((t) => t[1]).join(''));
        else if (type === 'b') value = raw === '1' ? 'TRUE' : 'FALSE';
        else if (raw !== undefined) value = decodeEntities(raw);
        cells[column] = value;
      }
      if (cells.some((value) => value)) rows.push(Array.from(cells, (value) => csvCell(value ?? '')).join(','));
    }
    blocks.push(`## Sheet: ${sheet.name}\n${rows.join('\n') || '(empty)'}`);
  }
  const capped = cap(blocks.join('\n\n'));
  return { text: capped.text, parts: sheets.length, images: [], truncated: truncated || capped.truncated };
}

/** Pure: a web page's title, description and readable text. */
export function htmlText(html: string, maxChars = 60_000): { title: string; text: string } {
  const title = decodeEntities(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '').replace(/\s+/g, ' ').trim();
  const description = decodeEntities(/<meta\s+[^>]*name=["']description["'][^>]*content=["']([^"']*)["']/i.exec(html)?.[1] ?? '').trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(br|hr)\b[^>]*>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|li|ul|ol|h[1-6]|tr|table|nav|main|aside|blockquote|pre|form)>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n${'#'.repeat(Number(level))} `)
    .replace(/<a\b[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => `${label} (${href})`)
    .replace(/<[^>]+>/g, ' ');
  const text = tidy(
    decodeEntities(body)
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .join('\n'),
  );
  const full = [description ? `Description: ${description}` : '', text].filter(Boolean).join('\n\n');
  return { title, text: full.length > maxChars ? `${full.slice(0, maxChars)}\n[…the rest was cut]` : full };
}
