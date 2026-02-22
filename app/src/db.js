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
      CREATE TABLE IF NOT EXISTS profiles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL UNIQUE,
        api_key TEXT NOT NULL UNIQUE,
        api_secret TEXT NOT NULL,
        base_url TEXT NOT NULL,
        recv_window INTEGER NOT NULL DEFAULT 5000,
        last_sync_at INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_profile_id INTEGER NOT NULL DEFAULT 0,
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

      CREATE INDEX IF NOT EXISTS idx_profiles_public_id ON profiles(public_id);
      DROP INDEX IF EXISTS idx_trades_buy_exec_id;
      CREATE INDEX IF NOT EXISTS idx_trades_buy_exec_id ON trades(buy_exec_id);
      CREATE INDEX IF NOT EXISTS idx_trades_symbol_status ON trades(symbol, status);
      CREATE INDEX IF NOT EXISTS idx_trades_owner_time ON trades(owner_profile_id, entry_time DESC);
    `);

    const tradeColumns = await db.all(`PRAGMA table_info(trades)`);
    const hasOwnerProfileId = tradeColumns.some((c) => c.name === 'owner_profile_id');
    if (!hasOwnerProfileId) {
      await db.exec(`ALTER TABLE trades ADD COLUMN owner_profile_id INTEGER NOT NULL DEFAULT 0`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_trades_owner_time ON trades(owner_profile_id, entry_time DESC)`);
    }

    const profileColumns = await db.all(`PRAGMA table_info(profiles)`);
    const hasLastSyncAt = profileColumns.some((c) => c.name === 'last_sync_at');
    if (!hasLastSyncAt) {
      await db.exec(`ALTER TABLE profiles ADD COLUMN last_sync_at INTEGER NOT NULL DEFAULT 0`);
    }
  }

  return db;
}

module.exports = { getDb };
