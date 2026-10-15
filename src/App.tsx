import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Role = 'assistant' | 'user';
type ToolStep = { id: string; name: string; server?: string | null; status: 'running' | 'done' | 'error'; error?: string };
type Risk = {
  mintAuthority: string;
  freezeAuthority: string;
  topTenTokenAccountSharePct: number | null;
  holderConcentrationNote: string;
  liquidityUsd: number | null;
  pairAgeHours: number | null;
  shieldStatus?: string;
  shieldWarnings?: Array<{ type: string; severity: string; message: string }>;
  honeypotPatternCheck: { status: string; message: string };
  warnings: string[];
};
type Quote = {
  inputMint: string;
  outputMint: string;
  inputName?: string;
  inputSymbol?: string;
  outputName?: string;
  outputSymbol?: string;
  amount: string;
  estimatedOut: string;
  minimumOut: string | null;
  slippageBps: number;
  fees: string;
  tradeUsd: number;
  provider: string;
  chain: string;
  priceImpactPct: number | null;
};
type Proposal = { id: string; status: string; expiresAt: number; quote: Quote; risk: Risk; requestId?: string; approvalUrl?: string | null; signature?: string | null };
type Message = { id: string; role: Role; text: string; steps: ToolStep[]; proposal?: Proposal; swapResult?: SwapResult };
type SwapResult = { status: string; requestId?: string; approvalUrl?: string | null; signature?: string | null; explorerUrl?: string | null; message?: string | null };
type Session = { tradingUnlocked: boolean; dailySpentUsd: number | null; maxTradeUsd: number | null; maxDailyUsd: number | null; history: Array<{ role: Role; content: string }>; pendingApproval: Proposal | null; requests: Array<{ requestId: string; approvalId?: string; status: string; approvalUrl?: string | null; signature?: string | null; proposal?: Proposal }> };
type Portfolio = { connected: boolean; walletAddress: string | null; portfolio: unknown; message?: string };
type EventHandler = (name: string, value: Record<string, unknown>) => void;

const SOL_MINT = 'So11111111111111111111111111111111111111112';
const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

