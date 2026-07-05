// Trace Viewer — client-side JavaScript
// Runs inside an IIFE with VIEW_ID and VIEW_WS_PATH injected by embsim-ui shell.

// ============================================================
// Color palette (Catppuccin Mocha)
// ============================================================
const COLORS = [
  '#89b4fa', '#a6e3a1', '#f38ba8', '#f9e2af', '#cba6f7',
  '#f5c2e7', '#94e2d5', '#fab387', '#74c7ec', '#b4befe',
  '#89dceb', '#eba0ac', '#a6adc8', '#f2cdcd', '#bac2de',
];

// ============================================================
// State
// ============================================================
let ws = null;
let paused = false;
let updateCount = 0;
let lastCountReset = Date.now();
let colorIndex = 0;

// Active signals: name -> { group, unit, color, lastValue, sidebarEl, enumType }
const activeSignals = {};
// Per-signal chart: name -> { chart, panel, valueEl }
const charts = {};
// Trace data: name -> [{ time_us, value }, ...]
const traceData = {};
// Server subscription tracking
const subscribedOnServer = new Set();

// Known signal catalogs from server
const knownSignals = { Model: [], Peripheral: [], Firmware: [] };
let firmwareCatalogLoaded = false;

// Enum definitions: enum_type_name -> { "0": "VARIANT_A", "1": "VARIANT_B", ... }
const enumDefinitions = {};

// Current virtual time (updated by server messages)
let currentTimeUs = 0;

// ============================================================
// Group management — groups are data-driven (any string). KNOWN_GROUPS are
// shown first (even when empty) for a stable layout; any other group a signal
// declares gets a section created lazily.
// ============================================================
const KNOWN_GROUPS = ['Model', 'Peripheral', 'Firmware'];
const groupElements = {};

// Create (once) and return the sidebar section element for a group.
function ensureGroup(group) {
  if (groupElements[group]) return groupElements[group];

  const container = document.getElementById('signalList');
  const div = document.createElement('div');
  div.className = 'trace-signal-group';
  div.dataset.group = group;

  const header = document.createElement('div');
  header.className = 'trace-signal-group-header';

  const title = document.createElement('div');
  title.className = 'trace-signal-group-title';
  title.textContent = group;

  const count = document.createElement('span');
  count.className = 'trace-signal-group-count';
  count.dataset.groupCount = group;

  const addBtn = document.createElement('button');
  addBtn.className = 'trace-add-signal-btn';
  addBtn.textContent = '+';
  addBtn.title = 'Add ' + group + ' signal';
  addBtn.addEventListener('click', () => openAddModal(group));

  header.appendChild(title);
  header.appendChild(count);
  header.appendChild(addBtn);
  div.appendChild(header);
  container.appendChild(div);
  groupElements[group] = div;
  return div;
}

function initGroups() {
  // Pre-create the conventional groups for a stable layout; custom groups are
  // created on demand by ensureGroup() when a signal in them appears.
  for (const group of KNOWN_GROUPS) ensureGroup(group);
}

function updateGroupCounts() {
  for (const group of Object.keys(groupElements)) {
    const count = Object.values(activeSignals).filter(s => s.group === group).length;
    const el = document.querySelector(`[data-group-count="${group}"]`);
    if (el) el.textContent = count > 0 ? count : '';
  }
}

// ============================================================
// WebSocket
// ============================================================
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host + VIEW_WS_PATH);

  ws.onopen = () => {
    document.getElementById('traceStatusDot').classList.add('connected');
    document.getElementById('traceStatusText').textContent = 'Connected';
    subscribedOnServer.clear();
    syncSubscriptions();
  };

  ws.onclose = () => {
    document.getElementById('traceStatusDot').classList.remove('connected');
    document.getElementById('traceStatusText').textContent = 'Disconnected';
    subscribedOnServer.clear();
    setTimeout(connect, 1000);
  };

  ws.onerror = () => ws.close();

  ws.onmessage = (event) => {
    if (paused) return;
    updateCount++;
    try {
      handleMessage(JSON.parse(event.data));
    } catch (e) {
      console.error('Parse error:', e);
    }
  };
}

