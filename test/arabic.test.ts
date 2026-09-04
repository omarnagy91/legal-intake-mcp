import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deshape,
  foldForMatching,
  foldPreservingOffsets,
  hasPresentationForms,
  normaliseDigits,
  paragraphDirection,
  repairVisualOrder,
  scriptMix,
} from '../src/lib/arabic.js';
import { itemsToLines, type TextItem } from '../src/lib/pdf.js';

describe('Arabic digits', () => {
  test('converts Arabic-Indic digits to ASCII', () => {
    assert.equal(normaliseDigits('١٤٤٦'), '1446');
    assert.equal(normaliseDigits('٣٠ يوم'), '30 يوم');
  });

  test('converts Extended Arabic-Indic (Persian and Urdu) digits', () => {
    assert.equal(normaliseDigits('۱۴۴۶'), '1446');
  });

  test('handles the Arabic thousands and decimal separators', () => {
    assert.equal(normaliseDigits('١٬٢٠٠٬٠٠٠'), '1200000');
    assert.equal(normaliseDigits('٣٫٥'), '3.5');
  });

  test('leaves ASCII digits untouched', () => {
    assert.equal(normaliseDigits('2025-03-14'), '2025-03-14');
  });
});

describe('presentation form repair', () => {
  // Arabic text as a badly configured PDF exporter stores it: every letter
  // written as its joined glyph rather than its base character. This is the
  // exact defect class measured against a real generated PDF during
  // development, reproduced here so the repair path is covered without
  // depending on a particular PDF producer.
  const shaped =
    'ﻱﺕﺝﺩﺩ ﻩﺫﺍ ﺍﻝﻉﻕﺩ ﺕﻝﻕﺍﺉﻱﺍ';

  test('detects presentation forms', () => {
    assert.equal(hasPresentationForms(shaped), true);
    assert.equal(hasPresentationForms('يتجدد هذا العقد'), false);
  });

  test('maps presentation forms back to base Arabic letters', () => {
    assert.equal(deshape(shaped), 'يتجدد هذا العقد تلقائيا');
  });

  test('leaves clean Arabic untouched', () => {
    const clean = 'المادة (٣): مدة العقد والتجديد';
    assert.equal(deshape(clean), clean);
  });

  test('splits the lam alef ligature into two characters', () => {
    // U+FEFB is the isolated lam alef ligature, one codepoint standing for two
    // letters. Left in place it breaks every search for a word containing it.
    assert.equal(deshape('ﻻ'), 'لا');
  });
});

describe('visual order repair', () => {
  const visualOrder =
    'ﺍﻱﺉﺍﻕﻝﺕ ﺩﻕﻉﻝﺍ ﺍﺫﻩ ﺩﺩﺝﺕﻱ';

  test('reverses a line that was extracted right to left', () => {
    const repaired = repairVisualOrder(deshape(visualOrder));
    assert.equal(repaired.repaired, true);
    assert.equal(repaired.text, 'يتجدد هذا العقد تلقائيا');
  });

  test('refuses to reverse text that is already in logical order', () => {
    const logical = 'يلتزم الطرف الأول بأن يقدم للطرف الثاني الخدمات الاستشارية';
    const repaired = repairVisualOrder(logical);
    assert.equal(repaired.repaired, false);
    assert.equal(repaired.text, logical);
  });

  test('leaves Latin text alone', () => {
    const english = 'This Agreement shall commence on 1 April 2025.';
    assert.equal(repairVisualOrder(english).repaired, false);
  });
});

describe('folding for matching', () => {
  test('folds alef variants so spellings match', () => {
    assert.equal(foldForMatching('الأول'), foldForMatching('الاول'));
    assert.equal(foldForMatching('إبريل'), foldForMatching('ابريل'));
    assert.equal(foldForMatching('آذار'), foldForMatching('اذار'));
  });

  test('folds teh marbuta to heh and alef maqsura to yeh', () => {
    assert.equal(foldForMatching('السرية'), foldForMatching('السريه'));
    assert.equal(foldForMatching('جمادى'), foldForMatching('جمادي'));
  });

  test('strips tatweel so a stretched heading still matches', () => {
    // Justified Arabic headings are stretched with kashida. Without stripping
    // it, a search for the plain word fails on the very heading it names.
    assert.equal(foldForMatching('الســـرية'), foldForMatching('السرية'));
  });

  test('strips diacritics', () => {
    assert.equal(foldForMatching('يوماً'), foldForMatching('يوما'));
  });

  test('normalises Arabic digits and punctuation', () => {
    assert.equal(foldForMatching('٦٠'), '60');
    assert.equal(foldForMatching('نعم، لا'), 'نعم, لا');
  });

  test('is case insensitive and collapses whitespace for English', () => {
    assert.equal(foldForMatching('  Automatically   RENEW '), 'automatically renew');
  });
});

describe('offset preserving fold', () => {
  test('keeps the string length so matched spans stay aligned', () => {
    const samples = [
      'المادة (٣): مدة العقد والتجديد',
      'يلتزم الطرف الأول بأن يؤدي الخدمات بالعناية المهنية',
      'تحرر هذا العقد بتاريخ ١٥ رمضان ١٤٤٦هـ الموافق ١٤ مارس ٢٠٢٥م',
      'الســـرية وعدم الإفشاء',
    ];
    for (const s of samples) {
      assert.equal(
        foldPreservingOffsets(s).length,
        s.length,
        `fold changed the length of: ${s}`
      );
    }
  });

  test('still folds hamza carriers and digits', () => {
    assert.equal(foldPreservingOffsets('الأول'), 'الاول');
    assert.equal(foldPreservingOffsets('١٤٤٦'), '1446');
  });
});

