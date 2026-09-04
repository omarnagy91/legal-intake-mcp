/**
 * Arabic text handling for legal document intake.
 *
 * Two rules govern everything in this file.
 *
 * 1. Text that a lawyer will read or cite is never silently rewritten. The only
 *    transforms applied to the returned text are repairs of an encoding defect
 *    in the source file (presentation form glyphs, visual ordering), and every
 *    repair that fires is reported on the document so the reader knows.
 * 2. Folding for matching is aggressive and is used only to decide whether a
 *    pattern matched. The span that comes back is always cut from the verbatim
 *    text, never from the folded copy.
 */

/** Arabic Presentation Forms A and B, plus the two ligature blocks. */
const PRESENTATION_FORMS = /[ﭐ-﷿ﹰ-﻿]/;

/** U+0640 ARABIC TATWEEL, the kashida used to stretch justified headings. */
const TATWEEL = /ـ/g;

/**
 * Arabic combining marks: harakat, tanween, shadda, sukun, superscript alef,
 * and the Quranic annotation range that turns up in quoted religious text.
 */
const DIACRITICS = /[ً-ٰٟۖ-ۭ࣓-ࣿ]/g;

/** Zero width joiner, non joiner, marks, and the bidi control characters. */
const INVISIBLES = /[​-‏‪-‮⁦-⁩﻿]/g;

const ARABIC_LETTER = /[ء-يٮ-ۓݐ-ݿ]/;
const LATIN_LETTER = /[A-Za-z]/;

/** Arabic-Indic digits, U+0660 to U+0669. */
const ARABIC_INDIC = /[٠-٩]/g;
/** Extended Arabic-Indic digits (Persian and Urdu), U+06F0 to U+06F9. */
const EXTENDED_ARABIC_INDIC = /[۰-۹]/g;

/** Arabic thousands and decimal separators, U+066B and U+066C. */
const ARABIC_DECIMAL_SEP = /٫/g;
const ARABIC_THOUSANDS_SEP = /[٬⁩⁦]/g;

export function hasArabic(text: string): boolean {
  return ARABIC_LETTER.test(text);
}

export function hasPresentationForms(text: string): boolean {
  return PRESENTATION_FORMS.test(text);
}

/**
 * Convert Arabic-Indic and Extended Arabic-Indic digits to ASCII digits.
 * Used before any numeric parse. Never applied to text that is returned.
 */
export function normaliseDigits(text: string): string {
  return text
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(ARABIC_THOUSANDS_SEP, '')
    .replace(ARABIC_DECIMAL_SEP, '.');
}

/**
 * Undo the glyph shaping that some PDF producers bake into the extracted text.
 *
 * A correctly authored PDF stores the base Arabic letters and lets the font do
 * the joining. A badly authored one stores the joined glyph for each position,
 * which extracts as Arabic Presentation Forms. NFKC carries the compatibility
 * decompositions for that whole range, so it maps every positional form back to
 * its base letter and splits the lam alef ligatures into two characters. The
 * tatweel that NFKC introduces when decomposing an isolated mark is stripped
 * afterwards.
 */
export function deshape(text: string): string {
  if (!PRESENTATION_FORMS.test(text)) return text;
  return text.normalize('NFKC').replace(TATWEEL, '');
}

/**
 * Frequent Arabic function words and legal words. Used only as evidence when
 * deciding whether a line of extracted text came out in visual order.
 */
const ORDER_PROBES = [
  'من',
  'في',
  'على',
  'إلى',
  'هذا',
  'التي',
  'الذي',
  'العقد',
  'الطرف',
  'المادة',
  'يلتزم',
  'أو',
  'ما',
  'بين',
];

function probeScore(text: string): number {
  let score = 0;
  for (const word of ORDER_PROBES) {
    let index = text.indexOf(word);
    while (index !== -1) {
      score += word.length;
      index = text.indexOf(word, index + 1);
    }
  }
  return score;
}