function syncSubscriptions() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;

  const active = Object.keys(activeSignals);
  const toSub = active.filter(n => !subscribedOnServer.has(n));
  const toUnsub = [...subscribedOnServer].filter(n => !activeSignals[n]);

  if (toSub.length > 0) {
    ws.send(JSON.stringify({ cmd: 'subscribe', signals: toSub }));
    toSub.forEach(n => subscribedOnServer.add(n));
  }
  if (toUnsub.length > 0) {
    ws.send(JSON.stringify({ cmd: 'unsubscribe', signals: toUnsub }));
    toUnsub.forEach(n => subscribedOnServer.delete(n));
  }
}

// ============================================================
// Message handling
// ============================================================
function handleMessage(msg) {
  // Active signal catalog (Model + Peripheral registered at startup, plus any Firmware added)
  if (msg.catalog) {
    for (const sig of msg.catalog) {
      const group = sig.group;
      if (group === 'Model' || group === 'Peripheral') {
        if (!knownSignals[group].find(s => s.name === sig.name)) {
          knownSignals[group].push({ name: sig.name, unit: sig.unit });
        }
      }
    }
  }

  // Firmware variable catalog (response to browse_firmware)
  if (msg.firmware_catalog) {
    knownSignals.Firmware = msg.firmware_catalog.map(v => ({
      name: v.signal_name,
      var_name: v.var_name,
      field_path: v.field_path,
      enum_type: v.enum_type || null,
    }));
    firmwareCatalogLoaded = true;
    refreshModalIfOpen('Firmware');
  }

  // Enum definitions (sent alongside firmware_catalog)
  if (msg.enum_definitions) {
    Object.assign(enumDefinitions, msg.enum_definitions);
  }

  // Track current virtual time from server
  if (msg.current_time_us !== undefined) {
    currentTimeUs = msg.current_time_us;
  }

  // Poll interval acknowledgment — sync the dropdown
  if (msg.poll_interval_ms !== undefined) {
    const sel = document.getElementById('sampleRate');
    const ms = msg.poll_interval_ms;
    // Select matching option, or closest
    for (const opt of sel.options) {
      opt.selected = (parseInt(opt.value) === ms);
    }
  }

  // Incremental data
  if (msg.data) {
    for (const [name, samples] of Object.entries(msg.data)) {
      if (!traceData[name]) traceData[name] = [];
      const arr = traceData[name];
      for (const s of samples) arr.push(s);
      if (arr.length > 100000) traceData[name] = arr.slice(arr.length - 100000);
      if (samples.length > 0 && activeSignals[name]) {
        activeSignals[name].lastValue = samples[samples.length - 1].value;
        updateSignalValue(name);
      }
    }
  }

  // Always update charts when we get a message (even if no new data,
  // so charts extend to the current time)
  updateCharts();
  updateInfoBar();
}

// ============================================================
// Enum helpers
// ============================================================

// Look up the variant name for an enum signal value.
// Returns the variant name string, or null if not an enum or not found.
function getEnumVariantName(signalName, value) {
  const meta = activeSignals[signalName];
  if (!meta || !meta.enumType) return null;
  const defs = enumDefinitions[meta.enumType];
  if (!defs) return null;
  const intVal = Math.round(value).toString();
  return defs[intVal] || null;
}

// Shorten enum variant names by stripping common prefixes.
// e.g., "APP_CONTROL_STATE_DISABLED" → "DISABLED"
function shortenEnumName(name) {
  const parts = name.split('_');
  if (parts.length <= 2) return name;
  return parts.slice(-Math.min(2, parts.length)).join('_');
}

// ============================================================
// Add / remove signals
// ============================================================
function addSignal(name, group, unit, enumType) {
  if (activeSignals[name]) return;

  const color = COLORS[colorIndex % COLORS.length];
  colorIndex++;

  activeSignals[name] = {
    group, unit: unit || '', color, lastValue: 0,
    sidebarEl: null, enumType: enumType || null,
  };
  traceData[name] = [];

  // For firmware signals, tell the server to activate polling
  if (group === 'Firmware') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd: 'add_signal', signal: name }));
      subscribedOnServer.add(name);
    }
  } else {
    syncSubscriptions();
  }

  addSignalToSidebar(name);
  createChartPanel(name);
  updateActiveCount();
  updateGroupCounts();
  updateEmptyState();
}

