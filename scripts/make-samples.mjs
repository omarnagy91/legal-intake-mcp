#!/usr/bin/env node
/**
 * Developer utility. Regenerates the binary sample files (DOCX and PDF) from the
 * plain text sample contracts so the repository always ships a real .docx and a
 * real .pdf to exercise both parsers.
 *
 * DOCX is written here with nothing but Node's built in zlib, so the repository
 * carries no extra dependency just to produce a fixture.
 * PDF is produced with headless Chrome, which is present on the machine that
 * generated the committed fixture. Reviewers never need to run this script.
 *
 * Usage: node scripts/make-samples.mjs
 */
import { deflateRawSync } from 'node:zlib';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const samples = join(root, 'samples');

/* ------------------------------------------------------------------ */
/* Minimal ZIP writer (store + deflate), enough for a valid OOXML file  */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const compressed = deflateRawSync(raw, { level: 9 });
    const useDeflate = compressed.length < raw.length;
    const payload = useDeflate ? compressed : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 name flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x2821, 12); // fixed date so output is reproducible
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, payload);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x2821, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(payload.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + payload.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

const xmlEscape = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function buildDocx(text, rtl) {
  const paragraphs = text.split(/\n/).map((line) => {
    const trimmed = line.trim();
    const props = rtl ? '<w:pPr><w:bidi/><w:jc w:val="right"/></w:pPr>' : '';
    if (trimmed === '') return `<w:p>${props}</w:p>`;
    const runProps = rtl ? '<w:rPr><w:rtl/></w:rPr>' : '';
    return `<w:p>${props}<w:r>${runProps}<w:t xml:space="preserve">${xmlEscape(trimmed)}</w:t></w:r></w:p>`;
  });

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.join(
    ''
  )}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`;

  const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`;

  return zip([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'word/document.xml', data: document },
    { name: 'word/_rels/document.xml.rels', data: docRels },
  ]);
}

/* ------------------------------------------------------------------ */
/* PDF via headless Chrome                                             */
/* ------------------------------------------------------------------ */

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function buildPdf(text, rtl, outPath) {
  if (!existsSync(CHROME)) {
    console.log(`skip pdf, Chrome not found at ${CHROME}`);
    return false;
  }
  const dir = mkdtempSync(join(tmpdir(), 'legal-intake-'));
  const htmlPath = join(dir, 'doc.html');
  const body = text
    .split(/\n/)
    .map((l) => (l.trim() === '' ? '<p class="blank"></p>' : `<p>${xmlEscape(l.trim())}</p>`))
    .join('\n');
  const font = rtl
    ? "'Geeza Pro', 'Al Bayan', 'Baghdad', 'Arial Unicode MS', serif"
    : "'Times New Roman', Georgia, serif";
  const html = `<!doctype html><html lang="${rtl ? 'ar' : 'en'}" dir="${rtl ? 'rtl' : 'ltr'}"><head>
<meta charset="utf-8"><title>contract</title>
<style>
 @page { size: A4; margin: 20mm 18mm; }
 body { font-family: ${font}; font-size: 11.5pt; line-height: 1.7; }
 p { margin: 0 0 6pt 0; }
 p.blank { margin: 0 0 6pt 0; min-height: 6pt; }
</style></head><body>
${body}
</body></html>`;
  writeFileSync(htmlPath, html, 'utf8');
  execFileSync(
    CHROME,
    [
      '--headless',
      '--disable-gpu',
      '--no-sandbox',
      `--user-data-dir=${join(dir, 'chrome-profile')}`,
      '--no-pdf-header-footer',
      '--virtual-time-budget=5000',
      `--print-to-pdf=${outPath}`,
      `file://${htmlPath}`,
    ],
    { stdio: 'ignore' }
  );
  unlinkSync(htmlPath);
  return true;
}

/* ------------------------------------------------------------------ */

const en = readFileSync(join(samples, 'services-agreement-en.txt'), 'utf8');
const ar = readFileSync(join(samples, 'services-agreement-ar.txt'), 'utf8');

writeFileSync(join(samples, 'services-agreement-en.docx'), buildDocx(en, false));
console.log('wrote samples/services-agreement-en.docx');

writeFileSync(join(samples, 'services-agreement-ar.docx'), buildDocx(ar, true));
console.log('wrote samples/services-agreement-ar.docx');

if (buildPdf(en, false, join(samples, 'services-agreement-en.pdf'))) {
  console.log('wrote samples/services-agreement-en.pdf');
}

// No Arabic PDF is generated on purpose.
//
// The browser engine available here writes an Arabic text layer that is wrong
// at character level: certain shaped clusters carry their two codepoints in
// visual rather than logical order, so الموافق extracts as املوافق and بين as
// بني. The result is well formed Unicode that happens to be incorrect, which
// nothing downstream can detect or repair. A sample whose words are quietly
// transposed would contradict the rule this whole server is built on, that text
// handed to a lawyer is text they can cite. See the README for the full finding.
console.log('skipping the Arabic PDF on purpose, see the note in this script and in the README');
