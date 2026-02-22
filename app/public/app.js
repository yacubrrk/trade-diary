const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}
const telegramUserId = String(tg?.initDataUnsafe?.user?.id || '').trim();

const STORAGE_TOKEN_KEY = 'trade_diary_token';

const $authCard = document.getElementById('auth-card');
const $authForm = document.getElementById('auth-form');
const $appSections = document.getElementById('app-sections');
const $historyView = document.getElementById('history-view');
const $profileView = document.getElementById('profile-view');
const $profileInfo = document.getElementById('profile-info');
const $changeKeysBtn = document.getElementById('change-keys-btn');
const $profileSettingsBtn = document.getElementById('profile-settings-btn');
const $profileSettingsPanel = document.getElementById('profile-settings-panel');
const $bottomNav = document.getElementById('bottom-nav');
const $tabHistory = document.getElementById('tab-history');
const $tabProfile = document.getElementById('tab-profile');

const $stats = document.getElementById('stats');
const $balanceSummary = document.getElementById('balance-summary');
const $balanceList = document.getElementById('balance-list');
const $tbody = document.getElementById('trades-body');
const $mobileTrades = document.getElementById('mobile-trades');
const $p2pList = document.getElementById('p2p-list');
const $tradeModal = document.getElementById('trade-modal');
const $tradeModalTitle = document.getElementById('trade-modal-title');
const $tradeModalGrid = document.getElementById('trade-modal-grid');
const $tradeModalClose = document.getElementById('trade-modal-close');
const $newTradesPill = document.getElementById('new-trades-pill');
const $historyTabBadge = document.getElementById('history-tab-badge');

let authToken = localStorage.getItem(STORAGE_TOKEN_KEY) || '';
let lastSeenTradeId = 0;
let latestTradeId = 0;
let autoRefreshTimer = null;

const fmt = (n) => (n === null || n === undefined ? '-' : Number(n).toFixed(4));
const fmtQty = (n) => (n === null || n === undefined ? '-' : Number(n).toFixed(8));
const fmtTime = (ms) => (ms ? new Date(Number(ms)).toLocaleString() : '-');