function removeSignal(name) {
  if (!activeSignals[name]) return;
  const group = activeSignals[name].group;

  if (activeSignals[name].sidebarEl) activeSignals[name].sidebarEl.remove();
  destroyChartPanel(name);
  delete traceData[name];

  if (group === 'Firmware') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd: 'remove_signal', signal: name }));
      subscribedOnServer.delete(name);
    }
  } else {
    subscribedOnServer.delete(name);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd: 'unsubscribe', signals: [name] }));
    }
  }

  delete activeSignals[name];
  updateActiveCount();
  updateGroupCounts();
  updateEmptyState();
}

function addSignalToSidebar(name) {
  const meta = activeSignals[name];
  if (!meta) return;
  // Lazily create the section for this signal's group (handles custom groups).
  const groupEl = ensureGroup(meta.group);
  if (!groupEl) return;

  const item = document.createElement('div');
  item.className = 'trace-signal-item';
  item.dataset.signal = name;

  const swatch = document.createElement('div');
  swatch.className = 'trace-signal-color';
  swatch.style.background = meta.color;

  const nameSpan = document.createElement('span');
  nameSpan.className = 'trace-signal-name';
  nameSpan.title = name;
  nameSpan.textContent = name;

  const valSpan = document.createElement('span');
  valSpan.className = 'trace-signal-value';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'trace-signal-remove';
  removeBtn.textContent = '×';
  removeBtn.title = 'Remove';
  removeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeSignal(name); });

  item.appendChild(swatch);
  item.appendChild(nameSpan);
  item.appendChild(valSpan);
  item.appendChild(removeBtn);
  groupEl.appendChild(item);
  meta.sidebarEl = item;
}

function updateSignalValue(name) {
  const meta = activeSignals[name];
  if (!meta) return;
  const formatted = formatValue(meta.lastValue, meta.unit, name);
  if (meta.sidebarEl) {
    const valEl = meta.sidebarEl.querySelector('.trace-signal-value');
    if (valEl) valEl.textContent = formatted;
  }
  const entry = charts[name];
  if (entry && entry.valueEl) entry.valueEl.textContent = formatted;
}

function updateActiveCount() {
  const n = Object.keys(activeSignals).length;
  document.getElementById('activeCount').textContent =
    n === 0 ? 'No signals active' : n + ' signal' + (n > 1 ? 's' : '') + ' active';
}

function updateEmptyState() {
  const empty = Object.keys(activeSignals).length === 0;
  document.getElementById('emptyState').style.display = empty ? 'flex' : 'none';
  document.getElementById('chartsScroll').style.display = empty ? 'none' : 'block';
}

function formatValue(value, unit, signalName) {
  if (unit === 'bool') return value ? 'true' : 'false';
  // Check if this is an enum signal with known variant names
  if (signalName) {
    const variantName = getEnumVariantName(signalName, value);
    if (variantName) return shortenEnumName(variantName);
  }
  if (unit === 'enum') return Math.round(value).toString();
  if (Math.abs(value) < 0.001 && value !== 0) return value.toExponential(2);
  if (Number.isInteger(value)) return value.toString();
  return value.toFixed(3);
}

// ============================================================
// Chart creation / destruction
// ============================================================
function isEnumSignal(name) {
  const meta = activeSignals[name];
  return meta && meta.enumType && enumDefinitions[meta.enumType];
}

