/* =============================================
   Encomendas Messenger — App Logic v2
   Auto-sync MacroDroid + Keyword Detection
   ============================================= */
'use strict';

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────
let orders        = [];
let reviewQueue   = [];   // messages not matching keywords
let templates     = [];
let keywords      = [];
let orderCounter  = 0;
let currentSection   = 'queue';
let currentFilter    = 'all';
let currentReplyId   = null;

// Auto-sync state
let fileHandle      = null;
let syncTimer       = null;
let lastFileContent = '';
let syncStats       = { total: 0, orders: 0, review: 0 };
let isSyncing       = false;

// Chatbot Server sync state
let serverApiUrl        = 'http://localhost:5000';
let isServerSyncEnabled = false;
let serverSyncTimer     = null;

// ─────────────────────────────────────────────
// STORAGE KEYS
// ─────────────────────────────────────────────
const K_ORDERS    = 'messenger_orders';
const K_REVIEW    = 'messenger_review';
const K_TEMPLATES = 'messenger_templates';
const K_KEYWORDS  = 'messenger_keywords';
const K_COUNTER   = 'messenger_counter';
const K_SYNCSTATS = 'messenger_syncstats';
const K_FNAME     = 'messenger_filename';
const K_SERVER_URL  = 'chatbot_server_url';
const K_SERVER_SYNC = 'chatbot_server_sync_enabled';

// ─────────────────────────────────────────────
// DEFAULT KEYWORDS (Portuguese order terms)
// ─────────────────────────────────────────────
const DEFAULT_KEYWORDS = [
  'quero', 'queria', 'queria encomendar', 'encomendar', 'encomenda',
  'comprar', 'compra', 'pedir', 'pedido', 'preciso', 'gostava',
  'quantidade', 'unidades', 'disponível', 'stock', 'preço',
  'quanto custa', 'tem à venda', 'posso encomendar', 'reservar'
];

// ─────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  setDefaultDateTime();
  buildBookmarkletLink();
  renderAll();
  updateSyncUI();
  initServerSync();
  registerSW();
});

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

// ─────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────
function loadData() {
  try { orders      = JSON.parse(localStorage.getItem(K_ORDERS)    || '[]'); } catch { orders = []; }
  try { reviewQueue = JSON.parse(localStorage.getItem(K_REVIEW)    || '[]'); } catch { reviewQueue = []; }
  try { templates   = JSON.parse(localStorage.getItem(K_TEMPLATES) || 'null') || defaultTemplates(); } catch { templates = defaultTemplates(); }
  try { keywords    = JSON.parse(localStorage.getItem(K_KEYWORDS)  || 'null') || [...DEFAULT_KEYWORDS]; } catch { keywords = [...DEFAULT_KEYWORDS]; }
  try { syncStats   = JSON.parse(localStorage.getItem(K_SYNCSTATS) || '{}');  } catch { syncStats = {}; }
  try { orderCounter = parseInt(localStorage.getItem(K_COUNTER) || '0', 10); } catch { orderCounter = 0; }

  serverApiUrl = localStorage.getItem(K_SERVER_URL) || 'http://localhost:5000';
  isServerSyncEnabled = localStorage.getItem(K_SERVER_SYNC) === 'true';

  // Back-fill sequence numbers
  orders.forEach(o => { if (!o.seq) { orderCounter++; o.seq = orderCounter; } });
  saveData();
}

function saveData() {
  localStorage.setItem(K_ORDERS,    JSON.stringify(orders));
  localStorage.setItem(K_REVIEW,    JSON.stringify(reviewQueue));
  localStorage.setItem(K_TEMPLATES, JSON.stringify(templates));
  localStorage.setItem(K_KEYWORDS,  JSON.stringify(keywords));
  localStorage.setItem(K_COUNTER,   String(orderCounter));
  localStorage.setItem(K_SYNCSTATS, JSON.stringify(syncStats));
  localStorage.setItem(K_SERVER_URL,  serverApiUrl);
  localStorage.setItem(K_SERVER_SYNC, String(isServerSyncEnabled));
}

// ─────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────
const SECTION_META = {
  queue:    ['🗂️ Fila de Triagem', 'Encomendas por ordem de chegada', true,  true],
  history:  ['📋 Histórico',        'Encomendas processadas',          false, true],
  review:   ['🔎 Para Rever',       'Mensagens sem palavras-chave',    false, false],
  import:   ['📥 Importar',         'Adicionar encomendas manualmente', false, false],
  replies:  ['💬 Respostas',        'Templates de mensagens rápidas',  false, false],
  settings: ['⚙️ Configurações',   'Auto-sync e palavras-chave',      false, false],
};

function showSection(name) {
  currentSection = name;
  document.querySelectorAll('.section').forEach(s => s.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));

  const sec = document.getElementById('section-' + name);
  if (sec) sec.classList.add('active');
  ['nav-', 'mnav-'].forEach(p => {
    const b = document.getElementById(p + name);
    if (b) b.classList.add('active');
  });

  const meta = SECTION_META[name] || [name, '', false, false];
  document.getElementById('topbar-title').textContent = meta[0];
  document.getElementById('topbar-sub').textContent   = meta[1];
  document.getElementById('filter-bar').style.display  = meta[2] ? 'flex' : 'none';
  document.getElementById('stats-bar').style.display   = meta[3] ? 'flex' : 'none';

  if (name === 'queue')    renderQueue();
  if (name === 'history')  renderHistory();
  if (name === 'review')   renderReview();
  if (name === 'replies')  renderTemplates();
  if (name === 'settings') { renderKeywords(); renderSyncConnectedUI(); }
}

