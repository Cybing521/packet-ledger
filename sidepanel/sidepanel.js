/**
 * PacketLedger Side Panel Controller
 * Implements real-time BroadcastChannel updates, IndexedDB querying/export,
 * detail inspection tabs, and modern-web-guidance progressive enhancement fallbacks.
 */
import {
  LIVE_CHANNEL,
  getSettings,
  updateSettings,
  queryRecentRecords,
  getAllRecordsAscending,
  getRecordById
} from '../shared/db.js';

// 1. Progressive enhancement fallback for <input type="checkbox" switch>
if (!('switch' in HTMLInputElement.prototype)) {
  for (const input of document.querySelectorAll('input[type="checkbox"][switch]')) {
    input.setAttribute('role', 'switch');
    input.classList.add('switch-fallback');
  }
}

// 2. Progressive enhancement fallback for <dialog closedby="any"> light-dismiss
if (!('closedBy' in HTMLDialogElement.prototype)) {
  for (const dialog of document.querySelectorAll('dialog[closedby="any"]')) {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      const isDialogContent =
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width;
      if (isDialogContent) return;
      dialog.close();
    });
  }
}

// DOM References
const statusDot = document.getElementById('status-dot');
const countBadge = document.getElementById('record-count-badge');
const toggleRecording = document.getElementById('toggle-recording');
const recordingLabelText = document.getElementById('recording-label-text');
const presetSelect = document.getElementById('preset-select');
const customRuleBox = document.getElementById('custom-rule-box');
const customScopeSelect = document.getElementById('custom-scope-select');
const customPatternInput = document.getElementById('custom-pattern-input');
const searchInput = document.getElementById('search-input');
const siteFilterSelect = document.getElementById('site-filter-select');
const toggleRedact = document.getElementById('toggle-redact');
const toggleSink = document.getElementById('toggle-sink');
const btnSinkHelp = document.getElementById('btn-sink-help');
const sinkStatusBanner = document.getElementById('sink-status-banner');
const btnExportJsonl = document.getElementById('btn-export-jsonl');
const btnOpenClear = document.getElementById('btn-open-clear');

const recordsTbody = document.getElementById('records-tbody');
const emptyState = document.getElementById('empty-state');
const detailPane = document.getElementById('detail-pane');
const detailMethodBadge = document.getElementById('detail-method-badge');
const detailUrlText = document.getElementById('detail-url-text');
const btnCloseDetail = document.getElementById('btn-close-detail');
const detailContent = document.getElementById('detail-content');
const btnCopyCurrent = document.getElementById('btn-copy-current');
const tabButtons = Array.from(document.querySelectorAll('.tab-btn'));

const confirmClearDialog = document.getElementById('confirm-clear-dialog');
const sinkHelpDialog = document.getElementById('sink-help-dialog');
const sinkCmdBlock = document.getElementById('sink-cmd-block');
const btnCopySinkCmd = document.getElementById('btn-copy-sink-cmd');

// UI State
let allLoadedRecords = [];
let selectedRecord = null;
let activeTab = 'overview';
let lastCopyableText = '';

function formatShortPath(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return `${u.hostname}${u.pathname}${u.search}`;
  } catch {
    return String(rawUrl || '');
  }
}

function formatClock(isoStr) {
  if (!isoStr) return '';
  try {
    const d = new Date(isoStr);
    return d.toTimeString().slice(0, 8);
  } catch {
    return '';
  }
}

function formatSiteLabel(tag) {
  if (tag === 'chatgpt') return 'ChatGPT';
  if (tag === 'bilibili') return 'B站';
  return tag || '其他';
}

function buildRowPreview(rec) {
  if (rec.promptPreview) return `提问: ${rec.promptPreview}`;
  if (rec.sseSummary?.extractedText) return `回复: ${rec.sseSummary.extractedText.slice(0, 90)}`;
  if (rec.wsMeta?.decodedMessages?.length) {
    return `直播帧(${rec.wsMeta.decodedMessages.length}条): ${JSON.stringify(rec.wsMeta.decodedMessages[0]).slice(0, 80)}`;
  }
  if (typeof rec.responseBody === 'string' && rec.responseBody.startsWith('{')) {
    return rec.responseBody.slice(0, 90);
  }
  return '';
}

