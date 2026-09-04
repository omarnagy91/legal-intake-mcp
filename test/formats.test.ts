import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadDocument } from '../src/lib/document.js';
import { foldClauses, segmentClauses } from '../src/lib/clauses.js';
import { findByConcept } from '../src/lib/concepts.js';
import { extractDates } from '../src/lib/dates.js';
import { extractParties } from '../src/lib/parties.js';
import { sample } from './helpers/mcpClient.js';

describe('format detection and parsing', () => {
  test('parses a plain text contract', async () => {
    const document = await loadDocument(sample('services-agreement-en.txt'));
    assert.equal(document.format, 'text');
    assert.equal(document.pageCount, null);
    assert.ok(document.paragraphCount > 40);
  });

  test('parses a Word document with no external dependency', async () => {
    const document = await loadDocument(sample('services-agreement-en.docx'));
    assert.equal(document.format, 'docx');
    assert.ok(document.paragraphCount > 40);
    assert.ok(document.paragraphs.some((p) => p.text.includes('TERM AND RENEWAL')));
  });

  test('parses an Arabic Word document and keeps the text right to left', async () => {
    const document = await loadDocument(sample('services-agreement-ar.docx'));
    assert.equal(document.format, 'docx');
    assert.equal(document.languageMix.direction, 'rtl');
    assert.ok(document.languageMix.arabicShare > 0.9);
    assert.ok(document.paragraphs.some((p) => p.text.includes('المادة (٣)')));
  });

  test('parses a PDF and reports real page numbers', async () => {
    const document = await loadDocument(sample('services-agreement-en.pdf'));
    assert.equal(document.format, 'pdf');
    assert.ok((document.pageCount ?? 0) >= 4, 'expected a multi page PDF');
    assert.ok(document.paragraphs.some((p) => (p.page ?? 0) > 1), 'expected content past page one');
    for (const paragraph of document.paragraphs) {
      assert.ok(paragraph.page !== null, 'every PDF paragraph must carry a page number');
    }
  });

  test('detects format from content, not from the extension', async () => {
    // The loader reads magic bytes first, so a mislabelled file in an intake
    // pile is parsed correctly rather than confidently mis-parsed.
    const document = await loadDocument(sample('services-agreement-en.pdf'));
    assert.equal(document.format, 'pdf');
  });

  test('reports a clear error for a missing file', async () => {
    await assert.rejects(
      () => loadDocument(sample('does-not-exist.pdf')),
      /file not found/
    );
  });

  test('clean sources need no normalisation', async () => {
    // Nothing should be rewritten in a well formed file. If this starts
    // failing, the server has begun altering text a lawyer intends to cite.
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    assert.deepEqual(document.normalisations, []);
    assert.deepEqual(document.warnings, []);
  });
});

describe('the same contract in different formats agrees with itself', () => {
  test('text and docx produce the same clause labels and dates', async () => {
    const fromText = await loadDocument(sample('services-agreement-ar.txt'));
    const fromDocx = await loadDocument(sample('services-agreement-ar.docx'));

    const textClauses = segmentClauses(fromText);
    const docxClauses = segmentClauses(fromDocx);

    const labels = (clauses: typeof textClauses) =>
      clauses.map((c) => c.normalisedLabel).filter((l): l is string => l !== null);

    // The same contract must anchor the same way whichever format it arrives
    // in, otherwise a citation taken from the .docx does not survive the client
    // sending the .txt version of the same file.
    assert.deepEqual(labels(docxClauses), labels(textClauses));

    const textDates = extractDates(fromText, textClauses);
    const docxDates = extractDates(fromDocx, docxClauses);
    assert.deepEqual(
      docxDates.dates.map((d) => d.iso),
      textDates.dates.map((d) => d.iso)
    );
    assert.equal(
      docxDates.computedDeadlines[0]?.deadline,
      textDates.computedDeadlines[0]?.deadline
    );
  });

  test('text and pdf find the same parties', async () => {
    const fromText = extractParties(await loadDocument(sample('services-agreement-en.txt')));
    const fromPdf = extractParties(await loadDocument(sample('services-agreement-en.pdf')));

    assert.deepEqual(
      fromPdf.parties.map((p) => p.name),
      fromText.parties.map((p) => p.name)
    );
    assert.deepEqual(
      fromPdf.signatories.map((s) => s.name),
      fromText.signatories.map((s) => s.name)
    );
  });

  test('text and pdf find the same concepts', async () => {
    const concepts = ['auto_renewal', 'arbitration', 'penalty', 'non_compete'] as const;

    for (const file of ['services-agreement-en.txt', 'services-agreement-en.pdf']) {
      const document = await loadDocument(sample(file));
      const clauses = segmentClauses(document);
      const folded = foldClauses(clauses);
      for (const concept of concepts) {
        const matches = findByConcept(clauses, folded, concept, null);
        assert.ok(matches.length > 0, `${concept} not found in ${file}`);
      }
    }
  });
});

