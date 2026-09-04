/**
 * Date and deadline extraction.
 *
 * Three things make legal dates harder than they look, and all three show up in
 * Arabic contracts constantly.
 *
 *  - The numerals may be Arabic-Indic, so a parser built on \d finds nothing.
 *  - The calendar may be Hijri, so 1446 is a year and not a typo, and the
 *    contract usually states a Gregorian equivalent next to it which does not
 *    always agree with any arithmetic conversion.
 *  - The month may be written in any of three naming traditions: the Egyptian
 *    and Gulf transliterations, the Levantine and Iraqi names, or Hijri names.
 *
 * Conversions are reported as tabular, never as authoritative, because the
 * civil Hijri calendar used for arithmetic differs from the sighting based
 * calendar a court or a ministry actually applies, usually by a day. When the
 * document states its own Gregorian equivalent, that stated value is preserved
 * and any divergence is flagged rather than quietly resolved.
 */
import { foldForMatching, foldPreservingOffsets, normaliseDigits } from './arabic.js';
import type { Clause, ComputedDeadline, DateRole, ExtractedDate, LoadedDocument } from './types.js';

const D = '[0-9٠-٩۰-۹]';

type MonthEntry = { value: number; calendar: 'gregorian' | 'hijri'; canonical: string };

/** Month names folded with foldForMatching, so lookups are script tolerant. */
const MONTHS = new Map<string, MonthEntry>();

function addMonths(names: string[][], calendar: 'gregorian' | 'hijri') {
  names.forEach((group, i) => {
    for (const name of group) {
      MONTHS.set(foldForMatching(name), { value: i + 1, calendar, canonical: group[0]! });
    }
  });
}

addMonths(
  [
    ['January', 'Jan', 'يناير', 'كانون الثاني'],
    ['February', 'Feb', 'فبراير', 'شباط'],
    ['March', 'Mar', 'مارس', 'آذار', 'اذار'],
    ['April', 'Apr', 'أبريل', 'إبريل', 'ابريل', 'نيسان'],
    ['May', 'مايو', 'أيار', 'ايار'],
    ['June', 'Jun', 'يونيو', 'يونيه', 'حزيران'],
    ['July', 'Jul', 'يوليو', 'يوليه', 'تموز'],
    ['August', 'Aug', 'أغسطس', 'اغسطس', 'آب'],
    ['September', 'Sep', 'Sept', 'سبتمبر', 'أيلول', 'ايلول'],
    ['October', 'Oct', 'أكتوبر', 'اكتوبر', 'تشرين الأول', 'تشرين الاول'],
    ['November', 'Nov', 'نوفمبر', 'تشرين الثاني'],
    ['December', 'Dec', 'ديسمبر', 'كانون الأول', 'كانون الاول'],
  ],
  'gregorian'
);

addMonths(
  [
    ['محرم', 'المحرم'],
    ['صفر'],
    ['ربيع الأول', 'ربيع الاول'],
    ['ربيع الآخر', 'ربيع الثاني'],
    ['جمادى الأولى', 'جمادى الاولى'],
    ['جمادى الآخرة', 'جمادى الثانية'],
    ['رجب'],
    ['شعبان'],
    ['رمضان'],
    ['شوال'],
    ['ذو القعدة', 'ذي القعدة'],
    ['ذو الحجة', 'ذي الحجة'],
  ],
  'hijri'
);

const HIJRI_MONTH_NAMES = [
  'محرم',
  'صفر',
  'ربيع الأول',
  'ربيع الآخر',
  'جمادى الأولى',
  'جمادى الآخرة',
  'رجب',
  'شعبان',
  'رمضان',
  'شوال',
  'ذو القعدة',
  'ذو الحجة',
];

/* ------------------------------------------------------------------ */
/* Calendar arithmetic                                                 */
/* ------------------------------------------------------------------ */

/**
 * Tabular civil Hijri to Julian Day Number.
 *
 * This is the arithmetic calendar with a 30 year cycle of 11 leap years. It is
 * the standard used for computation, and it is deliberately not the calendar
 * used to declare the start of a month by sighting, which is why every result
 * derived from it is reported with a tolerance.
 */
