# legal-intake-mcp

A Model Context Protocol server for law firm document intake, Arabic and English.

It turns a contract file into structured, citable context: normalised text with paragraph anchors, clauses split along both Arabic and English numbering conventions, dates resolved across the Gregorian and Hijri calendars with the deadlines that follow from them, parties and signatories, and clause search by legal concept.

**Safety line, stated plainly: this server extracts and cites. It does not give legal advice, it does not decide anything, and it does not judge whether a clause is fair or enforceable. Every item it returns carries an anchor pointing at the exact paragraph of the source document it came from, so a qualified lawyer can verify each one against the original before relying on it.**

---

## Why an MCP server is the right shape for this

The temptation with a task like "review this contract" is to build a service that reads the document, calls a model, and returns an answer. That is the wrong shape, for three reasons.

**The deterministic work and the reasoning work are different work.** Parsing a PDF, mapping Arabic presentation forms back to real letters, converting 15 Ramadan 1446 to a Gregorian date, and subtracting sixty days from a term end are all deterministic. They should be done once, correctly, in code that can be tested. Deciding whether an auto renewal clause is a problem for this client is judgement, and it belongs to the model and to the lawyer supervising it.

**It means no API key and no secrets.** This server makes no network call and holds no credentials. You point Claude at it, and Claude does the reasoning it was already going to do, with better inputs. Nothing about a client's contract leaves the machine because of this server.

**It makes the output checkable.** Because the server returns anchors rather than conclusions, every statement built on it can be traced back to a paragraph. `C12` is a clause, `P34` is a paragraph, and both mean the same thing in every tool. A reviewer who does not trust the summary can open the anchor.

The division of labour is the point: **the server does the document work, the client model does the legal reasoning, and the anchors let a human check both.**

---

## Arabic is first class

Arabic contract text breaks tools that were built for English and then localised. The specific failures this server handles:

| Problem | What happens without handling | What this server does |
|---|---|---|
| Arabic-Indic numerals `٦٠` | Any parser built on `\d` finds no numbers at all | Accepts `٠-٩` and Persian and Urdu `۰-۹` everywhere a numeral can appear |
| Arabic clause numbering | The whole contract comes back as one clause, destroying every citation | Handles `المادة (٣)`, `البند الأول`, `أولاً`, `٣-٢`, `الملحق رقم (١)` |
| Hijri dates | `1446` is read as a nonsense year, or silently converted with no tolerance | Parsed, labelled, converted with the tabular civil calendar, with the divergence flagged |
| Tatweel `الســـرية` | A search for the plain word misses the very heading that names it | Kashida stripped before matching |
| Alef and hamza variants `أ إ آ ا`, teh marbuta `ة/ه` | `الأول` and `الاول` are treated as different words | Folded for matching only, never in the text you are given |
| Presentation forms in PDFs | Text extracts as unreadable, unsearchable glyph codes | Detected and mapped back to base letters, and reported |
| Visual order text | Every Arabic word comes out reversed | Detected on strong evidence only, repaired, and reported |
| RTL run order in PDFs | Phrases come back in reverse sequence, a date landing before the sentence that introduces it | Runs on each line are sorted into reading order using the line's own direction |
| Mixed direction documents | One direction is forced on the whole file | Direction computed per paragraph |

Two rules govern all of it:

1. **Text you are given is verbatim.** The only changes ever applied are repairs to an encoding defect in the source file itself. Every repair that fires is listed in the document's `normalisations` field. A clean file produces an empty list.
2. **Folding is for matching only.** The aggressive normalisation that makes `الأول` match `الاول` is used to decide whether a pattern matched. The span returned to you is always cut from the original text.

### On Hijri conversion

Conversion uses the tabular civil Hijri calendar. That calendar is arithmetic, and it can differ by about a day from the sighting based calendar a court or ministry actually applies. So conversions are labelled as tabular, and where a contract states its own Gregorian equivalent, the stated value is preserved and any divergence is reported rather than resolved.

