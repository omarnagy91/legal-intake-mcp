import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { McpTestClient, sample } from './helpers/mcpClient.js';

/**
 * These tests drive the built server over real stdio JSON-RPC, the same way a
 * desktop client does. They are the ones that prove the server actually works
 * as an MCP server rather than as a library that happens to compile.
 */
describe('MCP protocol', () => {
  const client = new McpTestClient();

  before(async () => {
    await client.start();
    const response = await client.initialize();
    assert.ok(response.result, `initialize failed: ${JSON.stringify(response.error)}`);
  });

  after(async () => {
    await client.stop();
  });

  test('initialize reports the server identity and instructions', async () => {
    const fresh = new McpTestClient();
    await fresh.start();
    const response = await fresh.initialize();
    const result = response.result as Record<string, unknown>;

    const serverInfo = result['serverInfo'] as { name: string; version: string };
    assert.equal(serverInfo.name, 'legal-intake-mcp');
    assert.equal(serverInfo.version, '1.0.0');

    // The safety statement is part of the server's own description, not only
    // the README, so any client that surfaces instructions shows it.
    const instructions = String(result['instructions'] ?? '');
    assert.match(instructions, /does not give legal advice/);
    assert.match(instructions, /anchor/i);

    await fresh.stop();
  });

  test('tools/list returns all six tools with documented schemas', async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    assert.deepEqual(names, [
      'document_summary',
      'extract_dates',
      'extract_parties',
      'find_clauses',
      'load_document',
      'segment_clauses',
    ]);

    for (const tool of tools) {
      assert.ok(tool.description.length > 80, `${tool.name} needs a real description`);
      const schema = tool.inputSchema as {
        type: string;
        properties: Record<string, { description?: string }>;
        required?: string[];
      };
      assert.equal(schema.type, 'object');
      assert.ok(schema.required?.includes('path'), `${tool.name} must require a path`);
      for (const [property, definition] of Object.entries(schema.properties)) {
        assert.ok(
          definition.description && definition.description.length > 10,
          `${tool.name}.${property} needs a documented description`
        );
      }
    }
  });

  test('an unknown tool is reported as an error, not a crash', async () => {
    await assert.rejects(() => client.callTool('not_a_tool', { path: sample('services-agreement-en.txt') }));
  });

  test('a missing required argument is reported clearly', async () => {
    await assert.rejects(() => client.callTool('load_document', {}), /path/);
  });

  test('a missing file is reported clearly', async () => {
    await assert.rejects(
      () => client.callTool('load_document', { path: sample('nope.txt') }),
      /file not found/
    );
  });

  for (const file of [
    'services-agreement-en.txt',
    'services-agreement-ar.txt',
    'services-agreement-en.docx',
    'services-agreement-ar.docx',
    'services-agreement-en.pdf',
  ]) {
    test(`every tool returns real output for ${file}`, async () => {
      const path = sample(file);

      const loaded = await client.callTool('load_document', { path });
      assert.ok((loaded['paragraphCount'] as number) > 20);
      assert.ok(Array.isArray(loaded['paragraphs']));
      assert.ok(String(loaded['safety']).includes('does not give legal advice'));

      const segmented = await client.callTool('segment_clauses', { path });
      assert.ok((segmented['clauseCount'] as number) > 20);

      const dates = await client.callTool('extract_dates', { path });
      assert.ok((dates['dateCount'] as number) > 0);

      const parties = await client.callTool('extract_parties', { path });
      assert.equal((parties['parties'] as unknown[]).length, 2);

      const found = await client.callTool('find_clauses', { path, concept: 'auto_renewal' });
      assert.ok((found['matchCount'] as number) > 0);

      const summary = await client.callTool('document_summary', { path });
      assert.ok(String(summary['disclaimer']).length > 50);
      assert.ok((summary['obligationCount'] as number) > 0);
    });
  }

  test('find_clauses returns the clause text, not a summary of it', async () => {
    const result = await client.callTool('find_clauses', {
      path: sample('services-agreement-ar.txt'),
      concept: 'auto_renewal',
    });
    const matches = result['matches'] as Array<{ anchor: string; text: string; matchedTerms: string[] }>;
    assert.ok(matches.length > 0);
    assert.match(matches[0]!.text, /يتجدد/);
    assert.match(matches[0]!.anchor, /^C\d+$/);
    assert.ok(matches[0]!.matchedTerms.length > 0);
  });

  test('find_clauses rejects an unknown concept with the supported list', async () => {
    await assert.rejects(
      () =>
        client.callTool('find_clauses', {
          path: sample('services-agreement-en.txt'),
          concept: 'nonsense_concept',
        }),
      /unknown concept/
    );
  });

  test('find_clauses requires a concept or a query', async () => {
    await assert.rejects(
      () => client.callTool('find_clauses', { path: sample('services-agreement-en.txt') }),
      /concept.*query|query.*concept/
    );
  });

  test('document_summary carries citations and no opinion', async () => {
    const summary = await client.callTool('document_summary', {
      path: sample('services-agreement-ar.txt'),
    });

    const term = summary['term'] as Record<string, unknown>;
    assert.equal(term['renewsAutomatically'], true);
    assert.ok((term['renewalClauseAnchors'] as string[]).length > 0);

    const flagged = summary['flaggedClauses'] as Array<{
      concept: string;
      present: boolean;
      clauseAnchors: string[];
    }>;
    const renewal = flagged.find((f) => f.concept === 'auto_renewal');
    assert.equal(renewal?.present, true);

    // Every flagged clause anchor must resolve against segment_clauses.
    const segmented = await client.callTool('segment_clauses', {
      path: sample('services-agreement-ar.txt'),
      includeText: false,
    });
    const known = new Set((segmented['clauses'] as Array<{ anchor: string }>).map((c) => c.anchor));
    for (const flag of flagged) {
      for (const anchor of flag.clauseAnchors) {
        assert.ok(known.has(anchor), `summary flagged unknown clause ${anchor}`);
      }
    }

    const disclaimer = String(summary['disclaimer']);
    assert.match(disclaimer, /not an assessment/);
  });

  test('the Arabic Hijri date survives the full protocol round trip', async () => {
    const dates = await client.callTool('extract_dates', {
      path: sample('services-agreement-ar.txt'),
    });
    const list = dates['dates'] as Array<Record<string, unknown>>;
    const hijri = list.find((d) => d['calendar'] === 'hijri');

    assert.ok(hijri, 'expected a Hijri date over the wire');
    assert.equal((hijri['hijri'] as Record<string, unknown>)['monthName'], 'رمضان');
    assert.equal(hijri['statedGregorian'], '2025-03-14');
    assert.equal(hijri['iso'], '2025-03-15');

    const deadlines = dates['computedDeadlines'] as Array<Record<string, unknown>>;
    assert.equal(deadlines[0]?.['deadline'], '2026-01-30');
  });

  test('maxClauses truncates and says so', async () => {
    const result = await client.callTool('segment_clauses', {
      path: sample('services-agreement-en.txt'),
      maxClauses: 3,
    });
    assert.equal((result['clauses'] as unknown[]).length, 3);
    assert.equal(result['truncated'], true);
  });
});