// ─────────────────────────────────────────────
// FILTER
// ─────────────────────────────────────────────
function setFilter(f) {
  currentFilter = f;
  document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
  const tab = document.getElementById('ftab-' + f);
  if (tab) tab.classList.add('active');
  renderQueue();
}

// ─────────────────────────────────────────────
// RENDER ALL
// ─────────────────────────────────────────────
function renderAll() {
  updateStats();
  if (currentSection === 'queue')   renderQueue();
  if (currentSection === 'history') renderHistory();
  if (currentSection === 'review')  renderReview();
  if (currentSection === 'replies') renderTemplates();
}

// ─────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────
function updateStats() {
  const pending   = orders.filter(o => o.status === 'pendente').length;
  const analysis  = orders.filter(o => o.status === 'analise').length;
  const confirmed = orders.filter(o => o.status === 'confirmada').length;
  const noStock   = orders.filter(o => o.status === 'sem-stock').length;
  const review    = reviewQueue.length;

  setText('stat-pending',   pending);
  setText('stat-review',    review);
  setText('stat-confirmed', confirmed);
  setText('stat-nostock',   noStock);

  // Pending badge (queue nav)
  const pBadge = pending + analysis;
  updateBadge('badge-pending',  'mbadge-pending', pBadge);
  updateBadge('badge-review',   'mbadge-review',  review, true);
}

function updateBadge(id, mid, count, amber) {
  [id, mid].forEach(bid => {
    const el = document.getElementById(bid);
    if (!el) return;
    el.textContent    = count;
    el.style.display  = count > 0 ? 'flex' : 'none';
  });
}

// ─────────────────────────────────────────────
// QUEUE RENDER
// ─────────────────────────────────────────────
function renderQueue() {
  const search = (document.getElementById('queue-search')?.value || '').toLowerCase().trim();
  const list   = document.getElementById('orders-list');
  const empty  = document.getElementById('empty-queue');

  let filtered = [...orders].sort((a, b) =>
    new Date(a.receivedAt) - new Date(b.receivedAt) || a.seq - b.seq
  );

  if (currentFilter !== 'all') filtered = filtered.filter(o => o.status === currentFilter);
  if (search) filtered = filtered.filter(o =>
    o.name.toLowerCase().includes(search) ||
    o.message.toLowerCase().includes(search) ||
    (o.product || '').toLowerCase().includes(search)
  );

  updateStats();
  list.innerHTML  = filtered.length ? filtered.map(buildOrderCard).join('') : '';
  empty.style.display = filtered.length ? 'none' : 'block';
}

// ─────────────────────────────────────────────
// REVIEW RENDER (non-keyword messages)
// ─────────────────────────────────────────────
function renderReview() {
  const list  = document.getElementById('review-list');
  const empty = document.getElementById('empty-review');

  if (!reviewQueue.length) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';
  list.innerHTML = reviewQueue.map(r => buildReviewCard(r)).join('');
}

function buildReviewCard(r) {
  return `
    <div class="order-card status-analise" style="opacity:0.85">
      <div class="order-top">
        <div class="order-meta">
          <div class="order-name">${esc(r.name)}</div>
          <div class="order-time">⏱ ${formatTime(r.receivedAt)}</div>
        </div>
        <span class="order-status" style="background:rgba(139,92,246,0.15);color:#8b5cf6">🔎 A Rever</span>
      </div>
      <div class="order-msg">${esc(r.message)}</div>
      <div class="order-actions">
        <button class="btn btn-confirm btn-sm" onclick="promoteToOrder('${r.id}')">✅ É uma encomenda</button>
        <button class="btn btn-danger btn-sm"  onclick="dismissReview('${r.id}')">🗑️ Ignorar</button>
      </div>
    </div>
  `;
}

function promoteToOrder(id) {
  const r = reviewQueue.find(x => x.id === id);
  if (!r) return;
  reviewQueue = reviewQueue.filter(x => x.id !== id);
  addOrderObj(r);
  saveData();
  renderAll();
  renderReview();
  showToast('✅ Movido para a fila de encomendas');
}

function dismissReview(id) {
  reviewQueue = reviewQueue.filter(x => x.id !== id);
  saveData();
  renderReview();
  updateStats();
  showToast('🗑️ Mensagem ignorada');
}