function prettyFormatBody(raw) {
  if (raw == null || raw === '') return '(无内容)';
  if (typeof raw !== 'string') return JSON.stringify(raw, null, 2);
  const trimmed = raw.trim();
  if ((trimmed.startsWith('{') && trimmed.endsWith('}')) || (trimmed.startsWith('[') && trimmed.endsWith(']'))) {
    try {
      return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      return raw;
    }
  }
  return raw;
}

function applySettingsToControls(settings) {
  toggleRecording.checked = Boolean(settings.recordingEnabled);
  recordingLabelText.textContent = settings.recordingEnabled ? '录制中' : '已暂停';
  statusDot.classList.toggle('is-recording', Boolean(settings.recordingEnabled));

  presetSelect.value = settings.activePreset || 'smart';
  customRuleBox.hidden = presetSelect.value !== 'custom';
  customScopeSelect.value = settings.customMatchScope || 'request';
  if (document.activeElement !== customPatternInput) {
    customPatternInput.value = settings.customPattern || '';
  }

  toggleRedact.checked = Boolean(settings.redactAuth);
  toggleSink.checked = Boolean(settings.localSinkEnabled);
  checkSinkConnectivity(settings);
}

async function checkSinkConnectivity(settings) {
  if (!settings.localSinkEnabled) {
    sinkStatusBanner.hidden = true;
    return;
  }
  sinkStatusBanner.hidden = false;
  try {
    const healthUrl = settings.localSinkUrl.replace(/\/ingest\/?$/, '/health');
    const res = await fetch(healthUrl);
    if (res.ok) {
      const info = await res.json();
      sinkStatusBanner.className = 'sink-banner is-ok';
      sinkStatusBanner.textContent = `本地实时落盘已连接：写入目录 ${info.outDir}`;
    } else {
      throw new Error(`HTTP ${res.status}`);
    }
  } catch {
    sinkStatusBanner.className = 'sink-banner is-err';
    sinkStatusBanner.textContent = '未检测到本机 127.0.0.1:17890 接收器，点上方 落盘说明 复制启动命令；当前记录仍安全保存在浏览器内。';
  }
}

