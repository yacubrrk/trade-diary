const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}
const telegramUserId = String(tg?.initDataUnsafe?.user?.id || '').trim();

const STORAGE_TOKEN_KEY = 'trade_diary_token';

const $authCard = document.getElementById('auth-card');
const $authForm = document.getElementById('auth-form');
const $exchangeInput = document.getElementById('exchange-input');
const $okxPassphraseWrap = document.getElementById('okx-passphrase-wrap');
const $apiPassphraseInput = document.getElementById('api-passphrase-input');
const $quickLoginCard = document.getElementById('quick-login-card');
const $quickLoginList = document.getElementById('quick-login-list');
const $appSections = document.getElementById('app-sections');
const $spotView = document.getElementById('spot-view');
const $p2pView = document.getElementById('p2p-view');
const $profileView = document.getElementById('profile-view');
const $profileName = document.getElementById('profile-name');
const $profileInfo = document.getElementById('profile-info');
const $changeKeysBtn = document.getElementById('change-keys-btn');
const $profileSettingsBtn = document.getElementById('profile-settings-btn');
const $profileSettingsPanel = document.getElementById('profile-settings-panel');
const $profileSwitchSelect = document.getElementById('profile-switch-select');
const $switchProfileBtn = document.getElementById('switch-profile-btn');
const $profileNameInput = document.getElementById('profile-name-input');
const $saveProfileNameBtn = document.getElementById('save-profile-name-btn');
const $bottomNav = document.getElementById('bottom-nav');
const $tabSpot = document.getElementById('tab-spot');
const $tabP2P = document.getElementById('tab-p2p');
const $tabProfile = document.getElementById('tab-profile');

const $stats = document.getElementById('stats');
const $tbody = document.getElementById('trades-body');
const $mobileTrades = document.getElementById('mobile-trades');
const $p2pList = document.getElementById('p2p-list');
const $profileBalanceSummary = document.getElementById('profile-balance-summary');
const $profileBalanceList = document.getElementById('profile-balance-list');
const $tradeModal = document.getElementById('trade-modal');
const $tradeModalTitle = document.getElementById('trade-modal-title');
const $tradeModalGrid = document.getElementById('trade-modal-grid');
const $tradeModalClose = document.getElementById('trade-modal-close');
const $newTradesPill = document.getElementById('new-trades-pill');
const $spotTabBadge = document.getElementById('spot-tab-badge');
const $syncStatusPill = document.getElementById('sync-status-pill');

let authToken = localStorage.getItem(STORAGE_TOKEN_KEY) || '';
let lastSeenTradeId = 0;
let latestTradeId = 0;
let autoRefreshTimer = null;
let warmupRefreshTimer = null;
let currentProfileName = '';
let currentProfileId = 0;
let currentExchange = 'BYBIT';

const fmt = (n) => (n === null || n === undefined ? '-' : Number(n).toFixed(4));
const fmtQty = (n) => (n === null || n === undefined ? '-' : Number(n).toFixed(8));
const fmtTime = (ms) => (ms ? new Date(Number(ms)).toLocaleString() : '-');
const normalizeExchange = (value) => (String(value || 'BYBIT').trim().toUpperCase() === 'OKX' ? 'OKX' : 'BYBIT');

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
  stopWarmupRefreshLoop();
  setNewTradesIndicator(0);
  $tbody.innerHTML = '';
  $mobileTrades.innerHTML = '';
  $stats.innerHTML = '';
  if ($profileSwitchSelect) $profileSwitchSelect.innerHTML = '';
  currentExchange = normalizeExchange($exchangeInput?.value || 'BYBIT');
  togglePassphraseField();
  loadQuickLoginOptions().catch(() => {});
  setSyncStatus(false);
}