function createChartOptions(name) {
  const meta = activeSignals[name];
  const unit = meta ? meta.unit : '';
  const enumSig = isEnumSignal(name);

  return {
    responsive: true,
    maintainAspectRatio: false,
    animation: false,
    parsing: false,
    normalized: true,
    interaction: { mode: 'nearest', axis: 'x', intersect: false },
    plugins: {
      legend: { display: false },
      tooltip: {
        backgroundColor: '#292a3e',
        borderColor: '#444566',
        borderWidth: 1,
        titleColor: '#cdd6f4',
        bodyColor: '#cdd6f4',
        bodyFont: { family: "'SF Mono', monospace", size: 11 },
        callbacks: {
          title: (items) => items.length ? 't = ' + (items[0].parsed.x / 1000).toFixed(3) + 's' : '',
          label: (item) => {
            const val = item.parsed.y;
            if (enumSig) {
              const variantName = getEnumVariantName(name, val);
              if (variantName) return ' ' + shortenEnumName(variantName) + ' (' + Math.round(val) + ')';
            }
            return ' ' + val.toFixed(4) + (unit ? ' ' + unit : '');
          },
        }
      },
      zoom: {
        pan: { enabled: true, mode: 'x' },
        zoom: { wheel: { enabled: true }, pinch: { enabled: true }, mode: 'x' }
      }
    },
    scales: {
      x: {
        type: 'linear',
        ticks: {
          color: '#888aaa',
          font: { size: 10 },
          maxTicksLimit: 10,
          callback: (v) => (v / 1000).toFixed(1) + 's',
        },
        grid: { color: '#33344d' },
      },
      y: enumSig ? {
        // Enum: use integer ticks with variant labels
        ticks: {
          color: '#888aaa',
          font: { size: 10 },
          stepSize: 1,
          callback: (v) => {
            const variantName = getEnumVariantName(name, v);
            if (variantName) return shortenEnumName(variantName);
            if (Number.isInteger(v)) return v.toString();
            return '';
          },
        },
        grid: { color: '#33344d' },
      } : {
        // Numeric: auto-scale
        ticks: {
          color: '#888aaa',
          font: { size: 10 },
          maxTicksLimit: 6,
        },
        grid: { color: '#33344d' },
      }
    }
  };
}

function createChartPanel(name) {
  const meta = activeSignals[name];
  if (!meta) return;
  const container = document.getElementById('chartsScroll');

  const panel = document.createElement('div');
  panel.className = 'trace-chart-panel';
  panel.dataset.signal = name;

  const header = document.createElement('div');
  header.className = 'trace-chart-panel-header';

  const swatch = document.createElement('div');
  swatch.className = 'trace-chart-panel-swatch';
  swatch.style.background = meta.color;

  const title = document.createElement('div');
  title.className = 'trace-chart-panel-title';
  title.textContent = name;
  title.title = name;

  // Show enum badge if applicable
  if (meta.enumType) {
    const badge = document.createElement('span');
    badge.className = 'trace-chart-enum-badge';
    badge.textContent = 'enum';
    badge.title = meta.enumType;
    title.appendChild(badge);
  }

  const valueEl = document.createElement('div');
  valueEl.className = 'trace-chart-panel-value';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'trace-chart-panel-close';
  closeBtn.textContent = '×';
  closeBtn.title = 'Remove chart';
  closeBtn.addEventListener('click', (e) => { e.stopPropagation(); removeSignal(name); });

  header.appendChild(swatch);
  header.appendChild(title);
  header.appendChild(valueEl);
  header.appendChild(closeBtn);

  const canvasWrap = document.createElement('div');
  canvasWrap.className = 'trace-chart-canvas-wrapper';
  const canvas = document.createElement('canvas');

  panel.appendChild(header);
  canvasWrap.appendChild(canvas);
  panel.appendChild(canvasWrap);
  container.appendChild(panel);

  const ctx = canvas.getContext('2d');
  const chart = new Chart(ctx, {
    type: 'scatter',
    data: {
      datasets: [{
        label: name,
        data: [],
        showLine: true,
        borderColor: meta.color + '40',
        borderWidth: 1,
        backgroundColor: meta.color,
        pointRadius: 2,
        pointHitRadius: 8,
        tension: 0,
        fill: false,
        stepped: isEnumSignal(name) ? 'before' : false,
      }]
    },
    options: createChartOptions(name),
  });

  charts[name] = { chart, panel, valueEl };
}

function destroyChartPanel(name) {
  const entry = charts[name];
  if (!entry) return;
  entry.chart.destroy();
  entry.panel.remove();
  delete charts[name];
}