function reverseGraphemes(text: string): string {
  return Array.from(text).reverse().join('');
}

/**
 * Some PDF producers write each Arabic run in visual order, right to left, so
 * naive extraction yields reversed words. Detect that by asking whether common
 * Arabic words appear far more often in the reversed string than the forward
 * one, and repair only when the evidence is clear.
 *
 * The guard matters. Reversing a line that was already in logical order would
 * destroy it, and mixed Arabic and Latin lines reverse badly, so the function
 * refuses to act unless the reversed reading is at least twice as word like and
 * the forward reading is close to meaningless.
 */
export function repairVisualOrder(line: string): { text: string; repaired: boolean } {
  if (!ARABIC_LETTER.test(line)) return { text: line, repaired: false };
  const forward = probeScore(line);
  const reversed = probeScore(reverseGraphemes(line));
  if (reversed >= 4 && reversed >= forward * 2 + 4) {
    return { text: reverseGraphemes(line), repaired: true };
  }
  return { text: line, repaired: false };
}

/**
 * Fold a string so that two spellings a lawyer would consider the same match.
 *
 * Folds: presentation forms, tatweel, diacritics, invisibles, alef variants,
 * alef maqsura to yeh, teh marbuta to heh, hamza carriers to their base, and
 * Arabic-Indic digits to ASCII. Also lowercases Latin and collapses whitespace
 * and the various dash and quote characters so English patterns match too.
 *
 * The result is for matching only. It is never returned to the caller as text.
 */
export function foldForMatching(text: string): string {
  return deshape(text)
    .replace(INVISIBLES, '')
    .replace(TATWEEL, '')
    .replace(DIACRITICS, '')
    .replace(/[آأإٱٲٳٵ]/g, 'ا') // alef variants to bare alef
    .replace(/ى/g, 'ي') // alef maqsura to yeh
    .replace(/ة/g, 'ه') // teh marbuta to heh
    .replace(/ؤ/g, 'و') // waw with hamza to waw
    .replace(/[ئٸ]/g, 'ي') // yeh with hamza to yeh
    .replace(/ء/g, '') // standalone hamza carries no matching value
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[،؛؟]/g, (c) => ({ '،': ',', '؛': ';', '؟': '?' })[c] ?? c)
    .replace(/[‐-―−]/g, '-')
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A fold that keeps every character position, so a regex can run against the
 * folded copy while the matched span is still cut from the original text.
 *
 * Every substitution here is one character for one character, and combining
 * marks become spaces rather than being deleted. That costs a little matching
 * power against heavily vocalised text and buys exact offsets, which is the
 * trade a citation tool has to make.
 */
