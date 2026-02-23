const crypto = require('crypto');

function signBybit({ apiKey, apiSecret, recvWindow, queryString, timestamp }) {
  const payload = `${timestamp}${apiKey}${recvWindow}${queryString}`;
  return crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
}

async function bybitRequest({
  method,
  path,
  apiKey,
  apiSecret,
  baseUrl,
  recvWindow,
  query = {},
  body = null,
}) {
  const cleanApiKey = String(apiKey || '').trim();
  const cleanApiSecret = String(apiSecret || '').trim();
  const cleanBaseUrl = String(baseUrl || '').trim();
  const timestamp = Date.now().toString();

  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query || {})) {
    if (v === null || v === undefined || v === '') continue;
    params.set(k, String(v));
  }
  const queryString = params.toString();
  const jsonBody = body ? JSON.stringify(body) : '';
  const signPayload = method === 'POST' ? jsonBody : queryString;

  const sign = signBybit({
    apiKey: cleanApiKey,
    apiSecret: cleanApiSecret,
    recvWindow,
    queryString: signPayload,
    timestamp,
  });

  const url = queryString ? `${cleanBaseUrl}${path}?${queryString}` : `${cleanBaseUrl}${path}`;
  const headers = {
    'X-BAPI-API-KEY': cleanApiKey,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': String(recvWindow),
    'X-BAPI-SIGN-TYPE': '2',
    'X-BAPI-SIGN': sign,
    'Content-Type': 'application/json',
  };

  const res = await fetch(url, {
    method,
    headers,
    body: method === 'POST' ? jsonBody : undefined,
  });

  const rawText = await res.text();
  let parsed = null;
  try {
    parsed = rawText ? JSON.parse(rawText) : null;
  } catch (_err) {
    parsed = null;
  }

  if (!res.ok) {
    const message = rawText ? rawText.slice(0, 200) : `HTTP ${res.status}`;
    throw new Error(`Bybit error: ${message}`);
  }

  if (parsed && parsed.retCode !== undefined && parsed.retCode !== 0) {
    throw new Error(`Bybit error: ${parsed.retMsg || 'unknown error'}`);
  }

  return parsed || {};
}

async function fetchBybitExecutions({
  apiKey,
  apiSecret,
  baseUrl,
  recvWindow,
  startTime,
  endTime,
  limit = 200,
}) {
  const body = await bybitRequest({
    method: 'GET',
    path: '/v5/execution/list',
    apiKey,
    apiSecret,
    baseUrl,
    recvWindow,
    query: {
      category: 'spot',
      limit,
      startTime,
      endTime,
    },
  });

  return body.result?.list || [];
}

async function fetchBybitExecutionsAll({
  apiKey,
  apiSecret,
  baseUrl,
  recvWindow,
  startTime,
  endTime,
  pageLimit = 200,
  maxPages = 300,
}) {
  const all = [];
  let cursor = '';
  let pages = 0;

  while (pages < Math.max(1, Number(maxPages || 1))) {
    const body = await bybitRequest({
      method: 'GET',
      path: '/v5/execution/list',
      apiKey,
      apiSecret,
      baseUrl,
      recvWindow,
      query: {
        category: 'spot',
        limit: Math.max(1, Math.min(200, Number(pageLimit || 200))),
        startTime: startTime || undefined,
        endTime: endTime || undefined,
        cursor: cursor || undefined,
      },
    });

    const list = Array.isArray(body.result?.list) ? body.result.list : [];
    all.push(...list);
    pages += 1;

    const nextCursor = String(body.result?.nextPageCursor || '').trim();
    if (!nextCursor || list.length === 0 || nextCursor === cursor) break;
    cursor = nextCursor;
  }

  return all;
}

async function fetchBybitWalletBalance({ apiKey, apiSecret, baseUrl, recvWindow }) {
  const unified = await bybitRequest({
    method: 'GET',
    path: '/v5/account/wallet-balance',
    apiKey,
    apiSecret,
    baseUrl,
    recvWindow,
    query: {
      accountType: 'UNIFIED',
    },
  });

  let fund = null;
  try {
    fund = await bybitRequest({
      method: 'GET',
      path: '/v5/asset/transfer/query-account-coins-balance',
      apiKey,
      apiSecret,
      baseUrl,
      recvWindow,
      query: {
        accountType: 'FUND',
      },
    });
  } catch (_err) {
    fund = null;
  }

  return {
    unified: unified.result?.list?.[0] || null,
    fund: fund?.result || null,
  };
}

async function fetchBybitP2POrders({
  apiKey,
  apiSecret,
  baseUrl,
  recvWindow,
  page = 1,
  size = 20,
  beginTime,
  endTime,
}) {
  const body = await bybitRequest({
    method: 'POST',
    path: '/v5/p2p/order/simplifyList',
    apiKey,
    apiSecret,
    baseUrl,
    recvWindow,
    body: {
      page,
      size: Math.min(30, Math.max(1, Number(size || 20))),
      status: null,
      beginTime: beginTime || null,
      endTime: endTime || null,
      tokenId: null,
      side: null,
    },
  });

  return {
    count: Number(body.result?.count || 0),
    items: body.result?.items || [],
  };
}

module.exports = {
  fetchBybitExecutions,
  fetchBybitExecutionsAll,
  fetchBybitWalletBalance,
  fetchBybitP2POrders,
};
