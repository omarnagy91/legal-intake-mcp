/**
 * Minimal DOCX reader.
 *
 * A .docx file is a ZIP container holding an OOXML part at word/document.xml.
 * Reading it needs a ZIP central directory walk and a raw inflate, both of which
 * Node provides, so this file adds no dependency to the project. Paragraph
 * structure comes straight from the w:p elements, which is exactly the anchor
 * granularity the server needs, and explicit page breaks are honoured so a
 * paginated docx still reports page numbers.
 */
import { inflateRawSync } from 'node:zlib';

const SIG_END_OF_CENTRAL_DIR = 0x06054b50;
const SIG_CENTRAL_FILE_HEADER = 0x02014b50;

type ZipEntry = { name: string; data: Buffer };

/** Locate the end of central directory record, scanning back over any comment. */
function findEndOfCentralDirectory(buf: Buffer): number {
  const minimum = 22;
  const start = Math.max(0, buf.length - 0xffff - minimum);
  for (let i = buf.length - minimum; i >= start; i--) {
    if (buf.readUInt32LE(i) === SIG_END_OF_CENTRAL_DIR) return i;
  }
  return -1;
}

/** Read one named entry out of a ZIP buffer. Returns null when absent. */
export function readZipEntry(buf: Buffer, wanted: string): Buffer | null {
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd === -1) throw new Error('not a zip container, end of central directory not found');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let pointer = buf.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    if (pointer + 46 > buf.length || buf.readUInt32LE(pointer) !== SIG_CENTRAL_FILE_HEADER) {
      throw new Error('corrupt zip central directory');
    }
    const method = buf.readUInt16LE(pointer + 10);
    const compressedSize = buf.readUInt32LE(pointer + 20);
    const nameLength = buf.readUInt16LE(pointer + 28);
    const extraLength = buf.readUInt16LE(pointer + 30);
    const commentLength = buf.readUInt16LE(pointer + 32);
    const localOffset = buf.readUInt32LE(pointer + 42);
    const name = buf.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');

    if (name === wanted) {
      // The local header repeats the name and extra field with its own lengths.
      const localNameLength = buf.readUInt16LE(localOffset + 26);
      const localExtraLength = buf.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const raw = buf.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(raw);
      if (method === 8) return inflateRawSync(raw);
      throw new Error(`unsupported zip compression method ${method} for ${name}`);
    }
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&amp;/g, '&');
}

export type DocxParagraph = { text: string; page: number };

/**
 * Extract paragraphs from word/document.xml.
 *
 * Only the elements that carry text or affect layout are interpreted: w:t for
 * text, w:tab and w:br for whitespace, and page breaks for pagination. Anything
 * else is markup the intake pipeline has no use for and is dropped, which keeps
 * the extracted text close to what a reader sees on the page.
 */
export function parseDocumentXml(xml: string): { paragraphs: DocxParagraph[]; pageCount: number } {
  const paragraphs: DocxParagraph[] = [];
  let page = 1;

  const bodyMatch = /<w:body[^>]*>([\s\S]*)<\/w:body>/.exec(xml);
  const body = bodyMatch?.[1] ?? xml;

  // Paragraphs are the only anchor granularity, but a table cell also holds
  // w:p elements, so a simple global scan collects them in document order.
  const paragraphPattern = /<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>|<w:p(?:\s[^>]*)?\/>/g;
  let match: RegExpExecArray | null;

  while ((match = paragraphPattern.exec(body)) !== null) {
    const inner = match[1] ?? '';

    // A page break before this paragraph moves the page counter first, so the
    // paragraph is attributed to the page it actually renders on.
    const breaksBefore = (inner.match(/<w:br[^>]*w:type="page"[^>]*\/?>/g) ?? []).length;
    const renderedBreaks = (inner.match(/<w:lastRenderedPageBreak\s*\/>/g) ?? []).length;

    let text = '';
    const runPattern = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br(?:\s[^>]*)?\/?>/g;
    let run: RegExpExecArray | null;
    while ((run = runPattern.exec(inner)) !== null) {
      if (run[1] !== undefined) text += decodeXmlEntities(run[1]);
      else if (run[0].startsWith('<w:tab')) text += '\t';
      else text += ' ';
    }

    text = text.replace(/[ \t]+/g, ' ').trim();
    if (text !== '') paragraphs.push({ text, page });
    page += breaksBefore + renderedBreaks;
  }

  return { paragraphs, pageCount: page };
}

export function extractDocx(buf: Buffer): { paragraphs: DocxParagraph[]; pageCount: number } {
  const part = readZipEntry(buf, 'word/document.xml');
  if (!part) throw new Error('not a Word document, word/document.xml is missing from the container');
  return parseDocumentXml(part.toString('utf8'));
}