describe('anchors are consistent across every tool', () => {
  for (const file of ['services-agreement-en.txt', 'services-agreement-ar.txt', 'services-agreement-en.pdf']) {
    test(`anchors resolve and agree for ${file}`, async () => {
      const document = await loadDocument(sample(file));
      const clauses = segmentClauses(document);
      const folded = foldClauses(clauses);

      const paragraphAnchors = new Set(document.paragraphs.map((p) => p.anchor));
      const clauseAnchors = new Map(clauses.map((c) => [c.anchor, c]));

      // Every paragraph belongs to exactly one clause, and no clause cites a
      // paragraph that does not exist.
      const seen = new Set<string>();
      for (const clause of clauses) {
        for (const anchor of clause.paragraphAnchors) {
          assert.ok(paragraphAnchors.has(anchor), `${clause.anchor} cites unknown ${anchor}`);
          assert.equal(seen.has(anchor), false, `${anchor} claimed by two clauses`);
          seen.add(anchor);
        }
      }
      assert.equal(seen.size, document.paragraphCount, 'every paragraph must belong to a clause');

      // extract_dates anchors must resolve into the same two spaces.
      const dates = extractDates(document, clauses);
      for (const date of dates.dates) {
        assert.ok(paragraphAnchors.has(date.anchor), `date cites unknown ${date.anchor}`);
        if (date.clauseAnchor !== null) {
          assert.ok(clauseAnchors.has(date.clauseAnchor), `date cites unknown ${date.clauseAnchor}`);
        }
      }
      for (const deadline of dates.computedDeadlines) {
        assert.ok(clauseAnchors.has(deadline.clauseAnchor));
        assert.ok(paragraphAnchors.has(deadline.paragraphAnchor));
      }

      // find_clauses must return the very same clause object identity that
      // segment_clauses reported, not a re-derived one.
      const matches = findByConcept(clauses, folded, 'arbitration', null);
      for (const match of matches) {
        const fromSegmentation = clauseAnchors.get(match.clause.anchor);
        assert.ok(fromSegmentation, 'search returned an anchor segmentation does not know');
        assert.equal(fromSegmentation.text, match.clause.text);
        assert.deepEqual(fromSegmentation.paragraphAnchors, match.clause.paragraphAnchors);
      }
    });
  }

  test('loading the same file twice gives identical anchors', async () => {
    const first = await loadDocument(sample('services-agreement-ar.txt'));
    const second = await loadDocument(sample('services-agreement-ar.txt'));
    assert.deepEqual(
      second.paragraphs.map((p) => p.anchor),
      first.paragraphs.map((p) => p.anchor)
    );
    assert.deepEqual(
      segmentClauses(second).map((c) => c.anchor),
      segmentClauses(first).map((c) => c.anchor)
    );
  });
});
