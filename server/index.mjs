import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgentTurn } from './agent.mjs';
import { getPortfolio } from './paybox.mjs';
import { createSwapPreview, confirmSwap, cancelSwap, refreshSwapStatus } from './trading.mjs';
import { availablePlugins, loadPlugins } from './plugins.mjs';
import { createStore } from './store.mjs';
import { assertJsonObject, parseUsdCap, PolicyError, sanitizeProviderText, validateChatPayload, validateSwapPreview } from './policy.mjs';
import { getTokenRisk, searchMarket } from './market.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const DIST = resolve(ROOT, 'dist');
const COOKIE_NAME = 'mintchat_session';
const MAX_BODY_BYTES = 64 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

function setSecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; img-src 'self' data: https:; font-src 'self' https://fonts.gstatic.com; connect-src 'self'; worker-src 'self'; manifest-src 'self'; base-uri 'self'; form-action 'self'");
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const index = part.indexOf('=');
    return index < 0 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
  }));
}

function setSessionCookie(req, res, token) {
  const localHttp = process.env.SESSION_COOKIE_SECURE === 'false';
  const sameSite = localHttp ? (process.env.SESSION_COOKIE_SAMESITE || 'Lax') : (process.env.SESSION_COOKIE_SAMESITE || 'None');
  const secure = localHttp ? '' : '; Secure';
  const maxAge = 60 * 60 * 24 * 30;
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAge}${secure}`);
}

async function sessionFor(req, res, store) {
  const cookies = parseCookies(req.headers.cookie);
  let token = cookies[COOKIE_NAME];
  if (!token || !/^[A-Za-z0-9_-]{40,60}$/.test(token)) {
    token = randomBytes(32).toString('base64url');
    setSessionCookie(req, res, token);
  }
  const sessionId = createHash('sha256').update(token).digest('hex');
  const state = await store.loadSession(sessionId);
  return { sessionId, state };
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new PolicyError('payload_too_large', 'Request is larger than 64 KB.');
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return assertJsonObject(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
  catch (error) {
    if (error instanceof PolicyError) throw error;
    throw new PolicyError('invalid_input', 'Request body must be valid JSON.');
  }
}

function expectedRequestOrigin(req) {
  const configured = (process.env.APP_ORIGIN || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (configured.length) return configured;
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const protocol = String(req.headers['x-forwarded-proto'] || (process.env.NODE_ENV === 'production' ? 'https' : 'http')).split(',')[0].trim();
  return host ? [`${protocol}://${host}`] : [];
}

function requireSameOrigin(req) {
  const origin = req.headers.origin;
  const allowed = expectedRequestOrigin(req);
  if (typeof origin !== 'string' || !allowed.includes(origin)) {
    throw new PolicyError('origin_rejected', 'This request did not come from the MintChat application origin.');
  }
  const contentType = String(req.headers['content-type'] || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    throw new PolicyError('invalid_content_type', 'Use a JSON request from the MintChat application.');
  }
}

const rateBuckets = new Map();
function rateLimit(req, sessionId, isChat = false) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown').split(',')[0].trim();
  const key = `${ip}:${sessionId}:${isChat ? 'chat' : 'api'}`;
  const now = Date.now();
  const max = isChat ? 12 : 40;
  const bucket = rateBuckets.get(key);
  if (!bucket || bucket.start + 60000 <= now) {
    rateBuckets.set(key, { start: now, count: 1 });
    if (rateBuckets.size > 5000) {
      for (const [entry, value] of rateBuckets) if (value.start + 60000 <= now) rateBuckets.delete(entry);
    }
    return;
  }
  if (bucket.count >= max) throw new PolicyError('rate_limited', 'Too many requests. Wait a minute and try again.');
  bucket.count += 1;
}

function sendJson(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  res.end(JSON.stringify(payload));
}

function sendSse(res, event, payload) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function publicHistory(history) {
  return history.slice(-30).map((item) => ({ role: item.role, content: sanitizeProviderText(item.content, 6000), createdAt: item.createdAt }));
}