// ============================================================
// Chart updates
// ============================================================
function updateCharts() {
  const windowSec = parseInt(document.getElementById('timeWindow').value);

  // ── Compute global x-axis bounds so all charts share the same time range ──
  let globalMaxUs = currentTimeUs || 0;
  let globalMinUs = Infinity;
  for (const name of Object.keys(activeSignals)) {
    const samples = traceData[name] || [];
    if (samples.length > 0) {
      const first = samples[0].time_us;
      const last = samples[samples.length - 1].time_us;
      if (first < globalMinUs) globalMinUs = first;
      if (last > globalMaxUs) globalMaxUs = last;
    }
  }
  if (globalMinUs === Infinity) globalMinUs = 0;
  const globalMaxMs = globalMaxUs / 1000;
  const globalMinMs = windowSec > 0
    ? (globalMaxUs - windowSec * 1000000) / 1000
    : globalMinUs / 1000;

  for (const name of Object.keys(activeSignals)) {
    const entry = charts[name];
    if (!entry) continue;

    let samples = traceData[name] || [];
    if (samples.length === 0) {
      // Still set axis bounds so empty charts align with others
      entry.chart.options.scales.x.min = globalMinMs;
      entry.chart.options.scales.x.max = globalMaxMs;
      entry.chart.data.datasets[0].data = [];
      entry.chart.update('none');
      continue;
    }

    // Extend the trace line to the current virtual time so the chart
    // keeps scrolling even when the signal value hasn't changed.
    const lastSample = samples[samples.length - 1];
    if (currentTimeUs > 0 && currentTimeUs > lastSample.time_us) {
      // Add a synthetic point at current time with the last known value.
      // This is ephemeral — not stored in traceData, only used for display.
      samples = samples.concat([{ time_us: currentTimeUs, value: lastSample.value }]);
    }

    if (windowSec > 0) {
      const cutoffUs = globalMaxUs - windowSec * 1000000;
      let lo = 0, hi = samples.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (samples[mid].time_us < cutoffUs) lo = mid + 1; else hi = mid; }
      samples = samples.slice(lo);
    }

    if (samples.length > 2000) {
      const step = Math.ceil(samples.length / 2000);
      const ds = [];
      for (let i = 0; i < samples.length; i += step) ds.push(samples[i]);
      if (ds[ds.length - 1] !== samples[samples.length - 1]) ds.push(samples[samples.length - 1]);
      samples = ds;
    }

    // Set uniform x-axis bounds
    entry.chart.options.scales.x.min = globalMinMs;
    entry.chart.options.scales.x.max = globalMaxMs;

    entry.chart.data.datasets[0].data = samples.map(s => ({ x: s.time_us / 1000, y: s.value }));
    entry.chart.update('none');
  }
}

// ============================================================
// Info bar
// ============================================================
function updateInfoBar() {
  document.getElementById('infoActive').textContent = Object.keys(activeSignals).length;

  let totalSamples = 0, maxTime = 0;
  for (const samples of Object.values(traceData)) {
    totalSamples += samples.length;
    if (samples.length > 0) maxTime = Math.max(maxTime, samples[samples.length - 1].time_us);
  }
  // Also consider server-reported current time
  if (currentTimeUs > maxTime) maxTime = currentTimeUs;
  document.getElementById('infoSamples').textContent = totalSamples.toLocaleString();
  document.getElementById('infoTime').textContent = (maxTime / 1000000).toFixed(3) + 's';

  const now = Date.now();
  const elapsed = (now - lastCountReset) / 1000;
  if (elapsed >= 1) {
    document.getElementById('infoUpdates').textContent = Math.round(updateCount / elapsed) + '/s';
    updateCount = 0;
    lastCountReset = now;
  }
}

// ============================================================
// Add-signal modal
// ============================================================
let currentModal = null;
let currentModalGroup = null;

function openAddModal(group) {
  closeModal();
  currentModalGroup = group;

  // For firmware, request the catalog from server if not loaded yet
  if (group === 'Firmware' && !firmwareCatalogLoaded) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ cmd: 'browse_firmware' }));
    }
  }

  const overlay = document.createElement('div');
  overlay.className = 'trace-modal-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeModal(); });

  const modal = document.createElement('div');
  modal.className = 'trace-modal';

  const header = document.createElement('div');
  header.className = 'trace-modal-header';
  const title = document.createElement('div');
  title.className = 'trace-modal-title';
  title.textContent = 'Add ' + group + ' Signal';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'trace-modal-close';
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', closeModal);
  header.appendChild(title);
  header.appendChild(closeBtn);

  const searchDiv = document.createElement('div');
  searchDiv.className = 'trace-modal-search';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search ' + group.toLowerCase() + ' signals…';
  searchInput.autocomplete = 'off';
  searchInput.spellcheck = false;
  searchInput.addEventListener('input', () => populateModalList(group, searchInput.value));
  searchDiv.appendChild(searchInput);

  const list = document.createElement('div');
  list.className = 'trace-modal-list';
  list.id = 'traceModalList';

  const countDiv = document.createElement('div');
  countDiv.className = 'trace-modal-count';
  countDiv.id = 'traceModalCount';

  modal.appendChild(header);
  modal.appendChild(searchDiv);
  modal.appendChild(list);
  modal.appendChild(countDiv);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
  currentModal = overlay;

  setTimeout(() => searchInput.focus(), 50);
  populateModalList(group, '');
}