function setActiveTab(tab) {
  $spotView.classList.toggle('hidden', tab !== 'spot');
  $p2pView.classList.toggle('hidden', tab !== 'p2p');
  $profileView.classList.toggle('hidden', tab !== 'profile');
  $tabSpot.classList.toggle('active', tab === 'spot');
  $tabP2P.classList.toggle('active', tab === 'p2p');
  $tabProfile.classList.toggle('active', tab === 'profile');
}

function setLoggedInView(profile) {
  $authCard.classList.add('hidden');
  $appSections.classList.remove('hidden');
  $bottomNav.classList.remove('hidden');
  currentProfileId = Number(profile.id || 0);
  currentExchange = normalizeExchange(profile.exchange);
  currentProfileName = String(profile.profile_name || '').trim();
  $profileName.textContent = currentProfileName || 'Профиль без имени';
  $profileInfo.textContent = `Биржа: ${currentExchange} (${profile.base_url})`;
  $profileNameInput.value = currentProfileName;
  $profileSettingsPanel.classList.add('hidden');
  lastSeenTradeId = Number(profile.last_read_trade_id || 0);
  setActiveTab('spot');
  startAutoRefreshLoop();
}

async function loadProfileSwitchOptions() {
  try {
    const data = await api('/api/profiles');
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!$profileSwitchSelect) return;
    $profileSwitchSelect.innerHTML = rows
      .map((p) => {
        const exchange = normalizeExchange(p.exchange);
        const title = `${exchange}: ${p.profile_name || p.api_key_masked || `Профиль #${p.id}`}`;
        const selected = Number(p.id) === Number(currentProfileId) ? 'selected' : '';
        return `<option value="${p.id}" ${selected}>${title}</option>`;
      })
      .join('');
    $switchProfileBtn.disabled = rows.length <= 1;
  } catch (_err) {
    if ($profileSwitchSelect) {
      $profileSwitchSelect.innerHTML = '<option value="">Профили недоступны</option>';
    }
  }
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
  setSyncStatus(true, 'Синхронизируем сделки, это может занять до 1-2 минут...');
  let trades = [];
  try {
    trades = await api('/api/trades');
  } catch (err) {
    $tbody.innerHTML = `<tr><td colspan="13">${err.message || 'Ошибка загрузки сделок'}</td></tr>`;
    $mobileTrades.innerHTML = `<div class="hint">${err.message || 'Ошибка загрузки сделок'}</div>`;
    setSyncStatus(false);
    return;
  }
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

  if (!visibleTrades.length) {
    $tbody.innerHTML =
      '<tr><td colspan="13">Сделки загружаются с биржи. Обычно это занимает 10-90 секунд.</td></tr>';
    $mobileTrades.innerHTML = '<div class="hint">Сделки загружаются с биржи. Подожди немного.</div>';
  }

  setSyncStatus(false);
}

async function refreshAll() {
  try {
    await Promise.all([loadStats(), loadTrades(), loadP2POrders(), loadProfileBalance()]);
  } finally {
    setSyncStatus(false);
  }
}

function setNewTradesIndicator(count) {
  const safeCount = Math.max(0, Number(count || 0));
  if (safeCount > 0) {
    $newTradesPill.textContent = `Новые: ${safeCount}`;
    $newTradesPill.classList.remove('hidden');
    $spotTabBadge.textContent = String(safeCount);
    $spotTabBadge.classList.remove('hidden');
  } else {
    $newTradesPill.classList.add('hidden');
    $spotTabBadge.classList.add('hidden');
  }
}

function setSyncStatus(active, text = 'Синхронизируем сделки...') {
  if (!$syncStatusPill) return;
  if (!active) {
    $syncStatusPill.classList.add('hidden');
    return;
  }
  $syncStatusPill.textContent = text;
  $syncStatusPill.classList.remove('hidden');
}

function togglePassphraseField() {
  const exchange = normalizeExchange($exchangeInput?.value || 'BYBIT');
  const isOkx = exchange === 'OKX';
  $okxPassphraseWrap.classList.toggle('hidden', !isOkx);
  $apiPassphraseInput.required = isOkx;
  if (!isOkx) {
    $apiPassphraseInput.value = '';
  }
}