function publicPending(state) {
  const pending = state.pendingApproval;
  if (!pending || !['pending', 'submitted', 'unknown'].includes(pending.status)) return null;
  const request = state.requests.find((item) => item.approvalId === pending.id);
  return {
    ...pending,
    requestId: request?.requestId ?? null,
    approvalUrl: request?.approvalUrl ?? null,
    signature: request?.signature ?? null,
  };
}

function safeError(error) {
  if (error instanceof PolicyError) return { status: error.code === 'execution_unknown' ? 503 : 400, code: error.code, message: error.message };
  if (error?.status === 429) return { status: 503, code: 'provider_busy', message: 'The AI or data provider is busy. Wait briefly and try again.' };
  if (error?.status === 401 || error?.status === 403) return { status: 503, code: 'provider_auth', message: 'A provider rejected its server-side credentials. Check the configured access token and permissions.' };
  return { status: 503, code: 'service_unavailable', message: sanitizeProviderText(error?.message || 'The request could not be completed.', 500) };
}

async function serveStatic(req, res) {
  const path = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const resolved = resolve(DIST, `.${path}`);
  if (!resolved.startsWith(`${DIST}${sep}`) && resolved !== resolve(DIST, 'index.html')) {
    sendJson(res, 400, { error: 'invalid_path' });
    return;
  }
  let target = resolved;
  try {
    if ((await stat(target)).isDirectory()) target = resolve(target, 'index.html');
  } catch {
    if (path.startsWith('/api/')) {
      sendJson(res, 404, { error: 'not_found', message: 'API route was not found.' });
      return;
    }
    target = resolve(DIST, 'index.html');
  }
  try {
    const body = await readFile(target);
    res.writeHead(200, { 'Content-Type': MIME[extname(target)] || 'application/octet-stream', 'Cache-Control': extname(target) === '.html' ? 'no-cache' : 'public, max-age=300' });
    res.end(body);
  } catch {
    sendJson(res, 404, { error: 'not_found' });
  }
}

