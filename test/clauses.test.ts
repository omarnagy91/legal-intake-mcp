import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadDocument } from '../src/lib/document.js';
import { detectMarker, foldClauses, segmentClauses } from '../src/lib/clauses.js';
import { findByConcept } from '../src/lib/concepts.js';
import { extractParties } from '../src/lib/parties.js';
import { sample } from './helpers/mcpClient.js';

describe('marker detection, English conventions', () => {
  test('reads a decimal sub clause', () => {
    const marker = detectMarker('2.2 Upon expiry of the Initial Term, this Agreement shall renew.');
    assert.equal(marker?.numbering, 'decimal');
    assert.equal(marker?.label, '2.2');
    assert.equal(marker?.depth, 1);
  });

  test('reads a three level decimal clause', () => {
    const marker = detectMarker('1.1.1 The Parties agree as follows.');
    assert.equal(marker?.normalisedLabel, '1.1.1');
    assert.equal(marker?.depth, 2);
  });

  test('reads a top level numbered heading', () => {
    const marker = detectMarker('2. TERM AND RENEWAL');
    assert.equal(marker?.numbering, 'decimal');
    assert.equal(marker?.depth, 0);
    assert.equal(marker?.remainder, 'TERM AND RENEWAL');
  });

  test('reads an unnumbered heading', () => {
    assert.equal(detectMarker('RECITALS')?.numbering, 'heading');
  });

  test('does not promote a sentence that opens with a date', () => {
    // "14 March 2025 was the date..." must not become clause 14.
    assert.equal(
      detectMarker(
        'This Professional Services Agreement is made and entered into on 14 March 2025 by the parties named below and shall bind them accordingly.'
      ),
      null
    );
  });
});

describe('marker detection, Arabic conventions', () => {
  test('reads the article form المادة (٣)', () => {
    const marker = detectMarker('المادة (٣): مدة العقد والتجديد');
    assert.equal(marker?.numbering, 'arabic-article');
    assert.equal(marker?.normalisedLabel, '3');
    assert.equal(marker?.depth, 0);
    assert.equal(marker?.remainder, 'مدة العقد والتجديد');
  });

  test('reads the article form with Western numerals', () => {
    assert.equal(detectMarker('المادة (3): مدة العقد')?.normalisedLabel, '3');
  });

  test('reads a spelled ordinal clause البند الأول', () => {
    const marker = detectMarker('البند الأول: التعريفات');
    assert.equal(marker?.numbering, 'arabic-ordinal');
    assert.equal(marker?.normalisedLabel, '1');
  });

  test('reads a standalone ordinal أولاً', () => {
    const marker = detectMarker('أولاً: شركة الواحة للاستشارات الإدارية');
    assert.equal(marker?.numbering, 'arabic-ordinal');
    assert.equal(marker?.normalisedLabel, '1');
  });

  test('reads the Arabic decimal form written with a hyphen', () => {
    const marker = detectMarker('٣-٢ يتجدد هذا العقد تلقائياً لمدة مماثلة.');
    assert.equal(marker?.numbering, 'arabic-decimal');
    assert.equal(marker?.normalisedLabel, '3.2');
    assert.equal(marker?.depth, 1);
  });

  test('reads a schedule heading الملحق رقم (١)', () => {
    const marker = detectMarker('الملحق رقم (١): بيان الخدمات');
    assert.equal(marker?.numbering, 'arabic-article');
    assert.equal(marker?.normalisedLabel, '1');
  });

  test('reads the unnumbered Arabic preamble heading', () => {
    assert.equal(detectMarker('تمهيد')?.numbering, 'heading');
  });

  test('reads Arabic lettered sub items', () => {
    const marker = detectMarker('ب. إعداد وتقديم ملف تجديد الترخيص السنوي.');
    assert.equal(marker?.numbering, 'lettered');
    assert.equal(marker?.normalisedLabel, '2');
  });
});

