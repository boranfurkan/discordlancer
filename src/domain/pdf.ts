// Pure: a one-page PDF from text, lines and filled boxes, using the two Helvetica fonts
// every PDF reader has, so nothing needs embedding and no library is needed. Text is
// encoded as WinAnsi (Latin-1 and a few more); other letters are simplified (ş to s).

export type Color = readonly [number, number, number];

export type PdfOp =
  | { kind: 'text'; x: number; y: number; size: number; text: string; bold?: boolean; color?: Color }
  | { kind: 'line'; x1: number; y1: number; x2: number; y2: number; width?: number; color?: Color }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: Color }
  /** A clickable area that opens a web address. Draws nothing itself. */
  | { kind: 'link'; x: number; y: number; w: number; h: number; url: string };

export const A4 = { width: 595.28, height: 841.89 };

// Character widths (per 1,000 units of font size) for codes 32 to 126, from the Adobe metrics.
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667,
  667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500,
  556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722,
  722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556,
  611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

// WinAnsi codes 128 to 159 that differ from Latin-1.
const WIN_ANSI_EXTRA: Record<string, number> = {
  '€': 0x80, '‚': 0x82, 'ƒ': 0x83, '„': 0x84, '…': 0x85, '†': 0x86, '‡': 0x87, 'ˆ': 0x88, '‰': 0x89, 'Š': 0x8a, '‹': 0x8b, 'Œ': 0x8c, 'Ž': 0x8e,
  '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95, '–': 0x96, '—': 0x97, '˜': 0x98, '™': 0x99, 'š': 0x9a, '›': 0x9b, 'œ': 0x9c, 'ž': 0x9e, 'Ÿ': 0x9f,
};
const SIMPLER: Record<string, string> = { ı: 'i', İ: 'I', ł: 'l', Ł: 'L', đ: 'd', Đ: 'D', ø: 'o' };

/** Pure: the text as WinAnsi bytes; letters outside it lose their accents, and anything else becomes "?". */
export function winAnsi(text: string): number[] {
  const bytes: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if ((code >= 32 && code <= 126) || (code >= 0xa0 && code <= 0xff)) bytes.push(code);
    else if (WIN_ANSI_EXTRA[char] !== undefined) bytes.push(WIN_ANSI_EXTRA[char]);
    else if (SIMPLER[char]) bytes.push(SIMPLER[char].charCodeAt(0));
    else {
      const plain = char.normalize('NFD').replace(/\p{M}/gu, '');
      bytes.push(plain.length === 1 && plain.charCodeAt(0) >= 32 && plain.charCodeAt(0) <= 126 ? plain.charCodeAt(0) : 63);
    }
  }
  return bytes;
}

/** Pure: how wide the text is, in points. */
export function textWidth(text: string, size: number, bold = false): number {
  const widths = bold ? HELVETICA_BOLD : HELVETICA;
  return (winAnsi(text).reduce((sum, code) => sum + (code >= 32 && code <= 126 ? widths[code - 32]! : 556), 0) * size) / 1000;
}

/** Pure: the text split into lines no wider than `width`, breaking between words. */
export function wrap(text: string, width: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  let current = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = current ? `${current} ${word}` : word;
    if (current && textWidth(next, size, bold) > width) {
      lines.push(current);
      current = word;
    } else current = next;
  }
  if (current) lines.push(current);
  return lines;
}

const num = (value: number) => (Math.round(value * 100) / 100).toString();
const colour = (color: Color | undefined) => (color ?? [0, 0, 0]).map(num).join(' ');

/** A PDF string literal: ASCII as is, everything else as octal escapes. */
function literal(text: string): string {
  return `(${winAnsi(text)
    .map((code) => (code === 0x28 || code === 0x29 || code === 0x5c ? `\\${String.fromCharCode(code)}` : code >= 32 && code <= 126 ? String.fromCharCode(code) : `\\${code.toString(8).padStart(3, '0')}`))
    .join('')})`;
}

function content(ops: readonly PdfOp[]): string {
  return ops
    .map((op) => {
      if (op.kind === 'link') return '';
      if (op.kind === 'rect') return `${colour(op.color)} rg ${num(op.x)} ${num(op.y)} ${num(op.w)} ${num(op.h)} re f`;
      if (op.kind === 'line') return `${colour(op.color)} RG ${num(op.width ?? 0.5)} w ${num(op.x1)} ${num(op.y1)} m ${num(op.x2)} ${num(op.y2)} l S`;
      return `BT /${op.bold ? 'F2' : 'F1'} ${num(op.size)} Tf ${colour(op.color)} rg ${num(op.x)} ${num(op.y)} Td ${literal(op.text)} Tj ET`;
    })
    .filter(Boolean)
    .join('\n');
}

function annotations(ops: readonly PdfOp[]): string {
  const links = ops.flatMap((op) =>
    op.kind === 'link' && /^https:\/\/[\x21-\x7e]+$/.test(op.url)
      ? [`<< /Type /Annot /Subtype /Link /Rect [${num(op.x)} ${num(op.y)} ${num(op.x + op.w)} ${num(op.y + op.h)}] /Border [0 0 0] /A << /S /URI /URI ${literal(op.url)} >> >>`]
      : [],
  );
  return links.length ? ` /Annots [${links.join(' ')}]` : '';
}

/** Pure: a one-page A4 PDF. */
export function pdfDocument(ops: readonly PdfOp[], meta: { title: string; created: Date }): Buffer {
  const stream = content(ops);
  const date = meta.created.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${A4.width} ${A4.height}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R${annotations(ops)} >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`,
    `<< /Title ${literal(meta.title)} /Producer (Discordlancer) /CreationDate (D:${date}Z) >>`,
  ];
  let body = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'latin1');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, 'latin1');
}