function id() { return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`; }
function shortAddress(value?: string | null) { return value ? `${value.slice(0, 5)}…${value.slice(-5)}` : 'Not connected'; }
function money(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(value!);
}
function numberText(value?: number | null) {
  if (!Number.isFinite(value ?? NaN)) return 'Unavailable';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value!);
}
function scrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';
}
function titleCase(value: string) { return value.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function extractBalances(input: unknown): Array<{ symbol: string; amount: string; usd?: number }> {
  const found: Array<{ symbol: string; amount: string; usd?: number }> = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth = 0) => {
    if (!value || typeof value !== 'object' || depth > 5 || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    const row = value as Record<string, unknown>;
    const symbol = row.symbol ?? row.tokenSymbol ?? row.ticker;
    const amount = row.amount ?? row.balance ?? row.uiAmount ?? row.quantity;
    if (typeof symbol === 'string' && (typeof amount === 'number' || typeof amount === 'string')) {
      const usd = Number(row.usdValue ?? row.valueUsd ?? row.value_usd);
      found.push({ symbol: symbol.slice(0, 20), amount: String(amount), usd: Number.isFinite(usd) ? usd : undefined });
      return;
    }
    for (const child of Object.values(row)) visit(child, depth + 1);
  };
  visit(input);
  return found.slice(0, 8);
}

function latestProviderStatus(messages: Message[], toolNames: string[]) {
  const steps = messages.flatMap((message) => message.steps).filter((step) => toolNames.includes(step.name));
  const latest = steps.at(-1);
  if (!latest) return 'NOT QUERIED';
  if (latest.status === 'running') return 'CHECKING';
  if (latest.status === 'error') return 'ERROR';
  return 'RESPONDED';
}

async function requestJson<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'same-origin',
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error((data as { message?: string }).message || 'The request could not be completed.') as Error & { status?: number; code?: string };
    error.status = response.status;
    error.code = (data as { code?: string }).code;
    throw error;
  }
  return data as T;
}

async function readSse(response: Response, onEvent: EventHandler) {
  if (!response.ok || !response.body) {
    const data = await response.json().catch(() => ({}));
    throw new Error((data as { message?: string }).message || 'The chat connection could not be opened.');
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const process = (eventBlock: string) => {
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of eventBlock.split(/\r?\n/)) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    try { onEvent(eventName, JSON.parse(dataLines.join('\n')) as Record<string, unknown>); } catch { /* Ignore malformed provider events. */ }
  };
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let match: RegExpExecArray | null;
    const separator = /\r?\n\r?\n/g;
    while ((match = separator.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      separator.lastIndex = 0;
      process(block);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) process(buffer);
}

function Glyph({ name, size = 18 }: { name: 'orbit' | 'chat' | 'wallet' | 'search' | 'shield' | 'arrow' | 'lock' | 'copy' | 'refresh' | 'close' | 'send' | 'spark'; size?: number }) {
  const common = { width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true as const };
  const paths: Record<string, React.ReactNode> = {
    orbit: <><circle cx="11" cy="12" r="6.5" /><ellipse cx="12" cy="12" rx="10" ry="4" transform="rotate(-30 12 12)" /><circle cx="19" cy="6" r="1.4" fill="currentColor" stroke="none" /><path d="M8.2 14.5h3.1c1.1 0 1.8-.7 1.8-1.6s-.7-1.6-1.8-1.6H9.5" /></>,
    chat: <><path d="M20 11.5a7.5 7.5 0 0 1-8 7.5 8.7 8.7 0 0 1-3.6-.8L4 20l1.3-3.7A7.2 7.2 0 0 1 4 12c0-4.1 3.6-7.5 8-7.5s8 3.1 8 7Z" /><path d="M8 12h.01M12 12h.01M16 12h.01" /></>,
    wallet: <><rect x="3" y="6" width="18" height="14" rx="2" /><path d="M3 9h18M16 14h2" /><path d="M6 6V4h12" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.5 4.5" /></>,
    shield: <><path d="M12 3 19 6v5c0 4.5-2.6 7.8-7 10-4.4-2.2-7-5.5-7-10V6l7-3Z" /><path d="m9 12 2 2 4-4" /></>,
    arrow: <><path d="M5 12h14M13 6l6 6-6 6" /></>,
    lock: <><rect x="4" y="10" width="16" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6 9a7 7 0 0 1 12-2l2 2M4 15l2 2a7 7 0 0 0 12-2" /></>,
    close: <><path d="m6 6 12 12M18 6 6 18" /></>,
    send: <><path d="m22 2-7 20-4-9-9-4 20-7Z" /><path d="M22 2 11 13" /></>,
    spark: <><path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z" /><path d="m19 16 .8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16Z" /></>,
  };
  return <svg {...common}>{paths[name]}</svg>;
}

function RiskRow({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return <div className="risk-row"><span>{label}</span><strong className={warn ? 'risk-value is-warning' : 'risk-value'}>{value}</strong></div>;
}

function SwapCard({ proposal, result, onConfirm, onCancel, onPoll, busy }: {
  proposal: Proposal;
  result?: SwapResult;
  onConfirm: () => void;
  onCancel: () => void;
  onPoll: () => void;
  busy: boolean;
}) {
  const { quote, risk } = proposal;
  const pending = proposal.status === 'pending';
  const riskText = (value: string) => value === 'Active' ? 'Active' : value;
  return (
    <section className="swap-card" aria-label="Swap confirmation review">
      <div className="swap-card-top"><span className="eyebrow"><Glyph name="shield" size={14} /> USER CONFIRMATION REQUIRED</span><span className={`quote-state ${pending ? 'state-ready' : 'state-wait'}`}>{pending ? 'Quote ready' : titleCase(result?.status || proposal.status)}</span></div>
      <div className="swap-card-title"><div><p className="eyebrow">ASSET TO RECEIVE</p><h3>{quote.outputName || quote.outputSymbol || 'Name unavailable'}</h3><p className="token-symbol">{quote.outputSymbol ? `$${quote.outputSymbol}` : 'Solana token'}</p></div><div className="receive-amount"><strong>{quote.estimatedOut} {quote.outputSymbol || ''}</strong><span>estimated output</span></div></div>
      <div className="trade-grid">
        <div><span>Output mint</span><div className="address-inline"><code>{quote.outputMint}</code><button className="icon-button tiny" type="button" aria-label="Copy output token address" onClick={() => navigator.clipboard?.writeText(quote.outputMint)}><Glyph name="copy" size={13} /></button></div></div>
        <div><span>Input mint</span><div className="address-inline"><code>{quote.inputMint}</code><button className="icon-button tiny" type="button" aria-label="Copy input token address" onClick={() => navigator.clipboard?.writeText(quote.inputMint)}><Glyph name="copy" size={13} /></button></div></div>
        <div><span>Chain</span><strong>{quote.chain}</strong></div>
        <div><span>Amount in</span><strong>{quote.amount} {quote.inputSymbol || 'input token'}</strong><small>{quote.inputName ? `${quote.inputName} · ` : ''}{money(quote.tradeUsd)} estimated</small></div>
        <div><span>Minimum out</span><strong>{quote.minimumOut ? `${quote.minimumOut} ${quote.outputSymbol || ''}` : 'Unavailable'}</strong></div>
        <div><span>Slippage</span><strong>{(quote.slippageBps / 100).toFixed(2)}%</strong></div>
        <div><span>Fees</span><strong className="fee-text">{quote.fees}</strong></div>
      </div>
      <div className="risk-checks">
        <div className="risk-heading"><span>PRE-TRADE CHECKS</span><span className="risk-source">Solana RPC + market data</span></div>
        <RiskRow label="Liquidity" value={risk.liquidityUsd === null ? 'Unavailable' : money(risk.liquidityUsd)} warn={risk.liquidityUsd !== null && risk.liquidityUsd < 10000} />
        <RiskRow label="Pair age" value={risk.pairAgeHours === null ? 'Unavailable' : `${numberText(risk.pairAgeHours)} hours`} warn={risk.pairAgeHours !== null && risk.pairAgeHours < 24} />
        <RiskRow label="Mint authority" value={riskText(risk.mintAuthority)} warn={risk.mintAuthority === 'Active'} />
        <RiskRow label="Freeze authority" value={riskText(risk.freezeAuthority)} warn={risk.freezeAuthority === 'Active'} />
        <RiskRow label="Top 10 token accounts" value={risk.topTenTokenAccountSharePct === null ? 'Unavailable' : `${risk.topTenTokenAccountSharePct.toFixed(1)}%`} warn={risk.topTenTokenAccountSharePct !== null && risk.topTenTokenAccountSharePct >= 30} />
        <p className="risk-note">{risk.holderConcentrationNote}</p>
        <RiskRow label="Jupiter Shield" value={risk.shieldStatus === 'checked' ? `${(risk.shieldWarnings ?? []).length} warnings checked` : 'Unavailable'} warn={(risk.shieldWarnings ?? []).some((warning) => warning.severity === 'warning' || warning.severity === 'critical')} />
        <RiskRow label="Honeypot / sell risk" value={risk.honeypotPatternCheck.status === 'warning' ? 'Warning' : 'Not verified'} warn={risk.honeypotPatternCheck.status === 'warning'} />
        <p className="risk-note">{risk.honeypotPatternCheck.message}</p>
        {risk.warnings.length > 0 && <ul className="risk-warnings">{risk.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
      </div>
      <p className="quote-disclaimer">Quote from {quote.provider}. Market conditions can change. A PayBox passkey approval may also be required after you confirm here.</p>
      {result?.approvalUrl && <a className="paybox-approval" href={result.approvalUrl} target="_blank" rel="noreferrer">Open PayBox approval <Glyph name="arrow" size={15} /></a>}
      {result?.signature && <a className="paybox-approval" href={result.explorerUrl || `https://solscan.io/tx/${encodeURIComponent(result.signature)}`} target="_blank" rel="noreferrer">View transaction on Solscan <Glyph name="arrow" size={15} /></a>}
      {result?.message && <p className="result-message">{result.message}</p>}
      <div className="swap-actions">
        {pending ? <><button className="button button-muted" type="button" disabled={busy} onClick={onCancel}>Cancel</button><button className="button button-primary" type="button" disabled={busy} onClick={onConfirm}>{busy ? 'Sending once…' : 'Confirm swap'}</button></> : <><button className="button button-muted" type="button" disabled={busy || !(result?.requestId || proposal.requestId)} onClick={onPoll}><Glyph name="refresh" size={15} /> Refresh status</button><span className="final-status">{titleCase(result?.status || proposal.status)}</span></>}
      </div>
    </section>
  );
}

