/**
 * Runs every tool against both sample contracts through the real MCP protocol
 * and prints what comes back.
 *
 * This is the script behind the worked example in the README. It talks to the
 * built server over stdio exactly as a desktop client does, so what it prints is
 * genuine tool output and not a rehearsal of it.
 *
 * Usage: npm run demo
 */
import { McpTestClient, sample } from '../test/helpers/mcpClient.js';

function heading(text: string): void {
  console.log(`\n${'='.repeat(78)}\n${text}\n${'='.repeat(78)}`);
}

function show(label: string, value: unknown): void {
  console.log(`\n--- ${label} ---`);
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
}

async function main() {
  const client = new McpTestClient();
  await client.start();

  const init = await client.initialize();
  const serverInfo = (init.result?.['serverInfo'] ?? {}) as { name?: string; version?: string };
  heading('MCP handshake');
  console.log(`server: ${serverInfo.name} ${serverInfo.version}`);
  console.log(`protocol: ${String(init.result?.['protocolVersion'])}`);

  const tools = await client.listTools();
  heading(`tools/list returned ${tools.length} tools`);
  for (const tool of tools) console.log(`  ${tool.name}`);

  for (const file of ['services-agreement-en.txt', 'services-agreement-ar.txt']) {
    const path = sample(file);
    heading(file);

    const loaded = await client.callTool('load_document', { path, includeText: false });
    show('load_document', {
      format: loaded['format'],
      paragraphCount: loaded['paragraphCount'],
      pageCount: loaded['pageCount'],
      languageMix: loaded['languageMix'],
      normalisations: loaded['normalisations'],
      warnings: loaded['warnings'],
    });

    const segmented = await client.callTool('segment_clauses', { path, includeText: false });
    show('segment_clauses', {
      clauseCount: segmented['clauseCount'],
      numberingConventions: segmented['numberingConventions'],
      firstClauses: (segmented['clauses'] as Array<Record<string, unknown>>)
        .slice(0, 6)
        .map((c) => ({ anchor: c['anchor'], label: c['label'], heading: c['heading'], depth: c['depth'] })),
    });

    const dates = await client.callTool('extract_dates', { path });
    show('extract_dates', {
      dates: (dates['dates'] as Array<Record<string, unknown>>).map((d) => ({
        raw: d['raw'],
        calendar: d['calendar'],
        iso: d['iso'],
        role: d['role'],
        anchor: d['anchor'],
        ...(d['statedGregorian'] ? { statedGregorian: d['statedGregorian'] } : {}),
      })),
      computedDeadlines: dates['computedDeadlines'],
    });

    const parties = await client.callTool('extract_parties', { path });
    show('extract_parties', {
      parties: parties['parties'],
      signatories: parties['signatories'],
    });

    const renewal = await client.callTool('find_clauses', { path, concept: 'auto_renewal', limit: 2 });
    show('find_clauses concept=auto_renewal', {
      matchCount: renewal['matchCount'],
      matches: (renewal['matches'] as Array<Record<string, unknown>>).map((m) => ({
        anchor: m['anchor'],
        label: m['label'],
        score: m['score'],
        matchedTerms: m['matchedTerms'],
        text: m['text'],
      })),
    });

    const summary = await client.callTool('document_summary', { path });
    show('document_summary', {
      parties: summary['parties'],
      term: summary['term'],
      obligationCount: summary['obligationCount'],
      flaggedClauses: (summary['flaggedClauses'] as Array<Record<string, unknown>>).map((f) => ({
        concept: f['concept'],
        present: f['present'],
        clauseAnchors: f['clauseAnchors'],
      })),
      disclaimer: summary['disclaimer'],
    });
  }

  await client.stop();
  heading('done');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
