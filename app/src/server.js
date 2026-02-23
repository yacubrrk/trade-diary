const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { getDb } = require('./db');
const { fetchBybitExecutionsAll, fetchBybitWalletBalance, fetchBybitP2POrders } = require('./bybit');
const { fetchOkxSpotFillsAll, fetchOkxWalletBalance } = require('./okx');

dotenv.config({ path: path.join(__dirname, '..', '.env') });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const PORT = Number(process.env.PORT || 8000);

const toNum = (v, d = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
};

const roundMoney = (n) => Math.round((n + Number.EPSILON) * 1000000) / 1000000;
const roundQty = (n) => Math.round((n + Number.EPSILON) * 1000000000000) / 1000000000000;
const DUST_QTY = 0.000001;
const EXCHANGES = {
  BYBIT: 'BYBIT',
  OKX: 'OKX',
};
const DEFAULT_BASE_URL = {
  [EXCHANGES.BYBIT]: 'https://api.bybit.com',
  [EXCHANGES.OKX]: 'https://www.okx.com',
};
const AUTO_SYNC_ENABLED = String(process.env.AUTO_SYNC_ENABLED || 'true').toLowerCase() !== 'false';
const AUTO_SYNC_INTERVAL_MINUTES = Math.max(5, Number(process.env.AUTO_SYNC_INTERVAL_MINUTES || 30));
const PROFILE_SYNC_MIN_GAP_MS = Math.max(60, Number(process.env.PROFILE_SYNC_MIN_GAP_SECONDS || 120)) * 1000;

function buildClosedMetrics({ qty, entryPrice, exitPrice, entryCommission, exitCommission, entryTime, exitTime }) {
  const invested = qty * entryPrice;
  const received = qty * exitPrice;
  const totalCommission = entryCommission + exitCommission;
  const pl = received - invested - totalCommission;
  const plPercent = invested > 0 ? (pl / invested) * 100 : 0;
  const durationMinutes = Math.max(0, Math.round((exitTime - entryTime) / 60000));

  return {
    invested_usdt: roundMoney(invested),
    received_usdt: roundMoney(received),
    commission_usdt: roundMoney(totalCommission),
    pl_usdt: roundMoney(pl),
    pl_percent: roundMoney(plPercent),
    duration_minutes: durationMinutes,
  };
}

function normalizeExchange(input) {
  const value = String(input || EXCHANGES.BYBIT).trim().toUpperCase();
  return value === EXCHANGES.OKX ? EXCHANGES.OKX : EXCHANGES.BYBIT;
}

function makePublicId() {
  return crypto.randomBytes(24).toString('hex');
}

function extractCookieToken(req) {
  const rawCookie = String(req.headers.cookie || '');
  if (!rawCookie) return '';

  for (const pair of rawCookie.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === 'td_token') {
      return decodeURIComponent(rest.join('=').trim());
    }
  }
  return '';
}

function extractBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return extractCookieToken(req);
}

function setAuthCookie(res, token) {
  res.cookie('td_token', token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 365,
  });
}