export function hijriToJulianDay(year: number, month: number, day: number): number {
  return (
    Math.floor((11 * year + 3) / 30) +
    354 * year +
    30 * month -
    Math.floor((month - 1) / 2) +
    day +
    1948440 -
    385
  );
}

export function julianDayToGregorian(jd: number): { year: number; month: number; day: number } {
  let l = jd + 68569;
  const n = Math.floor((4 * l) / 146097);
  l = l - Math.floor((146097 * n + 3) / 4);
  const i = Math.floor((4000 * (l + 1)) / 1461001);
  l = l - Math.floor((1461 * i) / 4) + 31;
  const j = Math.floor((80 * l) / 2447);
  const day = l - Math.floor((2447 * j) / 80);
  l = Math.floor(j / 11);
  const month = j + 2 - 12 * l;
  const year = 100 * (n - 49) + i + l;
  return { year, month, day };
}

export function hijriToIso(year: number, month: number, day: number): string {
  const g = julianDayToGregorian(hijriToJulianDay(year, month, day));
  return toIso(g.year, g.month, g.day);
}

function toIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isValidGregorian(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

/** Add or subtract calendar days from an ISO date, in UTC to avoid any drift. */
export function shiftIsoDays(iso: string, days: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y!, m! - 1, d!));
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Add or subtract whole months, clamping to the end of a shorter month. */
export function shiftIsoMonths(iso: string, months: number): string {
  const [y, m, d] = iso.split('-').map(Number);
  const target = new Date(Date.UTC(y!, m! - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return toIso(target.getUTCFullYear(), target.getUTCMonth() + 1, Math.min(d!, lastDay));
}

/* ------------------------------------------------------------------ */
/* Date matching                                                       */
/* ------------------------------------------------------------------ */

type RawDate = {
  raw: string;
  start: number;
  end: number;
  calendar: 'gregorian' | 'hijri';
  year: number | null;
  month: number;
  day: number;
  hijriMonthName?: string;
};

const MONTH_NAME_ALTERNATION = [...MONTHS.keys()]
  .sort((a, b) => b.length - a.length)
  .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');

/**
 * Find every date in a string.
 *
 * Matching runs against a folded copy so Arabic-Indic digits, alef variants and
 * diacritics all match, while the span reported as `raw` is cut from the
 * original text so the citation shows what the document actually says.
 *
 * The offset preserving fold is used so that every reported span still points
 * at real characters in the original text.
 */
export function findDates(text: string): RawDate[] {
  const folded = foldPreservingOffsets(text);
  const found: RawDate[] = [];
  const claimed: Array<[number, number]> = [];

  const overlaps = (start: number, end: number) =>
    claimed.some(([s, e]) => start < e && end > s);

  const push = (d: RawDate) => {
    if (overlaps(d.start, d.end)) return;
    claimed.push([d.start, d.end]);
    found.push(d);
  };

  // Day month-name year, the dominant form in both languages.
  // The optional trailing marker captures the Hijri and Gregorian era letters
  // that Arabic contracts append, such as ١٤٤٦هـ and ٢٠٢٥م.
  const dayFirst = new RegExp(
    `(${D}{1,2})\\s+(${MONTH_NAME_ALTERNATION})\\s+(${D}{3,4})\\s*(هـ|ه\\b|م\\b)?`,
    'gu'
  );
  for (const m of folded.matchAll(dayFirst)) {
    const index = m.index ?? 0;
    const month = MONTHS.get((m[2] ?? '').trim());
    if (!month) continue;
    const day = Number(normaliseDigits(m[1] ?? ''));
    const year = Number(normaliseDigits(m[3] ?? ''));
    const marker = m[4];
    const calendar: 'gregorian' | 'hijri' =
      month.calendar === 'hijri' || marker === 'هـ' || marker === 'ه' ? 'hijri' : 'gregorian';
    push({
      raw: text.slice(index, index + m[0].length).trim(),
      start: index,
      end: index + m[0].length,
      calendar,
      year,
      month: month.value,
      day,
      ...(calendar === 'hijri' ? { hijriMonthName: HIJRI_MONTH_NAMES[month.value - 1] } : {}),
    });
  }

  // Month-name day, year. The English and American ordering.
  const monthFirst = new RegExp(`(${MONTH_NAME_ALTERNATION})\\s+(${D}{1,2})(?:st|nd|rd|th)?,?\\s+(${D}{3,4})`, 'gu');
  for (const m of folded.matchAll(monthFirst)) {
    const index = m.index ?? 0;
    const month = MONTHS.get((m[1] ?? '').trim());
    if (!month) continue;
    push({
      raw: text.slice(index, index + m[0].length).trim(),
      start: index,
      end: index + m[0].length,
      calendar: month.calendar,
      year: Number(normaliseDigits(m[3] ?? '')),
      month: month.value,
      day: Number(normaliseDigits(m[2] ?? '')),
      ...(month.calendar === 'hijri' ? { hijriMonthName: HIJRI_MONTH_NAMES[month.value - 1] } : {}),
    });
  }

  // ISO form, 2026-03-31.
  for (const m of folded.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    const index = m.index ?? 0;
    push({
      raw: text.slice(index, index + m[0].length),
      start: index,
      end: index + m[0].length,
      calendar: 'gregorian',
      year: Number(m[1]),
      month: Number(m[2]),
      day: Number(m[3]),
    });
  }

  // Numeric form, 31/03/2026 or 31-03-2026. Day first, which is the convention
  // in both Egypt and the Gulf. Ambiguous values are left to the day first
  // reading rather than guessed at, and the ambiguity is noted downstream.
  const numeric = new RegExp(`(${D}{1,2})[/.-](${D}{1,2})[/.-](${D}{4})`, 'gu');
  for (const m of folded.matchAll(numeric)) {
    const index = m.index ?? 0;
    const day = Number(normaliseDigits(m[1] ?? ''));
    const month = Number(normaliseDigits(m[2] ?? ''));
    const year = Number(normaliseDigits(m[3] ?? ''));
    if (month > 12) continue;
    push({
      raw: text.slice(index, index + m[0].length),
      start: index,
      end: index + m[0].length,
      calendar: year < 1600 ? 'hijri' : 'gregorian',
      year,
      month,
      day,
    });
  }

  // Day and month with no year, such as "15 February in each year of the term".
  const dayMonthOnly = new RegExp(`(${D}{1,2})\\s+(${MONTH_NAME_ALTERNATION})(?!\\s+${D})`, 'gu');
  for (const m of folded.matchAll(dayMonthOnly)) {
    const index = m.index ?? 0;
    const month = MONTHS.get((m[2] ?? '').trim());
    if (!month) continue;
    push({
      raw: text.slice(index, index + m[0].length).trim(),
      start: index,
      end: index + m[0].length,
      calendar: month.calendar,
      year: null,
      month: month.value,
      day: Number(normaliseDigits(m[1] ?? '')),
      ...(month.calendar === 'hijri' ? { hijriMonthName: HIJRI_MONTH_NAMES[month.value - 1] } : {}),
    });
  }

  return found.sort((a, b) => a.start - b.start);
}

/* ------------------------------------------------------------------ */
/* Role classification                                                 */
/* ------------------------------------------------------------------ */

/**
 * Triggers that reveal what a date is for. Ordered by specificity, since a
 * paragraph often contains more than one, and the nearest and most specific
 * trigger wins.
 */
const ROLE_TRIGGERS: ReadonlyArray<{ role: DateRole; terms: string[]; weight: number }> = [
  {
    role: 'commencement',
    weight: 5,
    terms: [
      'shall commence on',
      'commencement date',
      'commencing on',
      'تبدا مده هذا العقد',
      'تبدا مده العقد',
      'اعتبارا من',
      'يبدا العمل بهذا العقد',
    ],
  },
  {
    role: 'term_end',
    weight: 5,
    terms: ['expiring on', 'shall expire on', 'until', 'وتنتهي في', 'تنتهي في', 'حتي تاريخ', 'وحتي'],
  },
  {
    role: 'effective',
    weight: 4,
    terms: ['effective date', 'with effect from', 'تاريخ النفاذ', 'تاريخ سريان'],
  },
  {
    role: 'execution',
    weight: 4,
    terms: [
      'is made and entered into on',
      'made and entered into on',
      'entered into on',
      'dated',
      'تحرر هذا العقد',
      'حرر هذا العقد',
      'ابرم هذا العقد',
    ],
  },
  {
    role: 'delivery',
    weight: 3,
    terms: [
      'due no later than',
      'no later than',
      'to be delivered before',
      'delivered before',
      'shall be submitted by',
      'في موعد اقصاه',
      'علي ان تتم قبل',
      'قبل',
    ],
  },
  {
    role: 'signature',
    weight: 3,
    terms: ['date:', 'signed on', 'التاريخ:', 'بتاريخ التوقيع'],
  },
  {
    role: 'renewal',
    weight: 3,
    terms: ['renewal term', 'shall automatically renew', 'يتجدد', 'التجديد'],
  },
  {
    role: 'payment',
    weight: 2,
    terms: ['invoice date', 'payable within', 'due date', 'تاريخ الاستحقاق', 'تاريخ تحريرها'],
  },
  {
    role: 'notice',
    weight: 2,
    terms: ['written notice', 'notice of non-renewal', 'اخطار كتابي', 'اشعار كتابي'],
  },
];

function classifyRole(
  foldedParagraph: string,
  dateStart: number
): { role: DateRole; evidence: string | null } {
  let best: { role: DateRole; evidence: string; distance: number; weight: number } | null = null;

  for (const trigger of ROLE_TRIGGERS) {
    for (const term of trigger.terms) {
      let index = foldedParagraph.indexOf(term);
      while (index !== -1) {
        const distance = Math.abs(index + term.length - dateStart);
        if (distance <= 140) {
          if (
            best === null ||
            trigger.weight > best.weight ||
            (trigger.weight === best.weight && distance < best.distance)
          ) {
            best = { role: trigger.role, evidence: term, distance, weight: trigger.weight };
          }
        }
        index = foldedParagraph.indexOf(term, index + 1);
      }
    }
  }

  if (!best) return { role: 'unclassified', evidence: null };
  return { role: best.role, evidence: best.evidence };
}

/* ------------------------------------------------------------------ */
/* Notice periods and deadlines                                        */
/* ------------------------------------------------------------------ */

export type NoticePeriod = {
  /** The period as written, for example "sixty (60) days". */
  raw: string;
  days: number;
  unit: 'day' | 'month' | 'year';
  count: number;
  direction: 'before' | 'after';
  /** What the period is measured from, as written in the clause. */
  trigger: string;
  clauseAnchor: string;
  paragraphAnchor: string;
};

const UNIT_DAYS: Record<'day' | 'month' | 'year', number> = { day: 1, month: 30, year: 365 };

/**
 * Extract a period of time expressed in the way contracts express it, which is
 * almost always a spelled number followed by the same number in brackets. The
 * bracketed numeral is preferred because it is unambiguous in both scripts.
 */
export function findNoticePeriods(
  clause: Clause,
  paragraphTexts: Map<string, string>
): NoticePeriod[] {
  const periods: NoticePeriod[] = [];

  for (const paragraphAnchor of clause.paragraphAnchors) {
    const original = paragraphTexts.get(paragraphAnchor) ?? '';
    const folded = foldPreservingOffsets(original);

    // number in brackets, then a unit word
    const pattern = new RegExp(
      `\\(\\s*(${D}{1,4})\\s*\\)\\s*(days?|months?|years?|يوما|يوم|ايام|شهرا|شهر|اشهر|شهور|سنه|سنوات|سنة)`,
      'gu'
    );

    for (const m of folded.matchAll(pattern)) {
      const index = m.index ?? 0;
      const count = Number(normaliseDigits(m[1] ?? ''));
      if (!Number.isFinite(count) || count <= 0) continue;
      const unitWord = m[2] ?? '';
      const unit: 'day' | 'month' | 'year' = /day|يوم|ايام/.test(unitWord)
        ? 'day'
        : /month|شهر|اشهر|شهور/.test(unitWord)
          ? 'month'
          : 'year';

      // Look at the words immediately before and after to decide whether the
      // period runs backwards from an event or forwards from one.
      const contextStart = Math.max(0, index - 90);
      const before = folded.slice(contextStart, index);
      const after = folded.slice(index + m[0].length, index + m[0].length + 120);

      // A bracketed number followed by a unit is not necessarily a deadline. In
      // a contract it is just as often the length of a term, of a renewal
      // period, or of a restraint. Only a period introduced by an explicit
      // timing cue is treated as one that can produce a deadline, otherwise
      // "successive periods of twelve (12) months" is mistaken for a notice
      // period and yields a confident, wrong date.
      // The cue sits before the spelled out number, which itself sits before
      // the bracketed numeral, so a short window is allowed between the two.
      // A backward cue may also follow the period, as in "(14) days prior
      // written notice".
      const backwardCue =
        /(not less than|at least|no later than|prior to|before|in advance of)[\s\S]{0,30}$/.test(before) ||
        /(قبل|بما لا يقل عن)[\s\S]{0,30}$/u.test(before) ||
        /^[\s\S]{0,25}(prior to|prior|before|in advance of)/.test(after) ||
        /^[\s\S]{0,25}(قبل|سابقه)/u.test(after);

      const forwardCue =
        /(within|no later than)[\s\S]{0,30}$/.test(before) || /(خلال)[\s\S]{0,30}$/u.test(before);

      if (!backwardCue && !forwardCue) continue;

      const direction: 'before' | 'after' = forwardCue && !backwardCue ? 'after' : 'before';

      const triggerMatch =
        /(end of the then current term|end of the term|انتهاء المده|انتهاء المده الساريه|invoice date|due date|its due date|تاريخ الاستحقاق|تاريخ تحريرها|termination|الانهاء|expiry)/.exec(
          after
        );

      const rawStart = Math.max(0, index - 40);
      periods.push({
        raw: original.slice(rawStart, index + m[0].length).trim(),
        days: count * UNIT_DAYS[unit],
        unit,
        count,
        direction,
        trigger: triggerMatch?.[1] ?? after.trim().slice(0, 60),
        clauseAnchor: clause.anchor,
        paragraphAnchor,
      });
    }
  }

  return periods;
}

/* ------------------------------------------------------------------ */
/* Top level                                                           */
/* ------------------------------------------------------------------ */

export type DateExtraction = {
  dates: ExtractedDate[];
  computedDeadlines: ComputedDeadline[];
  noticePeriods: NoticePeriod[];
  notes: string[];
};

export function extractDates(document: LoadedDocument, clauses: Clause[]): DateExtraction {
  const dates: ExtractedDate[] = [];
  const notes: string[] = [];

  const clauseByParagraph = new Map<string, Clause>();
  for (const clause of clauses) {
    for (const anchor of clause.paragraphAnchors) clauseByParagraph.set(anchor, clause);
  }

  for (const paragraph of document.paragraphs) {
    const folded = foldPreservingOffsets(paragraph.text);
    const raws = findDates(paragraph.text);

    for (const raw of raws) {
      const { role, evidence } = classifyRole(folded, raw.start);
      const dateNotes: string[] = [];
      let iso: string | null = null;
      let hijri: ExtractedDate['hijri'] = null;

      if (raw.calendar === 'hijri' && raw.year !== null) {
        hijri = {
          year: raw.year,
          month: raw.month,
          day: raw.day,
          monthName: raw.hijriMonthName ?? HIJRI_MONTH_NAMES[raw.month - 1] ?? '',
        };
        iso = hijriToIso(raw.year, raw.month, raw.day);
        dateNotes.push(
          'Gregorian value is a tabular civil Hijri conversion and can differ by one day from the ' +
            'sighting based calendar used officially. Confirm against the calendar the contract is subject to.'
        );
      } else if (raw.year !== null) {
        if (!isValidGregorian(raw.year, raw.month, raw.day)) {
          dateNotes.push('Date does not exist in the Gregorian calendar as written.');
        } else {
          iso = toIso(raw.year, raw.month, raw.day);
        }
      } else {
        dateNotes.push('No year is stated, so this is a recurring date rather than a fixed one.');
      }

      dates.push({
        raw: raw.raw,
        calendar: raw.calendar,
        iso,
        hijri,
        role,
        roleEvidence: evidence,
        anchor: paragraph.anchor,
        clauseAnchor: clauseByParagraph.get(paragraph.anchor)?.anchor ?? null,
        page: paragraph.page,
        notes: dateNotes,
      });
    }

    // A Hijri date immediately followed by "الموافق" and a Gregorian date is
    // the contract stating its own equivalence. Record it against the Hijri
    // date and flag any divergence from the arithmetic conversion, because that
    // divergence is normal and a reader needs to know which one governs.
    const hijriInParagraph = dates.filter(
      (d) => d.anchor === paragraph.anchor && d.calendar === 'hijri' && d.iso !== null
    );
    const gregorianInParagraph = dates.filter(
      (d) => d.anchor === paragraph.anchor && d.calendar === 'gregorian' && d.iso !== null
    );
    if (hijriInParagraph.length === 1 && gregorianInParagraph.length >= 1 && /الموافق/.test(paragraph.text)) {
      const hijriDate = hijriInParagraph[0]!;
      const stated = gregorianInParagraph[0]!;
      hijriDate.statedGregorian = stated.iso;
      if (stated.iso !== hijriDate.iso) {
        const drift = Math.round(
          (Date.parse(stated.iso + 'T00:00:00Z') - Date.parse(hijriDate.iso + 'T00:00:00Z')) / 86400000
        );
        hijriDate.notes.push(
          `The contract states ${stated.iso} as the Gregorian equivalent. The tabular conversion gives ` +
            `${hijriDate.iso}, a difference of ${drift} day(s). The stated equivalent is what the parties wrote ` +
            `and normally governs.`
        );
      }
      // The stated equivalent shares the Hijri date's role rather than standing
      // as an unrelated date.
      if (stated.role === 'unclassified') stated.role = hijriDate.role;
    }
  }

  // Notice periods, gathered per clause so each one keeps a citable anchor.
  const paragraphTexts = new Map(document.paragraphs.map((p) => [p.anchor, p.text]));
  const noticePeriods: NoticePeriod[] = [];
  for (const clause of clauses) noticePeriods.push(...findNoticePeriods(clause, paragraphTexts));

  // Deadlines are only computed where there is a real anchor date to measure
  // from. A period such as "within thirty days of the invoice date" has no
  // fixed anchor in the contract, so it is reported as a period and not turned
  // into a date that would look more certain than it is.
  const computedDeadlines: ComputedDeadline[] = [];
  const termEnd = dates.find((d) => d.role === 'term_end' && d.iso !== null);

  const renewalPattern =
    /(automatically renew|auto-renewal|non-renewal|successive periods|renewal term|يتجدد|التجديد|عدم التجديد)/i;

  for (const period of noticePeriods) {
    const clause = clauses.find((c) => c.anchor === period.clauseAnchor);
    if (!clause) continue;
    const foldedClause = foldForMatching(clause.text);
    const isRenewalNotice = renewalPattern.test(foldedClause) || renewalPattern.test(clause.text);

    if (isRenewalNotice && period.direction === 'before' && termEnd?.iso) {
      const deadline =
        period.unit === 'day'
          ? shiftIsoDays(termEnd.iso, -period.count)
          : period.unit === 'month'
            ? shiftIsoMonths(termEnd.iso, -period.count)
            : shiftIsoMonths(termEnd.iso, -period.count * 12);

      computedDeadlines.push({
        description:
          'Written notice of non-renewal must be given on or before this date, otherwise the agreement renews automatically.',
        period: `${period.count} ${period.unit}${period.count === 1 ? '' : 's'}`,
        days: period.days,
        direction: 'before',
        anchorDate: termEnd.iso,
        anchorDateRole: 'term_end',
        deadline,
        clauseAnchor: period.clauseAnchor,
        paragraphAnchor: period.paragraphAnchor,
        notes: [
          `Computed as ${termEnd.iso} minus ${period.count} ${period.unit}(s), taken from the notice period in clause ` +
            `${clause.label ?? clause.anchor}.`,
          'Calendar days, not business days, unless the contract says otherwise. Verify against the notice clause before relying on it.',
        ],
      });
    }
  }

  if (computedDeadlines.length === 0 && noticePeriods.length > 0) {
    notes.push(
      'Notice periods were found but no deadline could be computed, because no fixed date in the document anchors them.'
    );
  }
  if (!termEnd) {
    notes.push('No term end date was identified, so any renewal deadline could not be computed.');
  }

  return { dates, computedDeadlines, noticePeriods, notes };
}
