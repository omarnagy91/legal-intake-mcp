#!/usr/bin/env node
/**
 * legal-intake-mcp
 *
 * An MCP server for law firm document intake, Arabic and English.
 *
 * The division of labour is deliberate. This server does the deterministic
 * work: it parses the file, normalises the text, segments clauses, resolves
 * calendars and computes date arithmetic, and returns structured context with a
 * citation anchor on every item. The connected model does the legal reasoning,
 * against the real clause text rather than a summary of it.
 *
 * That is why the server needs no API key and makes no network call. It is also
 * the reason its output can be checked: everything it returns points back at a
 * specific paragraph of the source file.
 */
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';

import { loadDocument } from './lib/document.js';
import { foldClauses, segmentClauses } from './lib/clauses.js';
import { extractDates } from './lib/dates.js';
import { extractParties } from './lib/parties.js';
import { CONCEPTS, FLAG_CONCEPTS, conceptDescription, findByConcept } from './lib/concepts.js';
import { foldForMatching } from './lib/arabic.js';
import type { Clause, LegalConcept } from './lib/types.js';

const SAFETY_LINE =
  'This server extracts and cites. It does not give legal advice, does not decide anything, and ' +
  'does not judge whether a clause is fair or enforceable. Every item it returns carries an anchor ' +
  'pointing at the exact paragraph of the source document it came from, so a qualified lawyer can ' +
  'verify each one against the original before relying on it.';

const SERVER_INSTRUCTIONS = `legal-intake-mcp turns a contract file into structured, citable context for review, in Arabic and English.

${SAFETY_LINE}

How to use it well:
  1. Call load_document first to see the format, the page and paragraph count and the language mix.
  2. Call segment_clauses to get the clause structure with a stable anchor on each clause.
  3. Call find_clauses with a legal concept to pull the real text of the clauses that matter, then
     read that text yourself rather than trusting any summary of it.
  4. Cite anchors in your answer. "C12" is a clause, "P34" is a paragraph. Quote them so the reader
     can find the wording in the source file.

Arabic handling is first class. Arabic-Indic and Persian digits, tatweel, diacritics, alef and teh
marbuta variants, Hijri dates, and Arabic clause numbering conventions (المادة (٣), البند الأول,
أولاً, ٣-٢) are all handled. Text returned to you is verbatim from the source. The only changes ever
applied are repairs to encoding defects in the file itself, such as Arabic presentation form glyphs
or text stored in visual order, and any repair that fires is listed in the document's
"normalisations" field.

Hijri to Gregorian conversion uses the tabular civil calendar, which can differ by a day from the
sighting based calendar actually applied by a court or ministry. Conversions are labelled, and where
the contract states its own Gregorian equivalent that stated value is preserved and any divergence
is flagged rather than resolved silently.`;

/* ------------------------------------------------------------------ */
/* Tool definitions                                                    */
/* ------------------------------------------------------------------ */

const pathProperty = {
  type: 'string' as const,
  description:
    'Path to the document. Accepts .pdf, .docx or a plain text file (.txt, .md). Absolute paths ' +
    'are safest. The format is detected from the file content, not the extension.',
};

