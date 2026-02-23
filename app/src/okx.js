const crypto = require('crypto');

function signOkx({ timestamp, method, requestPathWithQuery, body, apiSecret }) {
  const payload = `${timestamp}${method.toUpperCase()}${requestPathWithQuery}${body || ''}`;
  return crypto.createHmac('sha256', apiSecret).update(payload).digest('base64');
}

async function okxRequest({ method, path, apiKey, apiSecret, apiPassphrase, baseUrl, query = {}, body = null }) {
  const cleanApiKey = String(apiKey || '').trim();
  const cleanApiSecret = String(apiSecret || '').trim();
  const cleanPassphrase = String(apiPassphrase || '').trim();
  const cleanBaseUrl = String(baseUrl || '').trim();
  const jsonBody = body ? JSON.stringify(body) : '';

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === null || v === undefined || v === '') continue;
    params.set(k, String(v));
  }
  const queryString = params.toString();
  const requestPathWithQuery = queryString ? `${path}?${queryString}` : path;
  const timestamp = new Date().toISOString();
  const sign = signOkx({
    timestamp,
    method,
    requestPathWithQuery,
    body: method.toUpperCase() === 'POST' ? jsonBody : '',
    apiSecret: cleanApiSecret,
  });

  const res = await fetch(`${cleanBaseUrl}${requestPathWithQuery}`, {
    method,
    headers: {
      'OK-ACCESS-KEY': cleanApiKey,
      'OK-ACCESS-SIGN': sign,
      'OK-ACCESS-TIMESTAMP': timestamp,
      'OK-ACCESS-PASSPHRASE': cleanPassphrase,
      'Content-Type': 'application/json',
    },
    body: method.toUpperCase() === 'POST' ? jsonBody : undefined,
  });

  const rawText = await res.text();
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch (_err) {
    parsed = null;
  }

  if (!res.ok) {
    throw new Error(`OKX error: ${rawText ? rawText.slice(0, 200) : `HTTP ${res.status}`}`);
  }

  if (parsed && String(parsed.code || '0') !== '0') {
    throw new Error(`OKX error: ${parsed.msg || 'unknown error'}`);
  }

  return parsed || {};
}

async function fetchOkxSpotFills({ apiKey, apiSecret, apiPassphrase, baseUrl, beginMs, endMs, limit = 100 }) {
  const body = await okxRequest({
    method: 'GET',
    path: '/api/v5/trade/fills-history',
    apiKey,
    apiSecret,
    apiPassphrase,
    baseUrl,
    query: {
      instType: 'SPOT',
      begin: beginMs,
      end: endMs,
      limit: Math.max(1, Math.min(100, Number(limit || 100))),
    },
  });

  return Array.isArray(body.data) ? body.data : [];
}

async function fetchOkxSpotFillsAll({
  apiKey,
  apiSecret,
  apiPassphrase,
  baseUrl,
  pageLimit = 100,
  maxPages = 300,
}) {
  const all = [];
  let before = '';
  let pages = 0;

  while (pages < Math.max(1, Number(maxPages || 1))) {
    const body = await okxRequest({
      method: 'GET',
      path: '/api/v5/trade/fills-history',
      apiKey,
      apiSecret,
      apiPassphrase,
      baseUrl,
      query: {
        instType: 'SPOT',
        limit: Math.max(1, Math.min(100, Number(pageLimit || 100))),
        before: before || undefined,
      },
    });

    const data = Array.isArray(body.data) ? body.data : [];
    all.push(...data);
    pages += 1;

    if (!data.length) break;

    const last = data[data.length - 1] || {};
    const nextBefore = String(last.billId || last.tradeId || '').trim();
    if (!nextBefore || nextBefore === before) break;
    before = nextBefore;
  }

  return all;
}

async function fetchOkxSpotFillsArchive({
  apiKey,
  apiSecret,
  apiPassphrase,
  baseUrl,
  beginMs,
  endMs,
  limit = 100,
}) {
  const body = await okxRequest({
    method: 'GET',
    path: '/api/v5/trade/fills-archive',
    apiKey,
    apiSecret,
    apiPassphrase,
    baseUrl,
    query: {
      instType: 'SPOT',
      begin: beginMs,
      end: endMs,
      limit: Math.max(1, Math.min(100, Number(limit || 100))),
    },
  });

  return Array.isArray(body.data) ? body.data : [];
}

async function fetchOkxSpotFillsBackfill({
  apiKey,
  apiSecret,
  apiPassphrase,
  baseUrl,
  lookbackDays = 3650,
  windowDays = 90,
}) {
  const all = [];

  const recent = await fetchOkxSpotFillsAll({
    apiKey,
    apiSecret,
    apiPassphrase,
    baseUrl,
    pageLimit: 100,
    maxPages: 400,
  });
  all.push(...recent);

  const now = Date.now();
  const safeWindowDays = Math.max(1, Math.min(90, Number(windowDays || 90)));
  const safeLookbackDays = Math.max(safeWindowDays, Number(lookbackDays || 3650));
  const stepMs = safeWindowDays * 24 * 60 * 60 * 1000;
  const startBoundary = now - safeLookbackDays * 24 * 60 * 60 * 1000;

  for (let endTime = now; endTime > startBoundary; endTime -= stepMs) {
    const beginTime = Math.max(startBoundary, endTime - stepMs);
    try {
      const archive = await fetchOkxSpotFillsArchive({
        apiKey,
        apiSecret,
        apiPassphrase,
        baseUrl,
        beginMs: beginTime,
        endMs: endTime,
        limit: 100,
      });
      all.push(...archive);
    } catch (_err) {
      // Some accounts/exchanges can reject archive endpoint; keep recent history as fallback.
      break;
    }
  }

  return all;
}

async function fetchOkxWalletBalance({ apiKey, apiSecret, apiPassphrase, baseUrl }) {
  const trading = await okxRequest({
    method: 'GET',
    path: '/api/v5/account/balance',
    apiKey,
    apiSecret,
    apiPassphrase,
    baseUrl,
  });

  let funding = null;
  try {
    funding = await okxRequest({
      method: 'GET',
      path: '/api/v5/asset/balances',
      apiKey,
      apiSecret,
      apiPassphrase,
      baseUrl,
    });
  } catch (_err) {
    funding = null;
  }

  return {
    trading: Array.isArray(trading.data) ? trading.data[0] : null,
    funding: Array.isArray(funding?.data) ? funding.data : [],
  };
}

module.exports = {
  fetchOkxSpotFills,
  fetchOkxSpotFillsAll,
  fetchOkxSpotFillsBackfill,
  fetchOkxWalletBalance,
};