export function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [session, setSession] = useState<Session | null>(null);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [portfolioBusy, setPortfolioBusy] = useState(false);
  const [mobilePortfolioOpen, setMobilePortfolioOpen] = useState(false);
  const [swapDialogOpen, setSwapDialogOpen] = useState(false);
  const [swapForm, setSwapForm] = useState({ inputMint: SOL_MINT, outputMint: USDC_MINT, amount: '0.1', slippageBps: '100' });
  const [swapError, setSwapError] = useState('');
  const [sessionError, setSessionError] = useState('');
  const messagesEnd = useRef<HTMLDivElement>(null);
  const chatInput = useRef<HTMLTextAreaElement>(null);

  const loadSession = useCallback(async () => {
    try {
      const data = await requestJson<Session>('/api/session');
      setSession(data);
      if (messages.length === 0 && data.history?.length) {
        setMessages(data.history.map((item) => ({ id: id(), role: item.role, text: item.content, steps: [] })));
      }
      const requests = data.requests ?? [];
      const archived = requests.slice(0, 10).reverse().filter((request) => request.proposal).map((request) => {
        const terminal = ['success', 'denied', 'error'].includes(request.status);
        const proposal = { ...request.proposal!, status: terminal ? request.status : 'submitted', requestId: request.requestId, approvalUrl: request.approvalUrl, signature: request.signature };
        const swapResult: SwapResult = { status: request.status, requestId: request.requestId, approvalUrl: request.approvalUrl, signature: request.signature, explorerUrl: request.signature ? `https://solscan.io/tx/${encodeURIComponent(request.signature)}` : null };
        return { id: `swap-${request.requestId}`, role: 'assistant' as const, text: 'Previous swap request. Refresh its status below; MintChat will not submit it again.', steps: [], proposal, swapResult };
      });
      if (archived.length) {
        setMessages((current) => archived.reduce((next, restored) => next.some((message) => message.proposal?.id === restored.proposal.id) ? next : [...next, restored], current));
      }
      const pendingApproval = data.pendingApproval;
      if (pendingApproval && ['pending', 'submitted', 'unknown'].includes(pendingApproval.status)) {
        const linkedRequest = requests.find((request) => request.approvalId === pendingApproval.id);
        const terminal = linkedRequest && ['success', 'denied', 'error'].includes(linkedRequest.status);
        const proposal = { ...pendingApproval, status: linkedRequest ? (terminal ? linkedRequest.status : 'submitted') : pendingApproval.status, requestId: linkedRequest?.requestId, approvalUrl: linkedRequest?.approvalUrl, signature: linkedRequest?.signature };
        const result: SwapResult | undefined = linkedRequest
          ? { status: linkedRequest.status, requestId: linkedRequest.requestId, approvalUrl: linkedRequest.approvalUrl, signature: linkedRequest.signature, explorerUrl: linkedRequest.signature ? `https://solscan.io/tx/${encodeURIComponent(linkedRequest.signature)}` : null }
          : pendingApproval.status === 'unknown' ? { status: 'unknown', message: 'The provider result is unknown. Check PayBox request history; do not retry.' } : undefined;
        setMessages((current) => {
          const existing = current.findIndex((message) => message.proposal?.id === pendingApproval.id);
          if (existing >= 0) return current.map((message, index) => index === existing ? { ...message, proposal, swapResult: result } : message);
          return [...current, { id: id(), role: 'assistant', text: linkedRequest ? 'A previous swap request is available for status review.' : 'A swap review is awaiting your action.', steps: [], proposal, swapResult: result }];
        });
      }
      setSessionError('');
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Session status could not be loaded.');
    }
  }, [messages.length]);

  const loadPortfolio = useCallback(async () => {
    setPortfolioBusy(true);
    try {
      setPortfolio(await requestJson<Portfolio>('/api/portfolio'));
    } catch (error) {
      setPortfolio({ connected: false, walletAddress: null, portfolio: null, message: error instanceof Error ? error.message : 'Portfolio could not be loaded.' });
    } finally {
      setPortfolioBusy(false);
    }
  }, []);

  useEffect(() => { void loadSession(); void loadPortfolio(); }, [loadSession, loadPortfolio]);
  useEffect(() => { messagesEnd.current?.scrollIntoView({ behavior: scrollBehavior(), block: 'end' }); }, [messages.length, messages.at(-1)?.text]);

  const balances = useMemo(() => extractBalances(portfolio?.portfolio), [portfolio]);
  const dexStatus = latestProviderStatus(messages, ['get_token_market_data', 'get_token_risk']);
  const rpcStatus = latestProviderStatus(messages, ['get_token_risk']);
  const quoteToolStatus = latestProviderStatus(messages, ['request_swap_preview']);
  const quoteStatus = swapDialogOpen && busy ? 'CHECKING' : swapError ? 'ERROR' : quoteToolStatus !== 'NOT QUERIED' ? quoteToolStatus : messages.some((message) => Boolean(message.proposal)) ? 'RESPONDED' : 'NOT QUERIED';
  const messagesToShow = messages.length ? messages : [{ id: 'welcome', role: 'assistant' as const, text: 'I can look up Solana token facts, check your PayBox portfolio, and prepare a swap review. Trading stays locked until you unlock it.', steps: [] }];

  function patchMessage(messageId: string, update: (message: Message) => Message) {
    setMessages((items) => items.map((message) => message.id === messageId ? update(message) : message));
  }

  async function toggleTrading() {
    if (!session) return;
    try {
      const data = await requestJson<{ tradingUnlocked: boolean }>('/api/trading', { unlocked: !session.tradingUnlocked });
      setSession((current) => current ? { ...current, tradingUnlocked: data.tradingUnlocked, pendingApproval: data.tradingUnlocked ? current.pendingApproval : null } : current);
      if (!data.tradingUnlocked) {
        setMessages((current) => current.map((message) => message.proposal?.status === 'pending' ? { ...message, proposal: { ...message.proposal, status: 'cancelled' } } : message));
      }
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'Trading state could not be changed.');
    }
  }

  async function sendMessage(value = input) {
    const messageText = value.trim();
    if (!messageText || busy) return;
    const userId = id();
    const assistantId = id();
    setInput('');
    setBusy(true);
    setMessages((current) => [...current, { id: userId, role: 'user', text: messageText, steps: [] }, { id: assistantId, role: 'assistant', text: '', steps: [] }]);
    try {
      const response = await fetch('/api/chat', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: messageText }) });
      await readSse(response, (name, data) => {
        if (name === 'delta' && typeof data.text === 'string') {
          patchMessage(assistantId, (message) => ({ ...message, text: message.text + data.text }));
        } else if (name === 'tool_start') {
          const step: ToolStep = { id: String(data.id || id()), name: String(data.name || 'Tool'), server: typeof data.server === 'string' ? data.server : null, status: 'running' };
          patchMessage(assistantId, (message) => ({ ...message, steps: [...message.steps, step] }));
        } else if (name === 'tool_complete') {
          patchMessage(assistantId, (message) => ({ ...message, steps: message.steps.map((step) => step.id === String(data.id) ? { ...step, status: 'done' } : step) }));
        } else if (name === 'tool_error') {
          patchMessage(assistantId, (message) => ({ ...message, steps: message.steps.map((step) => step.id === String(data.id) ? { ...step, status: 'error', error: String(data.error || 'Tool call failed.') } : step) }));
        } else if (name === 'trade_proposal') {
          const proposal = data as unknown as Proposal;
          patchMessage(assistantId, (message) => ({ ...message, proposal }));
          setSession((current) => current ? { ...current, pendingApproval: proposal } : current);
        } else if (name === 'error') {
          patchMessage(assistantId, (message) => ({ ...message, text: message.text || String(data.message || 'The request failed.') }));
        }
      });
      await loadSession();
    } catch (error) {
      patchMessage(assistantId, (message) => ({ ...message, text: message.text || (error instanceof Error ? error.message : 'The chat could not connect.') }));
    } finally {
      setBusy(false);
      chatInput.current?.focus();
    }
  }

  async function createReview(event: React.FormEvent) {
    event.preventDefault();
    setSwapError('');
    setBusy(true);
    try {
      const proposal = await requestJson<Proposal>('/api/swap/preview', { ...swapForm, slippageBps: Number(swapForm.slippageBps) });
      setMessages((current) => [...current, { id: id(), role: 'assistant', text: 'Review the complete quote and risk checks below. Nothing has been submitted.', steps: [], proposal }]);
      setSession((current) => current ? { ...current, pendingApproval: proposal } : current);
      setSwapDialogOpen(false);
    } catch (error) {
      setSwapError(error instanceof Error ? error.message : 'A quote could not be prepared.');
    } finally {
      setBusy(false);
    }
  }

  async function confirmProposal(messageId: string, proposal: Proposal) {
    setBusy(true);
    try {
      const result = await requestJson<SwapResult>('/api/swap/confirm', { approvalId: proposal.id, confirmed: true });
      patchMessage(messageId, (message) => ({ ...message, proposal: { ...proposal, status: result.status }, swapResult: result }));
      setSession((current) => current ? { ...current, pendingApproval: { ...proposal, status: result.status }, requests: result.requestId ? [{ requestId: result.requestId, status: result.status, approvalUrl: result.approvalUrl }, ...current.requests] : current.requests } : current);
      if (result.requestId) await pollStatus(messageId, proposal, result.requestId);
    } catch (error) {
      const status = (error as Error & { status?: number }).status;
      if (status !== undefined && status < 500) {
        patchMessage(messageId, (message) => ({ ...message, proposal: { ...proposal, status: 'pending' }, swapResult: { status: 'not_submitted', message: `${error instanceof Error ? error.message : 'Preflight did not pass.'} No PayBox swap request was sent.` } }));
      } else {
        patchMessage(messageId, (message) => ({ ...message, proposal: { ...proposal, status: 'unknown' }, swapResult: { status: 'unknown', message: error instanceof Error ? error.message : 'The provider result is unknown. Do not retry before checking PayBox.' } }));
      }
    } finally {
      setBusy(false);
    }
  }

  async function pollStatus(messageId: string, proposal: Proposal, requestId: string) {
    try {
      const result = await requestJson<SwapResult>('/api/swap/status', { requestId });
      patchMessage(messageId, (message) => ({ ...message, proposal: { ...proposal, status: result.status }, swapResult: result }));
      setSession((current) => current ? { ...current, requests: current.requests.map((request) => request.requestId === requestId ? { ...request, status: result.status, signature: result.signature || undefined } : request) } : current);
    } catch (error) {
      patchMessage(messageId, (message) => ({ ...message, swapResult: { status: 'unavailable', requestId, message: error instanceof Error ? error.message : 'Status could not be refreshed. The swap was not retried.' } }));
    }
  }

  async function cancelProposal(messageId: string, proposal: Proposal) {
    setBusy(true);
    try {
      await requestJson('/api/swap/cancel', { approvalId: proposal.id });
      patchMessage(messageId, (message) => ({ ...message, proposal: { ...proposal, status: 'cancelled' }, swapResult: { status: 'cancelled', message: 'Cancelled. No PayBox swap request was sent.' } }));
      setSession((current) => current ? { ...current, pendingApproval: null } : current);
    } catch (error) {
      setSessionError(error instanceof Error ? error.message : 'The review could not be cancelled.');
    } finally {
      setBusy(false);
    }
  }

  function onComposerKeyDown(event: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      void sendMessage();
    }
  }

  return (
    <div className="app-shell">
      <aside className="nav-rail" aria-label="Primary navigation">
        <button className="brand-mark" type="button" aria-label="MintChat home" onClick={() => window.scrollTo({ top: 0, behavior: scrollBehavior() })}><Glyph name="orbit" size={28} /></button>
        <div className="rail-divider" />
        <button className="rail-button active" type="button" aria-label="Agent chat"><Glyph name="chat" /></button>
        <button className="rail-button" type="button" aria-label="Token research" onClick={() => chatInput.current?.focus()}><Glyph name="search" /></button>
        <button className="rail-button" type="button" aria-label="Wallet overview" onClick={() => setMobilePortfolioOpen((open) => !open)}><Glyph name="wallet" /></button>
        <div className="rail-bottom"><span className="online-dot" title="App online" /></div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div className="topbar-brand"><div className="brand-wordmark">MintChat<span className="brand-dot">.</span></div><span className="brand-subtitle">SOLANA RESEARCH DESK</span></div>
          <div className="topbar-center"><span className="network-mark" aria-hidden="true">◎</span><span>Solana Mainnet</span><span className="topbar-separator" /><span>External data · on demand</span></div>
          <div className="topbar-actions">
            <button className="wallet-chip" type="button" onClick={() => { setMobilePortfolioOpen(true); void loadPortfolio(); }} aria-label={`Wallet ${shortAddress(portfolio?.walletAddress)}`}><Glyph name="wallet" size={15} /><span>{shortAddress(portfolio?.walletAddress)}</span><span className={`tiny-dot ${portfolio?.connected ? 'connected' : ''}`} /></button>
            <button className={`lock-toggle ${session?.tradingUnlocked ? 'is-unlocked' : ''}`} type="button" aria-pressed={Boolean(session?.tradingUnlocked)} onClick={() => void toggleTrading()} disabled={!session}>
              <Glyph name="lock" size={15} /><span>{session?.tradingUnlocked ? 'Trading unlocked' : 'Trading locked'}</span><span className="toggle-knob" />
            </button>
            <button className="mobile-portfolio-trigger" type="button" aria-label="Open portfolio" onClick={() => setMobilePortfolioOpen(true)}><Glyph name="wallet" /></button>
          </div>
        </header>

        <div className="desk-layout">
          <section className="chat-column" aria-label="Agent conversation">
            <div className="conversation-head">
              <div><p className="eyebrow">PRIVATE SESSION <span className="session-id">{session ? `· ${String((session as Session & { session?: string }).session || 'ACTIVE')}` : '· CONNECTING'}</span></p><h1>Research with <span>context.</span></h1></div>
              <div className="conversation-meta"><span className="meta-dot" /> Sessions are private to this browser</div>
            </div>

            {sessionError && <div className="inline-alert" role="status"><Glyph name="shield" size={15} />{sessionError}</div>}

            <div className="conversation-scroll" role="log" aria-live="polite" aria-relevant="additions text">
              <div className="day-divider"><span>SESSION</span><i /></div>
              {messagesToShow.map((message) => (
                <article className={`message-row ${message.role === 'user' ? 'from-user' : 'from-agent'}`} key={message.id}>
                  {message.role === 'assistant' && <div className="agent-avatar"><Glyph name="orbit" size={17} /></div>}
                  <div className="message-body">
                    {message.role === 'assistant' && <div className="message-label">MINTCHAT <span>· AGENT</span></div>}
                    <div className="message-content">{message.text || (busy && message.role === 'assistant' ? <span className="typing-state"><i /><i /><i /><span>Checking the available sources</span></span> : null)}</div>
                    {message.steps.length > 0 && <div className="tool-steps">
                      {message.steps.map((step) => <details className={`tool-step ${step.status}`} key={step.id}>
                        <summary><span className={`step-icon ${step.status}`}>{step.status === 'running' ? <span className="spinner" /> : step.status === 'done' ? '✓' : '!'}</span><span>{step.server ? `${step.server} · ` : ''}{step.name}</span><span className="step-status">{step.status === 'running' ? 'Running' : step.status === 'done' ? 'Complete' : 'Needs attention'}</span></summary>
                        <div className="step-detail">{step.error || 'This step is read-only. Provider output is treated as untrusted data.'}</div>
                      </details>)}
                    </div>}
                    {message.proposal && <SwapCard proposal={message.proposal} result={message.swapResult} busy={busy} onConfirm={() => void confirmProposal(message.id, message.proposal!)} onCancel={() => void cancelProposal(message.id, message.proposal!)} onPoll={() => { const requestId = message.swapResult?.requestId || message.proposal?.requestId; if (requestId) void pollStatus(message.id, message.proposal!, requestId); }} />}
                  </div>
                  {message.role === 'user' && <div className="user-avatar">YOU</div>}
                </article>
              ))}
              <div ref={messagesEnd} />
            </div>

            {messages.length === 0 && <div className="starter-prompts" aria-label="Suggested prompts">
              <button type="button" onClick={() => void sendMessage('Look up this Solana mint and show its price, liquidity, volume, and pair age: ')}><Glyph name="search" size={15} /> Look up a mint <Glyph name="arrow" size={13} /></button>
              <button type="button" onClick={() => void sendMessage('Check my PayBox wallet balances.') }><Glyph name="wallet" size={15} /> Check wallet balances <Glyph name="arrow" size={13} /></button>
              <button type="button" onClick={() => setSwapDialogOpen(true)}><Glyph name="shield" size={15} /> Prepare a swap review <Glyph name="arrow" size={13} /></button>
            </div>}

            <div className="composer-wrap">
              <div className="composer-shell">
                <textarea ref={chatInput} value={input} onChange={(event) => setInput(event.target.value)} onKeyDown={onComposerKeyDown} placeholder="Ask about a Solana token, a wallet, or market data…" rows={1} maxLength={4000} aria-label="Message MintChat" />
                <div className="composer-controls">
                  <div className="composer-left"><span className="composer-hint"><kbd>Enter</kbd> to send <span>·</span> <kbd>Shift + Enter</kbd> for a new line</span><button className="review-link" type="button" onClick={() => setSwapDialogOpen(true)} disabled={!session?.tradingUnlocked}><Glyph name="shield" size={14} /> Review a swap</button></div>
                  <button className="send-button" type="button" onClick={() => void sendMessage()} disabled={!input.trim() || busy} aria-label="Send message"><Glyph name="send" size={17} /></button>
                </div>
              </div>
              <p className="composer-footnote"><Glyph name="lock" size={12} /> Read-only research stays available while trading is locked. Quotes are not recommendations.</p>
            </div>
          </section>

          <aside className={`portfolio-panel ${mobilePortfolioOpen ? 'mobile-open' : ''}`} aria-label="Wallet and market status">
            <div className="portfolio-header"><div><p className="eyebrow">ACCOUNT</p><h2>Portfolio</h2></div><button className="icon-button mobile-close" type="button" aria-label="Close portfolio" onClick={() => setMobilePortfolioOpen(false)}><Glyph name="close" /></button><button className="icon-button" type="button" aria-label="Refresh portfolio" onClick={() => void loadPortfolio()} disabled={portfolioBusy}><Glyph name="refresh" /></button></div>
            <div className="wallet-card">
              <div className="wallet-card-top"><span className="wallet-icon"><Glyph name="wallet" size={18} /></span><span className={`connection-pill ${portfolio?.connected ? 'on' : ''}`}><i />{portfolio?.connected ? 'CONNECTED' : 'NOT CONNECTED'}</span></div>
              <p className="eyebrow">PAYBOX WALLET</p>
              <div className="wallet-address">{portfolio?.walletAddress ? <code>{shortAddress(portfolio.walletAddress)}</code> : <span>Waiting for PayBox</span>}</div>
              <p className="wallet-help">Use a small, dedicated wallet. Never connect your main wallet.</p>
              {!portfolio?.connected && <div className="setup-hint"><span className="setup-hint-mark"><Glyph name="shield" size={14} /></span><span>{portfolio?.message || 'Add a scoped PAYBOX_ACCESS_TOKEN on the server to read balances.'}</span></div>}
            </div>

            <div className="panel-section">
              <div className="section-title"><h3>Token balances</h3><span>{balances.length ? `${balances.length} assets` : 'LIVE'}</span></div>
              {portfolioBusy ? <div className="panel-state"><span className="spinner" />Loading portfolio…</div> : balances.length > 0 ? <div className="balance-list">{balances.map((balance, index) => <div className="balance-row" key={`${balance.symbol}-${index}`}><span className="token-avatar">{balance.symbol.slice(0, 1)}</span><div className="balance-name"><strong>{balance.symbol}</strong><span>Solana asset</span></div><div className="balance-amount"><strong>{balance.amount}</strong><span>{balance.usd === undefined ? 'Value unavailable' : money(balance.usd)}</span></div></div>)}</div> : <div className="panel-state empty-state"><span className="empty-glyph"><Glyph name="wallet" size={17} /></span><strong>No balances to show</strong><span>{portfolio?.message || 'Connect a PayBox wallet to load live balances.'}</span></div>}
            </div>

            <div className="panel-section data-section">
              <div className="section-title"><h3>Data sources</h3><span className="source-state">ON DEMAND</span></div>
              <div className="source-row"><span className="source-icon dex-icon">D</span><span><strong>DexScreener</strong><small>Price · liquidity · volume · age</small></span><span className="source-state">{dexStatus}</span></div>
              <div className="source-row"><span className="source-icon sol-icon">◎</span><span><strong>Solana RPC</strong><small>Authority · supply · token accounts</small></span><span className="source-state">{rpcStatus}</span></div>
  <div className="source-row"><span className="source-icon jup-icon">J</span><span><strong>Jupiter quotes</strong><small>Quote only · no signing</small></span><span className="source-state">{quoteStatus}</span></div>
  <div className="source-row"><span className="source-icon agent-icon">A</span><span><strong>Agent runtime</strong><small>OpenClaw / Docker Agent boundary</small></span><span className="source-state">LOCAL</span></div>
  <div className="source-row"><span className="source-icon local-icon">G</span><span><strong>Local model lane</strong><small>GPT4All-compatible research fallback</small></span><span className="source-state">OPT-IN</span></div>
  </div>

            <div className="panel-section guardrail-section">
              <div className="section-title"><h3>Trading guardrails</h3></div>
              <div className="guardrail-row"><span>Per trade</span><strong>{session?.maxTradeUsd ? money(session.maxTradeUsd) : 'Not configured'}</strong></div>
              <div className="guardrail-row"><span>Daily cap</span><strong>{session?.maxDailyUsd ? money(session.maxDailyUsd) : 'Not configured'}</strong></div>
              <div className="guardrail-row"><span>Used today</span><strong>{money(session?.dailySpentUsd)}</strong></div>
              <p className="panel-note">Caps are enforced server-side for this browser session. UTC day boundary.</p>
            </div>

            <div className="portfolio-footer"><span className="secure-mark"><Glyph name="shield" size={13} /></span><span>Keys stay on the server.<br />Every swap requires your confirmation.</span></div>
          </aside>
        </div>
      </main>

      {swapDialogOpen && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSwapDialogOpen(false); }}>
        <section className="swap-modal" role="dialog" aria-modal="true" aria-labelledby="swap-modal-title">
          <div className="modal-header"><div><p className="eyebrow">READ-ONLY QUOTE</p><h2 id="swap-modal-title">Prepare a swap review</h2></div><button className="icon-button" type="button" aria-label="Close dialog" onClick={() => { setSwapDialogOpen(false); setSwapError(''); }}><Glyph name="close" /></button></div>
          <p className="modal-copy">This creates a quote and risk review only. PayBox is not contacted to submit a swap until you confirm the complete card.</p>
          {!session?.tradingUnlocked && <div className="inline-alert modal-alert"><Glyph name="lock" size={15} />Unlock trading in the header before preparing a review.</div>}
          <form onSubmit={(event) => void createReview(event)}>
            <label>Input token mint<input value={swapForm.inputMint} onChange={(event) => setSwapForm((current) => ({ ...current, inputMint: event.target.value.trim() }))} autoComplete="off" spellCheck={false} required /></label>
            <label>Output token mint<input value={swapForm.outputMint} onChange={(event) => setSwapForm((current) => ({ ...current, outputMint: event.target.value.trim() }))} autoComplete="off" spellCheck={false} required /></label>
            <div className="form-split"><label>Amount in<input value={swapForm.amount} onChange={(event) => setSwapForm((current) => ({ ...current, amount: event.target.value }))} inputMode="decimal" placeholder="0.1" required /></label><label>Slippage<input value={swapForm.slippageBps} onChange={(event) => setSwapForm((current) => ({ ...current, slippageBps: event.target.value }))} inputMode="numeric" placeholder="100" required /><small>Basis points · max 500</small></label></div>
            {swapError && <div className="inline-alert error-alert" role="alert">{swapError}</div>}
            <div className="modal-actions"><button className="button button-muted" type="button" onClick={() => setSwapDialogOpen(false)}>Cancel</button><button className="button button-primary" type="submit" disabled={busy || !session?.tradingUnlocked}>{busy ? 'Preparing…' : 'Get quote & risk checks'}</button></div>
          </form>
          <p className="modal-footnote"><Glyph name="shield" size={13} /> No token approval or transaction will be signed in this step.</p>
        </section>
      </div>}
    </div>
  );
}