describe('script mix', () => {
  test('reports Arabic dominance and right to left direction', () => {
    const mix = scriptMix('يلتزم الطرف الأول بأن يقدم الخدمات الاستشارية الموضحة');
    assert.equal(mix.dominant, 'arabic');
    assert.equal(mix.direction, 'rtl');
    assert.ok(mix.arabicShare > 0.9);
  });

  test('reports Latin dominance and left to right direction', () => {
    const mix = scriptMix('The Service Provider shall provide the Services with reasonable skill.');
    assert.equal(mix.dominant, 'latin');
    assert.equal(mix.direction, 'ltr');
  });

  test('reports a genuinely mixed document as mixed', () => {
    const mix = scriptMix('الطرف الأول Service Provider يلتزم بتقديم the Services المتفق عليها now');
    assert.equal(mix.dominant, 'mixed');
    assert.equal(mix.direction, 'mixed');
  });

  test('ignores digits and punctuation when measuring', () => {
    // Digits are script neutral. Counting them would drag any contract full of
    // figures toward whichever script the numerals were written in.
    const mix = scriptMix('العقد ١٢٣٤٥٦٧٨٩٠ ٢٠٢٥ ٣١/٠٣/٢٠٢٦');
    assert.equal(mix.dominant, 'arabic');
  });

  test('per paragraph direction is computed independently', () => {
    assert.equal(paragraphDirection('المادة (٣): مدة العقد'), 'rtl');
    assert.equal(paragraphDirection('2. TERM AND RENEWAL'), 'ltr');
  });
});

describe('PDF line reconstruction', () => {
  // These items reproduce, field for field, what pdf.js returned for the first
  // dated line of a real Arabic PDF generated during development. A PDF stores
  // runs by position, so the runs of a right to left line arrive left to right,
  // which is the reverse of reading order.
  const arabicLine: TextItem[] = [
    { str: '٢٠٢٥م', transform: [0, 0, 0, 0, 192.5, 728.7], width: 28.8, height: 11.5, dir: 'rtl' },
    { str: ' ', transform: [0, 0, 0, 0, 221.4, 728.7], width: 4.8, height: 11.5, dir: 'ltr' },
    { str: 'مارس', transform: [0, 0, 0, 0, 225.0, 728.7], width: 22.5, height: 11.5, dir: 'rtl' },
    { str: ' ', transform: [0, 0, 0, 0, 247.5, 728.7], width: 4.8, height: 11.5, dir: 'ltr' },
    { str: '١٤', transform: [0, 0, 0, 0, 251.1, 728.7], width: 12.1, height: 11.5, dir: 'rtl' },
    { str: ' ', transform: [0, 0, 0, 0, 263.2, 728.7], width: 4.8, height: 11.5, dir: 'ltr' },
    { str: 'رمضان', transform: [0, 0, 0, 0, 331.5, 728.7], width: 28.8, height: 11.5, dir: 'rtl' },
    { str: ' ', transform: [0, 0, 0, 0, 360.4, 728.7], width: 4.8, height: 11.5, dir: 'ltr' },
    { str: '١٥', transform: [0, 0, 0, 0, 363.9, 728.7], width: 12.1, height: 11.5, dir: 'rtl' },
    { str: ' ', transform: [0, 0, 0, 0, 376.0, 728.7], width: 4.8, height: 11.5, dir: 'ltr' },
    { str: 'تحرر هذا العقد بتاريخ', transform: [0, 0, 0, 0, 379.6, 728.7], width: 158.7, height: 11.5, dir: 'rtl' },
  ];

  test('orders right to left runs into reading order', () => {
    const lines = itemsToLines(arabicLine);
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.text, 'تحرر هذا العقد بتاريخ ١٥ رمضان ١٤ مارس ٢٠٢٥م');
  });

  test('leaves left to right runs in emission order', () => {
    const englishLine: TextItem[] = [
      { str: 'This Agreement', transform: [0, 0, 0, 0, 57.0, 728.7], width: 70, height: 11.5, dir: 'ltr' },
      { str: ' commences on ', transform: [0, 0, 0, 0, 127.0, 728.7], width: 70, height: 11.5, dir: 'ltr' },
      { str: '1 April 2025', transform: [0, 0, 0, 0, 197.0, 728.7], width: 60, height: 11.5, dir: 'ltr' },
    ];
    const lines = itemsToLines(englishLine);
    assert.equal(lines[0]!.text, 'This Agreement commences on 1 April 2025');
  });

  test('separates runs onto different lines by baseline', () => {
    const twoLines: TextItem[] = [
      { str: 'first line', transform: [0, 0, 0, 0, 57.0, 728.7], width: 50, height: 11.5, dir: 'ltr' },
      { str: 'second line', transform: [0, 0, 0, 0, 57.0, 709.2], width: 50, height: 11.5, dir: 'ltr' },
    ];
    assert.equal(itemsToLines(twoLines).length, 2);
  });
});