// ─────────────────────────────────────────────
// ORDER CARD
// ─────────────────────────────────────────────
function buildOrderCard(o) {
  const STATUS = {
    pendente:   '🟡 Pendente',
    analise:    '🔵 Em Análise',
    confirmada: '🟢 Confirmada',
    'sem-stock':'🔴 Sem Stock'
  };
  const seq     = String(o.seq).padStart(3, '0');
  const isActive = o.status === 'pendente' || o.status === 'analise';

  // Highlight matched keywords in message
  const msgHighlighted = highlightKeywords(esc(o.message));

  const messengerBtn = o.conversationUrl
    ? `<a class="btn btn-ghost btn-sm" href="${esc(o.conversationUrl)}" target="_blank" rel="noopener">💬 Messenger</a>`
    : `<button class="btn btn-ghost btn-sm" onclick="openMessengerInbox()">💬 Inbox</button>`;

  const actionBtns = isActive ? `
    <button class="btn btn-review btn-sm"  onclick="setStatus('${o.id}','analise')">🔵 Analisar</button>
    <button class="btn btn-confirm btn-sm" onclick="quickConfirm('${o.id}')">✅ Confirmar</button>
    <button class="btn btn-nostock btn-sm" onclick="quickNoStock('${o.id}')">❌ Sem Stock</button>
    <button class="btn btn-ghost btn-sm"   onclick="openReplyModal('${o.id}')">💬 Resposta</button>
  ` : `
    <button class="btn btn-ghost btn-sm" onclick="setStatus('${o.id}','pendente')">↩️ Reabrir</button>
    <button class="btn btn-ghost btn-sm" onclick="openReplyModal('${o.id}')">💬 Resposta</button>
  `;

  const notesHtml = o.notes
    ? `<div class="order-notes-display has-notes">📝 ${esc(o.notes)}</div>`
    : `<div class="order-notes-display"></div>`;

  // Keyword match chips
  const matched = keywords.filter(kw => o.message.toLowerCase().includes(kw.toLowerCase()));
  const kw_chips = matched.length
    ? `<div class="kw-chips">${matched.slice(0,4).map(kw => `<span class="kw-chip">${esc(kw)}</span>`).join('')}</div>`
    : '';

  return `
    <div class="order-card status-${o.status}" id="card-${o.id}">
      <div class="order-top">
        <span class="order-num">#${seq}</span>
        <div class="order-meta">
          <div class="order-name">${esc(o.name)}</div>
          <div class="order-time">⏱ ${formatTime(o.receivedAt)}</div>
        </div>
        <span class="order-status">${STATUS[o.status] || o.status}</span>
      </div>
      <div class="order-msg" id="msg-${o.id}">${msgHighlighted}</div>
      ${kw_chips}
      ${notesHtml}
      <div class="order-actions">
        ${actionBtns}
        <button class="btn btn-icon btn-sm" onclick="openNotesModal('${o.id}')" title="Notas">📝</button>
        <button class="btn btn-icon btn-sm" onclick="toggleExpand('${o.id}')" title="Detalhes">🔍</button>
        ${messengerBtn}
        <button class="btn btn-icon btn-sm" style="color:var(--rose)" onclick="deleteOrder('${o.id}')" title="Eliminar">🗑️</button>
      </div>
      <div class="order-expanded" id="exp-${o.id}">
        ${o.product ? `<div class="order-detail-label">Produto</div><div class="order-detail-text">${esc(o.product)}</div>` : ''}
        <div class="order-detail-label">Mensagem completa</div>
        <div class="order-detail-text">${esc(o.message)}</div>
      </div>
    </div>
  `;
}

function toggleExpand(id) {
  document.getElementById('exp-' + id)?.classList.toggle('open');
  document.getElementById('msg-' + id)?.classList.toggle('expanded');
}

// Highlight keywords in message text
function highlightKeywords(html) {
  let result = html;
  keywords.forEach(kw => {
    const re = new RegExp('(' + escRegex(kw) + ')', 'gi');
    result = result.replace(re, '<mark class="kw-mark">$1</mark>');
  });
  return result;
}