async function loginWithTelegramProfile({ exchange, profileId }) {
  if (!telegramUserId) throw new Error('Telegram user not found');

  const result = await api('/api/auth/telegram-login', {
    method: 'POST',
    body: JSON.stringify({
      tg_user_id: telegramUserId,
      exchange: exchange || undefined,
      profile_id: Number(profileId || 0) || undefined,
    }),
  });

  authToken = result.token;
  localStorage.setItem(STORAGE_TOKEN_KEY, authToken);
  setLoggedInView(result.profile);
  await autoSyncAndRefresh();
}

async function loadQuickLoginOptions() {
  if (!telegramUserId) {
    $quickLoginCard.classList.add('hidden');
    $quickLoginList.innerHTML = '';
    return;
  }

  try {
    const data = await api(`/api/auth/telegram-profiles?tg_user_id=${encodeURIComponent(telegramUserId)}`);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      $quickLoginCard.classList.add('hidden');
      $quickLoginList.innerHTML = '';
      return;
    }

    $quickLoginCard.classList.remove('hidden');
    $quickLoginList.innerHTML = rows
      .slice(0, 2)
      .map((p) => {
        const exchange = normalizeExchange(p.exchange);
        const title = p.profile_name || p.api_key_masked || `Профиль #${p.id}`;
        return `
          <button class="quick-login-btn" type="button" data-profile-id="${p.id}" data-exchange="${exchange}">
            Войти в ${exchange}: ${title}
          </button>
        `;
      })
      .join('');

    $quickLoginList.querySelectorAll('.quick-login-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const profileId = Number(btn.getAttribute('data-profile-id') || 0);
        const exchange = normalizeExchange(btn.getAttribute('data-exchange') || 'BYBIT');
        try {
          btn.disabled = true;
          btn.classList.add('is-loading');
          await loginWithTelegramProfile({ exchange, profileId });
        } catch (err) {
          alert(err.message || 'Не удалось войти в профиль');
        } finally {
          btn.disabled = false;
          btn.classList.remove('is-loading');
        }
      });
    });
  } catch (_err) {
    $quickLoginCard.classList.add('hidden');
    $quickLoginList.innerHTML = '';
  }
}

