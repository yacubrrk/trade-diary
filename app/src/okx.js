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
  fetchOkxWalletBalance,
};

