import { describe, expect, it } from 'vitest';
import { exportUrl, fetchPublic, findLinks, isPrivateAddress, LinkError, unreadableApp } from '../../src/files/links.js';

describe('findLinks', () => {
  it('finds https links, without trailing punctuation or duplicates, at most three', () => {
    expect(findLinks('See https://observv.com/, and <https://observv.com/pricing>. Also https://observv.com/ again!')).toEqual([
      'https://observv.com/',
      'https://observv.com/pricing',
    ]);
    expect(findLinks('https://a.com https://b.com https://c.com https://d.com')).toHaveLength(3);
  });

  it('leaves out Discord, GitHub (it has /review-repo), GIFs, explorers, plain http and odd ports', () => {
    const text = 'https://discord.com/channels/1/2 https://cdn.discordapp.com/x.png https://github.com/a/b https://tenor.com/x https://explorer.solana.com/tx/1 http://plain.com https://site.com:8443/x https://user:pw@site.com/';
    expect(findLinks(text)).toEqual([]);
  });

  it('drops the #fragment', () => {
    expect(findLinks('https://observv.com/docs#start')).toEqual(['https://observv.com/docs']);
  });
});

describe('exportUrl', () => {
  it('turns public Google Docs, Sheets and Slides links into exports', () => {
    const id = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';
    expect(exportUrl(`https://docs.google.com/document/d/${id}/edit?usp=sharing`)).toBe(`https://docs.google.com/document/d/${id}/export?format=txt`);
    expect(exportUrl(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=0`)).toBe(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv`);
    expect(exportUrl(`https://docs.google.com/presentation/d/${id}/edit`)).toBe(`https://docs.google.com/presentation/d/${id}/export/pdf`);
    expect(exportUrl('https://observv.com/')).toBe('https://observv.com/');
  });
});

describe('unreadableApp', () => {
  it('names apps whose links need a sign-in, with what to send instead', () => {
    expect(unreadableApp('https://www.figma.com/design/abc/App')?.app).toBe('Figma');
    expect(unreadableApp('https://www.loom.com/share/abc')?.instead).toMatch(/download/);
    expect(unreadableApp('https://observv.com/')).toBeUndefined();
  });
});

describe('isPrivateAddress', () => {
  it('blocks private, local and reserved addresses, and allows public ones', () => {
    for (const address of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1']) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '151.101.1.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
    expect(isPrivateAddress('not-an-ip')).toBe(true);
  });
});

describe('fetchPublic', () => {
  it('refuses anything that is not public https, before connecting', async () => {
    await expect(fetchPublic('http://example.com/')).rejects.toThrow(LinkError);
    await expect(fetchPublic('https://127.0.0.1/')).rejects.toThrow(/public internet/);
    await expect(fetchPublic('https://[::1]/')).rejects.toThrow(/public internet/);
  });

  it('refuses a name that resolves to a private address (checked inside the connection)', async () => {
    await expect(fetchPublic('https://localhost/')).rejects.toThrow(LinkError);
  });
});