// ─────────────────────────────────────────────
// HISTORY
// ─────────────────────────────────────────────
function renderHistory() {
  const search  = (document.getElementById('history-search')?.value || '').toLowerCase().trim();
  const tbody   = document.getElementById('history-tbody');
  const empty   = document.getElementById('empty-history');
  const STATUS  = { pendente:'🟡 Pendente', analise:'🔵 Em Análise', confirmada:'🟢 Confirmada', 'sem-stock':'🔴 Sem Stock' };

  let all = [...orders].sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
  if (search) all = all.filter(o =>
    o.name.toLowerCase().includes(search) || o.message.toLowerCase().includes(search)
  );

  if (!all.length) { tbody.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  tbody.innerHTML = all.map(o => `
    <tr>
      <td style="color:var(--indigo);font-weight:700">#${String(o.seq).padStart(3,'0')}</td>
      <td class="name-cell">${esc(o.name)}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
          title="${esc(o.message)}">${esc(o.message.substring(0,80))}${o.message.length > 80 ? '…' : ''}</td>
      <td>${STATUS[o.status] || o.status}</td>
      <td>${formatTime(o.receivedAt)}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost btn-sm" onclick="openReplyModal('${o.id}')">💬</button>
          <button class="btn btn-ghost btn-sm" onclick="setStatus('${o.id}','pendente')">↩️</button>
          <button class="btn btn-icon btn-sm" style="color:var(--rose)" onclick="deleteOrder('${o.id}')">🗑️</button>
        </div>
      </td>
    </tr>
  `).join('');
}

// ─────────────────────────────────────────────
// AUTO-SYNC: FILE SYSTEM ACCESS API
// ─────────────────────────────────────────────
async function connectMacroDroid() {
  if (!window.showOpenFilePicker) {
    showToast('⚠️ Browser não suporta leitura de ficheiros automática. Use o Kiwi Browser.');
    return;
  }
  try {
    [fileHandle] = await window.showOpenFilePicker({
      types: [{ description: 'JSON / Text', accept: { 'application/json': ['.json'], 'text/plain': ['.txt', '.json'] } }],
      multiple: false
    });

    localStorage.setItem(K_FNAME, fileHandle.name);
    syncStats = { total: 0, orders: 0, review: 0 };
    lastFileContent = '';

    startAutoSync();
    await syncNow(true); // First sync
    renderSyncConnectedUI();
    updateSyncUI();
    showToast('🟢 Ficheiro ligado! A sincronizar a cada 30 segundos.');
  } catch (e) {
    if (e.name !== 'AbortError') showToast('❌ Erro ao seleccionar ficheiro: ' + e.message);
  }
}

function disconnectFile() {
  fileHandle = null;
  lastFileContent = '';
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
  localStorage.removeItem(K_FNAME);
  renderSyncConnectedUI();
  updateSyncUI();
  showToast('🔌 Ficheiro desligado');
}

function startAutoSync() {
  if (syncTimer) clearInterval(syncTimer);
  syncTimer = setInterval(() => syncNow(false), 30000); // every 30 seconds
}

async function manualSync() {
  let hasSync = false;
  if (fileHandle) {
    await syncNow(true);
    hasSync = true;
  }
  if (isServerSyncEnabled) {
    await syncWithServer();
    hasSync = true;
  }
  if (!hasSync) {
    showToast('⚠️ Configure a ligação ao MacroDroid ou ao Chatbot primeiro.');
    showSection('settings');
  }
}

async function syncNow(notify = false) {
  if (!fileHandle || isSyncing) return;
  isSyncing = true;
  setSyncBarText('🔄 A sincronizar...');

  try {
    const file = await fileHandle.getFile();
    const text = await file.text();

    if (text === lastFileContent) {
      // No changes
      setSyncBarText('✅ Actualizado — ' + formatTime(new Date().toISOString()));
      if (notify) showToast('✅ Sem mensagens novas');
      isSyncing = false;
      return;
    }

    lastFileContent = text;
    const { newOrders, newReview } = processFileContent(text);

    const total = newOrders + newReview;
    setSyncBarText(`✅ Última sync: ${formatTime(new Date().toISOString())}`);

    if (total > 0) {
      showSyncBarNew(`+${newOrders} encomenda${newOrders !== 1 ? 's' : ''}, +${newReview} a rever`);
      if (newOrders > 0) {
        showToast(`📦 ${newOrders} nova${newOrders !== 1 ? 's' : ''} encomenda${newOrders !== 1 ? 's' : ''} detectada${newOrders !== 1 ? 's' : ''}!`);
        // Browser notification if supported
        requestNotification(newOrders);
      }
      renderAll();
    } else if (notify) {
      showToast('✅ Sem mensagens novas');
    }
    renderSyncConnectedUI();
  } catch (e) {
    setSyncBarText('❌ Erro de leitura — verifique o ficheiro');
    if (notify) showToast('❌ Erro ao ler ficheiro: ' + e.message);
  }
  isSyncing = false;
}

// ─────────────────────────────────────────────
// PROCESS FILE CONTENT (JSONL or JSON array)
// ─────────────────────────────────────────────
function processFileContent(text) {
  const items = parseFileContent(text);
  const existingKeys = new Set([...orders, ...reviewQueue].map(dedupKey));

  let newOrders = 0;
  let newReview = 0;

  for (const item of items) {
    const name    = (item.name || item.not_title || '').trim();
    const message = (item.message || item.not_text || item.text || item.body || '').trim();
    const time    = item.receivedAt || item.timestamp || item.time || new Date().toISOString();
    const url     = item.conversationUrl || item.url || '';

    if (!name && !message) continue;

    const obj = {
      id:              genId(),
      name:            name || 'Desconhecido',
      message,
      receivedAt:      normaliseTime(time),
      conversationUrl: url,
      product:         item.product || '',
      importedAt:      new Date().toISOString()
    };

    const key = dedupKey(obj);
    if (existingKeys.has(key)) continue;
    existingKeys.add(key);

    syncStats.total = (syncStats.total || 0) + 1;

    if (isOrderMessage(message)) {
      addOrderObj(obj);
      newOrders++;
      syncStats.orders = (syncStats.orders || 0) + 1;
    } else {
      reviewQueue.push(obj);
      newReview++;
      syncStats.review = (syncStats.review || 0) + 1;
    }
  }

  saveData();
  return { newOrders, newReview };
}

function parseFileContent(text) {
  if (!text.trim()) return [];

  // Try as JSON array first
  if (text.trim().startsWith('[')) {
    try { return JSON.parse(text.trim()); } catch {}
  }

  // Try JSONL (one JSON object per line)
  const items = [];
  const lines = text.trim().split('\n');
  for (const line of lines) {
    const l = line.trim();
    if (!l || !l.startsWith('{')) continue;
    try { items.push(JSON.parse(l)); } catch {}
  }
  return items;
}

// ─────────────────────────────────────────────
// KEYWORD DETECTION
// ─────────────────────────────────────────────
function isOrderMessage(message) {
  if (!keywords.length) return true; // No filter → accept all
  const lower = (message || '').toLowerCase();
  return keywords.some(kw => lower.includes(kw.toLowerCase()));
}

// ─────────────────────────────────────────────
// KEYWORD MANAGEMENT UI
// ─────────────────────────────────────────────
function renderKeywords() {
  const wrap = document.getElementById('keywords-wrap');
  if (!wrap) return;
  wrap.innerHTML = keywords.map((kw, i) => `
    <span class="kw-tag">
      ${esc(kw)}
      <button onclick="removeKeyword(${i})" title="Remover">×</button>
    </span>
  `).join('');
}

function addKeyword() {
  const input = document.getElementById('new-keyword');
  const val   = (input?.value || '').trim().toLowerCase();
  if (!val) return;
  if (keywords.includes(val)) { showToast('⚠️ Palavra-chave já existe'); return; }
  keywords.push(val);
  saveData();
  renderKeywords();
  input.value = '';
  showToast(`✅ "${val}" adicionada`);
}

function removeKeyword(i) {
  keywords.splice(i, 1);
  saveData();
  renderKeywords();
}

function resetKeywords() {
  keywords = [...DEFAULT_KEYWORDS];
  saveData();
  renderKeywords();
  showToast('↩️ Palavras-chave repostas');
}

// ─────────────────────────────────────────────
// SYNC UI
// ─────────────────────────────────────────────
function updateSyncUI() {
  const fileConnected = !!fileHandle;
  const serverConnected = isServerSyncEnabled;
  const dot   = document.getElementById('sync-dot');
  const label = document.getElementById('sync-label');
  const bar   = document.getElementById('sync-bar');

  const isConnected = fileConnected || serverConnected;
  if (dot)   dot.classList.toggle('sync-dot-active', isConnected);
  
  if (label) {
    if (fileConnected && serverConnected) {
      label.textContent = 'Auto-Sync + Chatbot';
    } else if (fileConnected) {
      label.textContent = 'Auto-Sync ON';
    } else if (serverConnected) {
      label.textContent = 'Chatbot ON';
    } else {
      label.textContent = 'Desligado';
    }
  }
  if (bar)   bar.style.display = isConnected ? 'flex' : 'none';
}

function setSyncBarText(text) {
  const el = document.getElementById('sync-bar-text');
  if (el) el.textContent = text;
}

function showSyncBarNew(text) {
  const el = document.getElementById('sync-bar-new');
  if (!el) return;
  el.textContent = text;
  el.style.display = 'inline';
  setTimeout(() => { el.style.display = 'none'; }, 8000);
}

function renderSyncConnectedUI() {
  const connected = !!fileHandle;
  const disc = document.getElementById('sync-disconnected-ui');
  const conn = document.getElementById('sync-connected-ui');
  if (disc) disc.style.display = connected ? 'none' : 'block';
  if (conn) conn.style.display = connected ? 'block' : 'none';

  if (connected) {
    setText('sync-file-name', fileHandle.name || localStorage.getItem(K_FNAME) || '—');
    setText('sync-last-sync', 'Activo — sync a cada 30 segundos');
    setText('ss-total',  syncStats.total  || 0);
    setText('ss-orders', syncStats.orders || 0);
    setText('ss-review', syncStats.review || 0);
  }

  const badge = document.getElementById('sync-status-badge');
  const btext = document.getElementById('sync-status-text');
  if (badge) badge.className = 'sync-status-badge ' + (connected ? 'connected' : '');
  if (btext) btext.textContent = connected ? '🟢 Conectado' : '🔴 Desligado';
}

// ─────────────────────────────────────────────
// BROWSER NOTIFICATIONS
// ─────────────────────────────────────────────
function requestNotification(count) {
  if (!('Notification' in window)) return;
  const send = () => {
    try {
      new Notification('📦 Encomendas Messenger', {
        body: `${count} nova${count !== 1 ? 's' : ''} encomenda${count !== 1 ? 's' : ''} detectada${count !== 1 ? 's' : ''}!`,
        icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text y=".9em" font-size="56">📦</text></svg>',
        tag: 'encomendas-sync',
        renotify: true
      });
    } catch {}
  };
  if (Notification.permission === 'granted') send();
  else if (Notification.permission !== 'denied') {
    Notification.requestPermission().then(p => { if (p === 'granted') send(); });
  }
}

// ─────────────────────────────────────────────
// STATUS MANAGEMENT
// ─────────────────────────────────────────────
function setStatus(id, status) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  o.status    = status;
  o.updatedAt = new Date().toISOString();
  saveData();
  renderAll();
  const msgs = { pendente:'↩️ Reaberta', analise:'🔵 Em análise', confirmada:'✅ Confirmada!', 'sem-stock':'❌ Sem stock' };
  showToast(msgs[status] || 'Estado actualizado');
}

