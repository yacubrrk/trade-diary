const path = require('path');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const { getDb } = require('./db');
const { fetchBybitExecutions } = require('./bybit');

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

const safeRound = (n) => Math.round((n + Number.EPSILON) * 1000000) / 1000000;

function buildClosedMetrics({ qty, entryPrice, exitPrice, entryCommission, exitCommission, entryTime, exitTime }) {
  const invested = qty * entryPrice;
  const received = qty * exitPrice;
  const totalCommission = entryCommission + exitCommission;
  const pl = received - invested - totalCommission;
  const plPercent = invested > 0 ? (pl / invested) * 100 : 0;
  const durationMinutes = Math.max(0, Math.round((exitTime - entryTime) / 60000));

  return {
    invested_usdt: safeRound(invested),
    received_usdt: safeRound(received),
    commission_usdt: safeRound(totalCommission),
    pl_usdt: safeRound(pl),
    pl_percent: safeRound(plPercent),
    duration_minutes: durationMinutes,
  };
}

function makePublicId() {
  return crypto.randomBytes(24).toString('hex');
}

function extractBearerToken(req) {
  const auth = String(req.headers.authorization || '');
  if (!auth.startsWith('Bearer ')) return '';
  return auth.slice(7).trim();
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
  let qtyToClose = toNum(execution.execQty);
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

    const sellCommissionPerUnit = toNum(execution.execQty) > 0 ? sellFeeTotal / toNum(execution.execQty) : 0;
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

    if (Math.abs(matchedQty - remaining) < 1e-10) {
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
      const remainingAfter = safeRound(remaining - matchedQty);
      const remainCommission = safeRound(entryCommissionPerUnit * remainingAfter);
      const remainInvested = safeRound(remainingAfter * toNum(openTrade.entry_price));

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

    qtyToClose = safeRound(qtyToClose - matchedQty);
    closedCount += 1;
  }

  return { closedCount, unmatchedQty: safeRound(qtyToClose) };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'trade-diary' });
});

app.post('/api/auth/register', async (req, res) => {
  try {
    const db = await getDb();
    const apiKey = String(req.body.api_key || '').trim();
    const apiSecret = String(req.body.api_secret || '').trim();
    const baseUrl = String(req.body.base_url || 'https://api.bybit.com').trim();
    const recvWindow = Math.max(1000, Math.min(15000, Number(req.body.recv_window || 5000)));

    if (!apiKey || !apiSecret) {
      return res.status(400).json({ error: 'api_key and api_secret are required' });
    }

    const existing = await db.get('SELECT * FROM profiles WHERE api_key = ? LIMIT 1', [apiKey]);

    if (existing) {
      await db.run(
        `UPDATE profiles
         SET api_secret = ?, base_url = ?, recv_window = ?
         WHERE id = ?`,
        [apiSecret, baseUrl, recvWindow, existing.id]
      );

      return res.json({
        token: existing.public_id,
        profile: {
          id: existing.id,
          api_key_masked: `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`,
          base_url: baseUrl,
        },
      });
    }

    const publicId = makePublicId();
    const now = Date.now();

    const result = await db.run(
      `INSERT INTO profiles (public_id, api_key, api_secret, base_url, recv_window, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [publicId, apiKey, apiSecret, baseUrl, recvWindow, now]
    );

    res.status(201).json({
      token: publicId,
      profile: {
        id: result.lastID,
        api_key_masked: `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}`,
        base_url: baseUrl,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/auth/me', requireProfile, async (req, res) => {
  const apiKey = String(req.profile.api_key || '');
  res.json({
    id: req.profile.id,
    api_key_masked: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : '',
    base_url: req.profile.base_url,
  });
});

app.get('/api/trades', requireProfile, async (req, res) => {
  const db = await getDb();
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
    total_pl_usdt: safeRound(toNum(closedStats.total_pl_usdt)),
    avg_pl_usdt: safeRound(toNum(closedStats.avg_pl_usdt)),
    avg_pl_percent: safeRound(toNum(closedStats.avg_pl_percent)),
    avg_duration_minutes: Math.round(toNum(closedStats.avg_duration_minutes)),
    avg_win_usdt: safeRound(toNum(closedStats.avg_win_usdt)),
    avg_loss_usdt: safeRound(toNum(closedStats.avg_loss_usdt)),
    win_rate_percent: safeRound(winRate),
  });
});

app.post('/api/bybit/sync', requireProfile, async (req, res) => {
  try {
    const db = await getDb();
    const apiKey = req.profile.api_key;
    const apiSecret = req.profile.api_secret;
    const recvWindow = Number(req.profile.recv_window || 5000);
    const baseUrl = req.profile.base_url || 'https://api.bybit.com';

    const days = Math.max(1, Math.min(30, Number(req.body.days || 7)));
    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;

    const executions = await fetchBybitExecutions({
      apiKey,
      apiSecret,
      baseUrl,
      recvWindow,
      startTime,
      endTime,
      limit: 200,
    });

    const sorted = executions.sort((a, b) => toNum(a.execTime) - toNum(b.execTime));

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

      if (!symbol || qty <= 0 || price <= 0 || !execTime) {
        continue;
      }

      if (side === 'BUY') {
        if (execId) {
          const exists = await db.get(
            'SELECT id FROM trades WHERE owner_profile_id = ? AND buy_exec_id = ? LIMIT 1',
            [req.profile.id, execId]
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
            req.profile.id,
            symbol,
            execTime,
            qty,
            qty,
            price,
            safeRound(qty * price),
            fee,
            execId || null,
            Date.now(),
          ]
        );
        createdBuys += 1;
      }

      if (side === 'SELL') {
        const result = await applySellExecutionFifo(db, req.profile.id, ex);
        closedFromSells += result.closedCount;
        unmatchedSellQty += toNum(result.unmatchedQty);
      }
    }

    res.json({
      synced_days: days,
      executions_received: sorted.length,
      buys_created: createdBuys,
      sell_matches_closed: closedFromSells,
      unmatched_sell_qty: safeRound(unmatchedSellQty),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Server started: http://localhost:${PORT}`);
});
