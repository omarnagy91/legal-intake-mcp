import type { ScriptMix } from './arabic.js';

export type DocumentFormat = 'pdf' | 'docx' | 'text';

/**
 * One paragraph of the source document.
 *
 * `anchor` is the citation handle. It is stable for a given file, identical in
 * every tool that reports this paragraph, and is what a model should quote so a
 * lawyer can find the text again.
 */
export type Paragraph = {
  /** Citation handle, for example "P12". */
  anchor: string;
  /** One based position of this paragraph in the document. */
  index: number;
  /** Source page, when the format carries pagination. Null for text and docx. */
  page: number | null;
  /** Verbatim paragraph text. */
  text: string;
  /** Rendering direction for this block, computed from its own script mix. */
  direction: 'rtl' | 'ltr';
};

export type LoadedDocument = {
  path: string;
  format: DocumentFormat;
  byteSize: number;
  pageCount: number | null;
  paragraphCount: number;
  characterCount: number;
  paragraphs: Paragraph[];
  languageMix: ScriptMix;
  /**
   * Repairs applied to the extracted text, each one an encoding defect in the
   * source rather than an editorial change. Empty when the source was clean.
   */
  normalisations: string[];
  warnings: string[];
};

export type Clause = {
  /** Citation handle, for example "C14". Unique and stable within the file. */
  anchor: string;
  /** One based position of this clause in the document. */
  index: number;
  /**
   * The clause label exactly as the document writes it, for example "2.2",
   * "المادة (٣)" or "أولاً". Null for an unnumbered block such as a recital.
   */
  label: string | null;
  /** Label reduced to ASCII digits and dots, for example "2.2" or "3-2". */
  normalisedLabel: string | null;
  /** Numbering convention that produced the label. */
  numbering:
    | 'decimal'
    | 'arabic-article'
    | 'arabic-decimal'
    | 'arabic-ordinal'
    | 'roman'
    | 'lettered'
    | 'heading'
    | 'none';
  /** Heading text when the clause opens with one. */
  heading: string | null;
  /** Full verbatim text of the clause, headings included. */
  text: string;
  /** Anchors of every paragraph this clause covers. */
  paragraphAnchors: string[];
  page: number | null;
  direction: 'rtl' | 'ltr';
  /** Anchor of the parent clause when this is a sub clause. */
  parentAnchor: string | null;
  /** Nesting depth, 0 for a top level clause. */
  depth: number;
};

export type LegalConcept =
  | 'auto_renewal'
  | 'unilateral_termination'
  | 'penalty'
  | 'governing_law'
  | 'arbitration'
  | 'confidentiality'
  | 'non_compete'
  | 'limitation_of_liability'
  | 'notice'
  | 'payment_terms'
  | 'force_majeure'
  | 'assignment'
  | 'entire_agreement';

export type CalendarSystem = 'gregorian' | 'hijri';

export type DateRole =
  | 'execution'
  | 'effective'
  | 'commencement'
  | 'term_end'
  | 'expiry'
  | 'renewal'
  | 'notice'
  | 'payment'
  | 'delivery'
  | 'signature'
  | 'unclassified';

export type ExtractedDate = {
  /** The date exactly as written in the document. */
  raw: string;
  calendar: CalendarSystem;
  /** ISO 8601 date. For a Hijri source this is the tabular conversion. */
  iso: string | null;
  /** Hijri components when the source date is Hijri. */
  hijri: { year: number; month: number; day: number; monthName: string } | null;
  role: DateRole;
  /** Why the role was assigned, quoting the trigger found near the date. */
  roleEvidence: string | null;
  anchor: string;
  clauseAnchor: string | null;
  page: number | null;
  /** Set when a Hijri date states its own Gregorian equivalent in the text. */
  statedGregorian?: string | null;
  notes: string[];
};

export type ComputedDeadline = {
  /** Plain language description of what the deadline is. */
  description: string;
  /** The period as written, for example "sixty (60) days". */
  period: string;
  days: number;
  direction: 'before' | 'after';
  /** ISO date the period is measured from. */
  anchorDate: string;
  /** What the anchor date is, for example "term_end". */
  anchorDateRole: DateRole;
  /** ISO date the action falls due. */
  deadline: string;
  clauseAnchor: string;
  paragraphAnchor: string;
  notes: string[];
};

export type Party = {
  name: string;
  /** Defined term the contract uses for this party, for example "the Client". */
  definedTerm: string | null;
  /** Ordinal role in the contract, for example "party 1" or "الطرف الأول". */
  role: string | null;
  /** Registration or licence identifiers found in the party block. */
  identifiers: string[];
  /** Registered address, when the party block states one. */
  address: string | null;
  anchor: string;
  page: number | null;
  language: 'ar' | 'en';
};

export type Signatory = {
  name: string;
  title: string | null;
  /** Party this person signs for, matched to a party name when possible. */
  onBehalfOf: string | null;
  date: string | null;
  anchor: string;
  /** Further anchors where the same person is named, if any. */
  additionalAnchors: string[];
  /** Where the mention was found. */
  source: 'party_block' | 'signature_block';
  page: number | null;
  language: 'ar' | 'en';
};