export function foldPreservingOffsets(text: string): string {
  return text
    .replace(TATWEEL, ' ')
    .replace(DIACRITICS, ' ')
    .replace(/[آأإٱٲٳٵ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/[ئٸ]/g, 'ي')
    .replace(ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(EXTENDED_ARABIC_INDIC, (d) => String(d.charCodeAt(0) - 0x06f0))
    .toLowerCase();
}

export type ScriptMix = {
  arabicChars: number;
  latinChars: number;
  arabicShare: number;
  latinShare: number;
  /** Dominant script, or "mixed" when neither reaches 85 per cent. */
  dominant: 'arabic' | 'latin' | 'mixed' | 'undetermined';
  /** RTL when Arabic dominates, LTR when Latin does, mixed otherwise. */
  direction: 'rtl' | 'ltr' | 'mixed' | 'undetermined';
};

/**
 * Measure the Arabic and Latin share of a string by letter count. Digits,
 * punctuation and whitespace are ignored because they are script neutral and
 * would otherwise drag every mixed document toward whichever side has more
 * numbers in it.
 */
export function scriptMix(text: string): ScriptMix {
  let arabicChars = 0;
  let latinChars = 0;
  for (const ch of text) {
    if (ARABIC_LETTER.test(ch)) arabicChars++;
    else if (LATIN_LETTER.test(ch)) latinChars++;
  }
  const total = arabicChars + latinChars;
  if (total === 0) {
    return {
      arabicChars,
      latinChars,
      arabicShare: 0,
      latinShare: 0,
      dominant: 'undetermined',
      direction: 'undetermined',
    };
  }
  const arabicShare = round3(arabicChars / total);
  const latinShare = round3(latinChars / total);
  let dominant: ScriptMix['dominant'] = 'mixed';
  let direction: ScriptMix['direction'] = 'mixed';
  if (arabicShare >= 0.85) {
    dominant = 'arabic';
    direction = 'rtl';
  } else if (latinShare >= 0.85) {
    dominant = 'latin';
    direction = 'ltr';
  }
  return { arabicChars, latinChars, arabicShare, latinShare, dominant, direction };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Per paragraph direction, used so a client can render each block correctly in
 * a mixed document rather than forcing one direction on the whole file.
 */
export function paragraphDirection(text: string): 'rtl' | 'ltr' {
  const mix = scriptMix(text);
  if (mix.arabicChars === 0 && mix.latinChars === 0) return 'ltr';
  return mix.arabicChars > mix.latinChars ? 'rtl' : 'ltr';
}

/**
 * Arabic ordinal words used to number clauses and party blocks. A great deal of
 * Arabic contract drafting numbers sections with these rather than with digits,
 * which is the case naive clause splitters miss.
 */
export const ARABIC_ORDINALS: ReadonlyArray<{ word: string; value: number }> = [
  { word: 'أولا', value: 1 },
  { word: 'ثانيا', value: 2 },
  { word: 'ثالثا', value: 3 },
  { word: 'رابعا', value: 4 },
  { word: 'خامسا', value: 5 },
  { word: 'سادسا', value: 6 },
  { word: 'سابعا', value: 7 },
  { word: 'ثامنا', value: 8 },
  { word: 'تاسعا', value: 9 },
  { word: 'عاشرا', value: 10 },
  { word: 'الحادي عشر', value: 11 },
  { word: 'الثاني عشر', value: 12 },
];

/** Arabic ordinal adjectives, as used in "البند الأول" (the first clause). */
export const ARABIC_ORDINAL_ADJECTIVES: ReadonlyArray<{ word: string; value: number }> = [
  { word: 'الاول', value: 1 },
  { word: 'الثاني', value: 2 },
  { word: 'الثالث', value: 3 },
  { word: 'الرابع', value: 4 },
  { word: 'الخامس', value: 5 },
  { word: 'السادس', value: 6 },
  { word: 'السابع', value: 7 },
  { word: 'الثامن', value: 8 },
  { word: 'التاسع', value: 9 },
  { word: 'العاشر', value: 10 },
];

/**
 * Cardinal number words, Arabic and English, used when a contract writes a
 * period out in words without a parenthetical numeral.
 */
export const NUMBER_WORDS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  fourteen: 14,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  'forty five': 45,
  sixty: 60,
  ninety: 90,
  'one hundred': 100,
  'one hundred and eighty': 180,
  واحد: 1,
  اثنين: 2,
  اثني: 2,
  ثلاث: 3,
  ثلاثة: 3,
  اربع: 4,
  اربعة: 4,
  خمس: 5,
  خمسة: 5,
  ست: 6,
  سته: 6,
  سبع: 7,
  سبعة: 7,
  ثمان: 8,
  ثمانية: 8,
  تسع: 9,
  تسعة: 9,
  عشر: 10,
  عشرة: 10,
  عشرين: 20,
  ثلاثين: 30,
  اربعين: 40,
  'خمسة واربعين': 45,
  خمسين: 50,
  ستين: 60,
  سبعين: 70,
  ثمانين: 80,
  تسعين: 90,
  مائه: 100,
  'مائه وثمانين': 180,
};