function clearAuthCookie(res) {
  res.clearCookie('td_token', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}

function mapProfileResponse(profile) {
  const apiKey = String(profile.api_key || '');
  const exchange = normalizeExchange(profile.exchange);
  return {
    id: profile.id,
    exchange,
    api_key_masked: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '',
    profile_name: profile.profile_name || null,
    base_url: profile.base_url || DEFAULT_BASE_URL[exchange],
    last_read_trade_id: Number(profile.last_read_trade_id || 0),
  };
}

async function requireProfile(req, res, next) {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const db = await getDb();
    const profile = await db.get('SELECT * FROM profiles WHERE public_id = ? LIMIT 1', [token]);
    if (!profile) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    req.profile = profile;
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

async function closeTradeManually(db, profileId, tradeId, { exitPrice, exitTime, exitCommission = 0 }) {
  const trade = await db.get('SELECT * FROM trades WHERE id = ? AND owner_profile_id = ?', [tradeId, profileId]);
  if (!trade) {
    throw new Error('Trade not found');
  }
  if (trade.status !== 'OPEN') {
    throw new Error('Trade is already closed');
  }

  const metrics = buildClosedMetrics({
    qty: trade.qty,
    entryPrice: trade.entry_price,
    exitPrice,
    entryCommission: toNum(trade.commission_usdt),
    exitCommission,
    entryTime: trade.entry_time,
    exitTime,
  });

  await db.run(
    `UPDATE trades
     SET status = 'CLOSED',
         remaining_qty = 0,
         exit_time = ?,
         exit_price = ?,
         received_usdt = ?,
         commission_usdt = ?,
         pl_usdt = ?,
         pl_percent = ?,
         duration_minutes = ?
     WHERE id = ? AND owner_profile_id = ?`,
    [
      exitTime,
      exitPrice,
      metrics.received_usdt,
      metrics.commission_usdt,
      metrics.pl_usdt,
      metrics.pl_percent,
      metrics.duration_minutes,
      tradeId,
      profileId,
    ]
  );
}

async function applySellExecutionFifo(db, profileId, execution) {
  const symbol = execution.symbol;
  const execQtyTotal = toNum(execution.execQty);
  let qtyToClose = execQtyTotal;
  const sellPrice = toNum(execution.execPrice);
  const sellFeeTotal = Math.abs(toNum(execution.execFee));
  const sellTime = toNum(execution.execTime);
  const execId = execution.execId || `sell_${sellTime}`;

  if (qtyToClose <= 0 || sellPrice <= 0) {
    return { closedCount: 0, unmatchedQty: 0 };
  }

  let closedCount = 0;
  while (qtyToClose > 1e-10) {
    const openTrade = await db.get(
      `SELECT * FROM trades
       WHERE owner_profile_id = ?
         AND symbol = ?
         AND status = 'OPEN'
         AND remaining_qty > 0
       ORDER BY entry_time ASC, id ASC
       LIMIT 1`,
      [profileId, symbol]
    );

    if (!openTrade) {
      break;
    }

    const remaining = toNum(openTrade.remaining_qty);
    const matchedQty = Math.min(remaining, qtyToClose);

    const entryCommissionPerUnit = openTrade.qty > 0 ? toNum(openTrade.commission_usdt) / openTrade.qty : 0;
    const entryCommissionForMatched = entryCommissionPerUnit * matchedQty;

    const sellCommissionPerUnit = execQtyTotal > 0 ? sellFeeTotal / execQtyTotal : 0;
    const sellCommissionForMatched = sellCommissionPerUnit * matchedQty;

    const metrics = buildClosedMetrics({
      qty: matchedQty,
      entryPrice: toNum(openTrade.entry_price),
      exitPrice: sellPrice,
      entryCommission: entryCommissionForMatched,
      exitCommission: sellCommissionForMatched,
      entryTime: toNum(openTrade.entry_time),
      exitTime: sellTime,
    });

    const remainingAfterRaw = remaining - matchedQty;
    const willFullyClose = remainingAfterRaw <= DUST_QTY;

    if (willFullyClose) {
      await db.run(
        `UPDATE trades
         SET status = 'CLOSED',
             remaining_qty = 0,
             qty = ?,
             invested_usdt = ?,
             exit_time = ?,
             exit_price = ?,
             received_usdt = ?,
             commission_usdt = ?,
             pl_usdt = ?,
             pl_percent = ?,
             duration_minutes = ?,
             sell_exec_id = ?
         WHERE id = ? AND owner_profile_id = ?`,
        [
          matchedQty,
          metrics.invested_usdt,
          sellTime,
          sellPrice,
          metrics.received_usdt,
          metrics.commission_usdt,
          metrics.pl_usdt,
          metrics.pl_percent,
          metrics.duration_minutes,
          execId,
          openTrade.id,
          profileId,
        ]
      );
    } else {
      const remainingAfter = roundQty(remainingAfterRaw);
      const remainCommission = roundMoney(entryCommissionPerUnit * remainingAfter);
      const remainInvested = roundMoney(remainingAfter * toNum(openTrade.entry_price));

      await db.run(
        `UPDATE trades
         SET qty = ?, remaining_qty = ?, invested_usdt = ?, commission_usdt = ?
         WHERE id = ? AND owner_profile_id = ?`,
        [remainingAfter, remainingAfter, remainInvested, remainCommission, openTrade.id, profileId]
      );

      await db.run(
        `INSERT INTO trades (
          owner_profile_id,
          symbol, entry_time, exit_time,
          qty, remaining_qty,
          entry_price, exit_price,
          invested_usdt, received_usdt,
          commission_usdt,
          pl_usdt, pl_percent,
          duration_minutes,
          status, source,
          buy_exec_id, sell_exec_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'CLOSED', 'bybit', ?, ?, ?)`,
        [
          profileId,
          symbol,
          toNum(openTrade.entry_time),
          sellTime,
          matchedQty,
          toNum(openTrade.entry_price),
          sellPrice,
          metrics.invested_usdt,
          metrics.received_usdt,
          metrics.commission_usdt,
          metrics.pl_usdt,
          metrics.pl_percent,
          metrics.duration_minutes,
          openTrade.buy_exec_id,
          execId,
          Date.now(),
        ]
      );
    }

    qtyToClose = roundQty(qtyToClose - matchedQty);
    if (qtyToClose <= DUST_QTY) qtyToClose = 0;
    closedCount += 1;
  }

  return { closedCount, unmatchedQty: roundQty(qtyToClose) };
}

async function closeDustOpenTrades(db, profileId) {
  const result = await db.run(
    `UPDATE trades
     SET status = 'CLOSED',
         qty = 0,
         remaining_qty = 0,
         invested_usdt = 0,
         received_usdt = 0,
         commission_usdt = 0,
         pl_usdt = 0,
         pl_percent = 0,
         duration_minutes = 0,
         exit_time = COALESCE(exit_time, entry_time),
         exit_price = COALESCE(exit_price, entry_price),
         source = 'bybit_dust_fix'
     WHERE owner_profile_id = ?
       AND status = 'OPEN'
       AND ABS(remaining_qty) <= ?`,
    [profileId, DUST_QTY]
  );

  return Number(result.changes || 0);
}

function normalizeExecutions(executions) {
  const groups = new Map();

  for (const raw of executions || []) {
    const side = String(raw.side || '').toUpperCase();
    const symbol = String(raw.symbol || '').toUpperCase();
    const qty = toNum(raw.execQty);
    const price = toNum(raw.execPrice);
    const fee = Math.abs(toNum(raw.execFee));
    const execTime = toNum(raw.execTime);
    const orderId = String(raw.orderId || '').trim();
    const execId = String(raw.execId || '').trim();

    if (!symbol || !side || qty <= 0 || price <= 0 || execTime <= 0) continue;

    const groupKey = orderId ? `${symbol}|${side}|${orderId}` : `${symbol}|${side}|${execId || execTime}`;
    const quote = qty * price;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        symbol,
        side,
        orderId,
        execId: execId || `agg_${groupKey}`,
        execQty: 0,
        execFee: 0,
        quoteSum: 0,
        minExecTime: execTime,
        maxExecTime: execTime,
      });
    }

    const g = groups.get(groupKey);
    g.execQty += qty;
    g.execFee += fee;
    g.quoteSum += quote;
    if (execTime < g.minExecTime) g.minExecTime = execTime;
    if (execTime > g.maxExecTime) g.maxExecTime = execTime;
  }

  return Array.from(groups.values())
    .map((g) => ({
      symbol: g.symbol,
      side: g.side,
      orderId: g.orderId || null,
      execId: g.orderId || g.execId,
      execQty: roundQty(g.execQty),
      execFee: roundMoney(g.execFee),
      execPrice: g.execQty > 0 ? g.quoteSum / g.execQty : 0,
      execTime: g.side === 'BUY' ? g.minExecTime : g.maxExecTime,
    }))
    .sort((a, b) => toNum(a.execTime) - toNum(b.execTime));
}

