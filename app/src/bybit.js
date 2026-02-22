const crypto = require('crypto');

function signBybit({ apiKey, apiSecret, recvWindow, queryString, timestamp }) {
  const payload = `${timestamp}${apiKey}${recvWindow}${queryString}`;
  return crypto.createHmac('sha256', apiSecret).update(payload).digest('hex');
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
  const cleanApiKey = String(apiKey || '').trim();
  const cleanApiSecret = String(apiSecret || '').trim();
  const cleanBaseUrl = String(baseUrl || '').trim();

  const timestamp = Date.now().toString();
  const params = new URLSearchParams({
    category: 'spot',
    limit: String(limit),
  });

  if (startTime) params.set('startTime', String(startTime));
  if (endTime) params.set('endTime', String(endTime));

  const queryString = params.toString();
  const sign = signBybit({
    apiKey: cleanApiKey,
    apiSecret: cleanApiSecret,
    recvWindow,
    queryString,
    timestamp,
  });

  const res = await fetch(`${cleanBaseUrl}/v5/execution/list?${queryString}`, {
    method: 'GET',
    headers: {
      'X-BAPI-API-KEY': cleanApiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': String(recvWindow),
      'X-BAPI-SIGN-TYPE': '2',
      'X-BAPI-SIGN': sign,
    },
  });

  const rawText = await res.text();
  let body = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch (_err) {
    body = null;
  }

  if (!res.ok || !body || body.retCode !== 0) {
    const message = (body && body.retMsg) || (rawText ? rawText.slice(0, 200) : `HTTP ${res.status}`);
    throw new Error(`Bybit error: ${message}`);
  }

  return body.result?.list || [];
}

module.exports = { fetchBybitExecutions };