The Arabic sample contract is dated `١٥ رمضان ١٤٤٦هـ الموافق ١٤ مارس ٢٠٢٥م`. The tabular conversion gives 2025-03-15, the contract says 2025-03-14. The server reports both and says which is which. Silently picking one would hide a real discrepancy that only a person can settle.

---

## Install

Requires Node 20 or newer.

```bash
git clone https://github.com/omarnagy91/legal-intake-mcp.git
cd legal-intake-mcp && npm install
```

That is the whole install. `npm install` also builds, because the `prepare` script runs `tsc`. There is no API key, no `.env`, and no configuration file.

Verify it:

```bash
npm test     # runs the full suite
npm run demo # runs every tool on both sample contracts over the real MCP protocol
```

## Connect it

### Claude Code

```bash
claude mcp add legal-intake -- node /absolute/path/to/legal-intake-mcp/dist/src/index.js
```

### Claude Desktop

Add this to `claude_desktop_config.json`. On macOS that file lives at `~/Library/Application Support/Claude/claude_desktop_config.json`, and on Windows at `%APPDATA%\Claude\claude_desktop_config.json`.

```json
{
  "mcpServers": {
    "legal-intake": {
      "command": "node",
      "args": ["/absolute/path/to/legal-intake-mcp/dist/src/index.js"]
    }
  }
}
```

Use an absolute path, and restart Claude Desktop afterwards. The server speaks stdio and needs no environment variables.

---

## Tools

Every tool takes a `path` to a `.pdf`, `.docx`, or plain text file. The format is detected from the file content rather than its extension, because a mislabelled file in an intake pile otherwise gets parsed confidently and wrongly.

### `load_document`

Loads a contract and returns normalised text with an anchor on every paragraph.

**Input:** `path` (required), `includeText` (boolean, default true), `maxParagraphs` (integer, optional).

**Output:** `format`, `pageCount` (null for formats without pages), `paragraphCount`, `characterCount`, `languageMix` (Arabic and Latin character counts and shares, dominant script, text direction), `normalisations` (encoding repairs applied), `warnings`, and `paragraphs`, each with `anchor`, `page`, `direction` and `text`.

Warnings that matter: a PDF whose text layer maps a share of its glyphs to nothing is reported as lossy, with the percentage, rather than returning text with silent holes in it. A PDF with no text layer at all is reported as needing OCR.

### `segment_clauses`

Splits the document into numbered clauses and headings.

**Input:** `path` (required), `includeText` (boolean, default true), `maxClauses` (integer, optional).

**Output:** `clauseCount`, `numberingConventions` (a count per convention found), and `clauses`, each with `anchor` (`C14`), `label` exactly as the document writes it, `normalisedLabel` in ASCII for comparison across scripts, `numbering`, `heading`, `depth`, `parentAnchor`, `paragraphAnchors`, `page`, `direction` and `text`.

Parent links are structural, not numeric. Real contracts contain misnumbered sub clauses, and matching on the number alone drops them.

### `extract_dates`

Extracts every date, classifies its role, and computes the deadlines that follow.

**Input:** `path` (required).

**Output:** `dates`, each with `raw` as written, `calendar`, `iso`, `hijri` components where applicable, `role` (`execution`, `commencement`, `term_end`, `renewal`, `notice`, `payment`, `delivery`, `signature`, `unclassified`), `roleEvidence` quoting the wording that justified the role, `anchor`, `clauseAnchor`, and `notes`. Plus `noticePeriods` found in the text and `computedDeadlines`.

A deadline is only computed where a fixed date in the document anchors it. A period such as "within thirty (30) days of the invoice date" has no fixed anchor, so it is reported as a period and not turned into a date that would look more certain than it is.

### `extract_parties`

**Input:** `path` (required).

**Output:** `parties` with `name`, `definedTerm`, `role`, `identifiers`, `address`, `anchor` and `language`. `signatories` with `name`, `title`, `onBehalfOf`, `date`, `anchor`, `additionalAnchors` and `source`.