function quickConfirm(id) {
  setStatus(id, 'confirmada');
  openReplyModal(id, 'confirm');
}

function quickNoStock(id) {
  setStatus(id, 'sem-stock');
  openReplyModal(id, 'nostock');
}

// ─────────────────────────────────────────────
// REPLY MODAL
// ─────────────────────────────────────────────
function openReplyModal(id, type) {
  currentReplyId = id;
  setReplyType(type || 'confirm');
  document.getElementById('reply-status-change').value = '';
  openModal('modal-reply');
}

function setReplyType(type) {
  document.querySelectorAll('.reply-type-btn').forEach(b => b.classList.remove('active'));
  const btn = document.getElementById('rtype-' + type);
  if (btn) btn.classList.add('active');

  const map   = { confirm: 0, nostock: 1, info: 2 };
  const tpl   = templates[map[type]] || templates[0];
  const o     = orders.find(x => x.id === currentReplyId) || reviewQueue.find(x => x.id === currentReplyId);
  const fname = o ? o.name.split(' ')[0] : '';
  const msg   = tpl ? tpl.text.replace(/\{nome\}/g, fname) : '';
  document.getElementById('reply-text').value = msg;
}

function copyAndOpenMessenger() {
  const text      = document.getElementById('reply-text').value.trim();
  const newStatus = document.getElementById('reply-status-change').value;
  if (!text) { showToast('⚠️ Escreva uma mensagem primeiro'); return; }

  copyToClipboard(text, '📋 Mensagem copiada! Cole no Messenger.');
  if (newStatus && currentReplyId) setStatus(currentReplyId, newStatus);

  const o = orders.find(x => x.id === currentReplyId);
  setTimeout(() => {
    window.open(o?.conversationUrl || 'https://business.facebook.com/latest/inbox/', '_blank', 'noopener');
  }, 400);
  closeModal('modal-reply');
}

function openMessengerInbox() {
  window.open('https://business.facebook.com/latest/inbox/', '_blank', 'noopener');
}

// ─────────────────────────────────────────────
// NOTES MODAL
// ─────────────────────────────────────────────
function openNotesModal(id) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  document.getElementById('notes-order-id').value = id;
  document.getElementById('notes-text').value     = o.notes || '';
  openModal('modal-notes');
}

function saveNotes() {
  const id  = document.getElementById('notes-order-id').value;
  const txt = document.getElementById('notes-text').value.trim();
  const o   = orders.find(x => x.id === id);
  if (!o) return;
  o.notes = txt;
  saveData();
  renderAll();
  closeModal('modal-notes');
  showToast('📝 Nota guardada');
}

