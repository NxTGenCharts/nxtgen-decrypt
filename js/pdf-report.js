// =============================================================
// pdf-report.js — builds the branded PDF reports (Trade Log, Backtest) entirely in the browser.
// No library and no network: the old export lazy-loaded jsPDF from a CDN and silently did nothing whenever that request
// was blocked (ad-blockers, firewalls, offline). This writes the PDF directly — standard Helvetica fonts, vector drawing,
// and the NxTGen DeCrypt wordmark embedded in the header.
//   exportReportPdf({ title, kicker, subtitle, summary:[{label,value,tone}], columns:[{label,get}], rows, sumColumns, filename })
// =============================================================
const PW = 841.89, PH = 595.28;                         // A4 landscape, points
const M = 36;                                           // page margin
const INK = '#0b0e0c', GOLD = '#f0b429', GREEN = '#12875a', RED = '#c0283f', MUTED = '#6b7a70', TEXT = '#1c2420', LINE = '#e3e7e1', ZEBRA = '#f6f8f5';

// Helvetica / Helvetica-Bold advance widths (1000 units) for ASCII 32..126.
const W_REG = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const W_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
const W_EXTRA = { '\u2014': 1000, '\u2013': 556, '\u00b7': 278, '\u2026': 1000, '\u2022': 350, '\u00d7': 584, '\u00b0': 400, '\u00b1': 584 };
const WIN_ANSI = { '\u20ac': 0x80, '\u2026': 0x85, '\u2022': 0x95, '\u2013': 0x96, '\u2014': 0x97, '\u2018': 0x91, '\u2019': 0x92, '\u201c': 0x93, '\u201d': 0x94, '\u2212': 0x2d };

function glyphWidth(ch, bold){
  const c = ch.charCodeAt(0);
  if(c >= 32 && c <= 126) return (bold ? W_BOLD : W_REG)[c - 32];
  if(W_EXTRA[ch] != null) return W_EXTRA[ch];
  return 556;
}
export function textWidth(str, size, bold, charSpace = 0){
  let w = 0; const s = String(str);
  for(let i = 0; i < s.length; i++) w += glyphWidth(s[i], bold) * size / 1000 + charSpace;
  return w;
}
function fitText(str, maxW, size, bold){
  str = String(str);
  if(textWidth(str, size, bold) <= maxW) return str;
  const dots = '\u2026', dw = textWidth(dots, size, bold);
  let s = str;
  while(s.length > 1 && textWidth(s, size, bold) + dw > maxW) s = s.slice(0, -1);
  return s.trimEnd() + dots;
}
// text -> PDF string literal in WinAnsi (standard fonts)
function pdfString(str){
  let out = '(';
  for(const ch of String(str)){
    let c = ch.charCodeAt(0);
    if(WIN_ANSI[ch] != null) c = WIN_ANSI[ch]; else if(c > 255 || (c < 32)) c = 0x3f;
    if(c === 0x28 || c === 0x29 || c === 0x5c) out += '\\' + String.fromCharCode(c);
    else if(c >= 32 && c < 127) out += String.fromCharCode(c);
    else out += '\\' + c.toString(8).padStart(3, '0');
  }
  return out + ')';
}
const rgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => (v / 255).toFixed(3)).join(' '); };
const num = (n) => (Math.round(n * 100) / 100).toString();

