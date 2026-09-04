/**
 * Clause segmentation.
 *
 * English contract drafting numbers clauses one way. Arabic contract drafting
 * numbers them several other ways, and a splitter written only for the English
 * conventions silently returns one enormous clause for an Arabic contract,
 * which destroys every citation downstream. Both families are handled here.
 *
 * English conventions handled
 *   1.            decimal, top level
 *   1.1, 1.1.1    decimal, nested
 *   (a) (b) (iv)  lettered and roman sub items
 *   SCHEDULE 1    an unnumbered or separately numbered heading
 *
 * Arabic conventions handled
 *   المادة (٣)     article, the standard Egyptian and Gulf drafting form
 *   البند الأول    clause plus an ordinal adjective, spelled not numbered
 *   أولاً ثانياً    standalone ordinals, very common for top level divisions
 *   ٣-٢            Arabic decimal, written with a hyphen rather than a dot
 *   الملحق رقم (١)  schedule
 *
 * Arabic-Indic digits are accepted everywhere a numeral can appear, and the
 * label is kept verbatim while `normalisedLabel` carries an ASCII form so a
 * caller can compare and sort clauses across the two scripts.
 */
import { ARABIC_ORDINALS, ARABIC_ORDINAL_ADJECTIVES, foldForMatching, normaliseDigits, paragraphDirection } from './arabic.js';
import { clauseAnchor } from './anchors.js';
import type { Clause, LoadedDocument, Paragraph } from './types.js';

type Marker = {
  label: string;
  normalisedLabel: string;
  numbering: Clause['numbering'];
  depth: number;
  /** Text following the marker in the same paragraph. */
  remainder: string;
  /** True when the paragraph is only a heading and carries no clause body. */
  headingOnly: boolean;
};

const AR_DIGIT = '[0-9\u0660-\u0669\u06F0-\u06F9]';

/** Arabic nouns that introduce a numbered division. */
const AR_DIVISION = '(?:المادة|مادة|البند|بند|الفصل|فصل|الملحق|ملحق|المــادة)';

function toAsciiDigits(text: string): string {
  return normaliseDigits(text);
}

function isUpperHeading(text: string): boolean {
  const letters = text.replace(/[^A-Za-z]/g, '');
  if (letters.length < 3) return false;
  const upper = text.replace(/[^A-Z]/g, '').length;
  return upper / letters.length >= 0.75;
}

/**
 * Decide whether a paragraph opens a new clause, and with what label.
 *
 * Order matters. The Arabic patterns are tried before the English decimal one
 * because an Arabic decimal such as "٣-٢" would otherwise be partly consumed by
 * the looser numeric rule.
 */
