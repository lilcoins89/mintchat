export class McpClient {
  constructor({ url, token, fetchImpl = fetch, timeoutMs = 12000 }) {
    this.url = url;
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.sessionId = null;
    this.requestId = 0;
    this.initialized = false;
    this.protocolVersion = null;
  }

  async request(method, params = {}, notification = false) {
    const id = notification ? undefined : ++this.requestId;
    const headers = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    if (this.protocolVersion) headers['MCP-Protocol-Version'] = this.protocolVersion;
    const body = { jsonrpc: '2.0', method, params };
    if (id !== undefined) body.id = id;

    const response = await this.fetchImpl(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const returnedSession = response.headers.get('mcp-session-id');
    if (returnedSession) this.sessionId = returnedSession;
    if (!response.ok && response.status !== 202) {
      const error = new Error(`MCP request failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    if (notification || response.status === 202) return null;

    const text = await response.text();
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      const messages = text.split(/\r?\n\r?\n/).flatMap((event) => {
        const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
        if (!data || data === '[DONE]') return [];
        try { return [JSON.parse(data)]; } catch { return []; }
      });
      const message = [...messages].reverse().find((item) => item.id === id || item.result || item.error);
      if (!message) throw new Error('MCP returned no JSON-RPC result.');
      if (message.error) throw new Error('MCP returned a JSON-RPC error.');
      return message.result;
    }
    let message;
    try { message = JSON.parse(text); } catch { throw new Error('MCP returned an invalid JSON response.'); }
    if (message.error) throw new Error('MCP returned a JSON-RPC error.');
    return message.result;
  }

  async initialize() {
    if (this.initialized) return;
    const result = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'mintchat-server', version: '1.0.0' },
    });
    if (!result || typeof result.protocolVersion !== 'string') throw new Error('MCP initialization did not return a negotiated protocol version.');
    this.protocolVersion = result.protocolVersion;
    await this.request('notifications/initialized', {}, true);
    this.initialized = true;
  }

  async listTools() {
    await this.initialize();
    const result = await this.request('tools/list', {});
    if (!Array.isArray(result?.tools)) throw new Error('MCP server did not return a tools list.');
    return result.tools;
  }

  async callTool(name, argumentsValue = {}) {
    await this.initialize();
    const result = await this.request('tools/call', { name, arguments: argumentsValue });
    if (result?.isError) throw new Error(`MCP tool ${name} returned an error.`);
    return result;
  }
}

export function textFromMcpResult(result) {
  if (typeof result === 'string') return result;
  const parts = (result?.content ?? []).filter((item) => item.type === 'text' && typeof item.text === 'string').map((item) => item.text);
  return parts.join('\n');
}
