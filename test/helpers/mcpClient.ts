/**
 * A tiny JSON-RPC client that speaks to the built server over real stdio.
 *
 * The tests drive the server the same way Claude Desktop does, as a child
 * process exchanging newline delimited JSON-RPC. Unit testing the parsers alone
 * would not prove the thing a reviewer actually cares about, which is that the
 * server starts, lists its tools and answers a call.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const projectRoot = join(here, '..', '..', '..');
export const serverEntry = join(projectRoot, 'dist', 'src', 'index.js');
export const samplesDir = join(projectRoot, 'samples');

export type JsonRpcResponse = {
  jsonrpc: '2.0';
  id: number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

export class McpTestClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, (response: JsonRpcResponse) => void>();
  public stderr = '';

  async start(): Promise<void> {
    const child = spawn(process.execPath, [serverEntry], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: projectRoot,
    });
    this.child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      this.buffer += chunk;
      let newline = this.buffer.indexOf('\n');
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line !== '') this.dispatch(line);
        newline = this.buffer.indexOf('\n');
      }
    });

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr += chunk;
    });

    // The server announces itself on stderr once the transport is attached.
    const deadline = Date.now() + 10000;
    while (!this.stderr.includes('running on stdio') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (child.exitCode !== null) {
        throw new Error(`server exited early with code ${child.exitCode}: ${this.stderr}`);
      }
    }
  }

  private dispatch(line: string): void {
    let message: JsonRpcResponse;
    try {
      message = JSON.parse(line) as JsonRpcResponse;
    } catch {
      return;
    }
    const resolver = this.pending.get(message.id);
    if (resolver) {
      this.pending.delete(message.id);
      resolver(message);
    }
  }

  request(method: string, params?: Record<string, unknown>): Promise<JsonRpcResponse> {
    const child = this.child;
    if (!child) throw new Error('client not started');
    const id = this.nextId++;

    const promise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timed out waiting for ${method}`));
      }, 30000);
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
    });

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`);
    return promise;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} })}\n`);
  }

  /** Perform the MCP handshake exactly as a real client does. */
  async initialize(): Promise<JsonRpcResponse> {
    const response = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'legal-intake-mcp-tests', version: '1.0.0' },
    });
    this.notify('notifications/initialized');
    return response;
  }

  async listTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
    const response = await this.request('tools/list');
    const tools = (response.result?.['tools'] ?? []) as Array<{
      name: string;
      description: string;
      inputSchema: unknown;
    }>;
    return tools;
  }

  /** Call a tool and parse the JSON payload the server returns as text. */
  async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const response = await this.request('tools/call', { name, arguments: args });
    if (response.error) throw new Error(`${name} failed: ${response.error.message}`);
    const content = (response.result?.['content'] ?? []) as Array<{ type: string; text?: string }>;
    const text = content.find((c) => c.type === 'text')?.text ?? '';
    if (response.result?.['isError'] === true) {
      throw new Error(`${name} returned an error: ${text}`);
    }
    return JSON.parse(text) as Record<string, unknown>;
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.child.stdin.end();
    this.child.kill();
    await once(this.child, 'close').catch(() => undefined);
    this.child = null;
  }
}

export function sample(name: string): string {
  return join(samplesDir, name);
}
