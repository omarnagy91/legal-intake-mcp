/**
 * Legal concept search.
 *
 * The point of this module is that the model should never have to guess which
 * clause is the termination clause from a summary. It asks for a concept, gets
 * the real clauses back with anchors, and reads the actual words the parties
 * agreed to.
 *
 * Every term is written here in natural Arabic or English and folded with the
 * same function that folds the document, so a term written with a hamza, a
 * tatweel or Arabic-Indic digits still matches a document that spells it
 * differently. Nothing in this file needs to be hand normalised, which is what
 * keeps the lexicon maintainable by a lawyer rather than only by its author.
 */
import { foldForMatching } from './arabic.js';
import type { Clause, LegalConcept } from './types.js';

type ConceptDefinition = {
  /** Short description of what the concept covers, returned to the caller. */
  description: string;
  /** Terms that on their own strongly indicate the concept. */
  strong: string[];
  /** Terms that support a match but are too common to carry it alone. */
  supporting: string[];
};

const LEXICON: Record<LegalConcept, ConceptDefinition> = {
  auto_renewal: {
    description: 'Clauses that renew the agreement without a fresh signature unless notice is given.',
    strong: [
      'automatically renew',
      'automatic renewal',
      'auto-renewal',
      'successive periods',
      'renewal term',
      'non-renewal',
      'يتجدد تلقائياً',
      'التجديد التلقائي',
      'يتجدد هذا العقد تلقائياً',
      'لمدد مماثلة',
      'عدم التجديد',
    ],
    supporting: ['renew', 'unless either party gives', 'يتجدد', 'التجديد', 'المدة السارية'],
  },
  unilateral_termination: {
    description:
      'Clauses letting one party end the agreement on its own, for convenience or with immediate effect.',
    strong: [
      'for convenience',
      'with immediate effect',
      'without liability',
      'terminate this agreement',
      'بإرادته المنفردة',
      'دون إبداء أسباب',
      'فسخ هذا العقد',
      'إنهاء هذا العقد',
      'دون تنبيه أو إنذار',
    ],
    supporting: [
      'may terminate',
      'termination',
      'insolvent',
      'الإنهاء',
      'الفسخ',
      'يفسخ',
      'إفلاس',
      'يجوز لأي من الطرفين',
    ],
  },
  penalty: {
    description: 'Liquidated damages, late payment interest and penalty clauses.',
    strong: [
      'liquidated damages',
      'penalty',
      'pre-estimate of the loss',
      'interest at the rate',
      'الشرط الجزائي',
      'غرامة تأخير',
      'فائدة تأخير',
      'شرطاً تحكمياً',
      'تقديراً حقيقياً للضرر',
    ],
    supporting: ['for each day of delay', 'per month', 'غرامة', 'عن كل يوم تأخير', 'بحد أقصى'],
  },
  governing_law: {
    description: 'The law the contract is subject to.',
    strong: [
      'governed by and construed in accordance with',
      'governing law',
      'shall be governed by',
      'القانون الواجب التطبيق',
      'يخضع هذا العقد',
      'لأحكام القانون',
    ],
    supporting: ['laws of', 'jurisdiction', 'القانون المصري', 'القانون المدني'],
  },
  arbitration: {
    description: 'Arbitration agreements, seat, rules and tribunal composition.',
    strong: [
      'arbitration',
      'arbitral',
      'arbitrator',
      'rules of arbitration',
      'seat of the arbitration',
      'التحكيم',
      'هيئة التحكيم',
      'محكم',
    ],
    supporting: ['finally settled', 'dispute', 'يسوى أي نزاع', 'مقر التحكيم', 'لغة التحكيم'],
  },
  confidentiality: {
    description: 'Confidentiality, non-disclosure and survival of those obligations.',
    strong: [
      'confidential information',
      'strictly confidential',
      'shall not disclose',
      'السرية',
      'عدم الإفشاء',
      'المحافظة على سرية',
      'بعدم إفشائها',
    ],
    supporting: ['disclosing party', 'prior written consent', 'سرية', 'موافقة كتابية مسبقة'],
  },
  non_compete: {
    description: 'Restraints on competing and on soliciting the other side staff or clients.',
    strong: [
      'non-compete',
      'non-solicitation',
      'shall not solicit',
      'services substantially similar',
      'solicit for employment',
      'عدم المنافسة',
      'عدم استقطاب',
      'خدمات مماثلة في جوهرها',
      'بعدم استقطاب أو توظيف',
    ],
    supporting: ['following its expiry', 'restraint', 'لا يقدم خدمات مماثلة', 'طوال مدة العقد'],
  },
  limitation_of_liability: {
    description: 'Liability caps and exclusions of indirect loss.',
    strong: [
      'limitation of liability',
      'total aggregate liability',
      'shall not exceed',
      'indirect, consequential',
      'حدود المسؤولية',
      'المسؤولية الإجمالية',
      'الأضرار غير المباشرة',
      'لا تتجاوز المسؤولية',
    ],
    supporting: ['loss of profit', 'loss of business', 'الكسب الفائت', 'فوات الفرصة'],
  },
  notice: {
    description: 'How formal notices must be given and to where.',
    strong: [
      'any notice under this agreement',
      'shall be in writing and shall be delivered',
      'notices to the',
      'الإخطارات',
      'يكون كل إخطار',
      'إخطار كتابي',
    ],
    supporting: ['delivered by hand', 'courier', 'يسلم باليد', 'البريد المسجل', 'البريد الإلكتروني'],
  },
  payment_terms: {
    description: 'Fees, invoicing and when money is due.',
    strong: [
      'fees and payment',
      'shall pay the service provider',
      'payable within',
      'quarterly instalments',
      'الأتعاب وطريقة السداد',
      'أتعاباً سنوية',
      'تستحق كل فاتورة',
      'أقساط ربع سنوية',
    ],
    supporting: ['invoice', 'fee', 'فاتورة', 'السداد', 'الأتعاب'],
  },
  force_majeure: {
    description: 'Events beyond the parties control that suspend or excuse performance.',
    strong: ['force majeure', 'act of god', 'beyond the reasonable control', 'القوة القاهرة', 'الظروف القاهرة'],
    supporting: ['unforeseeable', 'خارجة عن إرادة', 'حادث مفاجئ'],
  },
  assignment: {
    description: 'Whether a party may transfer the contract or its rights.',
    strong: ['shall not assign', 'assignment', 'transfer its rights', 'التنازل عن هذا العقد', 'حوالة الحق'],
    supporting: ['novation', 'sub-contract', 'التنازل', 'الحلول'],
  },
  entire_agreement: {
    description: 'Clauses making the document the whole of the bargain.',
    strong: [
      'entire agreement',
      'supersedes all prior',
      'كامل الاتفاق',
      'يلغي كل ما سبقه',
      'يمثل هذا العقد كامل الاتفاق',
    ],
    supporting: ['prior negotiations', 'مفاوضات', 'اتفاقات شفهية'],
  },
};