// ---- page drawing helper (top-left origin) ----
class Page{
  constructor(){ this.ops = []; this.images = new Set(); }
  rect(x, y, w, h, fill){ this.ops.push(`${rgb(fill)} rg ${num(x)} ${num(PH - y - h)} ${num(w)} ${num(h)} re f`); }
  rrect(x, y, w, h, r, fill, stroke){
    const X = x, Y = PH - y - h, k = 0.5523 * r;
    const p = [`${num(X + r)} ${num(Y)} m`, `${num(X + w - r)} ${num(Y)} l`, `${num(X + w - r + k)} ${num(Y)} ${num(X + w)} ${num(Y + r - k)} ${num(X + w)} ${num(Y + r)} c`,
      `${num(X + w)} ${num(Y + h - r)} l`, `${num(X + w)} ${num(Y + h - r + k)} ${num(X + w - r + k)} ${num(Y + h)} ${num(X + w - r)} ${num(Y + h)} c`,
      `${num(X + r)} ${num(Y + h)} l`, `${num(X + r - k)} ${num(Y + h)} ${num(X)} ${num(Y + h - r + k)} ${num(X)} ${num(Y + h - r)} c`,
      `${num(X)} ${num(Y + r)} l`, `${num(X)} ${num(Y + r - k)} ${num(X + r - k)} ${num(Y)} ${num(X + r)} ${num(Y)} c h`].join(' ');
    this.ops.push(`${rgb(fill)} rg ${stroke ? rgb(stroke) + ' RG 0.6 w ' : ''}${p} ${stroke ? 'B' : 'f'}`);
  }
  line(x1, y1, x2, y2, color, w = 0.6){ this.ops.push(`${rgb(color)} RG ${w} w ${num(x1)} ${num(PH - y1)} m ${num(x2)} ${num(PH - y2)} l S`); }
  // y = baseline from the top; align: 'l' | 'r' | 'c' about x
  text(str, x, y, { size = 8, bold = false, color = TEXT, align = 'l', charSpace = 0 } = {}){
    str = String(str); const w = textWidth(str, size, bold, charSpace);
    const px = align === 'r' ? x - w : align === 'c' ? x - w / 2 : x;
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${size} Tf ${charSpace} Tc ${rgb(color)} rg ${num(px)} ${num(PH - y)} Td ${pdfString(str)} Tj ET`);
  }
  image(name, x, y, w, h){ this.images.add(name); this.ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(x)} ${num(PH - y - h)} cm /${name} Do Q`); }
}

// ---- binary assembly ----
const latin1 = (s) => { const u = new Uint8Array(s.length); for(let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i) & 255; return u; };
async function deflate(u8){
  if(typeof CompressionStream !== 'function' || typeof Response !== 'function') return null;
  try{ return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer()); }
  catch(e){ return null; }
}

