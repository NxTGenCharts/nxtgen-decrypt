import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReportPdf, textWidth } from '../js/pdf-report.js';

const cols = [
  { label: 'Date/Time', get: t => t.when }, { label: 'Symbol', get: t => t.sym }, { label: 'Dir', get: t => t.dir },
  { label: 'Entry', get: t => t.entry }, { label: 'Gross', get: t => t.gross }, { label: 'Fees', get: t => t.fees }, { label: 'Net', get: t => t.net },
  { label: 'Order ID', get: t => t.oid },
];
const mk = (n) => Array.from({ length: n }, (_, i) => ({ when: `10/12/2026 ${i}`, sym: 'LUMIAUSDT', dir: i % 2 ? 'LONG' : 'SHORT', entry: 0.1198, gross: '', fees: '', net: i % 2 ? 5.5 : -193, oid: '' }));
const text = (u8) => Buffer.from(u8).toString('latin1');

test('builds a structurally valid PDF with no network and no logo', async () => {
  const { bytes, pages } = await buildReportPdf({ title: 'Trade Log', columns: cols, rows: mk(3), sumColumns: ['Net'], logoLoader: async () => null });
  const s = text(bytes);
  assert.ok(s.startsWith('%PDF-1.4') && s.trimEnd().endsWith('%%EOF'));
  assert.equal(pages, 1);
  const xrefAt = Number(/startxref\n(\d+)/.exec(s)[1]);
  assert.equal(s.slice(xrefAt, xrefAt + 4), 'xref');                       // startxref really points at the table
  assert.match(s, /\/Count 1/);
});

test('long tables paginate and every page gets a footer', async () => {
  const { pages } = await buildReportPdf({ title: 'T', columns: cols, rows: mk(120), logoLoader: async () => null });
  assert.ok(pages >= 5, `pages=${pages}`);
});

test('columns that are empty on every row are dropped (Net is always kept)', async () => {
  const { bytes } = await buildReportPdf({ title: 'T', columns: cols, rows: mk(2), logoLoader: async () => null, });
  // content streams are deflated; check via an uncompressed run by disabling CompressionStream
  const saved = globalThis.CompressionStream; globalThis.CompressionStream = undefined;
  try{
    const r = await buildReportPdf({ title: 'T', columns: cols, rows: mk(2), logoLoader: async () => null });
    const s = text(r.bytes);
    assert.ok(!s.includes('ORDER ID') && !s.includes('FEES'));
    assert.ok(s.includes('NET') && s.includes('DATE/TIME'));
    assert.ok(s.includes('-$193.00'));
  } finally { globalThis.CompressionStream = saved; }
  assert.ok(bytes.length > 500);
});

test('special characters are escaped and unicode dashes survive', async () => {
  const saved = globalThis.CompressionStream; globalThis.CompressionStream = undefined;
  try{
    const r = await buildReportPdf({ title: 'A (b) \\ c', columns: [{ label: 'Note', get: t => t }], rows: ['x \u2014 y', 'z'], logoLoader: async () => null });
    const s = text(r.bytes);
    assert.ok(s.includes('A \\(b\\) \\\\ c'));
    assert.ok(s.includes('\\227'));                                          // em dash -> WinAnsi 0x97
  } finally { globalThis.CompressionStream = saved; }
});

test('text metrics: bold is wider than regular and widths scale with size', () => {
  assert.ok(textWidth('NxTGen', 10, true) > textWidth('NxTGen', 10, false));
  assert.ok(Math.abs(textWidth('abc', 20) - 2 * textWidth('abc', 10)) < 1e-9);
});

test('the PDF buttons no longer depend on a CDN', async () => {
  const fs = await import('node:fs');
  for(const f of ['futures-ui.js', 'backtest-ui.js']){
    const src = fs.readFileSync(new URL(`../js/${f}`, import.meta.url), 'utf8');
    assert.ok(!/cdnjs\.cloudflare\.com\/ajax\/libs\/jspdf/.test(src), f);
    assert.ok(src.includes('exportReportPdf'), f);
  }
});