export const CONCEPTS = Object.keys(LEXICON) as LegalConcept[];

export function conceptDescription(concept: LegalConcept): string {
  return LEXICON[concept].description;
}

/** Terms are folded once at module load, not on every search. */
const FOLDED: Record<string, { strong: Array<[string, string]>; supporting: Array<[string, string]> }> = {};
for (const [name, definition] of Object.entries(LEXICON)) {
  FOLDED[name] = {
    strong: definition.strong.map((t) => [t, foldForMatching(t)] as [string, string]),
    supporting: definition.supporting.map((t) => [t, foldForMatching(t)] as [string, string]),
  };
}

export type ConceptMatch = {
  clause: Clause;
  score: number;
  /** Terms that matched, in their original spelling, for auditability. */
  matchedTerms: string[];
};

const STRONG_WEIGHT = 3;
const SUPPORTING_WEIGHT = 1;

/**
 * Score every clause against a concept, or against free text when the caller
 * asks for something the lexicon does not cover.
 *
 * A clause's own heading is worth more than its body, because a clause headed
 * "CONFIDENTIALITY" is the confidentiality clause even when another clause
 * merely mentions confidential information in passing.
 */
export function findByConcept(
  clauses: Clause[],
  foldedClauses: Map<string, string>,
  concept: LegalConcept | null,
  freeText: string | null
): ConceptMatch[] {
  const strong: Array<[string, string]> = [];
  const supporting: Array<[string, string]> = [];

  if (concept && FOLDED[concept]) {
    strong.push(...FOLDED[concept]!.strong);
    supporting.push(...FOLDED[concept]!.supporting);
  }
  if (freeText) {
    const trimmed = freeText.trim();
    if (trimmed !== '') strong.push([trimmed, foldForMatching(trimmed)]);
  }
  if (strong.length === 0 && supporting.length === 0) return [];

  const matches: ConceptMatch[] = [];
  const headingByAnchor = new Map(clauses.map((c) => [c.anchor, c.heading]));

  for (const clause of clauses) {
    const own = foldedClauses.get(clause.anchor) ?? '';
    if (own === '') continue;

    // A sub clause inherits its section heading for search purposes. Clause 7.1
    // never says "non-compete", it just says what the restraint is; the word is
    // in the heading of clause 7 above it. Without this, a search for the
    // concept returns the heading and misses the operative wording underneath.
    const parentHeading = clause.parentAnchor ? headingByAnchor.get(clause.parentAnchor) ?? null : null;
    const foldedParentHeading = parentHeading ? foldForMatching(parentHeading) : '';
    const searchText = foldedParentHeading === '' ? own : `${own} ${foldedParentHeading}`;

    // The heading bonus applies only to the clause's own heading, so the
    // section header still outranks the clauses beneath it.
    const foldedHeading = clause.heading ? foldForMatching(clause.heading) : '';

    let score = 0;
    const matchedTerms: string[] = [];

    for (const [original, term] of strong) {
      if (term !== '' && searchText.includes(term)) {
        score += STRONG_WEIGHT;
        if (foldedHeading !== '' && foldedHeading.includes(term)) score += STRONG_WEIGHT;
        matchedTerms.push(original);
      }
    }
    for (const [original, term] of supporting) {
      if (term !== '' && searchText.includes(term)) {
        score += SUPPORTING_WEIGHT;
        matchedTerms.push(original);
      }
    }

    if (score > 0) matches.push({ clause, score, matchedTerms });
  }

  return matches.sort((a, b) => b.score - a.score || a.clause.index - b.clause.index);
}

/**
 * Concepts a reviewer usually wants flagged on a first pass, because each one
 * can bind a client in a way they did not intend.
 */
export const FLAG_CONCEPTS: LegalConcept[] = [
  'auto_renewal',
  'unilateral_termination',
  'penalty',
  'non_compete',
  'limitation_of_liability',
  'arbitration',
];