function formatDurationFull(totalSecInput) {
  let totalSec = Math.max(0, Math.floor(Number(totalSecInput || 0)));
  const secInMinute = 60;
  const secInHour = 60 * secInMinute;
  const secInDay = 24 * secInHour;
  const secInMonth = 30 * secInDay;

  const months = Math.floor(totalSec / secInMonth);
  totalSec -= months * secInMonth;
  const days = Math.floor(totalSec / secInDay);
  totalSec -= days * secInDay;
  const hours = Math.floor(totalSec / secInHour);
  totalSec -= hours * secInHour;
  const minutes = Math.floor(totalSec / secInMinute);
  totalSec -= minutes * secInMinute;
  const seconds = totalSec;

  const parts = [];
  if (months > 0) parts.push(`${months} мес`);
  if (days > 0) parts.push(`${days} д`);
  if (hours > 0) parts.push(`${hours} ч`);
  if (minutes > 0) parts.push(`${minutes} мин`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds} сек`);
  return parts.join(' ');
}

function fmtDuration(trade) {
  if (trade.status === 'OPEN') return 'Открыта';

  const entry = Number(trade.entry_time || 0);
  const exit = Number(trade.exit_time || 0);
  if (entry > 0 && exit > entry) {
    const totalSec = Math.max(1, Math.round((exit - entry) / 1000));
    return formatDurationFull(totalSec);
  }

  if (trade.duration_minutes === null || trade.duration_minutes === undefined) return '-';
  const fallbackSec = Math.max(0, Math.round(Number(trade.duration_minutes || 0) * 60));
  return formatDurationFull(fallbackSec);
}

function setLoggedOutView() {
  $authCard.classList.remove('hidden');
  $appSections.classList.add('hidden');
  $bottomNav.classList.add('hidden');
  $profileSettingsPanel.classList.add('hidden');
  stopAutoRefreshLoop();
  setNewTradesIndicator(0);
  $tbody.innerHTML = '';
  $mobileTrades.innerHTML = '';
  $stats.innerHTML = '';
}

function setActiveTab(tab) {
  const isHistory = tab === 'history';
  $historyView.classList.toggle('hidden', !isHistory);
  $profileView.classList.toggle('hidden', isHistory);
  $tabHistory.classList.toggle('active', isHistory);
  $tabProfile.classList.toggle('active', !isHistory);
}

function setLoggedInView(profile) {
  $authCard.classList.add('hidden');
  $appSections.classList.remove('hidden');
  $bottomNav.classList.remove('hidden');
  $profileInfo.textContent = `Аккаунт: ${profile.api_key_masked} (${profile.base_url})`;
  $profileSettingsPanel.classList.add('hidden');
  lastSeenTradeId = Number(profile.last_read_trade_id || 0);
  setActiveTab('history');
  startAutoRefreshLoop();
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
    ['Общий P/L USDT', fmt(stats.total_pl_usdt), Number(stats.total_pl_usdt)],
    ['Средний P/L USDT', fmt(stats.avg_pl_usdt), Number(stats.avg_pl_usdt)],
    ['Средний P/L %', fmt(stats.avg_pl_percent), Number(stats.avg_pl_percent)],
    ['Средний профит', fmt(stats.avg_win_usdt)],
    ['Средний лосс', fmt(stats.avg_loss_usdt)],
    ['Win rate %', fmt(stats.win_rate_percent)],
    ['Ср. длительность (мин)', stats.avg_duration_minutes],
  ];

  $stats.innerHTML = items
    .map(
      ([label, value, score]) => `
      <div class="stat-item ${Number.isFinite(score) ? (score > 0 ? 'stat-pos' : score < 0 ? 'stat-neg' : '') : ''}">
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
  latestTradeId = visibleTrades.length ? Math.max(...visibleTrades.map((t) => Number(t.id || 0))) : 0;
  const unreadCount = visibleTrades.filter((t) => Number(t.id || 0) > lastSeenTradeId).length;
  const unreadTrades = visibleTrades.filter((t) => Number(t.id || 0) > lastSeenTradeId);
  const readTrades = visibleTrades.filter((t) => Number(t.id || 0) <= lastSeenTradeId);
  setNewTradesIndicator(unreadCount);

  $tbody.innerHTML = visibleTrades
    .map((t) => {
      const pl = t.pl_usdt;
      const plClass = pl === null ? '' : pl >= 0 ? 'good' : 'bad';
      const unreadClass = Number(t.id || 0) > lastSeenTradeId ? 'trade-unread' : '';
      return `
        <tr class="${unreadClass}">
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

  const renderTradeCard = (t, unread = false) => {
      const pl = Number(t.pl_usdt);
      const plClass = Number.isFinite(pl) ? (pl >= 0 ? 'good' : 'bad') : '';
      const unreadClass = unread ? 'trade-item-unread' : '';
      return `
        <article class="trade-item ${unreadClass}" data-trade-id="${t.id}">
          <div class="trade-item-top">
            <div>
              <div class="trade-item-symbol">${t.symbol}</div>
              <div class="trade-item-status">${t.status}</div>
            </div>
            <div class="trade-item-pl ${plClass}">${fmt(t.pl_usdt)} USDT</div>
          </div>
          <div class="trade-item-meta">
            <span>Вход: ${fmt(t.entry_price)}</span>
            <span>Выход: ${t.exit_price ? fmt(t.exit_price) : '-'}</span>
            <span>Длит.: ${fmtDuration(t)}</span>
          </div>
        </article>
      `;
    };

  const unreadSection = unreadTrades.length
    ? `
      <div class="trades-section-head">
        <h3>Непрочитанные</h3>
        <button class="mark-read-btn" id="mark-read-btn" type="button">Прочитать все</button>
      </div>
      ${unreadTrades.map((t) => renderTradeCard(t, true)).join('')}
      `
    : '';
  const readSection = `
    <div class="trades-section-head">
      <h3>${unreadTrades.length ? 'Прочитанные' : 'Сделки'}</h3>
    </div>
    ${readTrades.map((t) => renderTradeCard(t)).join('')}
  `;

  $mobileTrades.innerHTML = `${unreadSection}${readSection}`;

  $mobileTrades.querySelectorAll('.trade-item').forEach((item) => {
    item.addEventListener('click', () => {
      const tradeId = Number(item.getAttribute('data-trade-id'));
      const trade = visibleTrades.find((x) => x.id === tradeId);
      if (!trade) return;
      openTradeModal(trade);
    });
  });

  const markReadBtn = document.getElementById('mark-read-btn');
  if (markReadBtn) {
    markReadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      markAllTradesAsRead();
    });
  }
}

async function refreshAll() {
  await Promise.all([loadStats(), loadTrades(), loadBalance(), loadP2POrders()]);
}

function setNewTradesIndicator(count) {
  const safeCount = Math.max(0, Number(count || 0));
  if (safeCount > 0) {
    $newTradesPill.textContent = `Новые: ${safeCount}`;
    $newTradesPill.classList.remove('hidden');
    $historyTabBadge.textContent = String(safeCount);
    $historyTabBadge.classList.remove('hidden');
  } else {
    $newTradesPill.classList.add('hidden');
    $historyTabBadge.classList.add('hidden');
  }
}

async function loadBalance() {
  try {
    const data = await api('/api/balance');
    const total = Number(data.unified_total_usd || 0).toFixed(2);
    $balanceSummary.textContent = `Общий баланс (USD): ${total}`;

    const unifiedRows = (data.unified_coins || []).slice(0, 12).map(
      (c) => `
        <div class="balance-item">
          <div class="coin">${c.coin}</div>
          <div class="val">${Number(c.wallet_balance || 0).toFixed(6)}</div>
          <div class="sub">$${Number(c.usd_value || 0).toFixed(2)}</div>
        </div>
      `
    );
    const fundRows = (data.fund_coins || []).slice(0, 8).map(
      (c) => `
        <div class="balance-item balance-fund">
          <div class="coin">${c.coin} (FUND)</div>
          <div class="val">${Number(c.wallet_balance || c.transfer_balance || 0).toFixed(6)}</div>
          <div class="sub">Funding</div>
        </div>
      `
    );

    const rows = [...unifiedRows, ...fundRows];
    $balanceList.innerHTML = rows.length ? rows.join('') : '<div class="hint">Ненулевых балансов не найдено</div>';
  } catch (err) {
    $balanceSummary.textContent = 'Баланс недоступен';
    $balanceList.innerHTML = `<div class="hint">${err.message}</div>`;
  }
}

async function loadP2POrders() {
  try {
    const data = await api('/api/p2p/orders?days=7');
    const rows = data.rows || [];
    if (!rows.length) {
      $p2pList.innerHTML = '<div class="hint">За последние 7 дней P2P сделок нет</div>';
      return;
    }

    $p2pList.innerHTML = rows
      .slice(0, 20)
      .map(
        (r) => `
          <article class="p2p-item">
            <div class="top">
              <strong>${r.token || '-'}/${r.fiat || '-'}</strong>
              <span>${r.side || '-'}</span>
            </div>
            <div class="meta">
              <span>Сумма: ${Number(r.amount || 0).toFixed(4)}</span>
              <span>Цена: ${Number(r.price || 0).toFixed(4)}</span>
              <span>Итого: ${Number(r.total_price || 0).toFixed(2)}</span>
              <span>Статус: ${r.status || '-'}</span>
            </div>
          </article>
        `
      )
      .join('');
  } catch (err) {
    $p2pList.innerHTML = `<div class="hint">${err.message}</div>`;
  }
}

function markAllTradesAsRead() {
  if (latestTradeId <= 0) return;
  api('/api/trades/mark-read', { method: 'POST' })
    .then((result) => {
      lastSeenTradeId = Number(result.last_read_trade_id || latestTradeId);
      setNewTradesIndicator(0);
      return loadTrades();
    })
    .catch(() => {});
}

async function autoSyncAndRefresh() {
  try {
    await api('/api/bybit/auto-sync', { method: 'POST' });
  } catch (_err) {
    // Ignore transient sync errors, existing saved history should remain visible.
  }
  await refreshAll();
}

function startAutoRefreshLoop() {
  stopAutoRefreshLoop();
  autoRefreshTimer = setInterval(() => {
    autoSyncAndRefresh().catch(() => {});
  }, 45000);
}

function stopAutoRefreshLoop() {
  if (!autoRefreshTimer) return;
  clearInterval(autoRefreshTimer);
  autoRefreshTimer = null;
}

$authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const submitBtn = $authForm.querySelector('button[type="submit"]');
  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.classList.add('is-loading');
    }

    const payload = {
      api_key: $authForm.elements.api_key.value.trim(),
      api_secret: $authForm.elements.api_secret.value.trim(),
      tg_user_id: telegramUserId || undefined,
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
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.classList.remove('is-loading');
    }
  }
});

$changeKeysBtn.addEventListener('click', () => {
  api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  authToken = '';
  localStorage.removeItem(STORAGE_TOKEN_KEY);
  setLoggedOutView();
});

$profileSettingsBtn.addEventListener('click', () => {
  $profileSettingsPanel.classList.toggle('hidden');
});

function openTradeModal(t) {
  const plClass = Number(t.pl_usdt) >= 0 ? 'good' : 'bad';
  $tradeModalTitle.textContent = `${t.symbol} #${t.id}`;
  $tradeModalGrid.innerHTML = `
    <div class="trade-modal-row"><div class="k">Статус</div><div class="v">${t.status}</div></div>
    <div class="trade-modal-row"><div class="k">Источник</div><div class="v">${t.source}</div></div>
    <div class="trade-modal-row"><div class="k">Количество</div><div class="v">${fmtQty(t.qty)}</div></div>
    <div class="trade-modal-row"><div class="k">Цена входа</div><div class="v">${fmt(t.entry_price)}</div></div>
    <div class="trade-modal-row"><div class="k">Цена выхода</div><div class="v">${t.exit_price ? fmt(t.exit_price) : '-'}</div></div>
    <div class="trade-modal-row"><div class="k">Комиссия</div><div class="v">${fmt(t.commission_usdt)}</div></div>
    <div class="trade-modal-row"><div class="k">Сумма входа</div><div class="v">${fmt(t.invested_usdt)}</div></div>
    <div class="trade-modal-row"><div class="k">Сумма выхода</div><div class="v">${fmt(t.received_usdt)}</div></div>
    <div class="trade-modal-row"><div class="k">P/L USDT</div><div class="v ${plClass}">${fmt(t.pl_usdt)}</div></div>
    <div class="trade-modal-row"><div class="k">P/L %</div><div class="v ${plClass}">${fmt(t.pl_percent)}</div></div>
    <div class="trade-modal-row"><div class="k">Вход</div><div class="v">${fmtTime(t.entry_time)}</div></div>
    <div class="trade-modal-row"><div class="k">Выход</div><div class="v">${fmtTime(t.exit_time)}</div></div>
    <div class="trade-modal-row"><div class="k">Длительность</div><div class="v">${fmtDuration(t)}</div></div>
  `;
  $tradeModal.classList.remove('hidden');
}

function closeTradeModal() {
  $tradeModal.classList.add('hidden');
}

$tradeModalClose.addEventListener('click', closeTradeModal);
$tradeModal.addEventListener('click', (e) => {
  if (e.target === $tradeModal) closeTradeModal();
});

$tabHistory.addEventListener('click', () => setActiveTab('history'));
$tabProfile.addEventListener('click', () => setActiveTab('profile'));

async function bootstrap() {
  try {
    const profile = await api('/api/auth/me');
    setLoggedInView(profile);
    await autoSyncAndRefresh();
  } catch (_err) {
    try {
      if (!telegramUserId) throw new Error('no telegram user');
      const tgLogin = await api('/api/auth/telegram-login', {
        method: 'POST',
        body: JSON.stringify({ tg_user_id: telegramUserId }),
      });
      authToken = tgLogin.token;
      localStorage.setItem(STORAGE_TOKEN_KEY, authToken);
      setLoggedInView(tgLogin.profile);
      await autoSyncAndRefresh();
    } catch (_err2) {
      authToken = '';
      localStorage.removeItem(STORAGE_TOKEN_KEY);
      setLoggedOutView();
    }
  }
}

bootstrap().catch((e) => alert(e.message));