It reads both drafting traditions: the English numbered recital with a bracketed defined term, and the Arabic ordinal block with the `ويشار إليه` formula and the `ويمثلها في التوقيع` representative clause, which names the person who actually bound the company and is often the only place they are named.

### `find_clauses`

Searches by legal concept and returns the matching clauses with their real text.

**Input:** `path` (required), `concept` (optional enum), `query` (optional free text, Arabic or English), `limit` (default 5). At least one of `concept` or `query` is required.

Concepts: `auto_renewal`, `unilateral_termination`, `penalty`, `governing_law`, `arbitration`, `confidentiality`, `non_compete`, `limitation_of_liability`, `notice`, `payment_terms`, `force_majeure`, `assignment`, `entire_agreement`.

**Output:** `matchCount` and `matches`, each a full clause plus `score` and `matchedTerms`, so the ranking can be audited. The full clause text is returned deliberately, so the model reviews the wording rather than the fact that something matched. A sub clause inherits its section heading for search purposes, because clause 7.1 never says "non-compete", it just states the restraint; the word is in the heading above it.

When nothing matches, that is reported as a finding rather than papered over.

### `document_summary`

A structured skeleton for the model to reason over.

**Input:** `path` (required).

**Output:** `parties`, `signatories`, `term` (execution, commencement, term end, whether it renews automatically, the renewal clause anchors, computed deadlines), `obligations` with the party bound by each, `flaggedClauses`, `structureNotes`, and a `disclaimer`.

Clauses are flagged only because they belong to categories a reviewer normally reads closely, never because the server judged them. There is no risk rating and no recommendation, because those belong to the reviewing lawyer.

---

## Worked example

Real output, taken from `npm run demo` against `samples/services-agreement-ar.txt`. Trimmed for length, otherwise unedited.

**`load_document`**

```json
{
  "format": "text",
  "paragraphCount": 58,
  "languageMix": {
    "arabicChars": 4615, "latinChars": 55,
    "arabicShare": 0.988, "latinShare": 0.012,
    "dominant": "arabic", "direction": "rtl"
  },
  "normalisations": [],
  "warnings": []
}
```

**`segment_clauses`** finds 49 clauses and reports which conventions produced them:

```json
{
  "clauseCount": 49,
  "numberingConventions": {
    "none": 1, "arabic-ordinal": 2, "heading": 1,
    "arabic-article": 13, "arabic-decimal": 28, "lettered": 4
  },
  "clauses": [
    { "anchor": "C5", "label": "المادة (١)", "normalisedLabel": "1",
      "numbering": "arabic-article", "heading": "التمهيد وملحقات العقد", "depth": 0 },
    { "anchor": "C12", "label": "٣-٢", "normalisedLabel": "3.2",
      "numbering": "arabic-decimal", "depth": 1, "parentAnchor": "C10" }
  ]
}
```

**`extract_dates`** reads the Hijri date, converts it, and flags the divergence from the equivalent the contract states for itself:

```json
{
  "raw": "١٥ رمضان ١٤٤٦",
  "calendar": "hijri",
  "iso": "2025-03-15",
  "hijri": { "year": 1446, "month": 9, "day": 15, "monthName": "رمضان" },
  "role": "execution",
  "anchor": "P2",
  "statedGregorian": "2025-03-14",
  "notes": [
    "Gregorian value is a tabular civil Hijri conversion and can differ by one day from the sighting based calendar used officially. Confirm against the calendar the contract is subject to.",
    "The contract states 2025-03-14 as the Gregorian equivalent. The tabular conversion gives 2025-03-15, a difference of -1 day(s). The stated equivalent is what the parties wrote and normally governs."
  ]
}
```

and computes the deadline that follows from the auto renewal clause:

```json
{
  "description": "Written notice of non-renewal must be given on or before this date, otherwise the agreement renews automatically.",
  "period": "60 days", "days": 60, "direction": "before",
  "anchorDate": "2026-03-31", "anchorDateRole": "term_end",
  "deadline": "2026-01-30",
  "clauseAnchor": "C12", "paragraphAnchor": "P17",
  "notes": [
    "Computed as 2026-03-31 minus 60 day(s), taken from the notice period in clause ٣-٢.",
    "Calendar days, not business days, unless the contract says otherwise. Verify against the notice clause before relying on it."
  ]
}
```

**`extract_parties`** reads the Arabic party block, including the representative named inside it:

```json
{
  "parties": [
    { "name": "شركة الواحة للاستشارات الإدارية ذات مسؤولية محدودة",
      "definedTerm": "مقدم الخدمة", "role": "الطرف الأول",
      "identifiers": ["1183097"],
      "address": "٢٢ شارع النصر، مدينة نصر، القاهرة", "anchor": "P4" },
    { "name": "مؤسسة نور الشرق للتجارة والتوريدات",
      "definedTerm": "العميل", "role": "الطرف الثاني",
      "identifiers": ["9144722"],
      "address": "٧ شارع الجلاء، الإسكندرية", "anchor": "P5" }
  ],
  "signatories": [
    { "name": "كريم عبد الرحمن", "title": "المدير التنفيذي",
      "onBehalfOf": "شركة الواحة للاستشارات الإدارية ذات مسؤولية محدودة",
      "date": "١٤ مارس ٢٠٢٥",
      "anchor": "P4", "additionalAnchors": ["P50"], "source": "party_block" }
  ]
}
```

**`find_clauses`** with `concept: "auto_renewal"` returns the operative clause with its text and the reason it matched:

```json
{
  "matchCount": 4,
  "matches": [
    {
      "anchor": "C12", "label": "٣-٢", "score": 9,
      "matchedTerms": ["يتجدد هذا العقد تلقائياً", "عدم التجديد", "يتجدد"],
      "text": "٣-٢ يتجدد هذا العقد تلقائياً لمدة أو مدد مماثلة ما لم يخطر أحد الطرفين الطرف الآخر كتابةً برغبته في عدم التجديد قبل ستين (٦٠) يوماً على الأقل من تاريخ انتهاء المدة السارية."
    }
  ]
}
```

The same contract in English produces the same commencement date, the same term end, and the same computed deadline of 2026-01-30. There is a test asserting exactly that, because the two files agreeing is the clearest evidence that the Arabic path is doing real work rather than approximating it.

---

## Samples

`samples/` holds two contracts written for this repository, one English and one Arabic, with invented parties. They are not translations of each other; the Arabic one is drafted the way an Egyptian services agreement is actually drafted, with `المادة` numbering, a Hijri date, and the representative named in the party block.

| File | Format | Notes |
|---|---|---|
| `services-agreement-en.txt` | plain text | English services agreement |
| `services-agreement-en.docx` | Word | the same contract, exercising the DOCX reader |
| `services-agreement-en.pdf` | PDF, 5 pages | the same contract, exercising the PDF reader and page anchoring |
| `services-agreement-ar.txt` | plain text | Arabic services agreement |
| `services-agreement-ar.docx` | Word | the same contract, right to left |

`scripts/make-samples.mjs` regenerates the DOCX and PDF from the text files. Reviewers never need to run it.

### On the absence of an Arabic PDF sample

There is not one, and the reason is worth stating plainly, because it is the most interesting thing this project learned.

Arabic PDF text extraction depends entirely on how the producing tool wrote its text layer. Three distinct defect classes were measured during development, not assumed:

1. **Presentation forms.** One generator stored every letter as its joined glyph rather than its base character, so the text extracted as unreadable Arabic Presentation Forms. The same file also had a ToUnicode map that resolved a large share of glyphs to `U+0000`, meaning characters that simply are not recoverable from the file.
2. **Reversed run order.** A second generator wrote clean logical Unicode, but pdf.js returns runs in positional order, which for a right to left line is the reverse of reading order. The line `تحرر هذا العقد في مدينة القاهرة بتاريخ ١٥ رمضان ١٤٤٦هـ` came back with the date first and the sentence last. **This one the server now fixes**, by sorting the runs on each line using the line's own resolved direction. There is a unit test built from the exact pdf.js items that exposed it.
3. **Character level ligature transposition.** That same otherwise clean file still emitted certain shaped clusters with their two codepoints in visual order, so `الموافق` extracted as `املوافق` and `بين` as `بني`. This is below the level any consumer of the text layer can reliably detect or repair, because the output is well formed Unicode that happens to be wrong.