function normalizeOkxExecutions(fills) {
  const groups = new Map();

  for (const raw of fills || []) {
    const side = String(raw.side || '').toUpperCase();
    const symbol = String(raw.instId || '').toUpperCase().replace('-', '');
    const qty = toNum(raw.fillSz);
    const price = toNum(raw.fillPx);
    const fee = Math.abs(toNum(raw.fee));
    const execTime = toNum(raw.fillTime);
    const orderId = String(raw.ordId || '').trim();
    const execId = String(raw.tradeId || raw.billId || '').trim();

    if (!symbol || !side || qty <= 0 || price <= 0 || execTime <= 0) continue;

    const groupKey = orderId ? `${symbol}|${side}|${orderId}` : `${symbol}|${side}|${execId || execTime}`;
    const quote = qty * price;

    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        symbol,
        side,
        orderId,
        execId: execId || `okx_${groupKey}`,
        execQty: 0,
        execFee: 0,
        quoteSum: 0,
        minExecTime: execTime,
        maxExecTime: execTime,
      });
    }

    const g = groups.get(groupKey);
    g.execQty += qty;
    g.execFee += fee;
    g.quoteSum += quote;
    if (execTime < g.minExecTime) g.minExecTime = execTime;
    if (execTime > g.maxExecTime) g.maxExecTime = execTime;
  }

  return Array.from(groups.values())
    .map((g) => ({
      symbol: g.symbol,
      side: g.side,
      orderId: g.orderId || null,
      execId: g.orderId || g.execId,
      execQty: roundQty(g.execQty),
      execFee: roundMoney(g.execFee),
      execPrice: g.execQty > 0 ? g.quoteSum / g.execQty : 0,
      execTime: g.side === 'BUY' ? g.minExecTime : g.maxExecTime,
    }))
    .sort((a, b) => toNum(a.execTime) - toNum(b.execTime));
}