export function detectMarker(text: string): Marker | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;

  // Arabic: المادة (٣): مدة العقد    or    الملحق رقم (١): بيان الخدمات
  const article = new RegExp(
    `^${AR_DIVISION}\\s*(?:رقم\\s*)?\\(?\\s*(${AR_DIGIT}+)\\s*\\)?\\s*[:\\-\u2013\u061B\u060C.]?\\s*(.*)$`,
    'u'
  ).exec(trimmed);
  if (article) {
    const number = toAsciiDigits(article[1] ?? '');
    const remainder = (article[2] ?? '').trim();
    const labelEnd = trimmed.length - (article[2] ?? '').length;
    return {
      label: trimmed.slice(0, labelEnd).replace(/[\s:\-\u2013.]+$/u, '').trim(),
      normalisedLabel: number,
      numbering: 'arabic-article',
      depth: 0,
      remainder,
      headingOnly: remainder.length > 0 && remainder.length <= 80,
    };
  }

  // Arabic: البند الأول    the division noun followed by a spelled ordinal
  const spelled = new RegExp(
    `^(${AR_DIVISION}\\s+([^\\s:\u061B\u060C.\\-\u2013]+))\\s*[:\\-\u2013\u061B\u060C.]?\\s*(.*)$`,
    'u'
  ).exec(trimmed);
  if (spelled) {
    const folded = foldForMatching(spelled[2] ?? '');
    const ordinal = ARABIC_ORDINAL_ADJECTIVES.find((o) => foldForMatching(o.word) === folded);
    if (ordinal) {
      const remainder = (spelled[3] ?? '').trim();
      return {
        label: (spelled[1] ?? '').trim(),
        normalisedLabel: String(ordinal.value),
        numbering: 'arabic-ordinal',
        depth: 0,
        remainder,
        headingOnly: remainder.length > 0 && remainder.length <= 80,
      };
    }
  }

  // Arabic: أولاً:  ثانياً:   standalone ordinal opening a division
  const standalone = /^(\S+)\s*[:\u061B\u060C\-\u2013.]\s*(.*)$/u.exec(trimmed);
  if (standalone) {
    const folded = foldForMatching(standalone[1] ?? '');
    const ordinal = ARABIC_ORDINALS.find((o) => foldForMatching(o.word) === folded);
    if (ordinal) {
      const remainder = (standalone[2] ?? '').trim();
      return {
        label: (standalone[1] ?? '').trim(),
        normalisedLabel: String(ordinal.value),
        numbering: 'arabic-ordinal',
        depth: 0,
        remainder,
        headingOnly: remainder.length > 0 && remainder.length <= 80,
      };
    }
  }

  // Arabic decimal: ٣-٢ or ١٠-١-٢, written with a hyphen rather than a dot
  const arabicDecimal = new RegExp(`^(${AR_DIGIT}+(?:\\s*[-\u2013\u2014]\\s*${AR_DIGIT}+)+)\\s+(.*)$`, 'u').exec(
    trimmed
  );
  if (arabicDecimal) {
    const label = (arabicDecimal[1] ?? '').trim();
    const parts = toAsciiDigits(label)
      .split(/[-\u2013\u2014]/)
      .map((p) => p.trim())
      .filter((p) => p !== '');
    return {
      label,
      normalisedLabel: parts.join('.'),
      numbering: 'arabic-decimal',
      depth: Math.max(0, parts.length - 1),
      remainder: (arabicDecimal[2] ?? '').trim(),
      headingOnly: false,
    };
  }

  // English decimal: 1.  1.1  1.1.1
  const decimal = /^(\d+(?:\.\d+)+)\.?\s+(.*)$/u.exec(trimmed);
  if (decimal) {
    const label = decimal[1] ?? '';
    const parts = label.split('.').filter((p) => p !== '');
    return {
      label,
      normalisedLabel: parts.join('.'),
      numbering: 'decimal',
      depth: Math.max(0, parts.length - 1),
      remainder: (decimal[2] ?? '').trim(),
      headingOnly: false,
    };
  }

  // English top level: "2. TERM AND RENEWAL". A bare integer is only accepted
  // when what follows reads like a heading, otherwise every sentence that opens
  // with a number, a date included, would be promoted to a clause.
  const topLevel = /^(\d{1,2})\.\s+(.+)$/u.exec(trimmed);
  if (topLevel) {
    const remainder = (topLevel[2] ?? '').trim();
    if (isUpperHeading(remainder) || remainder.length <= 60) {
      return {
        label: topLevel[1] ?? '',
        normalisedLabel: topLevel[1] ?? '',
        numbering: 'decimal',
        depth: 0,
        remainder,
        headingOnly: true,
      };
    }
  }

  // Lettered or roman sub items: "A." "(a)" "(iv)"
  const lettered = /^(\(?([a-zA-Z])\)|\(?([ivxIVX]{1,4})\)|([A-Za-z])\.)\s+(.+)$/u.exec(trimmed);
  if (lettered) {
    const roman = lettered[3];
    const letter = lettered[2] ?? lettered[4];
    const isRoman = roman !== undefined && /^[ivxIVX]{2,4}$/.test(roman);
    return {
      label: (lettered[1] ?? '').trim(),
      normalisedLabel: (isRoman ? roman : letter ?? '').toLowerCase(),
      numbering: isRoman ? 'roman' : 'lettered',
      depth: 1,
      remainder: (lettered[5] ?? '').trim(),
      headingOnly: false,
    };
  }

  // Arabic lettered sub items: أ. ب. ج. د.
  const arabicLettered = /^([أ-ي])\s*[.\u061B\u060C\-]\s+(.+)$/u.exec(trimmed);
  if (arabicLettered) {
    const letters = ['أ', 'ب', 'ج', 'د', 'ه', 'و', 'ز', 'ح', 'ط', 'ي'];
    const letter = arabicLettered[1] ?? '';
    const position = letters.indexOf(letter);
    if (position !== -1) {
      return {
        label: letter,
        normalisedLabel: String(position + 1),
        numbering: 'lettered',
        depth: 1,
        remainder: (arabicLettered[2] ?? '').trim(),
        headingOnly: false,
      };
    }
  }

  // English unnumbered heading: "RECITALS", "SCHEDULE 1: DESCRIPTION OF SERVICES"
  if (isUpperHeading(trimmed) && trimmed.length <= 90) {
    return {
      label: null as unknown as string,
      normalisedLabel: null as unknown as string,
      numbering: 'heading',
      depth: 0,
      remainder: trimmed,
      headingOnly: true,
    };
  }

  // Arabic unnumbered heading: تمهيد, and other short headingless divisions
  const arabicHeadings = ['تمهيد', 'التمهيد', 'ديباجه', 'مقدمه', 'الديباجه'];
  if (arabicHeadings.includes(foldForMatching(trimmed))) {
    return {
      label: null as unknown as string,
      normalisedLabel: null as unknown as string,
      numbering: 'heading',
      depth: 0,
      remainder: trimmed,
      headingOnly: true,
    };
  }

  return null;
}

