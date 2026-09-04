/**
 * Party and signatory extraction.
 *
 * The two drafting traditions place the same information in different shapes.
 * An English contract opens a numbered recital per party and names it with a
 * defined term in brackets. An Arabic contract opens each party with an ordinal
 * and names it at the end of the block with the ويشار إليه formula, and it
 * usually names the individual signing and their capacity inside the same
 * paragraph rather than only in a signature block at the end.
 *
 * Both shapes are read here, and every party and signatory carries the anchor
 * of the paragraph it came from so a reviewer can check the extraction against
 * the document in one step.
 */
import { foldPreservingOffsets } from './arabic.js';
import type { LoadedDocument, Paragraph, Party, Signatory } from './types.js';

/** Legal form suffixes that mark a paragraph as naming an entity. */
const ENTITY_CUES =
  /\b(llc|l\.l\.c|ltd|limited|inc|incorporated|corporation|company|fz-llc|fze|plc|s\.a\.e|sae|gmbh|est|establishment)\b|شركة|مؤسسة|منشأة|جمعية|هيئة|مكتب/iu;

function isEnglishParagraph(paragraph: Paragraph): boolean {
  return paragraph.direction === 'ltr';
}

/* ------------------------------------------------------------------ */
/* Parties                                                             */
/* ------------------------------------------------------------------ */