async function loadP2POrders() {
  try {
    const data = await api('/api/p2p/orders?days=7');
    if (data.supported === false) {
      $p2pList.innerHTML = `<div class="hint">P2P недоступно для биржи ${data.exchange || currentExchange}</div>`;
      return;
    }
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

async function loadProfileBalance() {
  try {
    const data = await api('/api/balance');
    if (data.supported === false) {
      $profileBalanceSummary.textContent = '-';
      $profileBalanceList.innerHTML = `<div class="hint">${data.message || `Баланс недоступен для ${data.exchange || currentExchange}`}</div>`;
      return;
    }
    const total = Number(data.unified_total_usd || 0).toFixed(2);
    $profileBalanceSummary.textContent = total;

    const coins = (data.unified_coins || []).slice(0, 6).map(
      (c) => `
        <div class="profile-balance-item">
          <span>${c.coin}</span>
          <strong>$${Number(c.usd_value || 0).toFixed(2)}</strong>
        </div>
      `
    );

    $profileBalanceList.innerHTML = coins.length
      ? coins.join('')
      : '<div class="hint">Ненулевых активов не найдено</div>';
  } catch (err) {
    $profileBalanceSummary.textContent = '-';
    $profileBalanceList.innerHTML = `<div class="hint">${err.message}</div>`;
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
    .catch((err) => {
      alert(err.message || 'Не удалось отметить сделки как прочитанные');
    });
}

async function autoSyncAndRefresh() {
  try {
    await api('/api/sync/auto', { method: 'POST' });
  } catch (_err) {
    // Ignore transient sync errors, existing saved history should remain visible.
  }
  try {
    const profile = await api('/api/auth/me');
    lastSeenTradeId = Number(profile.last_read_trade_id || lastSeenTradeId);
  } catch (_err) {
    // keep current in-memory value
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

function stopWarmupRefreshLoop() {
  if (!warmupRefreshTimer) return;
  clearInterval(warmupRefreshTimer);
  warmupRefreshTimer = null;
}

function startWarmupRefreshLoop() {
  if (warmupRefreshTimer) clearInterval(warmupRefreshTimer);
  let ticks = 0;
  warmupRefreshTimer = setInterval(() => {
    ticks += 1;
    autoSyncAndRefresh().catch(() => {});
    if (ticks >= 12) {
      clearInterval(warmupRefreshTimer);
      warmupRefreshTimer = null;
    }
  }, 5000);
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
      exchange: normalizeExchange($authForm.elements.exchange.value),
      api_key: $authForm.elements.api_key.value.trim(),
      api_secret: $authForm.elements.api_secret.value.trim(),
      api_passphrase: $authForm.elements.api_passphrase.value.trim() || undefined,
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
    startWarmupRefreshLoop();
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
  stopWarmupRefreshLoop();
  setLoggedOutView();
});

$profileSettingsBtn.addEventListener('click', () => {
  $profileSettingsPanel.classList.toggle('hidden');
  if (!$profileSettingsPanel.classList.contains('hidden')) {
    loadProfileSwitchOptions().catch(() => {});
  }
});

$switchProfileBtn.addEventListener('click', async () => {
  const targetId = Number($profileSwitchSelect.value || 0);
  if (!targetId || targetId === Number(currentProfileId || 0)) return;
  try {
    $switchProfileBtn.disabled = true;
    $switchProfileBtn.classList.add('is-loading');
    const result = await api('/api/profiles/switch', {
      method: 'POST',
      body: JSON.stringify({ profile_id: targetId }),
    });
    authToken = result.token;
    localStorage.setItem(STORAGE_TOKEN_KEY, authToken);
    setLoggedInView(result.profile);
    await autoSyncAndRefresh();
    startWarmupRefreshLoop();
    await loadProfileSwitchOptions();
  } catch (err) {
    alert(err.message);
  } finally {
    $switchProfileBtn.disabled = false;
    $switchProfileBtn.classList.remove('is-loading');
  }
});

$saveProfileNameBtn.addEventListener('click', async () => {
  const name = String($profileNameInput.value || '').trim();
  if (!name) {
    alert('Введите имя профиля');
    return;
  }
  try {
    $saveProfileNameBtn.disabled = true;
    $saveProfileNameBtn.classList.add('is-loading');
    const result = await api('/api/profile/name', {
      method: 'POST',
      body: JSON.stringify({ profile_name: name }),
    });
    currentProfileName = String(result.profile_name || name);
    $profileName.textContent = currentProfileName;
    await loadProfileSwitchOptions();
  } catch (err) {
    alert(err.message);
  } finally {
    $saveProfileNameBtn.disabled = false;
    $saveProfileNameBtn.classList.remove('is-loading');
  }
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

$tabSpot.addEventListener('click', () => setActiveTab('spot'));
$tabP2P.addEventListener('click', () => setActiveTab('p2p'));
$tabProfile.addEventListener('click', () => setActiveTab('profile'));
$exchangeInput.addEventListener('change', togglePassphraseField);

async function bootstrap() {
  try {
    const profile = await api('/api/auth/me');
    setLoggedInView(profile);
    await autoSyncAndRefresh();
    startWarmupRefreshLoop();
  } catch (_err) {
    authToken = '';
    localStorage.removeItem(STORAGE_TOKEN_KEY);
    setLoggedOutView();
  }
}

bootstrap().catch((e) => alert(e.message));
togglePassphraseField();