async function main() {
  const store = await createStore(process.env);
  const plugins = await loadPlugins();
  const payboxPlugin = plugins.find((plugin) => plugin.name === 'paybox');
  const apiLimiter = { store, plugins, payboxPlugin };
  let vite = null;
  if (process.env.NODE_ENV !== 'production' || !existsSync(resolve(DIST, 'index.html'))) {
    const { createServer: createViteServer } = await import('vite');
    vite = await createViteServer({
      configFile: resolve(ROOT, 'vite.config.ts'),
      root: ROOT,
      server: { middlewareMode: true, hmr: { server: undefined } },
      appType: 'spa',
    });
  }

  const server = createServer(async (req, res) => {
    setSecurityHeaders(res);
    const pathname = new URL(req.url, 'http://localhost').pathname;
    try {
      if (req.method === 'GET' && pathname === '/api/health') {
        sendJson(res, 200, { ok: true, app: 'MintChat', database: process.env.DATABASE_URL ? 'configured' : 'development-memory' });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/session') {
        const { sessionId, state } = await sessionFor(req, res, store);
        rateLimit(req, sessionId);
        sendJson(res, 200, {
          tradingUnlocked: state.tradingUnlocked,
          dailySpentUsd: state.dailySpentUsd >= 0 ? Number(state.dailySpentUsd) : null,
          maxTradeUsd: Number(process.env.MAX_TRADE_USD) || null,
          maxDailyUsd: Number(process.env.MAX_DAILY_USD) || null,
          history: publicHistory(state.history),
          pendingApproval: publicPending(state),
          requests: state.requests.slice(0, 10),
          plugins: availablePlugins(plugins, process.env),
          session: sessionId.slice(0, 10),
        });
        return;
      }
      if (req.method === 'GET' && pathname === '/api/portfolio') {
        const { sessionId } = await sessionFor(req, res, store);
        rateLimit(req, sessionId);
        if (!payboxPlugin || !payboxPlugin.tokenEnv || !process.env[payboxPlugin.tokenEnv]) {
          sendJson(res, 200, { connected: false, walletAddress: null, portfolio: null, message: 'PayBox is not connected yet. Add a scoped server-side OAuth access token to the runtime environment.' });
          return;
        }
        try {
          const portfolio = await getPortfolio(payboxPlugin, { env: process.env });
          await store.mutateSession(sessionId, (current) => { current.walletAddress = portfolio.walletAddress ?? null; });
          await store.logToolCall({ sessionId, plugin: 'paybox', tool: 'list_credentials', outcome: 'read', details: {} });
          await store.logToolCall({ sessionId, plugin: 'paybox', tool: 'get_portfolio', outcome: 'read', details: {} });
          sendJson(res, 200, portfolio);
        } catch (error) {
          sendJson(res, 503, { connected: false, walletAddress: null, portfolio: null, message: safeError(error).message });
        }
        return;
      }
      if (pathname.startsWith('/api/')) {
        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'method_not_allowed', message: 'Use POST for API changes.' });
          return;
        }
        requireSameOrigin(req);
        const body = await readJsonBody(req);
        const { sessionId, state } = await sessionFor(req, res, store);
        rateLimit(req, sessionId, pathname === '/api/chat');

        if (pathname === '/api/chat') {
          const { message } = validateChatPayload(body);
          await store.mutateSession(sessionId, (current) => {
            current.history.push({ role: 'user', content: message, createdAt: new Date().toISOString() });
            current.history = current.history.slice(-60);
          });
          const controller = new AbortController();
          res.on('close', () => { if (!res.writableEnded) controller.abort(); });
          res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'private, no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
          });
          sendSse(res, 'start', { tradingUnlocked: state.tradingUnlocked });
          const onEvent = (event) => {
            if (event.type === 'tool_start' && event.name) {
              const pluginName = event.server || (event.name === 'request_swap_preview' ? 'trade-review' : 'market-data');
              store.logToolCall({ sessionId, plugin: pluginName, tool: event.name, outcome: 'started', details: {} }).catch(() => undefined);
            } else if ((event.type === 'tool_complete' || event.type === 'tool_error') && event.name) {
              const pluginName = event.server || (event.name === 'request_swap_preview' ? 'trade-review' : 'market-data');
              store.logToolCall({ sessionId, plugin: pluginName, tool: event.name, outcome: event.type === 'tool_complete' ? 'complete' : 'error', details: {} }).catch(() => undefined);
            }
            sendSse(res, event.type, event);
          };
          try {
            const answer = await runAgentTurn({
              message,
              history: state.history,
              plugins,
              env: { ...process.env, __MINTCHAT_TRADING_UNLOCKED: String(state.tradingUnlocked) },
              signal: controller.signal,
              onEvent,
              localToolHandler: async (name, input) => {
                if (name === 'get_token_market_data') return searchMarket(input.query);
                if (name === 'get_token_risk') return getTokenRisk(input.mint);
                if (name === 'request_swap_preview') {
                  const request = validateSwapPreview(input);
                  const proposal = await createSwapPreview(request, { sessionId, store, env: process.env });
                  sendSse(res, 'trade_proposal', proposal);
                  return { proposalId: proposal.id, status: 'awaiting_user_confirmation', note: 'A quote is displayed in the UI. Do not treat this as an executed swap.' };
                }
                throw new PolicyError('unknown_tool', 'This local tool is not available.');
              },
            });
            if (answer.text) {
              await store.mutateSession(sessionId, (current) => {
                current.history.push({ role: 'assistant', content: sanitizeProviderText(answer.text, 6000), createdAt: new Date().toISOString() });
              });
            }
            sendSse(res, 'done', { ok: true });
            res.end();
          } catch (error) {
            const safe = safeError(error);
            sendSse(res, 'error', { code: safe.code, message: safe.message });
            res.end();
          }
          return;
        }

        if (pathname === '/api/trading') {
          if (typeof body.unlocked !== 'boolean') throw new PolicyError('invalid_input', 'Provide a boolean trading lock state.');
          if (body.unlocked) {
            if (!payboxPlugin || !payboxPlugin.tokenEnv || !process.env[payboxPlugin.tokenEnv]) {
              throw new PolicyError('paybox_unconfigured', 'Add a scoped PayBox OAuth bearer access token to the server environment before unlocking trading.');
            }
            if (!parseUsdCap(process.env.MAX_TRADE_USD) || !parseUsdCap(process.env.MAX_DAILY_USD)) {
              throw new PolicyError('caps_not_configured', 'Set valid positive MAX_TRADE_USD and MAX_DAILY_USD values before unlocking trading.');
            }
            const portfolio = await getPortfolio(payboxPlugin, { env: process.env });
            await store.mutateSession(sessionId, (current) => { current.walletAddress = portfolio.walletAddress; });
            await store.logToolCall({ sessionId, plugin: 'paybox', tool: 'list_credentials', outcome: 'read', details: { purpose: 'trading_unlock' } });
            await store.logToolCall({ sessionId, plugin: 'paybox', tool: 'get_portfolio', outcome: 'read', details: { purpose: 'trading_unlock' } });
          }
          const { state: updated } = await store.mutateSession(sessionId, (current) => {
            current.tradingUnlocked = body.unlocked;
            if (!body.unlocked && current.pendingApproval?.status === 'pending') current.pendingApproval.status = 'cancelled';
          });
          sendJson(res, 200, { tradingUnlocked: updated.tradingUnlocked });
          return;
        }

        if (pathname === '/api/market/search') {
          if (typeof body.query !== 'string' || body.query.length > 120) throw new PolicyError('invalid_input', 'Search text must be at most 120 characters.');
          sendJson(res, 200, await searchMarket(body.query));
          return;
        }

        if (pathname === '/api/swap/preview') {
          if (!payboxPlugin) throw new PolicyError('plugin_missing', 'PayBox is missing from plugins.json.');
          const input = validateSwapPreview(body);
          const proposal = await createSwapPreview(input, { sessionId, store, env: process.env });
          await store.logToolCall({ sessionId, plugin: 'jupiter', tool: 'get_quote', outcome: 'quoted', details: {} });
          sendJson(res, 200, proposal);
          return;
        }

        if (pathname === '/api/swap/confirm') {
          if (!payboxPlugin) throw new PolicyError('plugin_missing', 'PayBox is missing from plugins.json.');
          const result = await confirmSwap({ sessionId, approvalId: body.approvalId, confirmed: body.confirmed, store, payboxPlugin, env: process.env });
          await store.logToolCall({ sessionId, plugin: 'paybox', tool: 'request_swap', outcome: result.status, details: { requestId: result.requestId ?? null } });
          sendJson(res, 200, result);
          return;
        }

        if (pathname === '/api/swap/cancel') {
          const result = await cancelSwap({ sessionId, approvalId: body.approvalId, store });
          sendJson(res, 200, result.result);
          return;
        }

        if (pathname === '/api/swap/status') {
          if (!payboxPlugin) throw new PolicyError('plugin_missing', 'PayBox is missing from plugins.json.');
          const result = await refreshSwapStatus({ sessionId, requestId: body.requestId, store, payboxPlugin, env: process.env });
          await store.logToolCall({ sessionId, plugin: 'paybox', tool: 'get_request', outcome: result.status, details: { requestId: result.requestId } });
          sendJson(res, 200, result);
          return;
        }

        sendJson(res, 404, { error: 'not_found', message: 'API route was not found.' });
        return;
      }

      if (vite) {
        vite.middlewares(req, res, () => serveStatic(req, res));
      } else {
        await serveStatic(req, res);
      }
    } catch (error) {
      const safe = safeError(error);
      if (!res.headersSent) sendJson(res, safe.status, { error: safe.code, message: safe.message });
      else if (!res.writableEnded) res.end();
    }
  });

  const port = Number(process.env.PORT || 3000);
  server.listen(port, '0.0.0.0', () => console.log(`MintChat listening on 0.0.0.0:${port}`));
  const shutdown = async () => {
    server.close();
    await vite?.close();
    await apiLimiter.store.close();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error(`MintChat startup failed: ${sanitizeProviderText(error?.message || 'unknown error', 300)}`);
  process.exitCode = 1;
});
