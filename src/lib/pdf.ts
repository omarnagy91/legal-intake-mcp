/**
 * PDF text extraction.
 *
 * pdf.js is used rather than a hand rolled parser because the part that matters
 * for this server, resolving glyph codes back to Unicode through the font's
 * ToUnicode map, is exactly the part that is hard to get right, and it is the
 * part Arabic depends on entirely.
 *
 * Two things this module refuses to do quietly:
 *
 *  - If a page's text layer maps a significant share of its glyphs to nothing,
 *    the extracted text is silently missing characters. That is common in
 *    Arabic PDFs produced by tools that embed a subset font without a usable
 *    ToUnicode map, and a document intake pipeline that hides it will hand a
 *    lawyer a contract with holes in it. The loader reports it as a warning.
 *  - If the text comes out as Arabic presentation forms, or in visual rather
 *    than logical order, the repair is applied and named in `normalisations`.
 */
import { hasPresentationForms, deshape, repairVisualOrder } from './arabic.js';

type TextItem = {
  str: string;
  hasEOL?: boolean;
  transform?: number[];
  height?: number;
  width?: number;
  /** pdf.js reports the bidi direction it resolved for the run. */
  dir?: string;
};

type PdfPage = {
  getTextContent(): Promise<{ items: unknown[] }>;
};

type PdfDocument = {
  numPages: number;
  getPage(n: number): Promise<PdfPage>;
  destroy(): Promise<void>;
};

let pdfjsModule: { getDocument: (opts: unknown) => { promise: Promise<PdfDocument> } } | null = null;

/**
 * The legacy build is the one that runs under plain Node. The default entry
 * assumes a DOM and a worker and will not load here.
 */
async function loadPdfjs() {
  if (!pdfjsModule) {
    pdfjsModule = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as typeof pdfjsModule;
  }
  if (!pdfjsModule) throw new Error('failed to load pdfjs-dist');
  return pdfjsModule;
}

export type PdfParagraph = { text: string; page: number };

export type PdfExtraction = {
  paragraphs: PdfParagraph[];
  pageCount: number;
  normalisations: string[];
  warnings: string[];
};

/** Codepoints a broken ToUnicode map produces instead of real characters. */
function isUnmapped(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code === 0 || code === 0xfffd;
}

export type Line = { text: string; y: number; height: number; left: number; right: number };
export type { TextItem };

/**
 * Rebuild lines from positioned text items.
 *
 * pdf.js emits runs, not lines, so runs are grouped by their baseline y. A
 * tolerance is needed because a run with a different font size on the same line
 * gets a slightly different baseline. The horizontal extent of each line is
 * kept, because how far a line reaches across the text column is the signal
 * that tells a wrapped line apart from the last line of a paragraph.
 *
 * The runs on a line are then sorted into reading order rather than trusted in
 * emission order. This matters enormously for Arabic. A PDF stores runs by
 * position, and for a right to left line the first run to read is the rightmost
 * one, so concatenating in emission order returns a line whose phrases are in
 * reverse sequence: a date ends up before the sentence that introduces it. The
 * line's own direction decides the sort, which leaves Latin lines untouched.
 */
export function itemsToLines(items: TextItem[]): Line[] {
  type Run = { text: string; x: number; width: number; rtl: boolean };
  type Bucket = { runs: Run[]; y: number; height: number };

  const buckets: Bucket[] = [];
  let current: Bucket | null = null;

  for (const item of items) {
    if (typeof item.str !== 'string') continue;
    const y = item.transform?.[5] ?? 0;
    const x = item.transform?.[4] ?? 0;
    const width = item.width && item.width > 0 ? item.width : 0;
    const height = item.height && item.height > 0 ? item.height : 10;
    const run: Run = { text: item.str, x, width, rtl: item.dir === 'rtl' };

    if (current === null || Math.abs(current.y - y) > Math.max(2, height * 0.5)) {
      if (current) buckets.push(current);
      current = { runs: [run], y, height };
    } else {
      current.runs.push(run);
      current.height = Math.max(current.height, height);
    }
    if (item.hasEOL) {
      buckets.push(current);
      current = null;
    }
  }
  if (current) buckets.push(current);

  return buckets
    .map((bucket) => {
      // Whitespace only runs carry no direction of their own, so the decision
      // is weighted by how much real text points each way.
      let rtlWeight = 0;
      let ltrWeight = 0;
      for (const run of bucket.runs) {
        const weight = run.text.trim().length;
        if (weight === 0) continue;
        if (run.rtl) rtlWeight += weight;
        else ltrWeight += weight;
      }
      const rightToLeft = rtlWeight > ltrWeight;

      const ordered = [...bucket.runs].sort((a, b) => (rightToLeft ? b.x - a.x : a.x - b.x));

      return {
        text: ordered
          .map((r) => r.text)
          .join('')
          .replace(/[ \t]+/g, ' ')
          .trim(),
        y: bucket.y,
        height: bucket.height,
        left: Math.min(...bucket.runs.map((r) => r.x)),
        right: Math.max(...bucket.runs.map((r) => r.x + r.width)),
      };
    })
    .filter((l) => l.text !== '');
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[index]!;
}

