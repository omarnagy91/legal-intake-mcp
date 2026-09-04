import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadDocument } from '../src/lib/document.js';
import { segmentClauses } from '../src/lib/clauses.js';
import { extractDates, hijriToIso, shiftIsoDays, shiftIsoMonths } from '../src/lib/dates.js';
import { sample } from './helpers/mcpClient.js';

describe('Hijri arithmetic', () => {
  test('converts the epoch correctly', () => {
    // 1 Muharram 1 AH in the tabular civil calendar.
    assert.equal(hijriToIso(1, 1, 1), '0622-07-19');
  });

  test('converts a modern Hijri date to within a day of the observed value', () => {
    // 15 Ramadan 1446 fell on 15 or 16 March 2025 depending on the calendar
    // used. The tabular value must land in that window.
    const iso = hijriToIso(1446, 9, 15);
    const days = Math.abs(
      (Date.parse(`${iso}T00:00:00Z`) - Date.parse('2025-03-15T00:00:00Z')) / 86400000
    );
    assert.ok(days <= 1, `expected within a day of 2025-03-15, got ${iso}`);
  });

  test('is monotonic across a month boundary', () => {
    assert.ok(hijriToIso(1446, 9, 30) < hijriToIso(1446, 10, 1));
  });
});

describe('ISO date arithmetic', () => {
  test('subtracts days across a month boundary', () => {
    assert.equal(shiftIsoDays('2026-03-31', -60), '2026-01-30');
  });

  test('subtracts days across a year boundary', () => {
    assert.equal(shiftIsoDays('2026-01-15', -30), '2025-12-16');
  });

  test('handles a leap day', () => {
    assert.equal(shiftIsoDays('2024-03-01', -1), '2024-02-29');
  });

  test('clamps when a month shift lands on a shorter month', () => {
    assert.equal(shiftIsoMonths('2025-03-31', -1), '2025-02-28');
  });
});

describe('date extraction, English contract', () => {
  test('finds and classifies the key dates', async () => {
    const document = await loadDocument(sample('services-agreement-en.txt'));
    const clauses = segmentClauses(document);
    const result = extractDates(document, clauses);

    const commencement = result.dates.find((d) => d.role === 'commencement');
    const termEnd = result.dates.find((d) => d.role === 'term_end');
    const execution = result.dates.find((d) => d.role === 'execution');

    assert.equal(execution?.iso, '2025-03-14');
    assert.equal(commencement?.iso, '2025-04-01');
    assert.equal(termEnd?.iso, '2026-03-31');
    assert.equal(commencement?.calendar, 'gregorian');
  });

  test('computes the non-renewal notice deadline', async () => {
    const document = await loadDocument(sample('services-agreement-en.txt'));
    const clauses = segmentClauses(document);
    const result = extractDates(document, clauses);

    assert.equal(result.computedDeadlines.length, 1);
    const deadline = result.computedDeadlines[0]!;
    assert.equal(deadline.deadline, '2026-01-30');
    assert.equal(deadline.anchorDate, '2026-03-31');
    assert.equal(deadline.days, 60);
    assert.match(deadline.clauseAnchor, /^C\d+$/);
  });

  test('does not mistake a term length for a notice period', async () => {
    // Clause 2.2 says the agreement renews "for successive periods of twelve
    // (12) months". That is the length of the renewal, not a deadline, and
    // reading it as one produces a confident wrong date.
    const document = await loadDocument(sample('services-agreement-en.txt'));
    const clauses = segmentClauses(document);
    const result = extractDates(document, clauses);

    assert.equal(
      result.computedDeadlines.some((d) => d.days === 360 || d.period.startsWith('12')),
      false
    );
  });

  test('reports a recurring date with no year rather than inventing one', async () => {
    const document = await loadDocument(sample('services-agreement-en.txt'));
    const clauses = segmentClauses(document);
    const result = extractDates(document, clauses);

    const february = result.dates.find((d) => d.raw.includes('15 February'));
    assert.ok(february, 'expected the annual licence renewal date to be found');
    assert.equal(february.iso, null);
    assert.ok(february.notes.some((n) => n.includes('No year is stated')));
  });
});

describe('date extraction, Arabic contract', () => {
  test('reads Arabic-Indic dates with Arabic month names', async () => {
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    const result = extractDates(document, clauses);

    const commencement = result.dates.find((d) => d.role === 'commencement');
    const termEnd = result.dates.find((d) => d.role === 'term_end');

    assert.equal(commencement?.iso, '2025-04-01');
    assert.equal(termEnd?.iso, '2026-03-31');
    assert.match(commencement!.raw, /أبريل/);
  });

  test('identifies the Hijri date and converts it', async () => {
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    const result = extractDates(document, clauses);

    const hijri = result.dates.find((d) => d.calendar === 'hijri');
    assert.ok(hijri, 'expected a Hijri date to be found');
    assert.equal(hijri.hijri?.year, 1446);
    assert.equal(hijri.hijri?.month, 9);
    assert.equal(hijri.hijri?.day, 15);
    assert.equal(hijri.hijri?.monthName, 'رمضان');
    assert.equal(hijri.iso, '2025-03-15');
  });

  test('preserves the stated Gregorian equivalent and flags the divergence', async () => {
    // The contract says 15 Ramadan 1446 corresponds to 14 March 2025. The
    // tabular conversion gives 15 March. Silently picking one would hide a real
    // discrepancy that only a human can resolve.
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    const result = extractDates(document, clauses);

    const hijri = result.dates.find((d) => d.calendar === 'hijri');
    assert.equal(hijri?.statedGregorian, '2025-03-14');
    assert.ok(
      hijri!.notes.some((n) => n.includes('tabular conversion')),
      'expected the divergence to be reported'
    );
  });

  test('computes the same notice deadline as the English contract', async () => {
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    const result = extractDates(document, clauses);

    assert.equal(result.computedDeadlines.length, 1);
    assert.equal(result.computedDeadlines[0]!.deadline, '2026-01-30');
    assert.equal(result.computedDeadlines[0]!.days, 60);
  });

  test('finds notice periods written with Arabic-Indic numerals', async () => {
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    const result = extractDates(document, clauses);

    const ninety = result.noticePeriods.find((p) => p.count === 90);
    assert.ok(ninety, 'expected the ninety day termination notice period');
    assert.equal(ninety.direction, 'before');
    assert.equal(ninety.unit, 'day');
  });
});

describe('cross language agreement', () => {
  test('the Arabic and English contracts yield the same term dates', async () => {
    const english = await loadDocument(sample('services-agreement-en.txt'));
    const arabic = await loadDocument(sample('services-agreement-ar.txt'));

    const en = extractDates(english, segmentClauses(english));
    const ar = extractDates(arabic, segmentClauses(arabic));

    const pick = (result: typeof en, role: string) =>
      result.dates.find((d) => d.role === role)?.iso ?? null;

    assert.equal(pick(en, 'commencement'), pick(ar, 'commencement'));
    assert.equal(pick(en, 'term_end'), pick(ar, 'term_end'));
    assert.equal(en.computedDeadlines[0]?.deadline, ar.computedDeadlines[0]?.deadline);
  });
});