// ─────────────────────────────────────────────
// DELETE
// ─────────────────────────────────────────────
function deleteOrder(id) {
  const o = orders.find(x => x.id === id);
  if (!o) return;
  openConfirm('🗑️ Eliminar', `Eliminar encomenda de <strong>${esc(o.name)}</strong>?`, () => {
    orders = orders.filter(x => x.id !== id);
    saveData(); renderAll();
    showToast('🗑️ Eliminada');
  });
}

function confirmClearAll() {
  openConfirm('⚠️ Limpar Tudo', `Eliminar TODAS as ${orders.length} encomendas e ${reviewQueue.length} mensagens para rever?`, () => {
    orders = []; reviewQueue = []; orderCounter = 0; syncStats = {};
    lastFileContent = '';
    saveData(); renderAll();
    showToast('🗑️ Tudo limpo');
  });
}

// ─────────────────────────────────────────────
// MANUAL ADD
// ─────────────────────────────────────────────
function addManual() {
  const name = document.getElementById('m-name').value.trim();
  const msg  = document.getElementById('m-msg').value.trim();
  if (!name) { showToast('⚠️ Nome obrigatório'); return; }
  if (!msg)  { showToast('⚠️ Mensagem obrigatória'); return; }

  const timeVal = document.getElementById('m-time').value;
  addOrderObj({
    id:              genId(),
    name,
    message:         msg,
    product:         document.getElementById('m-product').value.trim(),
    conversationUrl: document.getElementById('m-url').value.trim(),
    receivedAt:      timeVal ? new Date(timeVal).toISOString() : new Date().toISOString(),
    importedAt:      new Date().toISOString()
  });
  saveData(); renderAll();
  showToast(`✅ Encomenda de ${name} adicionada`);
  ['m-name','m-msg','m-product','m-url'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  setDefaultDateTime();
}

function addOrderObj(data) {
  orderCounter++;
  const o = {
    ...data,
    seq:    data.seq || orderCounter,
    status: data.status || 'pendente',
    notes:  data.notes  || ''
  };
  orders.push(o);
  return o;
}

function setDefaultDateTime() {
  const el = document.getElementById('m-time');
  if (el) {
    const now   = new Date();
    el.value    = new Date(now - now.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  }
}

// ─────────────────────────────────────────────
// IMPORT FILE
// ─────────────────────────────────────────────
function handleFileDrop(e) {
  e.preventDefault();
  document.getElementById('json-drop')?.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) readJsonFile(file);
}

function handleFileInput(e) {
  const file = e.target.files[0];
  if (file) readJsonFile(file);
  e.target.value = '';
}

function readJsonFile(file) {
  const reader = new FileReader();
  reader.onload  = e => {
    const { newOrders, newReview } = processFileContent(e.target.result);
    showToast(newOrders > 0
      ? `✅ ${newOrders} encomenda${newOrders !== 1 ? 's' : ''} importada${newOrders !== 1 ? 's' : ''}! (${newReview} para rever)`
      : `⚠️ Sem encomendas novas. ${newReview} para rever.`
    );
    if (newOrders > 0) showSection('queue');
    else if (newReview > 0) showSection('review');
  };
  reader.onerror = () => showToast('❌ Erro ao ler ficheiro');
  reader.readAsText(file, 'UTF-8');
}

// ─────────────────────────────────────────────
// EXPORT CSV
// ─────────────────────────────────────────────
function exportCSV() {
  if (!orders.length) { showToast('⚠️ Sem encomendas para exportar'); return; }
  const STATUS = { pendente:'Pendente', analise:'Em Análise', confirmada:'Confirmada', 'sem-stock':'Sem Stock' };
  const rows   = [['Nº','Nome','Mensagem','Produto','Estado','Data/Hora','Notas']];
  [...orders].sort((a, b) => a.seq - b.seq).forEach(o => rows.push([
    '#' + String(o.seq).padStart(3,'0'),
    o.name, o.message, o.product || '',
    STATUS[o.status] || o.status,
    formatTime(o.receivedAt), o.notes || ''
  ]));
  const csv  = rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: `encomendas_${new Date().toISOString().slice(0,10)}.csv` });
  a.click();
  URL.revokeObjectURL(url);
  showToast('⬇ CSV exportado!');
}

// ─────────────────────────────────────────────
// TEMPLATES
// ─────────────────────────────────────────────
function defaultTemplates() {
  return [
    { id:'tpl1', icon:'✅', name:'Confirmação', text:'Olá {nome}! ✅ A sua encomenda foi confirmada e está em preparação.\n\nEm breve entraremos em contacto com os detalhes de entrega/levantamento.\n\nMuito obrigado pela preferência! 🙏' },
    { id:'tpl2', icon:'❌', name:'Sem Stock',   text:'Olá {nome}, obrigado pelo contacto.\n\nInfelizmente o artigo que pediu encontra-se esgotado de momento. Assim que tivermos stock, entramos em contacto consigo.\n\nPedimos desculpa pelo inconveniente 🙏' },
    { id:'tpl3', icon:'❓', name:'Mais Info',   text:'Olá {nome}! 😊 Obrigado pelo interesse.\n\nPoderia indicar-nos mais detalhes sobre a sua encomenda? (quantidade, cor, tamanho, etc.)\n\nAssim que recebermos essa informação, confirmamos de imediato. 🙏' }
  ];
}