/**
 * Group lines into paragraphs.
 *
 * A PDF carries no paragraph structure, only positions, so paragraph breaks
 * have to be inferred. Two signals are used together.
 *
 * Vertical gap. The single line spacing of the document is taken as a low
 * percentile of the observed gaps rather than the median, because in a contract
 * most paragraphs are only one or two lines long, so the median gap is the
 * paragraph gap and a median based threshold merges the whole page into one
 * block.
 *
 * Line length. A line that stops well short of the width the text column
 * actually uses is the last line of its paragraph. This works for Arabic as
 * well as English because it measures the span a line covers, not which margin
 * it stops at.
 */
function linesToParagraphs(lines: Line[], page: number): PdfParagraph[] {
  if (lines.length === 0) return [];

  const gaps: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i - 1]!.y - lines[i]!.y;
    if (gap > 0) gaps.push(gap);
  }
  const sortedGaps = [...gaps].sort((a, b) => a - b);
  const lineSpacing = percentile(sortedGaps, 0.1);
  const gapThreshold = lineSpacing > 0 ? lineSpacing * 1.25 : Infinity;

  const maxSpan = Math.max(...lines.map((l) => l.right - l.left), 1);
  const shortLineThreshold = maxSpan * 0.75;

  const paragraphs: PdfParagraph[] = [];
  let buffer: string[] = [lines[0]!.text];

  for (let i = 1; i < lines.length; i++) {
    const previous = lines[i - 1]!;
    const line = lines[i]!;
    const gap = previous.y - line.y;
    const previousIsShort = previous.right - previous.left < shortLineThreshold;

    if (gap > gapThreshold || gap < 0 || previousIsShort) {
      paragraphs.push({ text: buffer.join(' ').trim(), page });
      buffer = [line.text];
    } else {
      buffer.push(line.text);
    }
  }
  paragraphs.push({ text: buffer.join(' ').trim(), page });

  return paragraphs.filter((p) => p.text !== '');
}

export async function extractPdf(data: Uint8Array): Promise<PdfExtraction> {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({
    data,
    useWorkerFetch: false,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
  }).promise;

  const paragraphs: PdfParagraph[] = [];
  const normalisations = new Set<string>();
  const warnings: string[] = [];

  let totalChars = 0;
  let unmappedChars = 0;
  let deshapedPages = 0;
  let reorderedLines = 0;

  try {
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const content = await page.getTextContent();
      const items = content.items as TextItem[];

      for (const item of items) {
        if (typeof item.str !== 'string') continue;
        for (const ch of item.str) {
          totalChars++;
          if (isUnmapped(ch)) unmappedChars++;
        }
      }

      // Drop unmapped codepoints before any structural work, otherwise they
      // corrupt the line grouping and every downstream match.
      const cleaned = items.map((item) => ({
        ...item,
        str: typeof item.str === 'string' ? Array.from(item.str).filter((c) => !isUnmapped(c)).join('') : '',
      }));

      let lines = itemsToLines(cleaned);

      const pageHadPresentationForms = lines.some((l) => hasPresentationForms(l.text));
      if (pageHadPresentationForms) {
        deshapedPages++;
        lines = lines.map((l) => ({ ...l, text: deshape(l.text) }));
      }

      lines = lines.map((l) => {
        const repaired = repairVisualOrder(l.text);
        if (repaired.repaired) reorderedLines++;
        return { ...l, text: repaired.text };
      });

      paragraphs.push(...linesToParagraphs(lines, pageNumber));
    }
  } finally {
    await doc.destroy();
  }

  if (deshapedPages > 0) {
    normalisations.add(
      `Arabic presentation forms found on ${deshapedPages} page(s) and mapped back to base letters. ` +
        `The source PDF stored joined glyph shapes rather than logical characters.`
    );
  }
  if (reorderedLines > 0) {
    normalisations.add(
      `${reorderedLines} line(s) were extracted in visual order and were reversed to logical order.`
    );
  }

  const unmappedShare = totalChars > 0 ? unmappedChars / totalChars : 0;
  if (unmappedChars > 0) {
    warnings.push(
      `This PDF has a lossy text layer. ${unmappedChars} of ${totalChars} extracted characters ` +
        `(${(unmappedShare * 100).toFixed(1)} per cent) carry no Unicode mapping and were dropped. ` +
        `The embedded font has an incomplete ToUnicode map, which is common in Arabic PDFs exported ` +
        `by tools that subset fonts. Treat the extracted text as incomplete and work from the original ` +
        `file or an OCR pass before relying on any quotation.`
    );
  }

  return {
    paragraphs,
    pageCount: doc.numPages,
    normalisations: [...normalisations],
    warnings,
  };
}