describe('segmentation of the sample contracts', () => {
  test('the English contract segments into many clauses, not one', async () => {
    const document = await loadDocument(sample('services-agreement-en.txt'));
    const clauses = segmentClauses(document);
    assert.ok(clauses.length > 30, `expected a segmented contract, got ${clauses.length} clauses`);
    assert.ok(clauses.some((c) => c.label === '2.2'));
  });

  test('the Arabic contract segments into many clauses, not one', async () => {
    // This is the assertion that fails for any splitter written only for
    // English numbering: the whole Arabic contract comes back as one clause.
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    assert.ok(clauses.length > 30, `expected a segmented contract, got ${clauses.length} clauses`);
    assert.ok(clauses.some((c) => c.numbering === 'arabic-article'));
    assert.ok(clauses.some((c) => c.numbering === 'arabic-decimal'));
    assert.ok(clauses.some((c) => c.numbering === 'arabic-ordinal'));
  });

  test('sub clauses are linked to a structural parent', async () => {
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    const sub = clauses.find((c) => c.depth === 1 && c.parentAnchor !== null);
    assert.ok(sub, 'expected at least one linked sub clause');
    const parent = clauses.find((c) => c.anchor === sub.parentAnchor);
    assert.ok(parent, 'parent anchor must resolve to a real clause');
    assert.ok(parent.depth < sub.depth);
  });

  test('every clause anchor is unique and well formed', async () => {
    for (const file of ['services-agreement-en.txt', 'services-agreement-ar.txt']) {
      const document = await loadDocument(sample(file));
      const clauses = segmentClauses(document);
      const anchors = clauses.map((c) => c.anchor);
      assert.equal(new Set(anchors).size, anchors.length, `duplicate anchors in ${file}`);
      for (const anchor of anchors) assert.match(anchor, /^C\d+$/);
    }
  });

  test('clause text is verbatim from the source paragraphs', async () => {
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    const byAnchor = new Map(document.paragraphs.map((p) => [p.anchor, p.text]));

    for (const clause of clauses) {
      for (const anchor of clause.paragraphAnchors) {
        const paragraph = byAnchor.get(anchor);
        assert.ok(paragraph !== undefined, `clause ${clause.anchor} cites unknown ${anchor}`);
        assert.ok(
          clause.text.includes(paragraph),
          `clause ${clause.anchor} text does not contain paragraph ${anchor} verbatim`
        );
      }
    }
  });
});

describe('concept search', () => {
  const cases: Array<{ file: string; concept: Parameters<typeof findByConcept>[2]; expect: RegExp }> = [
    { file: 'services-agreement-en.txt', concept: 'auto_renewal', expect: /automatically renew/i },
    { file: 'services-agreement-en.txt', concept: 'arbitration', expect: /arbitration/i },
    { file: 'services-agreement-en.txt', concept: 'non_compete', expect: /substantially similar/i },
    { file: 'services-agreement-ar.txt', concept: 'auto_renewal', expect: /يتجدد/ },
    { file: 'services-agreement-ar.txt', concept: 'arbitration', expect: /التحكيم/ },
    { file: 'services-agreement-ar.txt', concept: 'penalty', expect: /الشرط الجزائي|غرامة/ },
    { file: 'services-agreement-ar.txt', concept: 'non_compete', expect: /عدم المنافسة|مماثلة/ },
    { file: 'services-agreement-ar.txt', concept: 'governing_law', expect: /القانون/ },
    { file: 'services-agreement-ar.txt', concept: 'confidentiality', expect: /سرية|الإفشاء/ },
  ];

  for (const { file, concept, expect } of cases) {
    test(`${concept} is found in ${file}`, async () => {
      const document = await loadDocument(sample(file));
      const clauses = segmentClauses(document);
      const matches = findByConcept(clauses, foldClauses(clauses), concept, null);
      assert.ok(matches.length > 0, `no clause matched ${concept}`);
      // The top hit is often the section heading, which is the right answer to
      // "where is this dealt with". The operative wording must also come back,
      // because that is what actually gets reviewed.
      assert.ok(
        matches.some((m) => expect.test(m.clause.text)),
        `no match for ${concept} contained the operative wording ${expect}`
      );
      assert.ok(matches[0]!.matchedTerms.length > 0, 'a match must report why it matched');
    });
  }

  test('finds the confidentiality clause despite a tatweel stretched heading', async () => {
    // The Arabic contract heads its confidentiality article "الســـرية", which
    // is the plain word padded with kashida for justification. Matching has to
    // see through that.
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    const matches = findByConcept(clauses, foldClauses(clauses), 'confidentiality', null);
    assert.ok(matches.some((m) => /الســـرية/.test(m.clause.text)));
  });

  test('free text search works in Arabic', async () => {
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const clauses = segmentClauses(document);
    const matches = findByConcept(clauses, foldClauses(clauses), null, 'غرامة تأخير');
    assert.ok(matches.length > 0);
  });

  test('an absent concept returns nothing rather than a weak guess', async () => {
    const document = await loadDocument(sample('services-agreement-en.txt'));
    const clauses = segmentClauses(document);
    const matches = findByConcept(clauses, foldClauses(clauses), 'force_majeure', null);
    assert.equal(matches.length, 0);
  });
});

