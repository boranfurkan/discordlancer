import { describe, expect, it } from 'vitest';
import { columnIndex, decodeEntities, docxText, htmlText, pptxText, xlsxText } from '../../src/files/office.js';
import { readZip, ZipError } from '../../src/files/zip.js';
import { docx, makeZip, wp } from '../helpers/zip.js';

describe('readZip', () => {
  it('lists entries and reads stored and deflated ones', () => {
    for (const store of [true, false]) {
      const zip = readZip(makeZip({ 'a.txt': 'hello', 'dir/b.txt': 'world'.repeat(100) }, { store }));
      expect(zip.entries.map((entry) => entry.name)).toEqual(['a.txt', 'dir/b.txt']);
      expect(zip.read('a.txt')?.toString()).toBe('hello');
      expect(zip.read('dir/b.txt')?.toString()).toBe('world'.repeat(100));
      expect(zip.read('missing')).toBeUndefined();
    }
  });

  it("refuses what isn't a zip, and won't read encrypted entries", () => {
    expect(() => readZip(Buffer.from('not a zip at all, just some text that is long enough'))).toThrow(ZipError);
    const zip = readZip(makeZip({ 'secret.txt': 'x' }, { encrypt: ['secret.txt'] }));
    expect(zip.entries[0]?.encrypted).toBe(true);
    expect(zip.read('secret.txt')).toBeUndefined();
  });

  it('stops inflating at the limit, even when the entry lies about its size (a zip bomb)', () => {
    const bomb = makeZip({ 'bomb.txt': Buffer.alloc(5 * 1024 * 1024) }, { lieAboutSize: 'bomb.txt' });
    const zip = readZip(bomb, { maxEntries: 10, maxEntryBytes: 1024 * 1024, maxTotalBytes: 2 * 1024 * 1024 });
    expect(zip.entries[0]?.size).toBe(10);
    expect(zip.read('bomb.txt')).toBeUndefined();
  });
});

describe('Office text', () => {
  it('reads a Word document: paragraphs, entities, and tables as rows', () => {
    const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Plan</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Price</w:t></w:r></w:p></w:tc></w:tr><w:tr><w:tc><w:p><w:r><w:t>Pro</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>$49.95</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    const result = docxText(docx(`${wp('Booking app brief')}${wp('Owners &amp; managers')}${table}`));
    expect(result.text).toBe('Booking app brief\nOwners & managers\nPlan | Price\nPro | $49.95');
  });

  it('reads slides in number order, with speaker notes', () => {
    const slide = (text: string) => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`;
    const file = makeZip({
      'ppt/slides/slide10.xml': slide('Ten'),
      'ppt/slides/slide2.xml': slide('Two'),
      'ppt/slides/slide1.xml': slide('One'),
      'ppt/notesSlides/notesSlide2.xml': '<p:notes><a:p><a:r><a:t>Say this slowly</a:t></a:r></a:p><a:p><a:r><a:t>2</a:t></a:r></a:p></p:notes>',
    });
    const result = pptxText(file);
    expect(result.parts).toBe(3);
    expect(result.text).toBe('## Slide 1\nOne\n\n## Slide 2\nTwo\nSpeaker notes: Say this slowly\n\n## Slide 10\nTen');
  });

  it('reads a spreadsheet as CSV per sheet, with shared and inline strings', () => {
    const file = makeZip({
      'xl/workbook.xml': '<workbook><sheets><sheet name="Pricing" sheetId="1" r:id="rId1"/><sheet name="Notes &amp; more" sheetId="2" r:id="rId2"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="x" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="x" Target="worksheets/sheet2.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Plan</t></si><si><t>Price, monthly</t></si><si><r><t>Pr</t></r><r><t>o</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>49.95</v></c></row></sheetData></worksheet>',
      'xl/worksheets/sheet2.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Free for suppliers</t></is></c><c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>',
    });
    const result = xlsxText(file);
    expect(result.parts).toBe(2);
    expect(result.text).toBe('## Sheet: Pricing\nPlan,"Price, monthly"\nPro,,49.95\n\n## Sheet: Notes & more\nFree for suppliers,TRUE');
  });

  it('turns column letters into indexes', () => {
    expect([columnIndex('A'), columnIndex('Z'), columnIndex('AA'), columnIndex('AB')]).toEqual([0, 25, 26, 27]);
  });

  it('decodes entities, including numeric ones', () => {
    expect(decodeEntities('a &amp; b &#252; &#x1F600; &unknown;')).toBe('a & b ü 😀 &unknown;');
  });
});

describe('htmlText', () => {
  it('keeps the title, description, headings, list items and links, and drops scripts and styles', () => {
    const page = htmlText(
      '<html><head><title>Observv &amp; co</title><meta name="description" content="A living visual record"><style>p{}</style></head><body><script>alert(1)</script><h1>Every property</h1><p>Capture in 360</p><ul><li>Owners</li><li>Builders</li></ul><a href="https://example.com/pricing">Pricing</a></body></html>',
    );
    expect(page.title).toBe('Observv & co');
    expect(page.text).toContain('Description: A living visual record');
    expect(page.text).toContain('# Every property');
    expect(page.text).toContain('- Owners');
    expect(page.text).toContain('Pricing (https://example.com/pricing)');
    expect(page.text).not.toContain('alert');
  });
});