function closeModal() {
  if (currentModal) {
    currentModal.remove();
    currentModal = null;
    currentModalGroup = null;
  }
}

function refreshModalIfOpen(group) {
  if (currentModal && currentModalGroup === group) {
    const searchInput = currentModal.querySelector('.trace-modal-search input');
    const query = searchInput ? searchInput.value : '';
    populateModalList(group, query);
  }
}

function populateModalList(group, query) {
  const list = document.getElementById('traceModalList');
  const countEl = document.getElementById('traceModalCount');
  if (!list || !countEl) return;

  const signals = knownSignals[group] || [];
  const q = query.toLowerCase().trim();
  const filtered = q ? signals.filter(s => s.name.toLowerCase().includes(q)) : signals;

  list.innerHTML = '';

  if (group === 'Firmware' && !firmwareCatalogLoaded) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-dim);">Loading firmware variables…</div>';
    countEl.textContent = 'Fetching from DWARF debug info…';
    return;
  }

  if (filtered.length === 0) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text-dim);">' +
      (q ? 'No matching signals' : 'No signals available') + '</div>';
    countEl.textContent = signals.length + ' total';
    return;
  }

  const max = Math.min(filtered.length, 200);
  for (let i = 0; i < max; i++) {
    const sig = filtered[i];
    const isActive = !!activeSignals[sig.name];

    const item = document.createElement('div');
    item.className = 'trace-modal-item' + (isActive ? ' already-active' : '');

    const nameEl = document.createElement('span');
    nameEl.className = 'trace-modal-item-name';
    nameEl.textContent = sig.name;
    item.appendChild(nameEl);

    // Show enum type badge in the modal list
    if (sig.enum_type) {
      const enumBadge = document.createElement('span');
      enumBadge.className = 'trace-modal-item-enum';
      enumBadge.textContent = 'enum';
      enumBadge.title = sig.enum_type;
      item.appendChild(enumBadge);
    }

    if (isActive) {
      const badge = document.createElement('span');
      badge.className = 'trace-modal-item-badge';
      badge.textContent = 'active';
      item.appendChild(badge);
    }

    if (!isActive) {
      item.addEventListener('click', () => {
        addSignal(sig.name, group, sig.unit || '', sig.enum_type || null);
        item.classList.add('already-active');
        const badge = document.createElement('span');
        badge.className = 'trace-modal-item-badge';
        badge.textContent = 'active';
        item.appendChild(badge);
      });
    }

    list.appendChild(item);
  }

  const shown = max < filtered.length ? max + ' of ' + filtered.length : filtered.length;
  countEl.textContent = shown + ' signals' + (q ? ' (filtered from ' + signals.length + ')' : '');
}

// ============================================================
// Controls
// ============================================================
document.getElementById('pauseBtn').addEventListener('click', () => {
  paused = !paused;
  document.getElementById('pauseBtn').textContent = paused ? '▶ Resume' : '⏸ Pause';
});

document.getElementById('clearBtn').addEventListener('click', () => {
  const names = Object.keys(activeSignals);
  for (const name of names) removeSignal(name);
});

document.getElementById('timeWindow').addEventListener('change', updateCharts);

document.getElementById('sampleRate').addEventListener('change', () => {
  const ms = parseInt(document.getElementById('sampleRate').value);
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ cmd: 'set_poll_interval', interval_ms: ms }));
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});

// ============================================================
// Init
// ============================================================
initGroups();
connect();