/**
 * Split a loaded document into clauses.
 *
 * Paragraphs before the first recognised marker become a single front matter
 * clause rather than being dropped, because in practice the parties, the date
 * and the recitals all live there and every one of them needs an anchor.
 */
export function segmentClauses(document: LoadedDocument): Clause[] {
  const clauses: Clause[] = [];

  type Draft = {
    label: string | null;
    normalisedLabel: string | null;
    numbering: Clause['numbering'];
    heading: string | null;
    depth: number;
    paragraphs: Paragraph[];
  };

  let current: Draft | null = null;

  const flush = () => {
    if (!current || current.paragraphs.length === 0) return;
    const index = clauses.length + 1;
    const text = current.paragraphs.map((p) => p.text).join('\n\n');
    const firstPage = current.paragraphs.find((p) => p.page !== null)?.page ?? null;

    // The parent is the nearest preceding clause at a shallower depth. This is
    // structural rather than numeric on purpose: real contracts contain
    // misnumbered sub clauses, and a numeric match would drop them on the floor.
    let parentAnchor: string | null = null;
    if (current.depth > 0) {
      for (let i = clauses.length - 1; i >= 0; i--) {
        const candidate = clauses[i]!;
        if (candidate.depth < current.depth) {
          parentAnchor = candidate.anchor;
          break;
        }
      }
    }

    clauses.push({
      anchor: clauseAnchor(index),
      index,
      label: current.label,
      normalisedLabel: current.normalisedLabel,
      numbering: current.numbering,
      heading: current.heading,
      text,
      paragraphAnchors: current.paragraphs.map((p) => p.anchor),
      page: firstPage,
      direction: paragraphDirection(text),
      parentAnchor,
      depth: current.depth,
    });
    current = null;
  };

  for (const paragraph of document.paragraphs) {
    const marker = detectMarker(paragraph.text);

    if (marker === null) {
      if (current === null) {
        current = {
          label: null,
          normalisedLabel: null,
          numbering: 'none',
          heading: null,
          depth: 0,
          paragraphs: [],
        };
      }
      current.paragraphs.push(paragraph);
      continue;
    }

    flush();
    current = {
      label: marker.label ?? null,
      normalisedLabel: marker.normalisedLabel ?? null,
      numbering: marker.numbering,
      heading: marker.headingOnly ? marker.remainder || null : null,
      depth: marker.depth,
      paragraphs: [paragraph],
    };
  }
  flush();

  return clauses;
}

/**
 * Fold a clause once so repeated concept searches over the same document do not
 * re-fold the same text for every term in the lexicon.
 */
export function foldClauses(clauses: Clause[]): Map<string, string> {
  const folded = new Map<string, string>();
  for (const clause of clauses) folded.set(clause.anchor, foldForMatching(clause.text));
  return folded;
}