function extractEnglishParty(paragraph: Paragraph): Party | null {
  const text = paragraph.text.trim();

  // "(1) MERIDIAN COMPLIANCE ADVISORS FZ-LLC, a free zone limited liability..."
  const opener = /^\((\d+)\)\s*(.+?),\s+(?:an?|the)\s/u.exec(text);
  if (!opener) return null;
  if (!ENTITY_CUES.test(text)) return null;

  const name = (opener[2] ?? '').trim();
  if (name === '') return null;

  // The defined term is the last bracketed quotation in the block, since the
  // block normally ends "... (the "Client")".
  let definedTerm: string | null = null;
  for (const m of text.matchAll(/\(\s*(?:the|each|together)?\s*[""]([^""]{2,60})[""]\s*\)/gu)) {
    definedTerm = (m[1] ?? '').trim();
  }

  const identifiers: string[] = [];
  for (const m of text.matchAll(
    /\b(?:commercial\s+licence|commercial\s+license|licence|license|commercial\s+register|registration|company)\s+number\s+([A-Za-z0-9][A-Za-z0-9/-]{2,30})/giu
  )) {
    const value = (m[1] ?? '').replace(/[.,;]$/, '');
    if (value !== '') identifiers.push(value);
  }

  const addressMatch = /registered\s+office\s+at\s+(.+?)(?:\s*\(\s*(?:the|each)|\s*;|\s*\.\s*$|$)/iu.exec(text);

  return {
    name,
    definedTerm,
    role: `party ${opener[1]}`,
    identifiers,
    address: addressMatch?.[1]?.trim().replace(/[.,;]$/, '') ?? null,
    anchor: paragraph.anchor,
    page: paragraph.page,
    language: 'en',
  };
}

/**
 * Built by folding the ordinals rather than by writing them out, because this
 * pattern is matched against folded text. Writing "أولاً" literally here would
 * never match, since folding has already turned its alef hamza into a bare alef
 * and its fatha into a space.
 */
const AR_ORDINAL_OPENER = new RegExp(
  `^(${['أولا', 'ثانيا', 'ثالثا', 'رابعا', 'خامسا'].map((o) => foldPreservingOffsets(o).trim()).join('|')})\\s*[:؛،]\\s*(.+)$`,
  'u'
);

/**
 * The registered address formula, ومقرها الرئيسي <address>، ويمثلها ...
 *
 * Built by folding its literals for the same reason as the ordinal pattern
 * above. "الرئيسي" contains a yeh with hamza, which folding turns into a plain
 * yeh, so the literal spelling would never match and the capture would swallow
 * the word it was meant to skip.
 */
const AR_ADDRESS = new RegExp(
  `${foldPreservingOffsets('ومقرها')}(?:\\s+${foldPreservingOffsets('الرئيسي')})?\\s+([^،]+(?:،[^،]+){0,3}?)،\\s*(?:${foldPreservingOffsets('ويمثلها')}|${foldPreservingOffsets('ويمثله')}|${foldPreservingOffsets('ويشار')})`,
  'u'
);

function extractArabicParty(paragraph: Paragraph): Party | null {
  const text = paragraph.text.trim();
  const folded = foldPreservingOffsets(text);

  const opener = AR_ORDINAL_OPENER.exec(foldPreservingOffsets(text));
  if (!opener) return null;
  if (!ENTITY_CUES.test(text)) return null;

  // The name runs from after the ordinal marker to the first Arabic comma,
  // which is where the descriptive clause about incorporation begins.
  const afterOrdinal = text.slice(text.length - (opener[2] ?? '').length);
  const commaIndex = afterOrdinal.search(/[،,]/u);
  const name = (commaIndex === -1 ? afterOrdinal : afterOrdinal.slice(0, commaIndex)).trim();
  if (name === '') return null;

  // Defined terms come from the ويشار إليها فيما بعد بـ "..." formula.
  const definedTerms: string[] = [];
  for (const m of text.matchAll(/[""]([^""]{2,40})[""]/gu)) {
    const value = (m[1] ?? '').trim();
    if (value !== '') definedTerms.push(value);
  }

  // The ordinal party label, الطرف الأول and so on, is the contract's own role
  // name and is more useful than a positional index.
  const roleMatch = /(الطرف\s+(?:الاول|الثاني|الثالث|الرابع))/u.exec(folded);
  let role: string | null = null;
  if (roleMatch && roleMatch.index !== undefined) {
    role = text.slice(roleMatch.index, roleMatch.index + roleMatch[1]!.length).trim();
  }

  const identifiers: string[] = [];
  for (const m of folded.matchAll(/(?:رقم|تحت رقم)\s+([0-9]{4,20})/gu)) {
    const value = (m[1] ?? '').trim();
    if (value !== '') identifiers.push(value);
  }

  const addressMatch = AR_ADDRESS.exec(folded);
  let address: string | null = null;
  if (addressMatch && addressMatch.index !== undefined) {
    const start = folded.indexOf(addressMatch[1] ?? '', addressMatch.index);
    if (start !== -1) address = text.slice(start, start + (addressMatch[1] ?? '').length).trim();
  }

  const definedTerm =
    definedTerms.find((t) => !/^الطرف/u.test(foldPreservingOffsets(t))) ?? definedTerms[0] ?? null;

  return {
    name,
    definedTerm,
    role,
    identifiers,
    address,
    anchor: paragraph.anchor,
    page: paragraph.page,
    language: 'ar',
  };
}

/* ------------------------------------------------------------------ */
/* Signatories                                                         */
/* ------------------------------------------------------------------ */

const FIELD_LABEL = /(name|title|position|date|الاسم|الصفه|المنصب|التاريخ)\s*:/giu;

/**
 * Read labelled fields out of one paragraph.
 *
 * The same signature block arrives in two different shapes depending on the
 * source format. A .docx or a .pdf keeps each field on its own line, so each
 * becomes its own paragraph. A plain text file separates blocks by blank lines,
 * so the three field lines collapse into a single paragraph reading
 * "Name: X Title: Y Date: Z". Scanning for every label and taking each value up
 * to the next label handles both without caring which one it is looking at.
 */
function parseLabelledFields(original: string): Map<string, string> {
  const folded = foldPreservingOffsets(original);
  const hits: Array<{ key: string; labelStart: number; valueStart: number }> = [];

  for (const m of folded.matchAll(FIELD_LABEL)) {
    const label = (m[1] ?? '').toLowerCase();
    const key =
      label === 'name' || label === 'الاسم'
        ? 'name'
        : label === 'date' || label === 'التاريخ'
          ? 'date'
          : 'title';
    hits.push({ key, labelStart: m.index ?? 0, valueStart: (m.index ?? 0) + m[0].length });
  }

  const fields = new Map<string, string>();
  for (let i = 0; i < hits.length; i++) {
    const hit = hits[i]!;
    const end = i + 1 < hits.length ? hits[i + 1]!.labelStart : original.length;
    const value = original.slice(hit.valueStart, end).trim().replace(/[،,;]$/u, '');
    if (value !== '' && !fields.has(hit.key)) fields.set(hit.key, value);
  }
  return fields;
}

/**
 * Read a signature block: a header naming the entity, followed by labelled
 * fields that may be spread over several paragraphs or packed into one.
 */
function readSignatureBlock(
  paragraphs: Paragraph[],
  start: number,
  onBehalfOf: string | null,
  language: 'ar' | 'en'
): Signatory | null {
  const fields = new Map<string, string>();

  for (let i = start + 1; i < Math.min(paragraphs.length, start + 6); i++) {
    const found = parseLabelledFields(paragraphs[i]!.text.trim());
    if (found.size === 0) {
      if (fields.size > 0) break;
      continue;
    }
    for (const [key, value] of found) if (!fields.has(key)) fields.set(key, value);
  }

  const name = fields.get('name');
  if (!name) return null;

  return {
    name,
    title: fields.get('title') ?? null,
    onBehalfOf,
    date: fields.get('date') ?? null,
    anchor: paragraphs[start]!.anchor,
    additionalAnchors: [],
    source: 'signature_block',
    page: paragraphs[start]!.page,
    language,
  };
}

/**
 * The in paragraph representative formula, ويمثلها في التوقيع السيد/ فلان
 * بصفته المدير التنفيذي. Arabic contracts routinely name the signatory here
 * and nowhere else, so a reader that only looks at the end of the document
 * misses who actually bound the company.
 */
function extractArabicRepresentative(paragraph: Paragraph, partyName: string | null): Signatory | null {
  const text = paragraph.text;
  const folded = foldPreservingOffsets(text);

  const match = /ويمثل(?:ها|ه)\s+في\s+التوقيع[^\.]*?السيد(?:ه)?\s*\/\s*([^،\.]{3,60}?)\s+بصفت(?:ه|ها)\s+([^،\.]{3,60})/u.exec(
    folded
  );
  if (!match || match.index === undefined) return null;

  const nameStart = folded.indexOf(match[1] ?? '', match.index);
  const titleStart = folded.indexOf(match[2] ?? '', nameStart + (match[1] ?? '').length);
  if (nameStart === -1 || titleStart === -1) return null;

  return {
    name: text.slice(nameStart, nameStart + (match[1] ?? '').length).trim(),
    title: text.slice(titleStart, titleStart + (match[2] ?? '').length).trim(),
    onBehalfOf: partyName,
    date: null,
    anchor: paragraph.anchor,
    additionalAnchors: [],
    source: 'party_block',
    page: paragraph.page,
    language: 'ar',
  };
}

export type PartyExtraction = {
  parties: Party[];
  signatories: Signatory[];
  notes: string[];
};

export function extractParties(document: LoadedDocument): PartyExtraction {
  const parties: Party[] = [];
  const signatories: Signatory[] = [];
  const notes: string[] = [];
  const paragraphs = document.paragraphs;

  for (const paragraph of paragraphs) {
    const party = isEnglishParagraph(paragraph)
      ? extractEnglishParty(paragraph)
      : extractArabicParty(paragraph);
    if (party) {
      parties.push(party);
      const representative = extractArabicRepresentative(paragraph, party.name);
      if (representative) signatories.push(representative);
    }
  }

  for (let i = 0; i < paragraphs.length; i++) {
    const paragraph = paragraphs[i]!;
    const text = paragraph.text.trim();

    // "SIGNED for and on behalf of MERIDIAN COMPLIANCE ADVISORS FZ-LLC"
    const englishHeader = /^signed\s+(?:for\s+and\s+)?on\s+behalf\s+of\s+(.+)$/iu.exec(text);
    if (englishHeader) {
      const block = readSignatureBlock(paragraphs, i, (englishHeader[1] ?? '').trim(), 'en');
      if (block) signatories.push(block);
      continue;
    }

    // "توقيع الطرف الأول: شركة الواحة للاستشارات الإدارية"
    const arabicHeader = /^توقيع\s+(?:الطرف\s+\S+)\s*:\s*(.+)$/u.exec(foldPreservingOffsets(text));
    if (arabicHeader) {
      const separator = text.indexOf(':');
      const onBehalfOf = separator === -1 ? null : text.slice(separator + 1).trim();
      const block = readSignatureBlock(paragraphs, i, onBehalfOf, 'ar');
      if (block) signatories.push(block);
    }
  }

  const merged = mergeSignatories(signatories);

  if (parties.length === 0) {
    notes.push(
      'No party block was recognised. The document may use an unusual opening, or the parties may be named only in a schedule.'
    );
  }
  if (parties.length === 1) {
    notes.push('Only one party was recognised, which is unusual for a contract. Check the opening block.');
  }
  if (merged.length === 0) {
    notes.push('No signatory was recognised. The document may be an unsigned draft.');
  }

  return { parties, signatories: merged, notes };
}

/**
 * An Arabic contract names its signatories twice, once in the party block and
 * once in the signature block at the end. Both mentions are real and both are
 * worth citing, so they are merged into one person carrying every anchor rather
 * than reported as two people or silently deduplicated down to one mention.
 */
function mergeSignatories(signatories: Signatory[]): Signatory[] {
  const byPerson = new Map<string, Signatory>();

  for (const signatory of signatories) {
    const key = foldPreservingOffsets(signatory.name).replace(/\s+/gu, ' ').trim();
    const existing = byPerson.get(key);
    if (!existing) {
      byPerson.set(key, { ...signatory, additionalAnchors: [...signatory.additionalAnchors] });
      continue;
    }
    existing.additionalAnchors.push(signatory.anchor);
    existing.title = existing.title ?? signatory.title;
    existing.date = existing.date ?? signatory.date;
    existing.onBehalfOf = existing.onBehalfOf ?? signatory.onBehalfOf;
  }

  return [...byPerson.values()];
}