async function syncBybitForProfile(db, profile) {
  const exchange = normalizeExchange(profile.exchange);
  if (exchange !== EXCHANGES.BYBIT) {
    return { skipped: true, reason: `sync is not implemented for ${exchange}` };
  }

  const apiKey = profile.api_key;
  const apiSecret = profile.api_secret;
  const recvWindow = Number(profile.recv_window || 5000);
  const baseUrl = profile.base_url || DEFAULT_BASE_URL[EXCHANGES.BYBIT];

  const executions = await fetchBybitExecutionsAll({
    apiKey,
    apiSecret,
    baseUrl,
    recvWindow,
    pageLimit: 200,
    maxPages: 400,
  });

  const sorted = normalizeExecutions(executions);

  let createdBuys = 0;
  let closedFromSells = 0;
  let unmatchedSellQty = 0;

  for (const ex of sorted) {
    const side = String(ex.side || '').toUpperCase();
    const symbol = String(ex.symbol || '').toUpperCase();
    const qty = toNum(ex.execQty);
    const price = toNum(ex.execPrice);
    const fee = Math.abs(toNum(ex.execFee));
    const execId = String(ex.execId || '');
    const execTime = toNum(ex.execTime);

    if (!symbol || qty <= 0 || price <= 0 || !execTime) continue;

    if (side === 'BUY') {
      if (execId) {
        const exists = await db.get(
          'SELECT id FROM trades WHERE owner_profile_id = ? AND buy_exec_id = ? LIMIT 1',
          [profile.id, execId]
        );
        if (exists) continue;
      }

      await db.run(
        `INSERT INTO trades (
          owner_profile_id,
          symbol, entry_time, exit_time,
          qty, remaining_qty,
          entry_price, exit_price,
          invested_usdt, received_usdt,
          commission_usdt,
          pl_usdt, pl_percent,
          duration_minutes,
          status, source,
          buy_exec_id, sell_exec_id,
          created_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, 'OPEN', 'bybit', ?, NULL, ?)`,
        [
          profile.id,
          symbol,
          execTime,
          qty,
          qty,
          price,
          roundMoney(qty * price),
          fee,
          execId || null,
          Date.now(),
        ]
      );
      createdBuys += 1;
    }

    if (side === 'SELL') {
      const result = await applySellExecutionFifo(db, profile.id, ex);
      closedFromSells += result.closedCount;
      unmatchedSellQty += toNum(result.unmatchedQty);
    }
  }

  const dust_closed = await closeDustOpenTrades(db, profile.id);
  await db.run('UPDATE profiles SET last_sync_at = ? WHERE id = ?', [Date.now(), profile.id]);

  return {
    sync_scope: 'full_available_history',
    executions_received: sorted.length,
    buys_created: createdBuys,
    sell_matches_closed: closedFromSells,
    unmatched_sell_qty: roundQty(unmatchedSellQty),
    dust_closed,
  };
}

async function syncOkxForProfile(db, profile) {
  const apiKey = profile.api_key;
  const apiSecret = profile.api_secret;
  const apiPassphrase = String(profile.api_passphrase || '').trim();
  const baseUrl = profile.base_url || DEFAULT_BASE_URL[EXCHANGES.OKX];
  if (!apiPassphrase) {
    throw new Error('api_passphrase is required for OKX profile');
  }

  const fills = await fetchOkxSpotFillsAll({
    apiKey,
    apiSecret,
    apiPassphrase,
    baseUrl,
    pageLimit: 100,
    maxPages: 400,
  });

  const sorted = normalizeOkxExecutions(fills);

  let createdBuys = 0;
  let closedFromSells = 0;
  let unmatchedSellQty = 0;

  for (const ex of sorted) {
    const side = String(ex.side || '').toUpperCase();
    const symbol = String(ex.symbol || '').toUpperCase();
    const qty = toNum(ex.execQty);
    const price = toNum(ex.execPrice);
    const fee = Math.abs(toNum(ex.execFee));
    const execId = String(ex.execId || '');
    const execTime = toNum(ex.execTime);

    if (!symbol || qty <= 0 || price <= 0 || !execTime) continue;

    if (side === 'BUY') {
      if (execId) {
        const exists = await db.get(
          'SELECT id FROM trades WHERE owner_profile_id = ? AND buy_exec_id = ? LIMIT 1',
          [profile.id, execId]
        );
        if (exists) continue;
      }

      await db.run(
        `INSERT INTO trades (
          owner_profile_id,
          symbol, entry_time, exit_time,
          qty, remaining_qty,
          entry_price, exit_price,
          invested_usdt, received_usdt,
          commission_usdt,
          pl_usdt, pl_percent,
          duration_minutes,
          status, source,
          buy_exec_id, sell_exec_id,
          created_at
        ) VALUES (?, ?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, 'OPEN', 'okx', ?, NULL, ?)`,
        [
          profile.id,
          symbol,
          execTime,
          qty,
          qty,
          price,
          roundMoney(qty * price),
          fee,
          execId || null,
          Date.now(),
        ]
      );
      createdBuys += 1;
    }

    if (side === 'SELL') {
      const result = await applySellExecutionFifo(db, profile.id, ex);
      closedFromSells += result.closedCount;
      unmatchedSellQty += toNum(result.unmatchedQty);
    }
  }

  const dust_closed = await closeDustOpenTrades(db, profile.id);
  await db.run('UPDATE profiles SET last_sync_at = ? WHERE id = ?', [Date.now(), profile.id]);

  return {
    sync_scope: 'full_available_history',
    executions_received: sorted.length,
    buys_created: createdBuys,
    sell_matches_closed: closedFromSells,
    unmatched_sell_qty: roundQty(unmatchedSellQty),
    dust_closed,
  };
}