Defect 3 is why no Arabic PDF ships here. Shipping a fixture whose words are quietly transposed would contradict the one rule this server is built on, that text handed to a lawyer is text they can cite.

So the repository ships the English PDF, which extracts cleanly and proves the PDF path end to end including page numbers, and covers the Arabic defect classes with unit tests built on fixtures reproducing exactly what was measured. In real use the server detects presentation forms and maps them back, sorts RTL runs into reading order, repairs whole line visual ordering on strong evidence, and reports a lossy text layer as a warning with the percentage rather than returning text with silent holes in it. What it cannot do is invent characters a PDF never encoded, or detect a transposition that produces valid Unicode, and it says so rather than pretending otherwise.

The practical guidance that falls out of this: for Arabic, prefer `.docx` at intake where you can get it, and treat any Arabic PDF as needing a human to eyeball the extracted text before it is quoted.

---

## Tests

```bash
npm test
```

108 tests, all passing. They cover:

- **Arabic specifically:** digit conversion including Persian forms, presentation form de-shaping, lam alef ligature splitting, visual order repair including the negative case where it must refuse to act, tatweel stripping, alef and teh marbuta folding, offset preserving folds, script mix, per paragraph direction, and right to left PDF run ordering driven by the real pdf.js items that exposed the bug.
- **Dates:** the Hijri epoch, a modern Hijri conversion checked against the observed date, ISO arithmetic across month, year and leap day boundaries, role classification, and the assertion that a renewal term length is not mistaken for a notice period.
- **Clause segmentation:** every Arabic and English numbering convention, and the assertion that the Arabic contract segments into many clauses rather than one, which is the test that fails for any splitter written only for English.
- **Anchors:** that every paragraph belongs to exactly one clause, that no tool cites an anchor another tool does not know, and that clause text is verbatim from its paragraphs.
- **Formats:** that the same contract as `.txt`, `.docx` and `.pdf` produces the same clause labels, the same dates and the same parties.
- **The MCP protocol itself:** the suite spawns the built server as a child process and speaks real JSON-RPC over stdio, running `initialize`, `tools/list` and every tool against all five sample files.

---

## Design notes

**Dependencies are two.** `@modelcontextprotocol/sdk` and `pdfjs-dist`, both pinned to exact versions. The DOCX reader is written against Node's own `zlib`, because a `.docx` is a ZIP holding an XML part and that needs a central directory walk and a raw inflate, not a library. Tests use `node:test`. There is no test framework, no bundler and no linter config to install.

**pdf.js rather than a hand rolled parser**, because the part that matters here is resolving glyph codes back to Unicode through the font's ToUnicode map, which is exactly the part that is hard, and the part Arabic depends on entirely.

**Right to left run ordering** was a real bug found by reading the output of a generated Arabic PDF rather than by reasoning about the code. It is fixed, and its fix is the difference between a legible Arabic contract and a scrambled one.

**Paragraph grouping in PDFs** uses a low percentile of the observed line gaps as the line spacing rather than the median. In a contract most paragraphs are one or two lines, so the median gap is the paragraph gap, and a median based threshold merges an entire page into one block. That was a real bug, found by checking the output rather than by reading the code.

**Documents are addressed by path, not by a handle.** There is no session state to get out of sync, and a restart loses nothing. Loading is cached on path, size and modification time, so repeated calls are cheap and an edited file is picked up immediately.

---

## Licence

MIT. See [LICENSE](LICENSE).

Built by Omar G. Nagy.
