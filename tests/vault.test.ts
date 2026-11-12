import { describe, expect, it } from 'vitest';
import { EXPORT_FORMAT, exportItems, makeItem, MAX_LABEL, parseExport, renameItem, VaultError } from '../src/vault';

// A PNG signature and some bytes are enough: the vault keeps images as they are and never decodes them.
const png = (seed: number, n = 64) => {
  const b = new Uint8Array(n);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let i = 8; i < n; i++) b[i] = (seed * 31 + i * 7) & 255;
  return b;
};

describe('saved secrets', () => {
  it('gives the same images the same id, and different images a different one', async () => {
    const a = await makeItem([{ width: 10, height: 10, png: png(1) }], 'received', 'x');
    const b = await makeItem([{ width: 10, height: 10, png: png(1) }], 'sent', 'y');
    const c = await makeItem([{ width: 10, height: 10, png: png(2) }], 'received');
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
    expect(c.label).toMatch(/^Received /);
  });

  it('round-trips an export with labels, origins, dates and every part', async () => {
    const it1 = await makeItem([{ width: 3, height: 4, png: png(5, 200000) }, { width: 5, height: 6, png: png(6) }], 'sent', '  Trip plans  ', 1700000000000);
    const it2 = await makeItem([{ width: 7, height: 8, png: png(7) }], 'received', 'From Sam', 1700000500000);
    const text = exportItems([it1, it2]);
    expect(JSON.parse(text).format).toBe(EXPORT_FORMAT);
    const back = await parseExport(text);
    expect(back).toHaveLength(2);
    expect(back[0]).toMatchObject({ id: it1.id, label: 'Trip plans', origin: 'sent', saved: 1700000000000 });
    expect(back[0].parts.map((p) => [p.width, p.height])).toEqual([[3, 4], [5, 6]]);
    expect([...back[0].parts[0].png]).toEqual([...it1.parts[0].png]);
    expect(back[1]).toMatchObject({ id: it2.id, label: 'From Sam', origin: 'received' });
  });

  it('works out ids from the images and ignores ids written in the file', async () => {
    const it1 = await makeItem([{ width: 1, height: 1, png: png(9) }], 'received', 'a');
    const doc = JSON.parse(exportItems([it1]));
    doc.items[0].id = 'forged';
    expect((await parseExport(JSON.stringify(doc)))[0].id).toBe(it1.id);
  });

  it('refuses files that are not exports, are damaged, or hold something other than PNG', async () => {
    await expect(parseExport('not json')).rejects.toBeInstanceOf(VaultError);
    await expect(parseExport('{"format":"other"}')).rejects.toBeInstanceOf(VaultError);
    await expect(parseExport(JSON.stringify({ format: EXPORT_FORMAT, version: 2, items: [] }))).rejects.toThrow(/newer/);
    const good = JSON.parse(exportItems([await makeItem([{ width: 1, height: 1, png: png(3) }], 'received')]));
    const notPng = structuredClone(good);
    notPng.items[0].parts[0].png = btoa('GIF89a-and-some-more-bytes-here');
    await expect(parseExport(JSON.stringify(notPng))).rejects.toThrow(/PNG/);
    const badSize = structuredClone(good);
    badSize.items[0].parts[0].width = -1;
    await expect(parseExport(JSON.stringify(badSize))).rejects.toBeInstanceOf(VaultError);
    const noParts = structuredClone(good);
    noParts.items[0].parts = [];
    await expect(parseExport(JSON.stringify(noParts))).rejects.toBeInstanceOf(VaultError);
  });

  it('refuses to save non-PNG data or nothing at all, and keeps labels tidy', async () => {
    await expect(makeItem([], 'received')).rejects.toBeInstanceOf(VaultError);
    await expect(makeItem([{ width: 1, height: 1, png: new Uint8Array(40) }], 'received')).rejects.toBeInstanceOf(VaultError);
    const it1 = await makeItem([{ width: 1, height: 1, png: png(4) }], 'received', 'a\u0000b\nc' + 'x'.repeat(200));
    expect(it1.label.length).toBe(MAX_LABEL);
    expect(it1.label.startsWith('a b c')).toBe(true);
    expect(renameItem(it1, '   ').label).toBe(it1.label);
    expect(renameItem(it1, ' New name ').label).toBe('New name');
  });
});