function renderTemplates() {
  const list = document.getElementById('templates-list');
  if (!list) return;
  list.innerHTML = templates.map((t, i) => `
    <div class="template-card">
      <div class="template-header">
        <span class="template-icon">${esc(t.icon || '💬')}</span>
        <span class="template-name">${esc(t.name)}</span>
      </div>
      <div class="template-text">${esc(t.text)}</div>
      <div class="template-actions">
        <button class="btn btn-ghost btn-sm" onclick="openTemplateModal(${i})">✏️ Editar</button>
        <button class="btn btn-ghost btn-sm" onclick="copyTemplate(${i})">📋 Copiar</button>
        ${i >= 3 ? `<button class="btn btn-danger btn-sm" onclick="deleteTemplate(${i})">🗑️</button>` : ''}
      </div>
    </div>
  `).join('');
}

function addTemplate() {
  templates.push({ id: 'tpl_' + Date.now(), icon: '💬', name: 'Novo Template', text: 'Olá {nome}! ' });
  saveData(); renderTemplates();
  openTemplateModal(templates.length - 1);
}

function openTemplateModal(idx) {
  const t = templates[idx]; if (!t) return;
  document.getElementById('tpl-idx').value  = idx;
  document.getElementById('tpl-name').value = t.name;
  document.getElementById('tpl-icon').value = t.icon || '💬';
  document.getElementById('tpl-text').value = t.text;
  document.getElementById('tpl-modal-title').textContent = '✏️ ' + t.name;
  openModal('modal-template');
}

function saveTemplate() {
  const idx  = parseInt(document.getElementById('tpl-idx').value, 10);
  const name = document.getElementById('tpl-name').value.trim();
  const icon = document.getElementById('tpl-icon').value.trim() || '💬';
  const text = document.getElementById('tpl-text').value.trim();
  if (!name || !text) { showToast('⚠️ Nome e texto obrigatórios'); return; }
  if (templates[idx]) { templates[idx] = { ...templates[idx], name, icon, text }; }
  saveData(); renderTemplates();
  closeModal('modal-template');
  showToast('💾 Template guardado');
}

function deleteTemplate(idx) {
  if (idx < 3) return;
  templates.splice(idx, 1);
  saveData(); renderTemplates();
  showToast('🗑️ Template eliminado');
}

function copyTemplate(idx) {
  const t = templates[idx]; if (!t) return;
  copyToClipboard(t.text, '📋 Template copiado!');
}

// ─────────────────────────────────────────────
// MACRODROID TEMPLATE COPY
// ─────────────────────────────────────────────
function copyMacroTemplate() {
  const tmpl = `\n{"name":"{not_title}","message":"{not_text}","receivedAt":"{year}-{month}-{day}T{hour}:{mins}:{secs}.000Z"}`;
  copyToClipboard(tmpl, '📋 Template do MacroDroid copiado!');
}

// ─────────────────────────────────────────────
// BOOKMARKLET
// ─────────────────────────────────────────────
function buildBookmarkletLink() {
  const code = `(function(){var items=[];var rows=document.querySelectorAll('[data-visualcompletion] [role="row"],.x1n2onr6[role="row"],[data-testid="MWV2ConversationItem"],li[class]');if(!rows.length)rows=document.querySelectorAll('li,[role="listitem"]');rows.forEach(function(el,i){var nm=el.querySelector('strong,b,[data-testid="conversation_name"],[aria-label]');var ms=el.querySelector('[data-testid="last_message_preview"],span[dir="auto"]');var tm=el.querySelector('abbr,time,[data-testid="timestamp"]');var lk=el.querySelector('a[href*="messages"],a[href*="inbox"],a[href]');if(!nm||!nm.textContent.trim())return;items.push({name:nm.textContent.trim(),message:ms?ms.textContent.trim():'',receivedAt:tm?(tm.getAttribute('data-utime')?new Date(parseInt(tm.getAttribute('data-utime'))*1000).toISOString():tm.getAttribute('datetime')||new Date().toISOString()):new Date().toISOString(),conversationUrl:lk?lk.href:'',importedAt:new Date().toISOString()});});if(!items.length){alert('Não foram encontradas conversas.\\nAbra: business.facebook.com/latest/inbox/');return;}var blob=new Blob([JSON.stringify(items,null,2)],{type:'application/json'});var url=URL.createObjectURL(blob);var a=document.createElement('a');a.href=url;a.download='orders_import.json';a.click();URL.revokeObjectURL(url);alert('✅ '+items.length+' conversa(s) exportada(s)!');})();`;
  const href = 'javascript:' + encodeURIComponent(code);
  const link = document.getElementById('bookmarklet-link');
  if (link) link.href = href;
  window._bmCode = href;
}

function copyBookmarkletCode() {
  copyToClipboard(window._bmCode || '', '📋 Código copiado! Crie um favorito e cole no campo URL.');
}

// ─────────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────────
function openModal(id)  { document.getElementById(id)?.classList.add('open'); }
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

let _confirmCb = null;
function openConfirm(title, msg, cb) {
  setText('confirm-title', title);
  document.getElementById('confirm-msg').innerHTML = msg;
  _confirmCb = cb;
  const ok = document.getElementById('confirm-ok');
  ok.onclick = () => { closeModal('modal-confirm'); _confirmCb?.(); _confirmCb = null; };
  openModal('modal-confirm');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') document.querySelectorAll('.modal-overlay.open').forEach(m => m.classList.remove('open'));
});

// ─────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────
let _toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  if (_toastTimer) clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3500);
}

// ─────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}
function escRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function genId() { return 'o_' + Date.now() + '_' + Math.random().toString(36).slice(2,8); }
function dedupKey(o) { return ((o.name||'') + '::' + (o.message||'').slice(0,50)).toLowerCase().trim(); }

function normaliseTime(t) {
  if (!t) return new Date().toISOString();
  if (/^\d{10}$/.test(String(t))) return new Date(Number(t) * 1000).toISOString();
  if (/^\d{13}$/.test(String(t))) return new Date(Number(t)).toISOString();
  const d = new Date(t);
  return isNaN(d) ? new Date().toISOString() : d.toISOString();
}

function formatTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso); if (isNaN(d)) return iso;
  const now   = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dDay  = new Date(d.getFullYear(),   d.getMonth(),   d.getDate());
  const diff  = (today - dDay) / 86400000;
  const time  = d.toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit' });
  if (diff === 0) return `Hoje às ${time}`;
  if (diff === 1) return `Ontem às ${time}`;
  return d.toLocaleDateString('pt-PT', { day:'2-digit', month:'2-digit', year:'2-digit' }) + ' ' + time;
}

function copyToClipboard(text, msg) {
  navigator.clipboard.writeText(text).then(() => showToast(msg)).catch(() => {
    const el = Object.assign(document.createElement('textarea'), { value: text });
    el.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(el); el.select(); document.execCommand('copy');
    document.body.removeChild(el); showToast(msg);
  });
}

// ─────────────────────────────────────────────
// CHATBOT SERVER SYNC INTEGRATION
// ─────────────────────────────────────────────

function initServerSync() {
  const input = document.getElementById('server-api-url');
  if (input) input.value = serverApiUrl;
  
  updateServerSyncUI();
  if (isServerSyncEnabled) {
    startServerSyncLoop();
  }
}

function startServerSyncLoop() {
  if (serverSyncTimer) clearInterval(serverSyncTimer);
  // Primeira sync imediata
  syncWithServer();
  // Repetir de 30 em 30 segundos
  serverSyncTimer = setInterval(syncWithServer, 30000);
}

function stopServerSyncLoop() {
  if (serverSyncTimer) {
    clearInterval(serverSyncTimer);
    serverSyncTimer = null;
  }
}

function connectServerSync() {
  const input = document.getElementById('server-api-url');
  const url = (input?.value || '').trim();
  if (!url) {
    showToast('⚠️ Introduza um URL de servidor válido.');
    return;
  }
  
  serverApiUrl = url;
  isServerSyncEnabled = true;
  saveData();
  
  updateServerSyncUI();
  updateSyncUI();
  startServerSyncLoop();
  showToast('🟢 Sincronização com o Chatbot activada!');
}

function disconnectServerSync() {
  isServerSyncEnabled = false;
  saveData();
  stopServerSyncLoop();
  updateServerSyncUI();
  updateSyncUI();
  showToast('🔌 Sincronização com o Chatbot desactivada');
}

function updateServerSyncUI() {
  const dot = document.getElementById('server-sync-dot');
  const text = document.getElementById('server-status-text');
  const badge = document.getElementById('server-status-badge');
  
  if (isServerSyncEnabled) {
    if (dot) dot.classList.add('sync-dot-active');
    if (text) text.textContent = '🟢 Ligado';
    if (badge) badge.className = 'sync-status-badge connected';
  } else {
    if (dot) dot.classList.remove('sync-dot-active');
    if (text) text.textContent = '🔴 Desligado';
    if (badge) badge.className = 'sync-status-badge';
  }
}

function setServerSyncStatus(success, message) {
  const text = document.getElementById('server-status-text');
  const dot = document.getElementById('server-sync-dot');
  const badge = document.getElementById('server-status-badge');
  
  if (text) text.textContent = success ? message : `❌ ${message}`;
  if (dot) {
    if (success) dot.classList.add('sync-dot-active');
    else dot.classList.remove('sync-dot-active');
  }
  if (badge) {
    badge.className = 'sync-status-badge ' + (success ? 'connected' : '');
  }
}

async function syncWithServer() {
  if (!isServerSyncEnabled || !serverApiUrl) return;
  
  try {
    const response = await fetch(`${serverApiUrl}/api/orders?_=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error('Falha na resposta do servidor');
    
    const serverOrders = await response.json();
    if (!Array.isArray(serverOrders)) throw new Error('Dados inválidos recebidos');
    
    let newImported = 0;
    const existingKeys = new Set([...orders, ...reviewQueue].map(dedupKey));
    const existingIds = new Set([...orders, ...reviewQueue].map(o => o.id));
    
    for (const item of serverOrders) {
      const key = dedupKey(item);
      if (existingKeys.has(key) || existingIds.has(item.id)) {
        // Já existe localmente, tentar limpar do servidor
        await deleteOrderFromServer(item.id);
        continue;
      }
      
      const obj = {
        id:              item.id,
        name:            item.name,
        message:         item.message,
        receivedAt:      item.receivedAt,
        conversationUrl: item.conversationUrl,
        product:         item.product || '',
        notes:           item.notes || '',
        importedAt:      new Date().toISOString()
      };

      if (isOrderMessage(item.message)) {
        addOrderObj(obj);
      } else {
        reviewQueue.push(obj);
      }
      
      newImported++;
      // Remover do servidor já que foi importado com sucesso
      await deleteOrderFromServer(item.id);
    }
    
    if (newImported > 0) {
      showToast(`🌐 ${newImported} nova(s) encomenda(s) sincronizada(s) do chatbot!`);
      saveData();
      renderAll();
    }
    
    setServerSyncStatus(true, `Ligado — Última sync: ${formatTime(new Date().toISOString())}`);
  } catch (e) {
    console.error('❌ Erro na sincronização com o chatbot:', e.message);
    setServerSyncStatus(false, 'Erro de ligação');
  }
}

async function deleteOrderFromServer(id) {
  try {
    await fetch(`${serverApiUrl}/api/orders/${id}`, { method: 'DELETE' });
  } catch (e) {
    console.warn(`⚠️ Não foi possível apagar a encomenda ${id} do servidor:`, e.message);
  }
}