// ---- logo (browser only): drawn onto the header colour so no transparency handling is needed ----
async function loadLogo(url, widthPt, bg){
  if(typeof document === 'undefined' || typeof fetch !== 'function') return null;
  try{
    const res = await fetch(url); if(!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const w = Math.round(widthPt * 3), h = Math.round(w * bmp.height / bmp.width);
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d'); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h); ctx.imageSmoothingQuality = 'high'; ctx.drawImage(bmp, 0, 0, w, h);
    const px = ctx.getImageData(0, 0, w, h).data, out = new Uint8Array(w * h * 3);
    for(let i = 0, j = 0; i < px.length; i += 4){ out[j++] = px[i]; out[j++] = px[i + 1]; out[j++] = px[i + 2]; }
    return { w, h, rgb: out, ratio: bmp.width / bmp.height };
  }catch(e){ return null; }
}

// ---- value formatting by column ----
const thousands = (n, d) => Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const money = (n) => (n < 0 ? '-' : '') + '$' + thousands(n, 2);
function kindOf(label){
  const l = String(label).toLowerCase();
  if(/^(gross|fees?|net)\b/.test(l)) return 'money';
  if(/^(entry|exit)$/.test(l)) return 'price';
  if(/^(qty|quantity|duration|lev)/.test(l)) return 'num';
  if(/^dir/.test(l)) return 'dir';
  return 'text';
}
function formatCell(kind, v){
  if(v == null || v === '' || (typeof v === 'number' && !isFinite(v))) return { text: '\u2014', n: null };
  if(kind === 'money'){ const n = Number(v); return isFinite(n) ? { text: money(n), n } : { text: String(v), n: null }; }
  if(kind === 'price' || kind === 'num'){
    const n = Number(v); if(!isFinite(n)) return { text: String(v), n: null };
    const a = Math.abs(n);
    return { text: a >= 1000 ? thousands(n, 2) : String(Number(n.toPrecision(a >= 1 ? 6 : 5))), n: null };
  }
  return { text: String(v), n: null };
}

export async function buildReportPdf(opts){
  const { title = 'Report', kicker = 'NXTGEN DECRYPT', subtitle = '', summary = [], columns = [], rows = [], sumColumns = [], logoLoader = loadLogo } = opts;
  const generated = new Date().toLocaleString();

  // 1. cells; drop columns that are empty on every row (they only waste width)
  let cols = columns.map(c => ({ label: c.label, kind: c.kind || kindOf(c.label), get: c.get }));
  let cells = rows.map(r => cols.map(c => formatCell(c.kind, c.get(r))));
  const keep = cols.map((c, i) => /^net$/i.test(c.label) || cells.some(row => row[i].text !== '\u2014'));
  cols = cols.filter((_, i) => keep[i]); cells = cells.map(row => row.filter((_, i) => keep[i]));
  const rawVals = rows.map(r => cols.map(c => c.get(r)));

  // 2. column widths
  const avail = PW - 2 * M, pad = 5;
  let fs = 7.4;
  const measure = (size) => cols.map((c, i) => {
    const head = textWidth(c.label.toUpperCase(), size - 0.9, true, 0.35) + pad * 2 + 2;
    let body = 0; for(const row of cells) body = Math.max(body, textWidth(row[i].text, size, c.kind === 'dir'));
    return { min: Math.min(head, 90), want: Math.min(150, Math.max(head, body + pad * 2 + 2)) };
  });
  let m = measure(fs);
  if(m.reduce((a, x) => a + x.min, 0) > avail){ fs = 6.5; m = measure(fs); }
  const sumWant = m.reduce((a, x) => a + x.want, 0), sumMin = m.reduce((a, x) => a + x.min, 0);
  let widths;
  if(sumWant <= avail){ const k = Math.min(1.4, avail / sumWant); widths = m.map(x => x.want * k); const rest = avail - widths.reduce((a, b) => a + b, 0); widths[widths.length - 1] += rest; }
  else if(sumMin < avail){ const k = (avail - sumMin) / (sumWant - sumMin); widths = m.map(x => x.min + (x.want - x.min) * k); }
  else { const k = avail / sumMin; widths = m.map(x => x.min * k); }
  const xs = []; { let x = M; for(const w of widths){ xs.push(x); x += w; } }
  const rightAlign = cols.map(c => c.kind === 'money' || c.kind === 'price' || c.kind === 'num');

  // 3. logo
  const logo = await logoLoader('/assets/brand/word.png', 150, INK);

  // 4. pages
  const pages = [];
  const HEAD_H = 92, SUB_H = 38, ROW_H = 19, TH_H = 22, FOOT_Y = PH - 30;
  const startPage = (first) => {
    const p = new Page(); pages.push(p);
    const bandH = first ? HEAD_H : SUB_H;
    p.rect(0, 0, PW, bandH, INK); p.rect(0, bandH, PW, 3, GOLD);
    if(first){
      if(logo){ const h = 150 / logo.ratio; p.image('Im1', M, (HEAD_H - h) / 2, 150, h); }
      else { p.text('NxTGen', M, 40, { size: 13, bold: true, color: '#ffffff' }); p.text('DeCrypt', M, 66, { size: 26, bold: true, color: GOLD }); }
      p.text(String(kicker).toUpperCase(), PW - M, 30, { size: 7.5, bold: true, color: GOLD, align: 'r', charSpace: 1.4 });
      p.text(title, PW - M, 55, { size: 21, bold: true, color: '#ffffff', align: 'r' });
      if(subtitle) p.text(subtitle, PW - M, 73, { size: 8.3, color: '#9db0a4', align: 'r' });
      return HEAD_H + 3;
    }
    if(logo){ const h = 74 / logo.ratio; p.image('Im1', M, (SUB_H - h) / 2, 74, h); }
    else p.text('NxTGen DeCrypt', M, 24, { size: 11, bold: true, color: GOLD });
    p.text(title, PW - M, 23, { size: 9.5, bold: true, color: '#ffffff', align: 'r' });
    return SUB_H + 3;
  };
  const tableHead = (p, y) => {
    p.rect(M, y, avail, TH_H, INK);
    cols.forEach((c, i) => {
      const label = c.label.toUpperCase(), size = fs - 0.9;
      const t = fitText(label, widths[i] - pad * 2, size, true);
      if(rightAlign[i]) p.text(t, xs[i] + widths[i] - pad, y + 14.2, { size, bold: true, color: GOLD, align: 'r', charSpace: 0.35 });
      else p.text(t, xs[i] + pad, y + 14.2, { size, bold: true, color: GOLD, charSpace: 0.35 });
    });
    return y + TH_H;
  };

  let y = startPage(true) + 16;
  // summary cards
  if(summary.length){
    const gap = 10, cw = (avail - gap * (summary.length - 1)) / summary.length, chh = 58;
    summary.forEach((s, i) => {
      const x = M + i * (cw + gap), tone = s.tone === 'pos' ? GREEN : s.tone === 'neg' ? RED : TEXT;
      const bar = s.tone === 'pos' ? GREEN : s.tone === 'neg' ? RED : GOLD;
      pages[0].rrect(x, y, cw, chh, 5, '#f6f8f5', LINE);
      pages[0].rect(x, y + 9, 3, chh - 18, bar);
      pages[0].text(String(s.label).toUpperCase(), x + 14, y + 19, { size: 6.8, bold: true, color: MUTED, charSpace: 0.8 });
      pages[0].text(fitText(s.value, cw - 24, 17, true), x + 14, y + 41, { size: 17, bold: true, color: tone });
      if(s.note) pages[0].text(fitText(s.note, cw - 24, 6.8, false), x + 14, y + 52, { size: 6.8, color: MUTED });
    });
    y += chh + 18;
  }
  const bottom = FOOT_Y - 16;
  let page = pages[0]; y = tableHead(page, y);
  const sums = {};
  rows.forEach((r, ri) => {
    if(y + ROW_H > bottom){ page = null; const top = startPage(false); page = pages[pages.length - 1]; y = tableHead(page, top + 12); }
    if(ri % 2 === 0) page.rect(M, y, avail, ROW_H, ZEBRA);
    page.line(M, y + ROW_H, M + avail, y + ROW_H, LINE, 0.4);
    cols.forEach((c, i) => {
      const cell = cells[ri][i], raw = rawVals[ri][i];
      let color = TEXT, bold = false;
      if(c.kind === 'money' && cell.n != null){ color = cell.n < 0 ? RED : cell.n > 0 ? GREEN : MUTED; bold = /^net$/i.test(c.label); if(sumColumns.includes(c.label)) sums[c.label] = (sums[c.label] || 0) + cell.n; }
      else if(c.kind === 'dir'){ const v = String(raw).toUpperCase(); if(v === 'LONG' || v === 'BUY'){ color = GREEN; bold = true; } else if(v === 'SHORT' || v === 'SELL'){ color = RED; bold = true; } }
      else if(cell.text === '\u2014') color = '#b4beb7';
      const t = fitText(cell.text, widths[i] - pad * 2, fs, bold);
      if(rightAlign[i]) page.text(t, xs[i] + widths[i] - pad, y + 12.6, { size: fs, bold, color, align: 'r' });
      else page.text(t, xs[i] + pad, y + 12.6, { size: fs, bold, color });
    });
    y += ROW_H;
  });
  // totals row
  if(sumColumns.length){
    if(y + ROW_H + 4 > bottom){ startPage(false); page = pages[pages.length - 1]; y = tableHead(page, SUB_H + 15); }
    page.rect(M, y + 2, avail, ROW_H + 2, '#eef2ec'); page.line(M, y + 2, M + avail, y + 2, GOLD, 1.2);
    page.text(`TOTAL \u00b7 ${rows.length} TRADE${rows.length === 1 ? '' : 'S'}`, xs[0] + pad, y + 15.4, { size: fs - 0.6, bold: true, color: INK, charSpace: 0.5 });
    cols.forEach((c, i) => {
      if(!sumColumns.includes(c.label) || sums[c.label] == null) return;
      const n = sums[c.label];
      page.text(money(n), xs[i] + widths[i] - pad, y + 15.4, { size: fs, bold: true, color: n < 0 ? RED : n > 0 ? GREEN : MUTED, align: 'r' });
    });
  }
  // footers
  pages.forEach((p, i) => {
    p.line(M, FOOT_Y, PW - M, FOOT_Y, LINE, 0.6);
    p.text('NxTGen DeCrypt  \u00b7  Crypto Terminal  \u00b7  nxtgendecrypt.site', M, FOOT_Y + 14, { size: 7, color: MUTED });
    p.text(`Generated ${generated}`, PW / 2, FOOT_Y + 14, { size: 7, color: MUTED, align: 'c' });
    p.text(`Page ${i + 1} of ${pages.length}`, PW - M, FOOT_Y + 14, { size: 7, bold: true, color: MUTED, align: 'r' });
  });

  // 5. assemble the file
  const objs = [];                                    // 1-based: objs[i-1]
  const add = (dict, data) => { objs.push({ dict, data }); return objs.length; };
  const catalogId = add('', null), pagesId = add('', null);
  const f1 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const info = add(`<< /Title ${pdfString(title)} /Producer (NxTGen DeCrypt) /Creator (NxTGen DeCrypt) >>`);
  let imId = null;
  if(logo){
    const z = await deflate(logo.rgb);
    imId = add(`<< /Type /XObject /Subtype /Image /Width ${logo.w} /Height ${logo.h} /ColorSpace /DeviceRGB /BitsPerComponent 8${z ? ' /Filter /FlateDecode' : ''}`, z || logo.rgb);
  }
  const pageIds = [];
  for(const p of pages){
    const raw = latin1(p.ops.join('\n')), z = await deflate(raw);
    const cid = add(`<<${z ? ' /Filter /FlateDecode' : ''}`, z || raw);
    const xo = imId && p.images.size ? ` /XObject << /Im1 ${imId} 0 R >>` : '';
    pageIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 ${PW} ${PH}] /Contents ${cid} 0 R /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R >>${xo} >> >>`));
  }
  objs[catalogId - 1].dict = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objs[pagesId - 1].dict = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(i => i + ' 0 R').join(' ')}] >>`;

  const chunks = [], offsets = []; let off = 0;
  const push = (u) => { chunks.push(u); off += u.length; };
  push(latin1('%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n'));
  objs.forEach((o, i) => {
    offsets.push(off);
    push(latin1(`${i + 1} 0 obj\n`));
    if(o.data){ push(latin1(`${o.dict} /Length ${o.data.length} >>\nstream\n`)); push(o.data); push(latin1('\nendstream')); }
    else push(latin1(o.dict));
    push(latin1('\nendobj\n'));
  });
  const xref = off;
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach(o => { x += String(o).padStart(10, '0') + ' 00000 n \n'; });
  x += `trailer\n<< /Size ${objs.length + 1} /Root ${catalogId} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  push(latin1(x));
  const total = new Uint8Array(off); let p = 0; for(const c of chunks){ total.set(c, p); p += c.length; }
  return { bytes: total, pages: pages.length };
}

export async function exportReportPdf(opts){
  const { bytes, pages } = await buildReportPdf(opts);
  const blob = new Blob([bytes], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = opts.filename || 'nxtgen-report.pdf';
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  return { pages };
}
