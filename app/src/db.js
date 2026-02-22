const path = require('path');
const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

let db;

async function getDb() {
  if (!db) {
    const dbPath =
      process.env.SQLITE_PATH ||
      path.join(__dirname, '..', 'data', 'trades.db');

    db = await open({
      filename: dbPath,
      driver: sqlite3.Database,
    });

    await db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        entry_time INTEGER NOT NULL,
        exit_time INTEGER,
        qty REAL NOT NULL,
        remaining_qty REAL NOT NULL,
        entry_price REAL NOT NULL,
        exit_price REAL,
        invested_usdt REAL NOT NULL,
        received_usdt REAL,
        commission_usdt REAL DEFAULT 0,
        pl_usdt REAL,
        pl_percent REAL,
        duration_minutes INTEGER,
        status TEXT NOT NULL,
        source TEXT DEFAULT 'manual',
        buy_exec_id TEXT,
        sell_exec_id TEXT,
        created_at INTEGER NOT NULL
      );

      DROP INDEX IF EXISTS idx_trades_buy_exec_id;
      CREATE INDEX IF NOT EXISTS idx_trades_buy_exec_id ON trades(buy_exec_id);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades(symbol, status);
    `);
  }

  return db;
}

module.exports = { getDb };
