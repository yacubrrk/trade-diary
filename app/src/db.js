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
        tg_user_id TEXT,
        profile_name TEXT,
        exchange TEXT NOT NULL DEFAULT 'BYBIT',
        api_key TEXT NOT NULL UNIQUE,
        api_secret TEXT NOT NULL,
        api_passphrase TEXT,
        base_url TEXT NOT NULL,
        recv_window INTEGER NOT NULL DEFAULT 5000,
        history_synced_once INTEGER NOT NULL DEFAULT 0,
        last_read_trade_id INTEGER NOT NULL DEFAULT 0,
        last_selected_at INTEGER NOT NULL DEFAULT 0,
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
      DROP INDEX IF EXISTS idx_profiles_tg_user_id;
      CREATE INDEX IF NOT EXISTS idx_profiles_tg_user_id ON profiles(tg_user_id);
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
    const hasLastReadTradeId = profileColumns.some((c) => c.name === 'last_read_trade_id');
    if (!hasLastReadTradeId) {
      await db.exec(`ALTER TABLE profiles ADD COLUMN last_read_trade_id INTEGER NOT NULL DEFAULT 0`);
    }
    const hasLastSelectedAt = profileColumns.some((c) => c.name === 'last_selected_at');
    if (!hasLastSelectedAt) {
      await db.exec(`ALTER TABLE profiles ADD COLUMN last_selected_at INTEGER NOT NULL DEFAULT 0`);
    }

    const hasTgUserId = profileColumns.some((c) => c.name === 'tg_user_id');
    if (!hasTgUserId) {
      await db.exec(`ALTER TABLE profiles ADD COLUMN tg_user_id TEXT`);
      await db.exec(`DROP INDEX IF EXISTS idx_profiles_tg_user_id`);
      await db.exec(`CREATE INDEX IF NOT EXISTS idx_profiles_tg_user_id ON profiles(tg_user_id)`);
    }

    const hasProfileName = profileColumns.some((c) => c.name === 'profile_name');
    if (!hasProfileName) {
      await db.exec(`ALTER TABLE profiles ADD COLUMN profile_name TEXT`);
    }
    const hasHistorySyncedOnce = profileColumns.some((c) => c.name === 'history_synced_once');
    if (!hasHistorySyncedOnce) {
      await db.exec(`ALTER TABLE profiles ADD COLUMN history_synced_once INTEGER NOT NULL DEFAULT 0`);
    }

    const hasExchange = profileColumns.some((c) => c.name === 'exchange');
    if (!hasExchange) {
      await db.exec(`ALTER TABLE profiles ADD COLUMN exchange TEXT NOT NULL DEFAULT 'BYBIT'`);
      await db.run(`UPDATE profiles SET exchange = 'BYBIT' WHERE exchange IS NULL OR exchange = ''`);
    }

    const hasApiPassphrase = profileColumns.some((c) => c.name === 'api_passphrase');
    if (!hasApiPassphrase) {
      await db.exec(`ALTER TABLE profiles ADD COLUMN api_passphrase TEXT`);
    }
  }

  return db;
}

module.exports = { getDb };
