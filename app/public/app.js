const tg = window.Telegram?.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const $stats = document.getElementById('stats');
const $tbody = document.getElementById('trades-body');
const $syncBtn = document.getElementById('sync-btn');
const $syncDays = document.getElementById('sync-days');

const fmt = (n) => (n === null || n === undefined ? '-' : Number(n).toFixed(4));
const fmtTime = (ms) => (ms ? new Date(Number(ms)).toLocaleString() : '-');

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });

  const body = await res.json();
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

function closeButton(trade) {
  if (trade.status !== 'OPEN') return '-';
  return `<button data-close-id="${trade.id}" class="small-btn">Закрыть</button>`;
}

async function loadTrades() {
  const trades = await api('/api/trades');
  $tbody.innerHTML = trades
    .map((t) => {
      const pl = t.pl_usdt;
      const plClass = pl === null ? '' : pl >= 0 ? 'good' : 'bad';
      return `
        <tr>
          <td>${t.id}</td>
          <td>${t.symbol}</td>
          <td>${t.status}</td>
          <td>${fmt(t.qty)}</td>
          <td>${fmt(t.entry_price)}<br><small>${fmtTime(t.entry_time)}</small></td>
          <td>${t.exit_price ? fmt(t.exit_price) : '-'}<br><small>${fmtTime(t.exit_time)}</small></td>
          <td>${fmt(t.invested_usdt)}</td>
          <td>${fmt(t.received_usdt)}</td>
          <td>${fmt(t.commission_usdt)}</td>
          <td class="${plClass}">${fmt(t.pl_usdt)}</td>
          <td class="${plClass}">${fmt(t.pl_percent)}</td>
          <td>${t.duration_minutes ?? '-'}</td>
          <td>${t.source}</td>
          <td>${closeButton(t)}</td>
        </tr>
      `;
    })
    .join('');
}

async function refreshAll() {
  await Promise.all([loadStats(), loadTrades()]);
}

$tbody.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-close-id]');
  if (!btn) return;

  const tradeId = btn.getAttribute('data-close-id');
  const exitPriceInput = prompt('Введите цену выхода:');
  if (!exitPriceInput) return;

  const feeInput = prompt('Введите комиссию выхода (USDT), если есть:', '0');

  try {
    await api(`/api/trades/${tradeId}/close`, {
      method: 'PUT',
      body: JSON.stringify({
        exit_price: Number(exitPriceInput),
        exit_commission_usdt: Number(feeInput || 0),
      }),
    });
    await refreshAll();
  } catch (err) {
    alert(err.message);
  }
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
refreshAll().catch((e) => alert(e.message));