const TOOLS: Tool[] = [
  {
    name: 'load_document',
    description:
      'Load a contract and return its normalised text with a citation anchor on every paragraph, ' +
      'plus the detected language mix. Start here. Returns the format, page count where the format ' +
      'has pages, per paragraph text direction for correct rendering of mixed Arabic and English, ' +
      'any encoding repairs that were applied, and any warnings such as a PDF with a lossy or ' +
      'missing text layer. Paragraph anchors look like "P12" and are the same anchors every other ' +
      'tool reports.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProperty,
        includeText: {
          type: 'boolean',
          description:
            'Include the full text of every paragraph. Default true. Set false for a structural ' +
            'overview of a long document without the body text.',
          default: true,
        },
        maxParagraphs: {
          type: 'integer',
          description: 'Return at most this many paragraphs. Omit for all of them.',
          minimum: 1,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'segment_clauses',
    description:
      'Split the document into numbered clauses and headings, handling English and Arabic ' +
      'numbering conventions. English decimal (1, 1.1, 1.1.1), lettered and roman sub items, and ' +
      'the Arabic conventions المادة (٣), البند الأول, standalone ordinals أولاً and ثانياً, and ' +
      'Arabic decimal ٣-٢ written with a hyphen. Each clause gets a stable anchor such as "C14", ' +
      'its label exactly as the document writes it, an ASCII normalised label for comparison, its ' +
      'nesting depth, its parent clause, and the paragraph anchors it covers. Cite these anchors so ' +
      'the reader can find the exact clause.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProperty,
        includeText: {
          type: 'boolean',
          description: 'Include each clause full text. Default true.',
          default: true,
        },
        maxClauses: {
          type: 'integer',
          description: 'Return at most this many clauses. Omit for all of them.',
          minimum: 1,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract_dates',
    description:
      'Extract every date, classify what it is for, and compute the deadlines that follow from it. ' +
      'Handles Gregorian and Hijri, Arabic-Indic and Persian digits, and month names in the ' +
      'Egyptian and Gulf, Levantine and Iraqi, and Hijri naming traditions. Each date reports its ' +
      'calendar, an ISO value, the role it plays (execution, commencement, term_end, renewal, ' +
      'notice, payment, delivery, signature) and the wording that justified that role. Hijri dates ' +
      'are converted with the tabular civil calendar and labelled as such, and where the contract ' +
      'states its own Gregorian equivalent any divergence is reported rather than resolved. Also ' +
      'returns notice periods found in the text and, where a fixed date anchors them, computed ' +
      'deadlines such as the date by which notice of non-renewal must be given.',
    inputSchema: {
      type: 'object',
      properties: { path: pathProperty },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract_parties',
    description:
      'Extract the parties, their defined terms and roles, their registration identifiers and ' +
      'addresses, and the signatories with their titles, each with an anchor. Reads both drafting ' +
      'traditions: the English numbered recital with a bracketed defined term, and the Arabic ' +
      'ordinal block with the ويشار إليه formula and the ويمثلها في التوقيع representative clause, ' +
      'which names the person who actually bound the company and is often the only place they are ' +
      'named.',
    inputSchema: {
      type: 'object',
      properties: { path: pathProperty },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'find_clauses',
    description:
      'Find the clauses that deal with a legal concept and return their real text with anchors, so ' +
      'the model reviews the actual wording instead of a summary of it. Supported concepts: ' +
      `${CONCEPTS.join(', ')}. Matching runs over an Arabic aware folded copy of the text, so a ` +
      'clause still matches whichever way it spells a term. Pass `query` instead of, or as well as, ' +
      '`concept` to search for free text. Results are ranked, and every result lists the terms that ' +
      'matched so the ranking can be audited.',
    inputSchema: {
      type: 'object',
      properties: {
        path: pathProperty,
        concept: {
          type: 'string',
          enum: CONCEPTS,
          description: 'The legal concept to search for.',
        },
        query: {
          type: 'string',
          description:
            'Free text to search for, in Arabic or English. Can be used on its own or alongside a ' +
            'concept to narrow it.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum number of clauses to return. Default 5.',
          minimum: 1,
          default: 5,
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'document_summary',
    description:
      'Build a structured skeleton of the contract for the model to reason over: parties and ' +
      'signatories, the term and whether it renews automatically, the obligations with the party ' +
      'bound by each, and the anchors of clauses that commonly need a closer look (auto renewal, ' +
      'unilateral termination, penalties, non compete, liability caps, arbitration). ' +
      'It returns structure and citations only. It contains no legal opinion, no risk rating and no ' +
      'recommendation, because those are the reviewing lawyer\'s to make.',
    inputSchema: {
      type: 'object',
      properties: { path: pathProperty },
      required: ['path'],
      additionalProperties: false,
    },
  },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function ok(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify({ error: message }, null, 2) }], isError: true };
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`"${key}" is required and must be a non empty string`);
  }
  return value;
}

function clauseSummary(clause: Clause, includeText: boolean) {
  return {
    anchor: clause.anchor,
    label: clause.label,
    normalisedLabel: clause.normalisedLabel,
    numbering: clause.numbering,
    heading: clause.heading,
    depth: clause.depth,
    parentAnchor: clause.parentAnchor,
    page: clause.page,
    direction: clause.direction,
    paragraphAnchors: clause.paragraphAnchors,
    ...(includeText ? { text: clause.text } : { characterCount: clause.text.length }),
  };
}

function documentHeader(document: Awaited<ReturnType<typeof loadDocument>>) {
  return {
    path: document.path,
    format: document.format,
    byteSize: document.byteSize,
    pageCount: document.pageCount,
    paragraphCount: document.paragraphCount,
    characterCount: document.characterCount,
    languageMix: document.languageMix,
    normalisations: document.normalisations,
    warnings: document.warnings,
  };
}

/** Verbs that create a duty, in both languages. */
const OBLIGATION_PATTERNS = [
  'shall',
  'must',
  'undertakes to',
  'agrees to',
  'is required to',
  'يلتزم',
  'يتعهد',
  'يجب',
  'على الطرف',
  'يحظر',
];

/* ------------------------------------------------------------------ */
/* Tool handlers                                                       */
/* ------------------------------------------------------------------ */

async function handleLoadDocument(args: Record<string, unknown>): Promise<CallToolResult> {
  const document = await loadDocument(requireString(args, 'path'));
  const includeText = args['includeText'] !== false;
  const max = typeof args['maxParagraphs'] === 'number' ? args['maxParagraphs'] : undefined;
  const paragraphs = max ? document.paragraphs.slice(0, max) : document.paragraphs;

  return ok({
    ...documentHeader(document),
    anchorFormat: 'Paragraph anchors are "P" followed by the paragraph number, for example "P12".',
    truncated: paragraphs.length < document.paragraphCount,
    paragraphs: paragraphs.map((p) => ({
      anchor: p.anchor,
      page: p.page,
      direction: p.direction,
      ...(includeText ? { text: p.text } : { characterCount: p.text.length }),
    })),
    safety: SAFETY_LINE,
  });
}

async function handleSegmentClauses(args: Record<string, unknown>): Promise<CallToolResult> {
  const document = await loadDocument(requireString(args, 'path'));
  const clauses = segmentClauses(document);
  const includeText = args['includeText'] !== false;
  const max = typeof args['maxClauses'] === 'number' ? args['maxClauses'] : undefined;
  const selected = max ? clauses.slice(0, max) : clauses;

  const byNumbering: Record<string, number> = {};
  for (const clause of clauses) byNumbering[clause.numbering] = (byNumbering[clause.numbering] ?? 0) + 1;

  return ok({
    document: documentHeader(document),
    anchorFormat:
      'Clause anchors are "C" followed by the clause number, for example "C14". They are stable for ' +
      'this file and identical in every tool that reports the same clause.',
    clauseCount: clauses.length,
    numberingConventions: byNumbering,
    truncated: selected.length < clauses.length,
    clauses: selected.map((c) => clauseSummary(c, includeText)),
    safety: SAFETY_LINE,
  });
}

async function handleExtractDates(args: Record<string, unknown>): Promise<CallToolResult> {
  const document = await loadDocument(requireString(args, 'path'));
  const clauses = segmentClauses(document);
  const result = extractDates(document, clauses);

  return ok({
    document: documentHeader(document),
    dateCount: result.dates.length,
    dates: result.dates,
    computedDeadlines: result.computedDeadlines,
    noticePeriods: result.noticePeriods,
    notes: [
      ...result.notes,
      'Deadlines are calendar days unless the clause says business days. Verify every computed date ' +
        'against the clause it came from before relying on it.',
    ],
    safety: SAFETY_LINE,
  });
}

async function handleExtractParties(args: Record<string, unknown>): Promise<CallToolResult> {
  const document = await loadDocument(requireString(args, 'path'));
  const result = extractParties(document);

  return ok({
    document: documentHeader(document),
    parties: result.parties,
    signatories: result.signatories,
    notes: result.notes,
    safety: SAFETY_LINE,
  });
}

async function handleFindClauses(args: Record<string, unknown>): Promise<CallToolResult> {
  const document = await loadDocument(requireString(args, 'path'));
  const clauses = segmentClauses(document);
  const folded = foldClauses(clauses);

  const concept = typeof args['concept'] === 'string' ? (args['concept'] as LegalConcept) : null;
  const query = typeof args['query'] === 'string' ? args['query'] : null;
  const limit = typeof args['limit'] === 'number' ? Math.max(1, args['limit']) : 5;

  if (!concept && !query) {
    return fail('provide "concept", "query", or both');
  }
  if (concept && !CONCEPTS.includes(concept)) {
    return fail(`unknown concept "${concept}". Supported concepts: ${CONCEPTS.join(', ')}`);
  }

  const matches = findByConcept(clauses, folded, concept, query);

  return ok({
    document: documentHeader(document),
    concept,
    conceptDescription: concept ? conceptDescription(concept) : null,
    query,
    matchCount: matches.length,
    truncated: matches.length > limit,
    matches: matches.slice(0, limit).map((m) => ({
      ...clauseSummary(m.clause, true),
      score: m.score,
      matchedTerms: m.matchedTerms,
    })),
    notes:
      matches.length === 0
        ? [
            'No clause matched. The concept may genuinely be absent from this contract, which is ' +
              'itself worth reporting, or it may be expressed in wording the lexicon does not cover. ' +
              'Try find_clauses again with a free text query before concluding it is absent.',
          ]
        : [
            'The full clause text is included above. Read it before drawing any conclusion, rather ' +
              'than relying on the fact that it matched.',
          ],
    safety: SAFETY_LINE,
  });
}

async function handleDocumentSummary(args: Record<string, unknown>): Promise<CallToolResult> {
  const document = await loadDocument(requireString(args, 'path'));
  const clauses = segmentClauses(document);
  const folded = foldClauses(clauses);
  const dates = extractDates(document, clauses);
  const parties = extractParties(document);

  const foldedObligations = OBLIGATION_PATTERNS.map((p) => foldForMatching(p));
  const partyTerms = parties.parties.flatMap((p) =>
    [p.definedTerm, p.role, p.name].filter((t): t is string => typeof t === 'string' && t.length > 2)
  );

  const obligations = clauses
    .filter((clause) => {
      const text = folded.get(clause.anchor) ?? '';
      return foldedObligations.some((pattern) => text.includes(pattern));
    })
    .map((clause) => {
      const text = folded.get(clause.anchor) ?? '';
      const bound = partyTerms.filter((term) => text.includes(foldForMatching(term)));
      return {
        anchor: clause.anchor,
        label: clause.label,
        heading: clause.heading,
        page: clause.page,
        boundParties: [...new Set(bound)],
        excerpt: clause.text.length > 220 ? `${clause.text.slice(0, 220)}...` : clause.text,
      };
    });

  const flagged = FLAG_CONCEPTS.map((concept) => {
    const matches = findByConcept(clauses, folded, concept, null).slice(0, 3);
    return {
      concept,
      description: conceptDescription(concept),
      present: matches.length > 0,
      clauseAnchors: matches.map((m) => m.clause.anchor),
      clauses: matches.map((m) => ({
        anchor: m.clause.anchor,
        label: m.clause.label,
        heading: m.clause.heading,
        page: m.clause.page,
        matchedTerms: m.matchedTerms,
        excerpt: m.clause.text.length > 300 ? `${m.clause.text.slice(0, 300)}...` : m.clause.text,
      })),
    };
  });

  const byRole = (role: string) => dates.dates.find((d) => d.role === role) ?? null;
  const autoRenewal = flagged.find((f) => f.concept === 'auto_renewal');

  return ok({
    document: documentHeader(document),
    parties: parties.parties.map((p) => ({
      name: p.name,
      definedTerm: p.definedTerm,
      role: p.role,
      identifiers: p.identifiers,
      anchor: p.anchor,
    })),
    signatories: parties.signatories.map((s) => ({
      name: s.name,
      title: s.title,
      onBehalfOf: s.onBehalfOf,
      date: s.date,
      anchor: s.anchor,
    })),
    term: {
      execution: byRole('execution'),
      commencement: byRole('commencement'),
      termEnd: byRole('term_end'),
      renewsAutomatically: autoRenewal?.present ?? false,
      renewalClauseAnchors: autoRenewal?.clauseAnchors ?? [],
      computedDeadlines: dates.computedDeadlines,
    },
    obligationCount: obligations.length,
    obligations,
    flaggedClauses: flagged,
    structureNotes: [
      ...document.warnings,
      ...parties.notes,
      ...dates.notes,
      `${clauses.length} clauses segmented from ${document.paragraphCount} paragraphs.`,
    ],
    disclaimer:
      'This is a structural skeleton with citations, not an assessment. Nothing here says whether a ' +
      'clause is unusual, unfair, enforceable or acceptable. Clauses are flagged only because they ' +
      'belong to categories a reviewer normally reads closely, never because this server judged ' +
      'them. Open each anchor and read the clause.',
    safety: SAFETY_LINE,
  });
}

/* ------------------------------------------------------------------ */
/* Server wiring                                                       */
/* ------------------------------------------------------------------ */

const HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<CallToolResult>> = {
  load_document: handleLoadDocument,
  segment_clauses: handleSegmentClauses,
  extract_dates: handleExtractDates,
  extract_parties: handleExtractParties,
  find_clauses: handleFindClauses,
  document_summary: handleDocumentSummary,
};

export function createServer(): Server {
  const server = new Server(
    { name: 'legal-intake-mcp', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const handler = HANDLERS[request.params.name];
    if (!handler) return fail(`unknown tool "${request.params.name}"`);
    try {
      return await handler((request.params.arguments ?? {}) as Record<string, unknown>);
    } catch (error) {
      return fail(error instanceof Error ? error.message : String(error));
    }
  });

  return server;
}

async function main() {
  const server = createServer();
  await server.connect(new StdioServerTransport());
  // stdout carries the protocol, so anything human readable goes to stderr.
  process.stderr.write('legal-intake-mcp running on stdio\n');
}

// Only start the transport when this file is the process entry point, so the
// test suite can import createServer without a stdio server attaching itself.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((error) => {
    process.stderr.write(`legal-intake-mcp failed to start: ${String(error)}\n`);
    process.exit(1);
  });
}
