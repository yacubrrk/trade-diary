const path = require('path');
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

async function closeTradeManually(db, tradeId, { exitPrice, exitTime, exitCommission = 0 }) {
  const trade = await db.get('SELECT * FROM trades WHERE id = ?', [tradeId]);
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
     WHERE id = ?`,
    [
      exitTime,
      exitPrice,
      metrics.received_usdt,
      metrics.commission_usdt,
      metrics.pl_usdt,
      metrics.pl_percent,
      metrics.duration_minutes,
      tradeId,
    ]
  );
}

async function applySellExecutionFifo(db, execution) {
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
       WHERE symbol = ? AND status = 'OPEN' AND remaining_qty > 0
       ORDER BY entry_time ASC, id ASC
       LIMIT 1`,
      [symbol]
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
         WHERE id = ?`,
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
        ]
      );
    } else {
      const remainingAfter = safeRound(remaining - matchedQty);
      const remainCommission = safeRound(entryCommissionPerUnit * remainingAfter);
      const remainInvested = safeRound(remainingAfter * toNum(openTrade.entry_price));

      await db.run(
        `UPDATE trades
         SET qty = ?, remaining_qty = ?, invested_usdt = ?, commission_usdt = ?
         WHERE id = ?`,
        [remainingAfter, remainingAfter, remainInvested, remainCommission, openTrade.id]
      );

      await db.run(
        `INSERT INTO trades (
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
        ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, 'CLOSED', 'bybit', ?, ?, ?)`,
        [
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

app.get('/api/trades', async (req, res) => {
  const db = await getDb();
  const status = (req.query.status || '').toUpperCase();

  const rows = status
    ? await db.all('SELECT * FROM trades WHERE status = ? ORDER BY entry_time DESC, id DESC', [status])
    : await db.all('SELECT * FROM trades ORDER BY entry_time DESC, id DESC');

  res.json(rows);
});

app.post('/api/trades', async (req, res) => {
  try {
    const db = await getDb();
    const now = Date.now();

    const symbol = String(req.body.symbol || '').toUpperCase().trim();
    const qty = toNum(req.body.qty);
    const entryPrice = toNum(req.body.entry_price);
    const entryTime = toNum(req.body.entry_time, now);
    const exitPrice = toNum(req.body.exit_price);
    const exitTime = toNum(req.body.exit_time);
    const commission = Math.abs(toNum(req.body.commission_usdt));

    if (!symbol || qty <= 0 || entryPrice <= 0) {
      return res.status(400).json({ error: 'symbol, qty, entry_price are required' });
    }

    let row = {
      symbol,
      entry_time: entryTime,
      exit_time: null,
      qty,
      remaining_qty: qty,
      entry_price: entryPrice,
      exit_price: null,
      invested_usdt: safeRound(qty * entryPrice),
      received_usdt: null,
      commission_usdt: commission,
      pl_usdt: null,
      pl_percent: null,
      duration_minutes: null,
      status: 'OPEN',
      source: 'manual',
      buy_exec_id: null,
      sell_exec_id: null,
      created_at: now,
    };

    if (exitPrice > 0 && exitTime > 0) {
      const metrics = buildClosedMetrics({
        qty,
        entryPrice,
        exitPrice,
        entryCommission: commission,
        exitCommission: 0,
        entryTime,
        exitTime,
      });

      row = {
        ...row,
        exit_time: exitTime,
        exit_price: exitPrice,
        received_usdt: metrics.received_usdt,
        commission_usdt: metrics.commission_usdt,
        pl_usdt: metrics.pl_usdt,
        pl_percent: metrics.pl_percent,
        duration_minutes: metrics.duration_minutes,
        remaining_qty: 0,
        status: 'CLOSED',
      };
    }

    const result = await db.run(
      `INSERT INTO trades (
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
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.symbol,
        row.entry_time,
        row.exit_time,
        row.qty,
        row.remaining_qty,
        row.entry_price,
        row.exit_price,
        row.invested_usdt,
        row.received_usdt,
        row.commission_usdt,
        row.pl_usdt,
        row.pl_percent,
        row.duration_minutes,
        row.status,
        row.source,
        row.buy_exec_id,
        row.sell_exec_id,
        row.created_at,
      ]
    );

    const inserted = await db.get('SELECT * FROM trades WHERE id = ?', [result.lastID]);
    res.status(201).json(inserted);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/trades/:id/close', async (req, res) => {
  try {
    const db = await getDb();
    const tradeId = Number(req.params.id);
    const exitPrice = toNum(req.body.exit_price);
    const exitTime = toNum(req.body.exit_time, Date.now());
    const exitCommission = Math.abs(toNum(req.body.exit_commission_usdt));

    if (!Number.isFinite(tradeId) || tradeId <= 0 || exitPrice <= 0) {
      return res.status(400).json({ error: 'valid trade id and exit_price are required' });
    }

    await closeTradeManually(db, tradeId, { exitPrice, exitTime, exitCommission });
    const updated = await db.get('SELECT * FROM trades WHERE id = ?', [tradeId]);
    res.json(updated);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/stats', async (_req, res) => {
  const db = await getDb();

  const total = await db.get('SELECT COUNT(*) as cnt FROM trades');
  const open = await db.get("SELECT COUNT(*) as cnt FROM trades WHERE status = 'OPEN'");
  const closed = await db.get("SELECT COUNT(*) as cnt FROM trades WHERE status = 'CLOSED'");

  const closedStats = await db.get(
    `SELECT
      COALESCE(SUM(pl_usdt), 0) as total_pl_usdt,
      COALESCE(AVG(pl_usdt), 0) as avg_pl_usdt,
      COALESCE(AVG(pl_percent), 0) as avg_pl_percent,
      COALESCE(AVG(duration_minutes), 0) as avg_duration_minutes,
      COALESCE(SUM(CASE WHEN pl_usdt > 0 THEN 1 ELSE 0 END), 0) as wins,
      COALESCE(SUM(CASE WHEN pl_usdt < 0 THEN 1 ELSE 0 END), 0) as losses,
      COALESCE(AVG(CASE WHEN pl_usdt > 0 THEN pl_usdt END), 0) as avg_win_usdt,
      COALESCE(AVG(CASE WHEN pl_usdt < 0 THEN pl_usdt END), 0) as avg_loss_usdt
    FROM trades
    WHERE status = 'CLOSED'`
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

app.post('/api/bybit/sync', async (req, res) => {
  try {
    const db = await getDb();
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;
    const recvWindow = Number(process.env.BYBIT_RECV_WINDOW || 5000);
    const baseUrl = process.env.BYBIT_BASE_URL || 'https://api.bybit.com';

    if (!apiKey || !apiSecret) {
      return res.status(400).json({ error: 'Set BYBIT_API_KEY and BYBIT_API_SECRET in .env' });
    }

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

    // Bybit already scopes this endpoint by `category=spot` in request params.
    // Some responses do not include `category` per row, so filtering by row field
    // can incorrectly drop all executions.
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
          const exists = await db.get('SELECT id FROM trades WHERE buy_exec_id = ? LIMIT 1', [execId]);
          if (exists) continue;
        }

        await db.run(
          `INSERT INTO trades (
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
          ) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, NULL, ?, NULL, NULL, NULL, 'OPEN', 'bybit', ?, NULL, ?)`,
          [
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
        const result = await applySellExecutionFifo(db, ex);
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