describe('party extraction', () => {
  test('reads both parties from the English contract', async () => {
    const document = await loadDocument(sample('services-agreement-en.txt'));
    const { parties, signatories } = extractParties(document);

    assert.equal(parties.length, 2);
    assert.equal(parties[0]!.name, 'MERIDIAN COMPLIANCE ADVISORS FZ-LLC');
    assert.equal(parties[0]!.definedTerm, 'Service Provider');
    assert.equal(parties[1]!.definedTerm, 'Client');
    assert.ok(parties[0]!.identifiers.includes('91-447-2210'));

    assert.equal(signatories.length, 2);
    assert.equal(signatories[0]!.name, 'Layla Haddad');
    assert.equal(signatories[0]!.title, 'Managing Director');
  });

  test('reads both parties from the Arabic contract', async () => {
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const { parties, signatories } = extractParties(document);

    assert.equal(parties.length, 2);
    assert.match(parties[0]!.name, /شركة الواحة/);
    assert.equal(parties[0]!.definedTerm, 'مقدم الخدمة');
    assert.equal(parties[0]!.role, 'الطرف الأول');
    assert.equal(parties[1]!.definedTerm, 'العميل');
    assert.equal(parties[1]!.role, 'الطرف الثاني');
  });

  test('reads the Arabic representative named inside the party block', async () => {
    // ويمثلها في التوقيع السيد/ فلان بصفته المدير التنفيذي. In many Arabic
    // contracts this is the only place the signing individual is named.
    const document = await loadDocument(sample('services-agreement-ar.txt'));
    const { signatories } = extractParties(document);

    const karim = signatories.find((s) => s.name.includes('كريم'));
    assert.ok(karim, 'expected the first party representative to be found');
    assert.equal(karim.title, 'المدير التنفيذي');
    assert.equal(karim.source, 'party_block');
    assert.ok(karim.additionalAnchors.length > 0, 'the signature block mention should be merged in');
  });

  test('every party and signatory carries a resolvable anchor', async () => {
    for (const file of ['services-agreement-en.txt', 'services-agreement-ar.txt']) {
      const document = await loadDocument(sample(file));
      const { parties, signatories } = extractParties(document);
      const anchors = new Set(document.paragraphs.map((p) => p.anchor));

      for (const party of parties) assert.ok(anchors.has(party.anchor), `bad anchor ${party.anchor}`);
      for (const signatory of signatories) {
        assert.ok(anchors.has(signatory.anchor));
        for (const extra of signatory.additionalAnchors) assert.ok(anchors.has(extra));
      }
    }
  });
});
