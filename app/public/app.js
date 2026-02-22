const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const STORAGE_TOKEN_KEY = 'trade_diary_token';

const $authCard = document.getElementById('auth-card');
const $authForm = document.getElementById('auth-form');
const $appSections = document.getElementById('app-sections');
const $profileCard = document.getElementById('profile-card');
const $profileInfo = document.getElementById('profile-info');
const $changeKeysBtn = document.getElementById('change-keys-btn');

const $stats = document.getElementById('stats');
const $tbody = document.getElementById('trades-body');
const $syncBtn = document.getElementById('sync-btn');
const $syncDays = document.getElementById('sync-days');

let authToken = localStorage.getItem(STORAGE_TOKEN_KEY) || '';

const fmt = (n) => (n === null || n === undefined ? '-' : Number(n).toFixed(4));
const fmtQty = (n) => (n === null || n === undefined ? '-' : Number(n).toFixed(8));
const fmtTime = (ms) => (ms ? new Date(Number(ms)).toLocaleString() : '-');
function fmtDuration(trade) {
  if (trade.status === 'OPEN') return 'Открыта';

  const entry = Number(trade.entry_time || 0);
  const exit = Number(trade.exit_time || 0);
  if (entry > 0 && exit > entry) {
    const totalSec = Math.max(1, Math.round((exit - entry) / 1000));
    if (totalSec < 60) return `${totalSec} сек`;
    const totalMin = Math.floor(totalSec / 60);
    if (totalMin < 60) return `${totalMin} мин`;
    const hours = Math.floor(totalMin / 60);
    const mins = totalMin % 60;
    return mins > 0 ? `${hours} ч ${mins} мин` : `${hours} ч`;
  }

  if (trade.duration_minutes === null || trade.duration_minutes === undefined) return '-';
  return `${trade.duration_minutes} мин`;
}

function setLoggedOutView() {
  $authCard.classList.remove('hidden');
  $appSections.classList.add('hidden');
  $profileCard.classList.add('hidden');
  $tbody.innerHTML = '';
  $stats.innerHTML = '';
}

function setLoggedInView(profile) {
  $authCard.classList.add('hidden');
  $appSections.classList.remove('hidden');
  $profileCard.classList.remove('hidden');
  $profileInfo.textContent = `Аккаунт: ${profile.api_key_masked} (${profile.base_url})`;
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {}),
  };

  if (authToken) {
    headers.Authorization = `Bearer ${authToken}`;
  }

  const res = await fetch(path, {
    ...options,
    headers,
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || 'Ошибка API');
  return body;
}

async function loadStats() {
  const stats = await api('/api/stats');
  const items = [
    ['Всего сделок', stats.total_trades],
    ['Открытых', stats.open_trades],
    ['Закрытых', stats.closed_trades],
    ['Общий P/L USDT', fmt(stats.total_pl_usdt)],
    ['Средний P/L USDT', fmt(stats.avg_pl_usdt)],
    ['Средний P/L %', fmt(stats.avg_pl_percent)],
    ['Средний профит', fmt(stats.avg_win_usdt)],
    ['Средний лосс', fmt(stats.avg_loss_usdt)],
    ['Win rate %', fmt(stats.win_rate_percent)],
    ['Ср. длительность (мин)', stats.avg_duration_minutes],
  ];

  $stats.innerHTML = items
    .map(
      ([label, value]) => `
      <div class="stat-item">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </div>`
    )
    .join('');
}

async function loadTrades() {
  const trades = await api('/api/trades');
  const visibleTrades = trades.filter((t) => {
    const isDustFix = String(t.source || '').toLowerCase() === 'bybit_dust_fix';
    const isAllZero =
      Number(t.qty || 0) === 0 &&
      Number(t.invested_usdt || 0) === 0 &&
      Number(t.received_usdt || 0) === 0 &&
      Number(t.pl_usdt || 0) === 0 &&
      Number(t.pl_percent || 0) === 0;
    return !(isDustFix || isAllZero);
  });

  $tbody.innerHTML = visibleTrades
    .map((t) => {
      const pl = t.pl_usdt;
      const plClass = pl === null ? '' : pl >= 0 ? 'good' : 'bad';
      return `
        <tr>
          <td>${t.id}</td>
          <td>${t.symbol}</td>
          <td>${t.status}</td>
          <td>${fmtQty(t.qty)}</td>
          <td>${fmt(t.entry_price)}<br><small>${fmtTime(t.entry_time)}</small></td>
          <td>${t.exit_price ? fmt(t.exit_price) : '-'}<br><small>${fmtTime(t.exit_time)}</small></td>
          <td>${fmt(t.invested_usdt)}</td>
          <td>${fmt(t.received_usdt)}</td>
          <td>${fmt(t.commission_usdt)}</td>
          <td class="${plClass}">${fmt(t.pl_usdt)}</td>
          <td class="${plClass}">${fmt(t.pl_percent)}</td>
          <td>${fmtDuration(t)}</td>
          <td>${t.source}</td>
        </tr>
      `;
    })
    .join('');
}

async function refreshAll() {
  await Promise.all([loadStats(), loadTrades()]);
}

$authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const payload = {
      api_key: $authForm.elements.api_key.value.trim(),
      api_secret: $authForm.elements.api_secret.value.trim(),
      base_url: $authForm.elements.base_url.value,
    };

    const result = await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    authToken = result.token;
    localStorage.setItem(STORAGE_TOKEN_KEY, authToken);
    setLoggedInView(result.profile);
    await refreshAll();
    $authForm.reset();
  } catch (err) {
    alert(err.message);
  }
});

$changeKeysBtn.addEventListener('click', () => {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  authToken = '';
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  setLoggedOutView();
});

$syncBtn.addEventListener('click', async () => {
  try {
    $syncBtn.disabled = true;
    $syncBtn.textContent = 'Синхронизация...';

    const days = Number($syncDays.value || 7);
    const result = await api('/api/bybit/sync', {
      method: 'POST',
      body: JSON.stringify({ days }),
    });

    alert(
      `Готово. Получено исполнений: ${result.executions_received}. ` +
        `Создано BUY: ${result.buys_created}. Закрыто SELL: ${result.sell_matches_closed}.`
    );

    await refreshAll();
  } catch (err) {
    alert(err.message);
  } finally {
    $syncBtn.disabled = false;
    $syncBtn.textContent = 'Синхронизировать';
  }
});

async function bootstrap() {
  try {
    const profile = await api('/api/auth/me');
    setLoggedInView(profile);
    await refreshAll();
  } catch (_err) {
    authToken = '';
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    setLoggedOutView();
  }
}

bootstrap().catch((e) => alert(e.message));