async function syncForProfile(db, profile) {
  const exchange = normalizeExchange(profile.exchange);
  if (exchange === EXCHANGES.OKX) {
    return syncOkxForProfile(db, profile);
  }
  return syncBybitForProfile(db, profile);
}

async function syncForProfileIfStale(db, profile) {
  const lastSyncAt = Number(profile.last_sync_at || 0);
  const now = Date.now();
  if (now - lastSyncAt < PROFILE_SYNC_MIN_GAP_MS) {
    return { skipped: true };
  }
  return syncForProfile(db, profile);
}

async function repairInvalidTradeTimes(db) {
  const result = await db.run(
    `UPDATE trades
     SET exit_time = entry_time,
         duration_minutes = 0
     WHERE exit_time IS NOT NULL
       AND entry_time IS NOT NULL
       AND exit_time < entry_time`
  );
  return Number(result.changes || 0);
}

let autoSyncRunning = false;
async function runAutoSync() {
  if (autoSyncRunning) return;
  autoSyncRunning = true;
  try {
    const db = await getDb();
    const profiles = await db.all('SELECT * FROM profiles ORDER BY id ASC');
    for (const profile of profiles) {
      try {
        await syncForProfile(db, profile);
      } catch (err) {
        console.error(`[auto-sync] profile ${profile.id} failed: ${err.message}`);
      }
    }
  } finally {
    autoSyncRunning = false;
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'trade-diary' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const db = await getDb();
    const exchange = normalizeExchange(req.body.exchange);
    const apiKey = String(req.body.api_key || '').trim();
    const apiSecret = String(req.body.api_secret || '').trim();
    const apiPassphrase = String(req.body.api_passphrase || '').trim();
    const profileName = String(req.body.profile_name || '').trim();
    const baseUrl = String(req.body.base_url || DEFAULT_BASE_URL[exchange]).trim();
    const recvWindow = Math.max(1000, Math.min(15000, Number(req.body.recv_window || 5000)));
    const tgUserId = String(req.body.tg_user_id || '').trim() || null;
    const now = Date.now();

    if (!apiKey || !apiSecret) {
      return res.status(400).json({ error: 'api_key and api_secret are required' });
    }
    if (exchange === EXCHANGES.OKX && !apiPassphrase) {
      return res.status(400).json({ error: 'api_passphrase is required for OKX' });
    }

    const existing = await db.get('SELECT * FROM profiles WHERE api_key = ? LIMIT 1', [apiKey]);

    if (existing) {
      await db.run(
        `UPDATE profiles
         SET exchange = ?, api_secret = ?, api_passphrase = ?, base_url = ?, recv_window = ?, tg_user_id = COALESCE(?, tg_user_id), profile_name = COALESCE(NULLIF(?, ''), profile_name), last_selected_at = ?
         WHERE id = ?`,
        [exchange, apiSecret, apiPassphrase || null, baseUrl, recvWindow, tgUserId, profileName, now, existing.id]
      );
      setAuthCookie(res, existing.public_id);
      const refreshed = await db.get('SELECT * FROM profiles WHERE id = ? LIMIT 1', [existing.id]);
      syncForProfileIfStale(db, refreshed).catch((err) =>
        console.error(`[auth-sync] profile ${existing.id} failed: ${err.message}`)
      );

      const responseProfileName = profileName || existing.profile_name || null;
      return res.json({
        token: existing.public_id,
        profile: {
          ...mapProfileResponse(refreshed),
          profile_name: responseProfileName,
        },
      });
    }

    const publicId = makePublicId();
    if (tgUserId) {
      const countRow = await db.get('SELECT COUNT(*) as cnt FROM profiles WHERE tg_user_id = ?', [tgUserId]);
      const linkedCount = Number(countRow?.cnt || 0);
      if (linkedCount >= 2) {
        return res.status(400).json({ error: 'Можно привязать максимум 2 профиля' });
      }
    }

    const result = await db.run(
      `INSERT INTO profiles (public_id, tg_user_id, profile_name, exchange, api_key, api_secret, api_passphrase, base_url, recv_window, last_selected_at, last_sync_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [publicId, tgUserId, profileName || null, exchange, apiKey, apiSecret, apiPassphrase || null, baseUrl, recvWindow, now, now]
    );
    setAuthCookie(res, publicId);
    const createdProfile = await db.get('SELECT * FROM profiles WHERE id = ? LIMIT 1', [result.lastID]);
    syncForProfileIfStale(db, createdProfile).catch((err) =>
      console.error(`[auth-sync] profile ${result.lastID} failed: ${err.message}`)
    );

    res.status(201).json({
      token: publicId,
      profile: mapProfileResponse(createdProfile),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireProfile, async (req, res) => {
  res.json(mapProfileResponse(req.profile));
});

app.post('/api/auth/telegram-login', async (req, res) => {
  try {
    const db = await getDb();
    const tgUserId = String(req.body.tg_user_id || '').trim();
    if (!tgUserId) {
      return res.status(400).json({ error: 'tg_user_id is required' });
    }

    const profile = await db.get(
      `SELECT *
       FROM profiles
       WHERE tg_user_id = ?
       ORDER BY last_selected_at DESC, created_at DESC, id DESC
       LIMIT 1`,
      [tgUserId]
    );
    if (!profile) {
      return res.status(404).json({ error: 'Profile not found for Telegram user' });
    }

    setAuthCookie(res, profile.public_id);
    await db.run('UPDATE profiles SET last_selected_at = ? WHERE id = ?', [Date.now(), profile.id]);
    const refreshed = await db.get('SELECT * FROM profiles WHERE id = ? LIMIT 1', [profile.id]);
    return res.json({
      token: refreshed.public_id,
      profile: mapProfileResponse(refreshed),
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get('/api/profiles', requireProfile, async (req, res) => {
  try {
    const db = await getDb();
    const tgUserId = String(req.profile.tg_user_id || '').trim();
    if (!tgUserId) {
      return res.json({ rows: [mapProfileResponse(req.profile)] });
    }
    const rows = await db.all(
      'SELECT * FROM profiles WHERE tg_user_id = ? ORDER BY last_selected_at DESC, created_at DESC, id DESC',
      [tgUserId]
    );
    res.json({ rows: rows.map(mapProfileResponse) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profiles/switch', requireProfile, async (req, res) => {
  try {
    const db = await getDb();
    const targetId = Number(req.body.profile_id);
    if (!Number.isFinite(targetId) || targetId <= 0) {
      return res.status(400).json({ error: 'profile_id is required' });
    }

    const target = await db.get('SELECT * FROM profiles WHERE id = ? LIMIT 1', [targetId]);
    if (!target) {
      return res.status(404).json({ error: 'Profile not found' });
    }

    const currentTg = String(req.profile.tg_user_id || '').trim();
    const targetTg = String(target.tg_user_id || '').trim();
    if (currentTg && targetTg && currentTg !== targetTg) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await db.run('UPDATE profiles SET last_selected_at = ? WHERE id = ?', [Date.now(), target.id]);
    const refreshed = await db.get('SELECT * FROM profiles WHERE id = ? LIMIT 1', [target.id]);
    setAuthCookie(res, refreshed.public_id);
    res.json({
      token: refreshed.public_id,
      profile: mapProfileResponse(refreshed),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', (_req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get('/api/trades', requireProfile, async (req, res) => {
  const db = await getDb();
  try {
    await syncForProfileIfStale(db, req.profile);
  } catch (err) {
    console.error(`[on-open-sync] trades profile ${req.profile.id} failed: ${err.message}`);
  }
  const status = (req.query.status || '').toUpperCase();

  const rows = status
    ? await db.all(
        'SELECT * FROM trades WHERE owner_profile_id = ? AND status = ? ORDER BY entry_time DESC, id DESC',
        [req.profile.id, status]
      )
    : await db.all('SELECT * FROM trades WHERE owner_profile_id = ? ORDER BY entry_time DESC, id DESC', [
        req.profile.id,
      ]);

  res.json(rows);
});

app.put('/api/trades/:id/close', requireProfile, async (req, res) => {
  try {
    const db = await getDb();
    const tradeId = Number(req.params.id);
    const exitPrice = toNum(req.body.exit_price);
    const exitTime = toNum(req.body.exit_time, Date.now());
    const exitCommission = Math.abs(toNum(req.body.exit_commission_usdt));

    if (!Number.isFinite(tradeId) || tradeId <= 0 || exitPrice <= 0) {
      return res.status(400).json({ error: 'valid trade id and exit_price are required' });
    }

    await closeTradeManually(db, req.profile.id, tradeId, { exitPrice, exitTime, exitCommission });
    const updated = await db.get('SELECT * FROM trades WHERE id = ? AND owner_profile_id = ?', [
      tradeId,
      req.profile.id,
    ]);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/stats', requireProfile, async (req, res) => {
  const db = await getDb();
  try {
    await syncForProfileIfStale(db, req.profile);
  } catch (err) {
    console.error(`[on-open-sync] stats profile ${req.profile.id} failed: ${err.message}`);
  }

  const total = await db.get('SELECT COUNT(*) as cnt FROM trades WHERE owner_profile_id = ?', [req.profile.id]);
  const open = await db.get("SELECT COUNT(*) as cnt FROM trades WHERE owner_profile_id = ? AND status = 'OPEN'", [
    req.profile.id,
  ]);
  const closed = await db.get(
    "SELECT COUNT(*) as cnt FROM trades WHERE owner_profile_id = ? AND status = 'CLOSED'",
    [req.profile.id]
  );

  const closedStats = await db.get(
    `SELECT
      COALESCE(SUM(pl_usdt), 0) as total_pl_usdt,
      COALESCE(AVG(pl_usdt), 0) as avg_pl_usdt,
      COALESCE(AVG(pl_percent), 0) as avg_pl_percent,
      COALESCE(AVG(duration_minutes), 0) as avg_duration_minutes,
      COALESCE(SUM(CASE WHEN pl_usdt > 0 THEN 1 ELSE 0 END), 0) as wins,
      COALESCE(AVG(CASE WHEN pl_usdt > 0 THEN pl_usdt END), 0) as avg_win_usdt,
      COALESCE(AVG(CASE WHEN pl_usdt < 0 THEN pl_usdt END), 0) as avg_loss_usdt
    FROM trades
    WHERE owner_profile_id = ? AND status = 'CLOSED'`,
    [req.profile.id]
  );

  const winRate = closed.cnt > 0 ? (closedStats.wins / closed.cnt) * 100 : 0;

  res.json({
    total_trades: total.cnt,
    open_trades: open.cnt,
    closed_trades: closed.cnt,
    total_pl_usdt: roundMoney(toNum(closedStats.total_pl_usdt)),
    avg_pl_usdt: roundMoney(toNum(closedStats.avg_pl_usdt)),
    avg_pl_percent: roundMoney(toNum(closedStats.avg_pl_percent)),
    avg_duration_minutes: Math.round(toNum(closedStats.avg_duration_minutes)),
    avg_win_usdt: roundMoney(toNum(closedStats.avg_win_usdt)),
    avg_loss_usdt: roundMoney(toNum(closedStats.avg_loss_usdt)),
    win_rate_percent: roundMoney(winRate),
  });
});

app.post('/api/bybit/sync', requireProfile, async (req, res) => {
  try {
    const db = await getDb();
    const result = await syncForProfile(db, req.profile);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/bybit/auto-sync', requireProfile, async (req, res) => {
  try {
    const db = await getDb();
    const result = await syncForProfileIfStale(db, req.profile);
    res.json({ ok: true, ...(result || {}) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/trades/mark-read', requireProfile, async (req, res) => {
  try {
    const db = await getDb();
    const maxRow = await db.get('SELECT COALESCE(MAX(id), 0) as max_id FROM trades WHERE owner_profile_id = ?', [
      req.profile.id,
    ]);
    const maxId = Number(maxRow?.max_id || 0);
    await db.run('UPDATE profiles SET last_read_trade_id = ? WHERE id = ?', [maxId, req.profile.id]);
    res.json({ ok: true, last_read_trade_id: maxId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/profile/name', requireProfile, async (req, res) => {
  try {
    const db = await getDb();
    const profileName = String(req.body.profile_name || '').trim();
    if (!profileName) {
      return res.status(400).json({ error: 'profile_name is required' });
    }
    const safeName = profileName.slice(0, 40);
    await db.run('UPDATE profiles SET profile_name = ? WHERE id = ?', [safeName, req.profile.id]);
    res.json({ ok: true, profile_name: safeName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/balance', requireProfile, async (req, res) => {
  try {
    const exchange = normalizeExchange(req.profile.exchange);
    if (exchange === EXCHANGES.OKX) {
      const result = await fetchOkxWalletBalance({
        apiKey: req.profile.api_key,
        apiSecret: req.profile.api_secret,
        apiPassphrase: req.profile.api_passphrase,
        baseUrl: req.profile.base_url || DEFAULT_BASE_URL[EXCHANGES.OKX],
      });

      const tradingDetails = Array.isArray(result.trading?.details) ? result.trading.details : [];
      const nonZeroTrading = tradingDetails
        .map((d) => ({
          coin: d.ccy,
          wallet_balance: toNum(d.cashBal),
          available_to_withdraw: toNum(d.availBal),
          locked: toNum(d.frozenBal),
          usd_value: toNum(d.eqUsd),
        }))
        .filter((c) => c.wallet_balance > 0 || c.locked > 0 || c.usd_value > 0)
        .sort((a, b) => b.usd_value - a.usd_value);

      const funding = (result.funding || [])
        .map((c) => ({
          coin: c.ccy,
          transfer_balance: toNum(c.availBal),
          wallet_balance: toNum(c.bal),
        }))
        .filter((c) => c.transfer_balance > 0 || c.wallet_balance > 0);

      return res.json({
        exchange,
        unified_total_usd: toNum(result.trading?.totalEq),
        unified_coins: nonZeroTrading,
        fund_coins: funding,
      });
    }

    const result = await fetchBybitWalletBalance({
      apiKey: req.profile.api_key,
      apiSecret: req.profile.api_secret,
      baseUrl: req.profile.base_url || DEFAULT_BASE_URL[EXCHANGES.BYBIT],
      recvWindow: Number(req.profile.recv_window || 5000),
    });

    const unifiedCoins = Array.isArray(result.unified?.coin) ? result.unified.coin : [];
    const nonZeroUnified = unifiedCoins
      .map((c) => ({
        coin: c.coin,
        wallet_balance: toNum(c.walletBalance),
        available_to_withdraw: toNum(c.availableToWithdraw),
        locked: toNum(c.locked),
        usd_value: toNum(c.usdValue),
      }))
      .filter((c) => c.wallet_balance > 0 || c.locked > 0 || c.usd_value > 0)
      .sort((a, b) => b.usd_value - a.usd_value);

    const fundCoins = Array.isArray(result.fund?.balance)
      ? result.fund.balance
          .map((c) => ({
            coin: c.coin,
            transfer_balance: toNum(c.transferBalance),
            wallet_balance: toNum(c.walletBalance),
          }))
          .filter((c) => c.transfer_balance > 0 || c.wallet_balance > 0)
      : [];

    res.json({
      unified_total_usd: toNum(result.unified?.totalEquity),
      unified_coins: nonZeroUnified,
      fund_coins: fundCoins,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/p2p/orders', requireProfile, async (req, res) => {
  try {
    const exchange = normalizeExchange(req.profile.exchange);
    if (exchange !== EXCHANGES.BYBIT) {
      return res.json({
        exchange,
        supported: false,
        total: 0,
        rows: [],
      });
    }

    const days = Math.max(1, Math.min(30, Number(req.query.days || 7)));
    const endTime = Date.now();
    const beginTime = endTime - days * 24 * 60 * 60 * 1000;

    const result = await fetchBybitP2POrders({
      apiKey: req.profile.api_key,
      apiSecret: req.profile.api_secret,
      baseUrl: req.profile.base_url || DEFAULT_BASE_URL[EXCHANGES.BYBIT],
      recvWindow: Number(req.profile.recv_window || 5000),
      page: 1,
      size: 30,
      beginTime,
      endTime,
    });

    const rows = (result.items || []).map((it) => ({
      id: it.id || it.orderId || '',
      token: it.tokenId || it.currencyId || '',
      side: it.side || '',
      fiat: it.currency || '',
      amount: toNum(it.amount),
      total_price: toNum(it.totalPrice),
      price: toNum(it.price),
      status: it.status || '',
      created_time: toNum(it.createDate || it.createTime || it.createdTime),
      finished_time: toNum(it.finishDate || it.finishTime || it.finishedTime),
    }));

    res.json({
      total: Number(result.count || rows.length),
      rows,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server started: http://localhost:${PORT}`);
  getDb()
    .then((db) => repairInvalidTradeTimes(db))
    .then((fixed) => {
      if (fixed > 0) {
        console.log(`[repair] fixed invalid trade times: ${fixed}`);
      }
    })
    .catch((err) => console.error(`[repair] failed: ${err.message}`));
  if (AUTO_SYNC_ENABLED) {
    runAutoSync().catch((err) => console.error(`[auto-sync] initial failed: ${err.message}`));
    setInterval(() => {
      runAutoSync().catch((err) => console.error(`[auto-sync] loop failed: ${err.message}`));
    }, AUTO_SYNC_INTERVAL_MINUTES * 60 * 1000);
    console.log(`[auto-sync] enabled: every ${AUTO_SYNC_INTERVAL_MINUTES} min, scope=full_available_history`);
  } else {
    console.log('[auto-sync] disabled');
  }
});