function getFilteredRecords() {
  const q = searchInput.value.trim().toLowerCase();
  const siteFilter = siteFilterSelect.value;

  return allLoadedRecords.filter((rec) => {
    if (siteFilter !== 'all') {
      if (siteFilter === 'other') {
        if (rec.siteTag === 'chatgpt' || rec.siteTag === 'bilibili') return false;
      } else if (rec.siteTag !== siteFilter) {
        return false;
      }
    }
    if (!q) return true;
    const haystack = [
      rec.url,
      rec.pageUrl,
      rec.method,
      rec.promptPreview,
      rec.sseSummary?.extractedText,
      rec.requestBody,
      rec.responseBody
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function renderTable() {
  countBadge.textContent = `${allLoadedRecords.length} 条`;
  const filtered = getFilteredRecords();
  recordsTbody.textContent = '';

  if (filtered.length === 0) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  const frag = document.createDocumentFragment();
  for (const rec of filtered) {
    const tr = document.createElement('tr');
    tr.dataset.id = String(rec.id);
    if (selectedRecord && selectedRecord.id === rec.id) {
      tr.classList.add('is-selected');
    }

    // Sticky row header <th>
    const th = document.createElement('th');
    th.scope = 'row';
    const pathCell = document.createElement('div');
    pathCell.className = 'path-cell';

    const pathTop = document.createElement('div');
    pathTop.className = 'path-top';

    const methodSpan = document.createElement('span');
    methodSpan.className = `method-tag method-${rec.method}`;
    methodSpan.textContent = rec.method || 'GET';

    const pathSpan = document.createElement('span');
    pathSpan.className = 'path-text';
    pathSpan.textContent = formatShortPath(rec.url);
    pathSpan.title = rec.url;

    pathTop.append(methodSpan, pathSpan);
    pathCell.appendChild(pathTop);

    const preview = buildRowPreview(rec);
    if (preview) {
      const prevDiv = document.createElement('div');
      prevDiv.className = 'preview-snippet';
      prevDiv.textContent = preview;
      pathCell.appendChild(prevDiv);
    }
    th.appendChild(pathCell);

    // Status <td>
    const tdStatus = document.createElement('td');
    const statusSpan = document.createElement('span');
    const isErr = rec.failed || (rec.status && rec.status >= 400) || rec.status === 0;
    statusSpan.className = `status-pill ${isErr ? 'status-err' : 'status-ok'}`;
    statusSpan.textContent = rec.failed ? 'ERR' : String(rec.status ?? '-');
    tdStatus.appendChild(statusSpan);

    // Site <td>
    const tdSite = document.createElement('td');
    const siteSpan = document.createElement('span');
    siteSpan.className = 'site-badge';
    siteSpan.textContent = formatSiteLabel(rec.siteTag);
    tdSite.appendChild(siteSpan);

    // Duration / Clock <td>
    const tdTime = document.createElement('td');
    tdTime.className = 'time-cell';
    const dur = rec.durationMs != null ? `${rec.durationMs}ms · ` : '';
    tdTime.textContent = `${dur}${formatClock(rec.capturedAt)}`;

    tr.append(th, tdStatus, tdSite, tdTime);
    tr.addEventListener('click', () => selectRecordById(rec.id));
    frag.appendChild(tr);
  }

  recordsTbody.appendChild(frag);
}

async function selectRecordById(id) {
  const full = await getRecordById(id);
  if (!full) return;
  selectedRecord = full;
  detailPane.hidden = false;
  detailMethodBadge.className = `method-tag method-${full.method}`;
  detailMethodBadge.textContent = full.method || 'GET';
  detailUrlText.textContent = full.url;
  detailUrlText.title = full.url;

  for (const tr of recordsTbody.querySelectorAll('tr')) {
    tr.classList.toggle('is-selected', Number(tr.dataset.id) === full.id);
  }
  renderDetailTab();
}

function appendKvRow(dl, key, val) {
  if (val == null || val === '') return;
  const dt = document.createElement('div');
  dt.className = 'kv-key';
  dt.textContent = key;
  const dd = document.createElement('div');
  dd.className = 'kv-val';
  dd.textContent = String(val);
  dl.append(dt, dd);
}

function renderDetailTab() {
  detailContent.textContent = '';
  if (!selectedRecord) return;
  const r = selectedRecord;

  if (activeTab === 'overview') {
    const dl = document.createElement('div');
    dl.className = 'kv-list';
    appendKvRow(dl, '请求接口', r.url);
    appendKvRow(dl, '所属页面', r.pageUrl);
    appendKvRow(dl, '页面标题', r.pageTitle);
    appendKvRow(dl, '捕获时间', r.capturedAt);
    appendKvRow(dl, '传输类型', `${r.transport || 'http'} · HTTP ${r.status ?? '-'} ${r.statusText || ''}`);
    appendKvRow(dl, '响应类型', r.mimeType || '-');
    appendKvRow(dl, '总计耗时', r.durationMs != null ? `${r.durationMs} ms` : '-');
    if (r.partialStream) {
      appendKvRow(dl, '流状态', '中途停止生成，已保存截至中断前的全部分片');
    }
    detailContent.appendChild(dl);

    const summaryPieces = [];
    if (r.promptPreview) {
      const card = document.createElement('div');
      card.className = 'parsed-card';
      const title = document.createElement('p');
      title.className = 'parsed-card-title';
      title.textContent = '解析出的提问内容 (Prompt)';
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      pre.textContent = r.promptPreview;
      card.append(title, pre);
      detailContent.appendChild(card);
      summaryPieces.push(`Prompt:\n${r.promptPreview}`);
    }

    if (r.sseSummary?.extractedText) {
      const card = document.createElement('div');
      card.className = 'parsed-card';
      const title = document.createElement('p');
      title.className = 'parsed-card-title';
      title.textContent = `SSE 流自动拼合正文 (共 ${r.sseSummary.sseEventCount} 个事件帧)`;
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      pre.textContent = r.sseSummary.extractedText;
      card.append(title, pre);
      detailContent.appendChild(card);
      summaryPieces.push(`Assistant:\n${r.sseSummary.extractedText}`);
    }

    if (r.wsMeta) {
      const card = document.createElement('div');
      card.className = 'parsed-card';
      const title = document.createElement('p');
      title.className = 'parsed-card-title';
      title.textContent = 'B站 WebSocket 16字节协议头解析';
      const pre = document.createElement('pre');
      pre.className = 'code-block';
      pre.textContent = JSON.stringify(r.wsMeta, null, 2);
      card.append(title, pre);
      detailContent.appendChild(card);
    }

    lastCopyableText = summaryPieces.length > 0 ? summaryPieces.join('\n\n') : JSON.stringify(r, null, 2);
    return;
  }

  if (activeTab === 'reqBody') {
    const formatted = prettyFormatBody(r.requestBody);
    lastCopyableText = formatted;
    const pre = document.createElement('pre');
    pre.className = 'code-block';
    pre.textContent = formatted;
    detailContent.appendChild(pre);
    return;
  }

  if (activeTab === 'resBody') {
    const formatted = prettyFormatBody(r.responseBody);
    lastCopyableText = formatted;
    const pre = document.createElement('pre');
    pre.className = 'code-block';
    pre.textContent = formatted;
    detailContent.appendChild(pre);
    return;
  }

  if (activeTab === 'headers') {
    const combined = {
      requestHeaders: r.requestHeaders || {},
      responseHeaders: r.responseHeaders || {}
    };
    lastCopyableText = JSON.stringify(combined, null, 2);

    const reqCard = document.createElement('div');
    reqCard.className = 'parsed-card';
    const reqTitle = document.createElement('p');
    reqTitle.className = 'parsed-card-title';
    reqTitle.textContent = 'Request Headers';
    const reqPre = document.createElement('pre');
    reqPre.className = 'code-block';
    reqPre.textContent = JSON.stringify(r.requestHeaders || {}, null, 2);
    reqCard.append(reqTitle, reqPre);

    const resCard = document.createElement('div');
    resCard.className = 'parsed-card';
    const resTitle = document.createElement('p');
    resTitle.className = 'parsed-card-title';
    resTitle.textContent = 'Response Headers';
    const resPre = document.createElement('pre');
    resPre.className = 'code-block';
    resPre.textContent = JSON.stringify(r.responseHeaders || {}, null, 2);
    resCard.append(resTitle, resPre);

    detailContent.append(reqCard, resCard);
  }
}

// Event Listeners
toggleRecording.addEventListener('change', async () => {
  const next = await updateSettings({ recordingEnabled: toggleRecording.checked });
  applySettingsToControls(next);
});

presetSelect.addEventListener('change', async () => {
  const next = await updateSettings({ activePreset: presetSelect.value });
  applySettingsToControls(next);
});

customScopeSelect.addEventListener('change', async () => {
  await updateSettings({ customMatchScope: customScopeSelect.value });
});

let patternDebounce = null;
customPatternInput.addEventListener('input', () => {
  clearTimeout(patternDebounce);
  patternDebounce = setTimeout(() => {
    updateSettings({ customPattern: customPatternInput.value });
  }, 220);
});

toggleRedact.addEventListener('change', async () => {
  await updateSettings({ redactAuth: toggleRedact.checked });
});

toggleSink.addEventListener('change', async () => {
  const next = await updateSettings({ localSinkEnabled: toggleSink.checked });
  applySettingsToControls(next);
});

searchInput.addEventListener('input', renderTable);
siteFilterSelect.addEventListener('change', renderTable);

btnCloseDetail.addEventListener('click', () => {
  detailPane.hidden = true;
  selectedRecord = null;
  for (const tr of recordsTbody.querySelectorAll('tr.is-selected')) {
    tr.classList.remove('is-selected');
  }
});

for (const btn of tabButtons) {
  btn.addEventListener('click', () => {
    activeTab = btn.dataset.tab;
    for (const b of tabButtons) {
      const active = b === btn;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    }
    renderDetailTab();
  });
}

btnCopyCurrent.addEventListener('click', async () => {
  if (!lastCopyableText) return;
  await navigator.clipboard.writeText(lastCopyableText);
  const orig = btnCopyCurrent.textContent;
  btnCopyCurrent.textContent = '已复制';
  setTimeout(() => {
    btnCopyCurrent.textContent = orig;
  }, 1200);
});

btnExportJsonl.addEventListener('click', async () => {
  const records = await getAllRecordsAscending();
  const siteFilter = siteFilterSelect.value;
  const targetList = siteFilter === 'all'
    ? records
    : records.filter((r) => (siteFilter === 'other'
        ? r.siteTag !== 'chatgpt' && r.siteTag !== 'bilibili'
        : r.siteTag === siteFilter));

  if (targetList.length === 0) return;
  const jsonlContent = targetList.map((r) => JSON.stringify(r)).join('\n') + '\n';
  const blob = new Blob([jsonlContent], { type: 'application/x-ndjson;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const dateTag = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `packet-ledger-${siteFilter}-${dateTag}.jsonl`;

  try {
    await chrome.downloads.download({
      url: blobUrl,
      filename,
      saveAs: true
    });
  } finally {
    setTimeout(() => URL.revokeObjectURL(blobUrl), 15000);
  }
});

// Modal dialogs (reset returnValue per modern-web-guidance dialog rule)
btnOpenClear.addEventListener('click', () => {
  confirmClearDialog.showModal();
});

confirmClearDialog.addEventListener('close', async () => {
  const choice = confirmClearDialog.returnValue;
  confirmClearDialog.returnValue = '';
  if (choice === 'confirm') {
    await chrome.runtime.sendMessage({ type: 'PL_CLEAR_RECORDS' });
    allLoadedRecords = [];
    selectedRecord = null;
    detailPane.hidden = true;
    renderTable();
  }
});

btnSinkHelp.addEventListener('click', () => {
  sinkHelpDialog.showModal();
});

sinkHelpDialog.addEventListener('close', () => {
  sinkHelpDialog.returnValue = '';
});

btnCopySinkCmd.addEventListener('click', async () => {
  await navigator.clipboard.writeText(sinkCmdBlock.textContent.trim());
  btnCopySinkCmd.textContent = '已复制命令';
  setTimeout(() => {
    btnCopySinkCmd.textContent = '复制启动命令';
  }, 1400);
});

// Live stream subscription from Service Worker
const liveChannel = new BroadcastChannel(LIVE_CHANNEL);
liveChannel.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'NEW_RECORD' && msg.record) {
    allLoadedRecords.unshift(msg.record);
    if (allLoadedRecords.length > 1000) {
      allLoadedRecords.length = 1000;
    }
    if (msg.sinkStatus && !msg.sinkStatus.skipped) {
      if (msg.sinkStatus.ok) {
        sinkStatusBanner.hidden = false;
        sinkStatusBanner.className = 'sink-banner is-ok';
        sinkStatusBanner.textContent = `实时落盘正常：最近写入 #${msg.record.id}`;
      } else {
        sinkStatusBanner.hidden = false;
        sinkStatusBanner.className = 'sink-banner is-err';
        sinkStatusBanner.textContent = '本地 127.0.0.1:17890 接收器未响应，已暂存于浏览器内';
      }
    }
    renderTable();
  } else if (msg.type === 'RECORDS_CLEARED') {
    allLoadedRecords = [];
    selectedRecord = null;
    detailPane.hidden = true;
    renderTable();
  } else if (msg.type === 'SETTINGS_UPDATED' && msg.settings) {
    applySettingsToControls(msg.settings);
  }
});

async function bootstrap() {
  const settings = await getSettings();
  applySettingsToControls(settings);
  allLoadedRecords = await queryRecentRecords(500);
  renderTable();
}

bootstrap();
