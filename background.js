/**
 * Background Service Worker
 * Handles API calls, token extraction, and data bundling.
 */

try {
  importScripts('./lib/jszip.min.js', './lib/xlsx.full.min.js');
} catch (err) {
  console.error('[HoaDon] Failed to load required libraries:', err);
}

const BASE_URL = 'https://hoadondientu.gdt.gov.vn/api';
const PAGE_SIZE = 50;
const INVOICE_HTML_WIDTH_MM = 235;
const INVOICE_QUERY_FAMILIES = [
  {
    key: 'standard',
    prefix: '/query',
    label: 'hóa đơn điện tử',
    actions: {
      purchase: 'Tìm kiếm (hóa đơn mua vào)',
      sold: 'Tìm kiếm (hóa đơn bán ra)'
    },
    searchVariants: {
      purchase: [
        { key: 'ttxly-5', label: 'đã cấp mã', filters: ['ttxly==5'] },
        { key: 'ttxly-6', label: 'đã nhận không mã', filters: ['ttxly==6'] },
        { key: 'ttxly-8', label: 'MTT đã nhận', filters: ['ttxly==8'] }
      ],
      sold: [
        { key: 'all', label: 'tất cả' }
      ]
    }
  },
  {
    key: 'sco',
    prefix: '/sco-query',
    label: 'hóa đơn máy tính tiền',
    actions: {
      purchase: 'Tìm kiếm (hóa đơn máy tính tiền mua vào)',
      sold: 'Tìm kiếm (hóa đơn máy tính tiền bán ra)'
    },
    searchVariants: {
      purchase: [
        { key: 'ttxly-5', label: 'đã cấp mã', filters: ['ttxly==5'] },
        { key: 'ttxly-6', label: 'đã nhận không mã', filters: ['ttxly==6'] },
        { key: 'ttxly-8', label: 'MTT đã nhận', filters: ['ttxly==8'] }
      ],
      sold: [
        { key: 'all', label: 'tất cả' }
      ]
    }
  }
];
const SEARCH_END_POINT = '/tra-cuu/tra-cuu-hoa-don';
const INVOICE_LIST_TIMEOUT_MS = 12000;
const INVOICE_RESOURCE_TIMEOUT_MS = 6000;
const RATE_LIST_FLOOR_MS = 300;
const RATE_ADAPTIVE_FLOOR_MS = 600;
const RATE_BACKOFF_MULTIPLIER = 5;
const RATE_BACKOFF_CAP_MS = 75000;
const RATE_BACKOFF_LINEAR_STEP_MS = 15000;
const RATE_RECOVERY_DIVISOR = 5;
const RATE_TIMEOUT_WINDOW_MS = 60000;
const RATE_TIMEOUT_THRESHOLD = 3;
const RATE_JITTER_FACTOR = 0.10;
const RATE_RECOVER_AFTER_MS = 0;
const RATE_WAIT_RECHECK_MS = 500;
const RATE_XML_MISSING_SOFT_BACKOFF_MS = 1000;
const RATE_SOFT_BACKOFF_RECOVER_SUCCESS_COUNT = 6;
const RATE_SOFT_BACKOFF_RECOVERY_STEP_MS = 100;
const RATE_QUOTA_429_WINDOW_MS = 60000;
const RATE_QUOTA_429_THRESHOLD = 3;
const RATE_QUOTA_COOLDOWN_MS = 180000;
const RATE_QUOTA_REPEAT_COOLDOWN_MS = 300000;
const RATE_RESOURCE_WINDOW_MS = 10 * 60 * 1000;
const RATE_RESOURCE_WINDOW_LIMIT = 480;
const INVOICE_LIST_MAX_RETRIES = 1;
const TAX_MAINTENANCE_ERROR_MESSAGE = 'Hệ thống bảo trì không kết nối được. Vui lòng thử lại sau.';
const LOGIN_ACCOUNT_ERROR_MESSAGE = 'Không tìm thấy tài khoản đăng nhập. Vui lòng đăng nhập trang thuế rồi thử lại.';
const INVOICE_RESOURCE_ERROR_MESSAGE = 'Không tải đủ dữ liệu hóa đơn do hệ thống thuế tạm ngừng kết nối. Đã lưu tiến độ, bấm Tiếp tục để tải tiếp.';
const BADGE_FETCH_TIMEOUT_MS = 3500;
const BADGE_IMAGE_MAX_BYTES = 512 * 1024;

const activeDownloads = new Map();
const FORM_STATE_STORAGE_KEY = 'hoaDonFormState';
const WORKFLOW_LOCK_STORAGE_KEY = 'hoaDonWorkflowLock';
const WORKFLOW_LOCK_TTL_MS = 45000;
const WORKFLOW_LOCK_HEARTBEAT_MS = 10000;
const RESUME_SESSION_STORAGE_KEY = 'hoaDonResumeSession';
const RESUME_SESSIONS_STORAGE_KEY = 'hoaDonResumeSessions';
const RESUME_DB_NAME = 'hoaDonResumeArtifacts';
const RESUME_DB_VERSION = 1;
const RESUME_ARTIFACT_STORE = 'artifacts';
const DOWNLOAD_ITEM_MAX_ATTEMPTS = 3;
const PDF_OFFSCREEN_DOCUMENT = 'offscreen.html';
const pdfRenderRequests = new Map();
const connectedContentPorts = new Map();
let pdfGeneratorPort = null;
let pdfGeneratorPortReady = null;
let resolvePdfGeneratorPortReady = null;
let pdfMakeRenderQueue = Promise.resolve();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'hoa-don-content') {
    const tabId = port.sender?.tab?.id;
    if (!tabId) return;
    connectedContentPorts.set(tabId, port);
    port.onDisconnect.addListener(() => {
      if (connectedContentPorts.get(tabId) === port) {
        connectedContentPorts.delete(tabId);
      }
    });
    return;
  }

  if (port.name !== 'pdf-generator') return;

  pdfGeneratorPort = port;
  if (resolvePdfGeneratorPortReady) {
    resolvePdfGeneratorPortReady(port);
    resolvePdfGeneratorPortReady = null;
    pdfGeneratorPortReady = null;
  }

  port.onMessage.addListener((msg) => {
    if (msg.type !== 'PDF_RESULT' || !msg.requestId) return;
    const pending = pdfRenderRequests.get(msg.requestId);
    if (!pending) return;

    clearTimeout(pending.timeout);
    pdfRenderRequests.delete(msg.requestId);

    if (msg.ok) {
      pending.resolve(base64ToUint8Array(msg.base64 || ''));
    } else {
      pending.reject(new Error(msg.error || 'Khong tao duoc PDF tu HTML.'));
    }
  });

  port.onDisconnect.addListener(() => {
    if (pdfGeneratorPort === port) {
      pdfGeneratorPort = null;
    }

    for (const [requestId, pending] of pdfRenderRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Kenh tao PDF da bi dong.'));
      pdfRenderRequests.delete(requestId);
    }
  });
});

function chromeStorageGet(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.get(keys, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result || {});
    });
  });
}

function chromeStorageSet(update) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.set(update, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function chromeStorageRemove(keys) {
  return new Promise((resolve, reject) => {
    chrome.storage.local.remove(keys, () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve();
    });
  });
}

function hasActiveWorkflow(exceptJob = null) {
  for (const job of activeDownloads.values()) {
    if (job !== exceptJob) return true;
  }
  return false;
}

function isWorkflowLockFresh(lock) {
  if (!lock?.ownerId) return false;
  const updatedAt = Number(lock.updatedAt || lock.startedAt || 0);
  return updatedAt > 0 && Date.now() - updatedAt < WORKFLOW_LOCK_TTL_MS;
}

async function loadWorkflowLock() {
  const result = await chromeStorageGet(WORKFLOW_LOCK_STORAGE_KEY);
  const lock = result[WORKFLOW_LOCK_STORAGE_KEY];
  return lock && typeof lock === 'object' ? lock : null;
}

async function clearWorkflowLockIfIdle() {
  if (hasActiveWorkflow()) return;
  await chromeStorageRemove(WORKFLOW_LOCK_STORAGE_KEY).catch(() => {});
}

async function acquireWorkflowLock(tabId, type, job = null) {
  const current = await loadWorkflowLock();
  if (isWorkflowLockFresh(current) && hasActiveWorkflow(job)) {
    return { ok: false, lock: current };
  }

  const now = Date.now();
  const ownerId = `${now}-${tabId}-${Math.random().toString(16).slice(2)}`;
  const lock = { ownerId, tabId, type, startedAt: now, updatedAt: now };
  await chromeStorageSet({ [WORKFLOW_LOCK_STORAGE_KEY]: lock });

  const verified = await loadWorkflowLock();
  if (verified?.ownerId !== ownerId) {
    return { ok: false, lock: verified };
  }
  return { ok: true, lock };
}

async function refreshWorkflowLock(job) {
  if (!job?.lockOwnerId) return;
  const current = await loadWorkflowLock();
  if (current?.ownerId !== job.lockOwnerId) return;
  await chromeStorageSet({
    [WORKFLOW_LOCK_STORAGE_KEY]: {
      ...current,
      accountKey: job.accountKey || current.accountKey || '',
      percent: job.percent || current.percent || 0,
      updatedAt: Date.now()
    }
  });
}

function startWorkflowLockHeartbeat(job) {
  if (!job?.lockOwnerId) return;
  if (job.lockHeartbeatId) clearInterval(job.lockHeartbeatId);
  job.lockHeartbeatId = setInterval(() => {
    refreshWorkflowLock(job).catch(() => {});
  }, WORKFLOW_LOCK_HEARTBEAT_MS);
}

async function releaseWorkflowLock(job) {
  if (job?.lockHeartbeatId) {
    clearInterval(job.lockHeartbeatId);
    job.lockHeartbeatId = null;
  }
  if (!job?.lockOwnerId) return;
  const current = await loadWorkflowLock().catch(() => null);
  if (current?.ownerId === job.lockOwnerId) {
    await chromeStorageRemove(WORKFLOW_LOCK_STORAGE_KEY).catch(() => {});
  }
}

function openResumeDb() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB khong kha dung trong trinh duyet nay.'));
      return;
    }

    const request = indexedDB.open(RESUME_DB_NAME, RESUME_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RESUME_ARTIFACT_STORE)) {
        const store = db.createObjectStore(RESUME_ARTIFACT_STORE, { keyPath: 'id' });
        store.createIndex('jobId', 'jobId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Khong mo duoc IndexedDB.'));
  });
}

async function withResumeStore(mode, callback) {
  const db = await openResumeDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(RESUME_ARTIFACT_STORE, mode);
      const store = tx.objectStore(RESUME_ARTIFACT_STORE);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error || new Error('Loi IndexedDB.'));
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted.'));
      Promise.resolve(callback(store)).then(value => {
        result = value;
      }).catch(error => {
        reject(error);
        try { tx.abort(); } catch (_) {}
      });
    });
  } finally {
    db.close();
  }
}

function resumeArtifactId(jobId, itemKey) {
  return `${jobId}:${itemKey}`;
}

async function putResumeArtifact(jobId, itemKey, artifact) {
  const record = {
    ...artifact,
    id: resumeArtifactId(jobId, itemKey),
    jobId,
    itemKey,
    updatedAt: Date.now()
  };
  await withResumeStore('readwrite', store => store.put(record));
}

async function putResumeArtifacts(records) {
  const items = (records || []).filter(record => record?.jobId && record?.itemKey);
  if (items.length === 0) return;
  await withResumeStore('readwrite', store => {
    items.forEach(record => {
      store.put({
        ...record,
        id: resumeArtifactId(record.jobId, record.itemKey),
        updatedAt: Date.now()
      });
    });
  });
}

async function getResumeArtifacts(jobId, filter = null) {
  return withResumeStore('readonly', store => new Promise((resolve, reject) => {
    const artifacts = [];
    const index = store.index('jobId');
    const request = index.openCursor(IDBKeyRange.only(jobId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(artifacts);
        return;
      }
      if (!filter || filter(cursor.value)) {
        artifacts.push(cursor.value);
      }
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('Khong doc duoc resume artifacts.'));
  }));
}

async function deleteResumeArtifacts(jobId) {
  if (!jobId) return;
  await withResumeStore('readwrite', store => new Promise((resolve, reject) => {
    const index = store.index('jobId');
    const request = index.openCursor(IDBKeyRange.only(jobId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const deleteRequest = cursor.delete();
      deleteRequest.onsuccess = () => cursor.continue();
      deleteRequest.onerror = () => reject(deleteRequest.error || new Error('Khong xoa duoc resume artifact.'));
    };
    request.onerror = () => reject(request.error || new Error('Khong xoa duoc resume artifacts.'));
  }));
}

async function deleteResumeArtifactsMatching(jobId, predicate) {
  if (!jobId || typeof predicate !== 'function') return;
  await withResumeStore('readwrite', store => new Promise((resolve, reject) => {
    const index = store.index('jobId');
    const request = index.openCursor(IDBKeyRange.only(jobId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      if (!predicate(cursor.value)) {
        cursor.continue();
        return;
      }
      const deleteRequest = cursor.delete();
      deleteRequest.onsuccess = () => cursor.continue();
      deleteRequest.onerror = () => reject(deleteRequest.error || new Error('Khong xoa duoc resume artifact.'));
    };
    request.onerror = () => reject(request.error || new Error('Khong xoa duoc resume artifacts.'));
  }));
}

function decodeJwtPayload(token) {
  try {
    const part = String(token || '').split('.')[1];
    if (!part) return null;
    const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(atob(padded));
  } catch (_) {
    return null;
  }
}

function normalizeAccountKeyPart(value) {
  const text = String(value || '').trim();
  return text ? text.toLowerCase() : '';
}

function pickPayloadValue(payload, paths) {
  for (const path of paths) {
    let value = payload;
    for (const key of path.split('.')) {
      value = value && typeof value === 'object' ? value[key] : undefined;
    }
    const normalized = normalizeAccountKeyPart(value);
    if (normalized) return normalized;
  }
  return '';
}

function normalizeDisplayValue(value, maxLength = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || /^(null|undefined|true|false)$/i.test(text)) return '';
  if (/^\d{10}(?:-\d{3})?$|^\d{13}$/.test(text)) return '';
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

function pickPayloadDisplayValue(payload, paths) {
  for (const path of paths) {
    let value = payload;
    for (const key of path.split('.')) {
      value = value && typeof value === 'object' ? value[key] : undefined;
    }
    const normalized = normalizeDisplayValue(value);
    if (normalized) return normalized;
  }
  return '';
}

function extractMstFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return pickPayloadValue(payload, [
    'mst',
    'maSoThue',
    'ma_so_thue',
    'taxCode',
    'tax_code',
    'user.mst',
    'user.maSoThue',
    'user.ma_so_thue',
    'user.taxCode',
    'user.tax_code',
    'profile.mst',
    'profile.maSoThue',
    'profile.ma_so_thue',
    'profile.taxCode',
    'profile.tax_code',
    'account.mst',
    'account.maSoThue',
    'taxpayer.mst',
    'taxpayer.maSoThue'
  ]);
}

function extractCompanyNameFromPayload(payload) {
  if (!payload || typeof payload !== 'object') return '';
  return pickPayloadDisplayValue(payload, [
    'companyName',
    'company_name',
    'taxpayerName',
    'taxpayer_name',
    'taxPayerName',
    'organizationName',
    'organisationName',
    'orgName',
    'org_name',
    'tenCongTy',
    'ten_cong_ty',
    'tenNnt',
    'ten_nnt',
    'tenNguoiNopThue',
    'ten_nguoi_nop_thue',
    'user.companyName',
    'user.company_name',
    'user.taxpayerName',
    'user.organizationName',
    'user.tenCongTy',
    'user.tenNnt',
    'profile.companyName',
    'profile.company_name',
    'profile.taxpayerName',
    'profile.organizationName',
    'profile.tenCongTy',
    'profile.tenNnt',
    'account.companyName',
    'account.company_name',
    'account.taxpayerName',
    'account.organizationName',
    'account.tenCongTy',
    'account.tenNnt',
    'taxpayer.name',
    'taxpayer.companyName',
    'taxpayer.company_name',
    'taxpayer.taxpayerName',
    'taxpayer.tenCongTy',
    'taxpayer.tenNnt',
    'nnt.ten',
    'nnt.tenNnt',
    'nnt.tenNguoiNopThue',
    'nguoiNopThue.ten',
    'nguoiNopThue.tenNnt'
  ]);
}

function getAccountKeyFromToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload || typeof payload !== 'object') return '';
  const taxCode = extractMstFromPayload(payload);
  const userId = pickPayloadValue(payload, [
    'username',
    'userName',
    'user_name',
    'preferred_username',
    'uid',
    'userId',
    'user_id',
    'user.username',
    'user.userName',
    'profile.username',
    'email',
    'sub'
  ]);
  if (taxCode && userId) return `tax:${taxCode}|user:${userId}`;
  if (taxCode) return `tax:${taxCode}`;
  if (userId) return `user:${userId}`;
  return '';
}

async function getCurrentAccountKey(tabId) {
  const token = await getToken(tabId);
  return getAccountKeyFromToken(token) || (token ? 'unknown' : '');
}

function normalizeResumeSessions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return { ...value };
}

async function loadResumeStorage() {
  const result = await chromeStorageGet([RESUME_SESSIONS_STORAGE_KEY, RESUME_SESSION_STORAGE_KEY]);
  return {
    sessions: normalizeResumeSessions(result[RESUME_SESSIONS_STORAGE_KEY]),
    legacySession: result[RESUME_SESSION_STORAGE_KEY] && typeof result[RESUME_SESSION_STORAGE_KEY] === 'object'
      ? result[RESUME_SESSION_STORAGE_KEY]
      : null
  };
}

async function loadResumeSession(accountKey = '') {
  const { sessions, legacySession } = await loadResumeStorage();
  if (accountKey && sessions[accountKey]) return sessions[accountKey];
  if (!accountKey) return null;
  if (legacySession?.jobId && (!legacySession.accountKey || legacySession.accountKey === accountKey)) {
    return { ...legacySession, accountKey };
  }
  return null;
}

async function saveResumeSession(session) {
  if (!session) return;
  const accountKey = session.accountKey || 'unknown';
  const { sessions } = await loadResumeStorage();
  session.accountKey = accountKey;
  session.updatedAt = Date.now();
  sessions[accountKey] = session;
  await chromeStorageSet({ [RESUME_SESSIONS_STORAGE_KEY]: sessions });
  await chromeStorageRemove([RESUME_SESSION_STORAGE_KEY]).catch(() => {});
}

async function clearResumeSession(expectedJobId = null, accountKey = '') {
  const { sessions, legacySession } = await loadResumeStorage();
  const jobIdsToDelete = new Set();
  let changed = false;

  if (accountKey) {
    const session = sessions[accountKey] || (
      legacySession?.jobId && (!legacySession.accountKey || legacySession.accountKey === accountKey)
        ? { ...legacySession, accountKey }
        : null
    );
    if (expectedJobId && session?.jobId && session.jobId !== expectedJobId) return;
    if (session?.jobId) jobIdsToDelete.add(session.jobId);
    if (sessions[accountKey]) {
      delete sessions[accountKey];
      changed = true;
    }
  } else if (expectedJobId) {
    for (const [key, session] of Object.entries(sessions)) {
      if (session?.jobId !== expectedJobId) continue;
      delete sessions[key];
      jobIdsToDelete.add(expectedJobId);
      changed = true;
    }
  } else {
    for (const session of Object.values(sessions)) {
      if (session?.jobId) jobIdsToDelete.add(session.jobId);
    }
    for (const key of Object.keys(sessions)) delete sessions[key];
    changed = true;
  }

  const removeLegacy = legacySession?.jobId
    && (!expectedJobId || legacySession.jobId === expectedJobId)
    && (!accountKey || !legacySession.accountKey || legacySession.accountKey === accountKey);
  if (removeLegacy) jobIdsToDelete.add(legacySession.jobId);

  if (changed) await chromeStorageSet({ [RESUME_SESSIONS_STORAGE_KEY]: sessions }).catch(() => {});
  if (removeLegacy || !expectedJobId) await chromeStorageRemove([RESUME_SESSION_STORAGE_KEY]).catch(() => {});
  if (expectedJobId) jobIdsToDelete.add(expectedJobId);
  await Promise.all([...jobIdsToDelete].map(jobId => deleteResumeArtifacts(jobId).catch(() => {})));
}

async function pauseResumeSession(accountKey) {
  if (!accountKey) return;
  const session = await loadResumeSession(accountKey).catch(() => null);
  if (session?.phase === 'list') {
    session.updatedAt = Date.now();
    await saveResumeSession(session).catch(() => {});
    return;
  }
  if (!session?.jobId || !Array.isArray(session.items)) return;
  let changed = false;

  for (const item of session.items) {
    if (item.state === 'detail_pending') {
      item.state = 'queued';
      item.detailAttempts = Math.max(0, Number(item.detailAttempts || 0) - 1);
      item.lastStatus = 0;
      item.lastError = '';
      item.updatedAt = Date.now();
      changed = true;
    } else if (item.state === 'xml_pending') {
      item.state = 'queued';
      item.xmlAttempts = Math.max(0, Number(item.xmlAttempts || 0) - 1);
      item.lastStatus = 0;
      item.lastError = '';
      item.updatedAt = Date.now();
      changed = true;
    }
  }

  if (changed) await saveResumeSession(session).catch(() => {});
}

function listSessionMonthStats(session) {
  const list = session?.list || {};
  const tasks = Array.isArray(list.tasks) ? list.tasks : [];
  const ranges = Array.isArray(list.dateRanges) ? list.dateRanges : [];
  const total = Number(list.totalMonths) || ranges.length || 1;
  let completed = 0;

  for (let index = 0; index < total; index += 1) {
    const monthTasks = tasks.filter(task => Number(task.dateRangeIndex) === index);
    if (monthTasks.length > 0 && monthTasks.every(task => task.state === 'done')) {
      completed += 1;
    }
  }

  return {
    total,
    completed,
    pending: Math.max(0, total - completed)
  };
}

function isDownloadItemTerminal(item) {
  return item?.state === 'done' || item?.state === 'xml_missing';
}

function summarizeResumeSession(session) {
  if (session?.phase === 'list') {
    const stats = listSessionMonthStats(session);
    const tasks = Array.isArray(session.list?.tasks) ? session.list.tasks : [];
    const loadedInvoices = tasks.reduce((sum, task) => sum + (Number(task.loadedCount) || 0), 0);
    return {
      jobId: session.jobId,
      accountKey: session.accountKey || '',
      phase: 'list',
      params: session.params || {},
      formats: session.formats || [],
      total: stats.total,
      completed: stats.completed,
      pending: stats.pending,
      loadedInvoices,
      updatedAt: session.updatedAt || session.createdAt || Date.now()
    };
  }
  if (!session?.jobId || !Array.isArray(session.items)) return null;
  const total = Number(session.total) || session.items.length;
  const completed = session.items.filter(isDownloadItemTerminal).length;
  return {
    jobId: session.jobId,
    accountKey: session.accountKey || '',
    params: session.params || {},
    formats: session.formats || [],
    total,
    completed,
    pending: Math.max(0, total - completed),
    updatedAt: session.updatedAt || session.createdAt || Date.now()
  };
}

function getActiveDownloadSummary() {
  const job = activeDownloads.values().next().value;
  if (!job) return null;
  const message = job.lastMessage && job.lastMessage.type === 'PROGRESS'
    ? job.lastMessage
    : {
        type: 'PROGRESS',
        percent: job.percent || 8,
        message: job.percent ? 'Đang tải dữ liệu...' : 'Đang khởi động...'
      };
  return {
    tabId: job.tabId,
    accountKey: job.accountKey || '',
    percent: job.percent || message.percent || 0,
    message
  };
}

function sendActiveDownloadState(tabId) {
  const active = getActiveDownloadSummary();
  if (!active) return false;
  safeSendMessage(tabId, {
    type: 'ACTIVE_DOWNLOAD_STATE',
    active: {
      ...active,
      isOwner: active.tabId === tabId
    }
  });
  return true;
}

async function sendResumeSessionState(tabId, accountKey = '') {
  const currentAccountKey = accountKey || await getCurrentAccountKey(tabId).catch(() => '');
  const session = currentAccountKey ? await loadResumeSession(currentAccountKey).catch(() => null) : null;
  safeSendMessage(tabId, {
    type: 'RESUME_SESSION',
    accountKey: currentAccountKey,
    session: summarizeResumeSession(session)
  });
}

function resolveBadgeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text, BADGE_CONFIG_URL);
    return url.protocol === 'https:' ? url.href : '';
  } catch (_) {
    return '';
  }
}

function normalizeBadgeText(value, maxLength = 240) {
  return String(value || '').trim().slice(0, maxLength);
}

function getBadgeCards(payload) {
  const cards = Array.isArray(payload?.cards) ? payload.cards : [payload];
  return cards.filter(card => card && typeof card === 'object' && card.enabled !== false).slice(0, 8);
}

function normalizeBadgeInterval(value) {
  const interval = Number(value) || 7000;
  return Math.min(30000, Math.max(4000, interval));
}

async function fetchWithTimeout(url, options = {}, timeoutMs = BADGE_FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchBadgeImageDataUrl(imageUrl) {
  const resolvedUrl = resolveBadgeUrl(imageUrl);
  if (!resolvedUrl) return '';

  const response = await fetchWithTimeout(resolvedUrl, { cache: 'no-cache', credentials: 'omit' }, BADGE_FETCH_TIMEOUT_MS);
  if (!response.ok) return '';

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.toLowerCase().startsWith('image/')) return '';

  const contentLength = Number(response.headers.get('content-length')) || 0;
  if (contentLength > BADGE_IMAGE_MAX_BYTES) return '';

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > BADGE_IMAGE_MAX_BYTES) return '';

  return blobToDataUrl(new Blob([buffer], { type: contentType || 'image/jpeg' }));
}

async function getRemoteBadgeConfig() {
  const response = await fetchWithTimeout(BADGE_CONFIG_URL, { cache: 'no-cache', credentials: 'omit' });
  if (!response.ok) throw new Error(`Badge config HTTP ${response.status}`);

  const payload = await response.json();
  if (payload?.enabled === false) return { enabled: false };

  const cards = getBadgeCards(payload);
  if (cards.length === 0) return { enabled: false };

  const normalizedCards = await Promise.all(cards.map(async (card) => {
    const imageUrl = resolveBadgeUrl(card.imageUrl);
    let imageDataUrl = '';
    if (imageUrl) {
      imageDataUrl = await fetchBadgeImageDataUrl(imageUrl).catch(() => '');
    }
    return {
      enabled: card.enabled !== false,
      id: normalizeBadgeText(card.id, 80),
      type: normalizeBadgeText(card.type, 40),
      title: normalizeBadgeText(card.title, 80),
      body: normalizeBadgeText(card.body, 260),
      imageUrl,
      imageDataUrl,
      imageAlt: normalizeBadgeText(card.imageAlt, 120),
      ctaText: normalizeBadgeText(card.ctaText, 40),
      ctaUrl: resolveBadgeUrl(card.ctaUrl),
      note: normalizeBadgeText(card.note, 120),
      disclosure: normalizeBadgeText(card.disclosure, 160)
    };
  }));

  return {
    enabled: true,
    mode: normalizeBadgeText(payload.mode, 30) || 'carousel',
    intervalMs: normalizeBadgeInterval(payload.intervalMs),
    cards: normalizedCards
  };
}

// Listen for messages from content scripts
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  if (request.type === 'CHECK_TOKEN') {
    getToken(tabId).then(async token => {
      const payload = decodeJwtPayload(token);
      let mst = extractMstFromPayload(payload);
      let companyName = extractCompanyNameFromPayload(payload);
      if (!mst || !companyName) {
        const pageAccount = await getLoggedInAccountInfo(tabId);
        mst = mst || pageAccount.mst || '';
        companyName = companyName || pageAccount.companyName || '';
      }
      const accountKey = getAccountKeyFromToken(token) || (token ? 'unknown' : '');
      sendResponse({ ok: !!token, token, mst, companyName, accountKey });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (request.type === 'GET_BADGE_CONFIG') {
    getRemoteBadgeConfig().then(config => {
      sendResponse({ ok: true, config });
    }).catch(err => {
      console.warn('[HoaDon] Failed to load remote badge config:', err);
      sendResponse({ ok: false, error: err.message || 'Badge config unavailable' });
    });
    return true;
  }

  if (request.type === 'GET_RESUME_SESSION') {
    getCurrentAccountKey(tabId).then(async accountKey => {
      const session = accountKey ? await loadResumeSession(accountKey) : null;
      sendResponse({ ok: true, accountKey, session: summarizeResumeSession(session) });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (request.type === 'GET_ACTIVE_DOWNLOAD_STATE') {
    const active = getActiveDownloadSummary();
    sendResponse({ ok: true, active: active ? { ...active, isOwner: active.tabId === tabId } : null });
    return true;
  }

  if (request.type === 'GET_FORM_STATE') {
    chromeStorageGet(FORM_STATE_STORAGE_KEY).then(result => {
      sendResponse({ ok: true, state: result[FORM_STATE_STORAGE_KEY] || null });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (request.type === 'SYNC_FORM_STATE') {
    const state = request.state && typeof request.state === 'object' ? request.state : null;
    if (!state) {
      sendResponse({ ok: false, error: 'Invalid form state' });
      return true;
    }
    const syncedState = {
      ...state,
      sourceClientId: request.sourceClientId || '',
      updatedAt: Date.now()
    };
    chromeStorageSet({ [FORM_STATE_STORAGE_KEY]: syncedState }).then(() => {
      sendResponse({ ok: true });
      safeSendMessage(tabId, {
        type: 'FORM_STATE_SYNC',
        state: syncedState
      });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (request.type === 'CLEAR_RESUME_SESSION') {
    getCurrentAccountKey(tabId).then(accountKey => clearResumeSession(request.jobId, accountKey))
    .then(() => clearWorkflowLockIfIdle())
    .then(() => {
      sendResponse({ ok: true });
      safeSendMessage(tabId, { type: 'RESUME_SESSION', session: null });
    }).catch(err => {
      sendResponse({ ok: false, error: err.message });
    });
    return true;
  }

  if (request.type === 'RESUME_DOWNLOAD') {
    beginDownloadJob(tabId, 'resume').catch(err => {
      console.error('[HoaDon] Failed to start resume workflow:', err);
      safeSendMessage(tabId, { type: 'ERROR', message: err.message || 'Không thể tiếp tục phiên tải.' });
    });
  }

  if (request.type === 'START_DOWNLOAD') {
    beginDownloadJob(tabId, 'start', request.params).catch(err => {
      console.error('[HoaDon] Failed to start download workflow:', err);
      safeSendMessage(tabId, { type: 'ERROR', message: err.message || 'Không thể bắt đầu tải.' });
    });
  }

  if (request.type === 'STOP_DOWNLOAD') {
    stopActiveDownload(tabId, true);
  }
});

async function beginDownloadJob(tabId, type, params = null) {
  if (hasActiveWorkflow()) {
    sendActiveDownloadState(tabId);
    return;
  }

  const job = {
    stopped: false,
    controller: new AbortController(),
    tabId,
    percent: 0,
    lockOwnerId: null,
    lockHeartbeatId: null,
    rateLimiter: null
  };
  job.rateLimiter = createAdaptiveRateLimiter(job, RATE_LIST_FLOOR_MS);
  activeDownloads.set(tabId, job);

  try {
    const acquired = await acquireWorkflowLock(tabId, type, job);
    if (!acquired.ok) {
      sendActiveDownloadState(tabId);
      return;
    }
    job.lockOwnerId = acquired.lock.ownerId;
    startWorkflowLockHeartbeat(job);
    throwIfStopped(job);

    if (type === 'resume') {
      await handleResumeDownloadWorkflow(tabId, job);
    } else {
      await handleDownloadWorkflow(tabId, params, job);
    }
  } finally {
    if (activeDownloads.get(tabId) === job) {
      activeDownloads.delete(tabId);
    }
    await releaseWorkflowLock(job);
  }
}

function stopActiveDownload(tabId, notify = true) {
  const job = activeDownloads.get(tabId) || activeDownloads.values().next().value;
  if (job) {
    job.stopped = true;
    job.controller.abort();
    return;
  }
  if (notify) safeSendMessage(tabId, { type: 'STOPPED' });
}

chrome.tabs?.onRemoved?.addListener((tabId) => {
  if (activeDownloads.has(tabId)) {
    stopActiveDownload(tabId, false);
  }
});

function safeSendMessage(tabId, message) {
  const activeJob = activeDownloads.get(tabId);
  const shouldBroadcast = message?.type === 'RESUME_SESSION'
    || message?.type === 'FORM_STATE_SYNC'
    || (!!activeJob && ['PROGRESS', 'DONE', 'ERROR', 'STOPPED', 'NOTIFY'].includes(message?.type));
  if (activeJob && ['PROGRESS', 'DONE', 'ERROR', 'STOPPED', 'NOTIFY'].includes(message?.type)) {
    activeJob.lastMessage = message;
  }

  try {
    chrome.tabs.sendMessage(tabId, message, () => {
      if (chrome.runtime.lastError) {
        // Tab might be closed or inactive, ignore to prevent console flood
      }
    });
  } catch (err) {
    // Ignore synchronous exceptions
  }

  if (shouldBroadcast) {
    for (const [otherTabId, port] of connectedContentPorts) {
      if (otherTabId === tabId) continue;
      try {
        port.postMessage(message);
      } catch (_) {
        connectedContentPorts.delete(otherTabId);
      }
    }

    try {
      chrome.tabs.query({ url: 'https://hoadondientu.gdt.gov.vn/*' }, (tabs) => {
        if (chrome.runtime.lastError || !Array.isArray(tabs)) return;
        tabs.forEach(tab => {
          if (!tab?.id || tab.id === tabId) return;
          chrome.tabs.sendMessage(tab.id, message, () => {
            if (chrome.runtime.lastError) {
              // The content script may not be ready in this tab yet.
            }
          });
        });
      });
    } catch (_) {}
  }
}

function createStoppedError() {
  const error = new Error('Đã dừng tải.');
  error.name = 'DownloadStopped';
  return error;
}

function isStoppedError(error) {
  return error && (error.name === 'DownloadStopped' || error.name === 'AbortError');
}

function isJobStopped(job) {
  return !!(job && (job.stopped || job.controller.signal.aborted));
}

function throwIfStopped(job) {
  if (isJobStopped(job)) throw createStoppedError();
}

function createTaxMaintenanceError(message = TAX_MAINTENANCE_ERROR_MESSAGE, cause) {
  const error = new Error(message);
  error.name = 'TaxMaintenanceError';
  error.userMessage = TAX_MAINTENANCE_ERROR_MESSAGE;
  error.cause = cause;
  error.abortDownload = true;
  return error;
}

function createCompletenessError(message, cause, userMessage = message) {
  const error = new Error(message);
  error.name = 'InvoiceCompletenessError';
  error.userMessage = userMessage;
  error.cause = cause;
  error.abortDownload = true;
  return error;
}

function isTaxMaintenanceError(error) {
  return error?.name === 'TaxMaintenanceError';
}

function invoiceDisplayId(inv) {
  const parts = [inv?.khhdon, inv?.shdon].filter(Boolean);
  return parts.length > 0 ? parts.join('-') : (inv?.id || 'không rõ số');
}

function createInvoiceFetchError(inv, formatLabel, response) {
  if (isRetryableEndpointFailure(response)) {
    return createCompletenessError(`${formatLabel} ${invoiceDisplayId(inv)} không tải được từ hệ thống thuế.`, response, INVOICE_RESOURCE_ERROR_MESSAGE);
  }
  return createCompletenessError(`Không tải được ${formatLabel} của hóa đơn ${invoiceDisplayId(inv)}. Vui lòng thử lại.`, response);
}

function decodeResponseText(response) {
  if (!response?.body) return '';
  try {
    return new TextDecoder('utf-8').decode(new Uint8Array(response.body));
  } catch (_) {
    return '';
  }
}

function responseMessage(response, fallback = '') {
  const text = decodeResponseText(response);
  if (!text) return fallback;
  try {
    const json = JSON.parse(text);
    return json.message || json.error || json.detail || fallback || text;
  } catch (_) {
    return text || fallback;
  }
}

function failureStatus(error) {
  if (typeof error === 'number') return error;
  return Number(error?.status ?? error?.cause?.status ?? error?.cause?.cause?.status);
}

function isRateLimitFailure(error) {
  return failureStatus(error) === 429;
}

function isBrowserThrottleError(error) {
  const message = normalizeSearchText(error?.message || error?.error || '');
  return message.includes('throttl')
    || message.includes('insufficient resources')
    || message.includes('err_insufficient_resources');
}

function isChromeThrottleResponse(response) {
  return Number(response?.status) === 0
    && (response?.browserThrottle || isBrowserThrottleError(response));
}

function normalizeSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\u0111/g, 'd')
    .replace(/\u0110/g, 'D')
    .toLowerCase();
}

function isMissingXmlMessage(message) {
  const normalized = normalizeSearchText(message);
  if (!normalized) return false;
  return normalized.includes('khong co du lieu xml')
    || normalized.includes('khong co file xml')
    || normalized.includes('khong tim thay xml')
    || normalized.includes('khong ton tai xml')
    || normalized.includes('khong ton tai ho so goc')
    || normalized.includes('khong tim thay ho so goc')
    || normalized.includes('khong co ho so goc')
    || normalized.includes('chua co xml')
    || normalized.includes('no xml')
    || normalized.includes('xml not found')
    || normalized.includes('xml does not exist');
}

function isExportXmlResource(resourcePath) {
  return String(resourcePath || '').startsWith('export-xml?');
}

function createAdaptiveRateLimiter(job, floorMs = RATE_ADAPTIVE_FLOOR_MS) {
  let floorMsRef = floorMs;
  let currentGapMs = floorMs;
  let softFloorMs = floorMs;
  let softSuccessCount = 0;
  let lastRequestAt = 0;
  let lastStepAt = 0;
  let quotaCooldownUntil = 0;
  let quotaCooldownCount = 0;
  let consecutive429Count = 0;
  let recent429At = [];
  let resourceRequestAt = [];
  let queue = Promise.resolve();

  const pruneResourceWindow = (now) => {
    resourceRequestAt = resourceRequestAt.filter(ts => now - ts < RATE_RESOURCE_WINDOW_MS);
  };

  const resourceWindowWaitUntil = (now) => {
    pruneResourceWindow(now);
    if (resourceRequestAt.length < RATE_RESOURCE_WINDOW_LIMIT) return 0;
    return resourceRequestAt[0] + RATE_RESOURCE_WINDOW_MS + 1;
  };

  const wait = async (waitJob = job, options = {}) => {
    const isResourceRequest = options.resource === true;
    const queued = queue
      .catch(() => {})
      .then(async () => {
        while (true) {
          throwIfStopped(waitJob);
          const now = Date.now();
          const jitter = 1 + ((Math.random() * 2 - 1) * RATE_JITTER_FACTOR);
          const actualGap = Math.max(0, Math.round(currentGapMs * jitter));
          const waitUntil = Math.max(
            lastRequestAt + actualGap,
            quotaCooldownUntil,
            isResourceRequest ? resourceWindowWaitUntil(now) : 0
          );
          const gap = waitUntil - now;
          if (gap <= 0) break;
          await delay(Math.min(gap, RATE_WAIT_RECHECK_MS), waitJob);
        }
        throwIfStopped(waitJob);
        lastRequestAt = Date.now();
        if (isResourceRequest) {
          pruneResourceWindow(lastRequestAt);
          resourceRequestAt.push(lastRequestAt);
        }
      });
    queue = queued.catch(() => {});
    return queued;
  };

  const on429 = () => {
    const now = Date.now();
    const alreadyCooling = now < quotaCooldownUntil;
    consecutive429Count += 1;
    recent429At.push(now);
    recent429At = recent429At.filter(ts => now - ts <= RATE_QUOTA_429_WINDOW_MS);
    if (currentGapMs >= RATE_BACKOFF_CAP_MS) {
      currentGapMs = currentGapMs + RATE_BACKOFF_LINEAR_STEP_MS;
    } else {
      currentGapMs = currentGapMs * RATE_BACKOFF_MULTIPLIER;
    }
    lastStepAt = now;
    if (!alreadyCooling && (consecutive429Count >= RATE_QUOTA_429_THRESHOLD || recent429At.length >= RATE_QUOTA_429_THRESHOLD)) {
      const cooldownMs = quotaCooldownCount > 0 ? RATE_QUOTA_REPEAT_COOLDOWN_MS : RATE_QUOTA_COOLDOWN_MS;
      quotaCooldownUntil = Math.max(quotaCooldownUntil, now + cooldownMs);
      quotaCooldownCount += 1;
      recent429At = [];
    }
  };

  const onSuccess = () => {
    const now = Date.now();
    consecutive429Count = 0;
    recent429At = [];
    quotaCooldownUntil = 0;
    quotaCooldownCount = 0;
    if (softFloorMs > floorMsRef) {
      softSuccessCount += 1;
      if (softSuccessCount >= RATE_SOFT_BACKOFF_RECOVER_SUCCESS_COUNT) {
        softFloorMs = Math.max(floorMsRef, softFloorMs - RATE_SOFT_BACKOFF_RECOVERY_STEP_MS);
        softSuccessCount = 0;
      }
    }
    if (currentGapMs > floorMsRef && now - lastStepAt >= RATE_RECOVER_AFTER_MS) {
      currentGapMs = Math.max(floorMsRef, softFloorMs, Math.round(currentGapMs / RATE_RECOVERY_DIVISOR));
      lastStepAt = now;
    }
  };

  const onSoftBackoff = (targetMs = RATE_XML_MISSING_SOFT_BACKOFF_MS) => {
    const now = Date.now();
    const nextSoftFloorMs = Math.max(floorMsRef, targetMs);
    softFloorMs = Math.max(softFloorMs, nextSoftFloorMs);
    softSuccessCount = 0;
    if (currentGapMs < softFloorMs) {
      currentGapMs = softFloorMs;
      lastStepAt = now;
    }
  };

  const setFloor = (newFloorMs) => {
    floorMsRef = newFloorMs;
    if (softFloorMs < newFloorMs) softFloorMs = newFloorMs;
    if (currentGapMs < newFloorMs) currentGapMs = newFloorMs;
  };

  const reset = (newFloorMs = floorMsRef) => {
    floorMsRef = newFloorMs;
    currentGapMs = newFloorMs;
    softFloorMs = newFloorMs;
    softSuccessCount = 0;
    quotaCooldownUntil = 0;
    quotaCooldownCount = 0;
    consecutive429Count = 0;
    recent429At = [];
    resourceRequestAt = [];
    lastRequestAt = 0;
    lastStepAt = 0;
    queue = Promise.resolve();
  };

  const timeoutLog = [];
  const onTimeout = () => {
    const now = Date.now();
    timeoutLog.push(now);
    while (timeoutLog.length > 0 && now - timeoutLog[0] > RATE_TIMEOUT_WINDOW_MS) {
      timeoutLog.shift();
    }
    if (timeoutLog.length >= RATE_TIMEOUT_THRESHOLD) {
      timeoutLog.length = 0;
      on429();
    }
  };

  return {
    wait,
    on429,
    onSoftBackoff,
    onTimeout,
    onSuccess,
    setFloor,
    reset,
    currentGap: () => currentGapMs
  };
}

function resetGlobalRateLimiter(job, floorMs) {
  if (!job) return;
  job.invoiceTypeRateLimiters = null;
  job.rateLimiter?.reset(floorMs);
}

function rateLimiterForInvoiceType(job, invoiceType = '') {
  return job?.rateLimiter || null;
}

async function waitInvoiceApiRateLimit(job, invoiceType = '', options = {}) {
  await rateLimiterForInvoiceType(job, invoiceType)?.wait(job, options);
}

function rateLimitOn429(job, invoiceType = '') {
  rateLimiterForInvoiceType(job, invoiceType)?.on429();
}

function rateLimitOnSoftBackoff(job, invoiceType = '', targetMs = RATE_XML_MISSING_SOFT_BACKOFF_MS) {
  rateLimiterForInvoiceType(job, invoiceType)?.onSoftBackoff(targetMs);
}

function rateLimitOnTimeout(job, invoiceType = '') {
  rateLimiterForInvoiceType(job, invoiceType)?.onTimeout();
}

function rateLimitOnSuccess(job, invoiceType = '') {
  rateLimiterForInvoiceType(job, invoiceType)?.onSuccess();
}

function rateLimitCurrentGap(job, invoiceType = '') {
  return rateLimiterForInvoiceType(job, invoiceType)?.currentGap() || 0;
}

function shouldSkipXmlSilently(response, message) {
  const status = Number(response?.status);
  return status === 404
    || isMissingXmlMessage(message);
}

function extensionAssetUrl(path) {
  try {
    return chrome.runtime.getURL(path);
  } catch (_) {
    return path;
  }
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function waitForPdfGeneratorPort(timeoutMs = 10000) {
  if (pdfGeneratorPort) return Promise.resolve(pdfGeneratorPort);

  if (!pdfGeneratorPortReady) {
    pdfGeneratorPortReady = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (!pdfGeneratorPort) {
          resolvePdfGeneratorPortReady = null;
          pdfGeneratorPortReady = null;
          reject(new Error('Offscreen PDF renderer khong san sang.'));
        }
      }, timeoutMs);

      resolvePdfGeneratorPortReady = (port) => {
        clearTimeout(timeout);
        resolve(port);
      };
    });
  }

  return pdfGeneratorPortReady;
}

async function ensurePdfOffscreenDocument() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    throw new Error('Trình duyệt không hỗ trợ tính năng này.');
  }

  const documentUrl = chrome.runtime.getURL(PDF_OFFSCREEN_DOCUMENT);
  let contexts = [];

  if (chrome.runtime.getContexts) {
    contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [documentUrl]
    });
  }

  if (contexts.length > 0 && !pdfGeneratorPort) {
    try {
      await chrome.offscreen.closeDocument();
    } catch (_) {}
    contexts = [];
  }

  if (contexts.length === 0 && !pdfGeneratorPort) {
    try {
      await chrome.offscreen.createDocument({
        url: PDF_OFFSCREEN_DOCUMENT,
        reasons: ['DOM_PARSER', 'BLOBS'],
        justification: 'Generate invoice PDF files with pdfMake.'
      });
    } catch (err) {
      if (!String(err?.message || '').includes('Only a single offscreen document')) {
        throw err;
      }
    }
  }

  return waitForPdfGeneratorPort();
}

async function requestPdfBytesWithPdfMake(docDef) {
  const port = await ensurePdfOffscreenDocument();
  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pdfRenderRequests.delete(requestId);
      reject(new Error('Quá thời gian tạo PDF (pdfmake).'));
    }, 60000);

    pdfRenderRequests.set(requestId, { resolve, reject, timeout });

    try {
      port.postMessage({ type: 'GENERATE_PDF_PDFMAKE', requestId, docDef });
    } catch (err) {
      clearTimeout(timeout);
      pdfRenderRequests.delete(requestId);
      reject(err);
    }
  });
}

function renderPdfBytesWithPdfMake(docDef) {
  const queuedRender = pdfMakeRenderQueue.then(
    () => requestPdfBytesWithPdfMake(docDef),
    () => requestPdfBytesWithPdfMake(docDef)
  );
  pdfMakeRenderQueue = queuedRender.catch(() => {});
  return queuedRender;
}

function delay(ms, job) {
  throwIfStopped(job);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(createStoppedError());
    };
    job?.controller.signal.addEventListener('abort', onAbort, { once: true });
  });
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Extracts the JWT token from the page's Redux store.
 */
async function getToken(tabId) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        func: () => {
          try {
            return window.__NEXT_REDUX_STORE__.getState().authReducer.jwt;
          } catch (e) {
            return null;
          }
        }
      });
      return results?.[0]?.result || null;
    } catch (err) {
      const message = err?.message || '';
      if (attempt === maxAttempts) {
        console.error('[HoaDon] Failed to get token after retries:', err);
        return null;
      }
      if (message.includes('Frame with ID 0 was removed') || message.includes('No frame with id 0') || message.includes('Could not establish connection')) {
        await sleep(150);
        continue;
      }
      console.error('[HoaDon] Failed to get token:', err);
      return null;
    }
  }
  return null;
}

async function getLoggedInAccountInfo(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: () => {
        const TAX_CODE_RE = /^\d{10}(?:-\d{3})?$|^\d{13}$/;
        const TAX_CODE_ANY_RE = /\b\d{10}(?:-\d{3})?\b|\b\d{13}\b/g;
        const KEY_RE = /^(mst|maSoThue|ma_so_thue|taxCode|tax_code)$/i;
        const COMPANY_KEY_RE = /^(companyName|company_name|taxpayerName|taxpayer_name|taxPayerName|organizationName|organisationName|orgName|org_name|tenCongTy|ten_cong_ty|tenNnt|ten_nnt|tenNguoiNopThue|ten_nguoi_nop_thue)$/i;
        const GENERIC_NAME_KEY_RE = /^(name|ten)$/i;
        const COMPANY_HINT_RE = /(cong ty|công ty|cty|tnhh|co phan|cổ phần|doanh nghiep|doanh nghiệp|hop tac xa|hợp tác xã|chi nhanh|chi nhánh|van phong|văn phòng|trung tam|trung tâm)/i;
        const seen = new WeakSet();

        const normalizeTaxCode = (value) => {
          const text = String(value || '').trim();
          return TAX_CODE_RE.test(text) ? text : '';
        };

        const normalizeCompanyName = (value) => {
          let text = String(value || '').replace(/\s+/g, ' ').trim();
          text = text.replace(TAX_CODE_ANY_RE, '').replace(/\b(MST|ma so thue|tax code)\b\s*[:：-]?\s*/ig, '').trim();
          text = text.replace(/^(ten cong ty|ten nnt|ten nguoi nop thue|company|company name|taxpayer|taxpayer name)\s*[:：-]\s*/i, '').trim();
          if (!text || /^(null|undefined|true|false)$/i.test(text)) return '';
          if (normalizeTaxCode(text)) return '';
          return text.length > 160 ? text.slice(0, 160).trim() : text;
        };

        const findInValue = (value, depth = 0) => {
          if (depth > 6 || value == null) return { mst: '', companyName: '' };
          if (typeof value === 'string' || typeof value === 'number') {
            return { mst: normalizeTaxCode(value), companyName: '' };
          }
          if (typeof value !== 'object') return { mst: '', companyName: '' };
          if (seen.has(value)) return { mst: '', companyName: '' };
          seen.add(value);

          const entries = Array.isArray(value)
            ? value.map((item, index) => [String(index), item])
            : Object.entries(value);

          const result = { mst: '', companyName: '' };
          for (const [key, item] of entries) {
            if (KEY_RE.test(key)) {
              const match = normalizeTaxCode(item);
              if (match) result.mst = match;
            }
            if (COMPANY_KEY_RE.test(key)) {
              const match = normalizeCompanyName(item);
              if (match) result.companyName = match;
            }
          }

          if (!result.companyName) {
            for (const [key, item] of entries) {
              if (!GENERIC_NAME_KEY_RE.test(key)) continue;
              const match = normalizeCompanyName(item);
              if (match && COMPANY_HINT_RE.test(match)) {
                result.companyName = match;
                break;
              }
            }
          }

          if (result.mst && result.companyName) return result;
          for (const [, item] of entries) {
            const match = findInValue(item, depth + 1);
            if (!result.mst && match.mst) result.mst = match.mst;
            if (!result.companyName && match.companyName) result.companyName = match.companyName;
            if (result.mst && result.companyName) return result;
          }
          return result;
        };

        const parseStorageValue = (value) => {
          const text = String(value || '').trim();
          if (!text) return null;
          try {
            return JSON.parse(text);
          } catch (_) {
            return text;
          }
        };

        const mergeInfo = (base, next) => ({
          mst: base.mst || next.mst || '',
          companyName: base.companyName || next.companyName || ''
        });

        const findCompanyNameInDom = () => {
          const selectors = [
            '.user-info',
            '#user-name',
            '[class*="user"]',
            '[id*="user"]',
            '[class*="account"]',
            '[id*="account"]',
            '[class*="company"]',
            '[id*="company"]',
            '[class*="taxpayer"]',
            '[id*="taxpayer"]'
          ].join(',');
          try {
            for (const el of document.querySelectorAll(selectors)) {
              const lines = String(el.textContent || '').split(/[\n\r|]+/).map(normalizeCompanyName).filter(Boolean);
              const match = lines.find(line => COMPANY_HINT_RE.test(line));
              if (match) return match;
            }
          } catch (_) {}
          return '';
        };

        let info = { mst: '', companyName: '' };
        try {
          const state = window.__NEXT_REDUX_STORE__?.getState?.();
          info = mergeInfo(info, findInValue(state));
          if (info.mst && info.companyName) return info;
        } catch (_) {}

        for (const storage of [window.localStorage, window.sessionStorage]) {
          try {
            for (let index = 0; index < storage.length; index += 1) {
              const key = storage.key(index);
              const raw = storage.getItem(key);
              const directMatch = KEY_RE.test(String(key || '')) ? normalizeTaxCode(raw) : '';
              if (directMatch) info.mst = info.mst || directMatch;
              if (COMPANY_KEY_RE.test(String(key || ''))) info.companyName = info.companyName || normalizeCompanyName(raw);
              info = mergeInfo(info, findInValue(parseStorageValue(raw)));
              if (info.mst && info.companyName) return info;
            }
          } catch (_) {}
        }

        info.companyName = info.companyName || findCompanyNameInDom();
        return info;
      }
    });
    const result = results?.[0]?.result;
    return result && typeof result === 'object' ? result : { mst: '', companyName: '' };
  } catch (err) {
    console.warn('[HoaDon] Failed to get logged-in account info:', err);
    return { mst: '', companyName: '' };
  }
}

async function getLoggedInMst(tabId) {
  const info = await getLoggedInAccountInfo(tabId);
  return info.mst || '';
}

/**
 * Main workflow for downloading invoices.
 */
async function handleDownloadWorkflow(tabId, params, job) {
  const invoiceTypes = normalizeInvoiceTypes(params || {});
  if (!params || !params.mode || invoiceTypes.length === 0 || !params.fromDate || !params.toDate) {
    safeSendMessage(tabId, { type: 'ERROR', message: 'Tham số yêu cầu không hợp lệ.' });
    return;
  }
  const normalizedParams = {
    ...params,
    invoiceType: invoiceTypes[0],
    invoiceTypes
  };
  const { mode, formats } = normalizedParams;

  try {
    const token = await getToken(tabId);
    throwIfStopped(job);

    if (!token) {
      safeSendMessage(tabId, { type: 'ERROR', message: LOGIN_ACCOUNT_ERROR_MESSAGE });
      return;
    }

    safeSendMessage(tabId, { type: 'PROGRESS', percent: 8, message: 'Đang lấy danh sách hoá đơn...' });
    const accountKey = getAccountKeyFromToken(token) || 'unknown';
    job.accountKey = accountKey;
    resetGlobalRateLimiter(job, RATE_LIST_FLOOR_MS);
    await clearResumeSession(null, accountKey);
    const listResult = await fetchAllInvoicesResumable(tabId, token, { ...normalizedParams, formats: formats || [] }, job);
    const invoices = listResult.invoices;
    resetGlobalRateLimiter(job, RATE_ADAPTIVE_FLOOR_MS);
    throwIfStopped(job);

    if (invoices.length === 0) {
      await clearResumeSession(listResult.session?.jobId, accountKey);
      safeSendMessage(tabId, { type: 'NOTIFY', message: 'Không tìm thấy hoá đơn nào trong khoảng thời gian này.' });
      return;
    }

    safeSendMessage(tabId, { type: 'PROGRESS', percent: 20, message: `Tìm thấy ${invoiceCountSummary(invoices, normalizedParams)}. Bắt đầu tải tệp...` });
    const downloadSession = convertListSessionToDownloadSession(listResult.session, invoices, token);
    await saveResumeSession(downloadSession);
    await sendResumeSessionState(tabId, accountKey);
    throwIfStopped(job);

    if (mode === 'invoices') {
      await downloadInvoicesBatch(tabId, token, invoices, formats, normalizedParams, job, downloadSession);
    }

  } catch (err) {
    if (isStoppedError(err)) {
      await pauseResumeSession(job.accountKey);
      safeSendMessage(tabId, { type: 'STOPPED' });
      sendResumeSessionState(tabId, job.accountKey);
      return;
    }
    console.error('[HoaDon] Workflow error:', err);
    safeSendMessage(tabId, { type: 'ERROR', message: err.userMessage || err.message });
    sendResumeSessionState(tabId, job.accountKey);
  }
}

async function handleResumeDownloadWorkflow(tabId, job) {
  try {
    const resumeToken = await getToken(tabId);
    throwIfStopped(job);
    if (!resumeToken) {
      safeSendMessage(tabId, { type: 'ERROR', message: LOGIN_ACCOUNT_ERROR_MESSAGE });
      return;
    }
    const accountKey = getAccountKeyFromToken(resumeToken) || 'unknown';
    job.accountKey = accountKey;

    const session = await loadResumeSession(accountKey);
    if (!session?.jobId || (session.phase !== 'list' && (!Array.isArray(session.items) || session.items.length === 0))) {
      safeSendMessage(tabId, { type: 'ERROR', message: 'Không có phiên tải nào để tiếp tục.' });
      return;
    }

    const token = resumeToken;
    throwIfStopped(job);
    if (!token) {
      safeSendMessage(tabId, { type: 'ERROR', message: LOGIN_ACCOUNT_ERROR_MESSAGE });
      return;
    }

    if (session.phase === 'list') {
      const summary = summarizeResumeSession(session);
      resetGlobalRateLimiter(job, RATE_LIST_FLOOR_MS);
      safeSendMessage(tabId, {
        type: 'PROGRESS',
        percent: 8,
        message: `\u0110ang ti\u1ebfp t\u1ee5c qu\u00e9t ${summary.completed}/${summary.total} th\u00e1ng...`
      });
      const listResult = await fetchAllInvoicesResumable(tabId, token, session.params || {}, job, session);
      const invoices = listResult.invoices;
      resetGlobalRateLimiter(job, RATE_ADAPTIVE_FLOOR_MS);
      throwIfStopped(job);
      if (invoices.length === 0) {
        await clearResumeSession(listResult.session?.jobId, accountKey);
        safeSendMessage(tabId, { type: 'NOTIFY', message: 'Kh\u00f4ng t\u00ecm th\u1ea5y h\u00f3a \u0111\u01a1n n\u00e0o trong kho\u1ea3ng th\u1eddi gian n\u00e0y.' });
        return;
      }
      const downloadSession = convertListSessionToDownloadSession(listResult.session, invoices, token);
      await saveResumeSession(downloadSession);
      await sendResumeSessionState(tabId, accountKey);
      safeSendMessage(tabId, { type: 'PROGRESS', percent: 20, message: `Tìm thấy ${invoiceCountSummary(invoices, listResult.session?.params || session.params || {})}. Bắt đầu tải tệp...` });
      await downloadInvoicesBatch(tabId, token, invoices, downloadSession.formats || downloadSession.params?.formats || [], downloadSession.params || {}, job, downloadSession);
      return;
    }

    const summary = summarizeResumeSession(session);
    safeSendMessage(tabId, {
      type: 'PROGRESS',
      percent: 20,
      message: `Tiếp tục tải ${summary.completed}/${summary.total} hoá đơn...`
    });
    const invoices = session.items.map(item => item.invoice).filter(Boolean);
    await downloadInvoicesBatch(tabId, token, invoices, session.formats || session.params?.formats || [], session.params || {}, job, session);
  } catch (err) {
    if (isStoppedError(err)) {
      await pauseResumeSession(job.accountKey);
      safeSendMessage(tabId, { type: 'STOPPED' });
      sendResumeSessionState(tabId, job.accountKey);
      return;
    }
    console.error('[HoaDon] Resume workflow error:', err);
    safeSendMessage(tabId, { type: 'ERROR', message: err.userMessage || err.message });
    sendResumeSessionState(tabId, job.accountKey);
  }
}

/**
 * Helper to make API requests directly from the background script.
 * @param {string} returnType - 'text' or 'arraybuffer'
 */
async function makeRequest(url, token, action, returnType = 'text', job, endPoint = SEARCH_END_POINT, options = {}) {
  let retries = 0;
  const maxRetries = Number.isInteger(options.maxRetries) ? Math.max(0, options.maxRetries) : 2;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 0;
  const deferRateLimit = options.deferRateLimit === true;

  while (retries <= maxRetries) {
    throwIfStopped(job);
    let timeoutId = null;
    let waitNoticeId = null;
    let removeAbortForwarder = null;
    let timedOut = false;
    try {
      if (typeof options.beforeAttempt === 'function') {
        await options.beforeAttempt(job, retries);
      }
      const headers = {
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'vi',
        'Authorization': 'Bearer ' + token,
        'Referer': `https://hoadondientu.gdt.gov.vn${endPoint || SEARCH_END_POINT}`
      };
      if (action) headers['Action'] = encodeURIComponent(action);
      if (endPoint) headers['End-Point'] = endPoint;

      let signal = job?.controller.signal;
      if (timeoutMs > 0) {
        const requestController = new AbortController();
        signal = requestController.signal;
        timeoutId = setTimeout(() => {
          timedOut = true;
          requestController.abort();
        }, timeoutMs);
        if (typeof options.onLongWait === 'function') {
          waitNoticeId = setTimeout(() => options.onLongWait(), options.longWaitMs ?? Math.min(8000, Math.max(1000, timeoutMs - 1000)));
        }

        if (job?.controller.signal) {
          const onJobAbort = () => requestController.abort();
          if (job.controller.signal.aborted) throw createStoppedError();
          job.controller.signal.addEventListener('abort', onJobAbort, { once: true });
          removeAbortForwarder = () => job.controller.signal.removeEventListener('abort', onJobAbort);
        }
      }

      const response = await fetch(url, { method: 'GET', headers: headers, signal });
      if (timeoutId) clearTimeout(timeoutId);
      if (waitNoticeId) clearTimeout(waitNoticeId);
      if (removeAbortForwarder) removeAbortForwarder();
      if (response.status === 429 && deferRateLimit) {
        const body = returnType === 'arraybuffer'
          ? await response.arrayBuffer()
          : await response.text();
        return { ok: false, status: response.status, body };
      }

      if (response.status === 429 && retries < maxRetries) {
        if (typeof options.onRetryableStatus === 'function') {
          options.onRetryableStatus(response.status, retries);
        }
        await delay(1000 * (retries + 1) + Math.floor(Math.random() * 500), job);
        retries++;
        continue;
      }

      // Retry on 5xx server errors (e.g. Cassandra timeout from GDT), unless a
      // caller needs to inspect the body immediately for a business-level error.
      if (options.retryServerErrors !== false && response.status >= 500 && retries < maxRetries) {
        if (typeof options.onRetryableStatus === 'function') {
          options.onRetryableStatus(response.status, retries);
        }
        await delay(1000 * (retries + 1) + Math.floor(Math.random() * 500), job);
        retries++;
        continue;
      }

      const body = returnType === 'arraybuffer'
        ? await response.arrayBuffer()
        : await response.text();

      return { ok: response.ok, status: response.status, body };
    } catch (err) {
      if (timeoutId) clearTimeout(timeoutId);
      if (waitNoticeId) clearTimeout(waitNoticeId);
      if (removeAbortForwarder) removeAbortForwarder();
      if (isJobStopped(job) || (!timedOut && isStoppedError(err))) throw createStoppedError();
      if (retries < maxRetries && typeof options.onRetryableStatus === 'function') {
        options.onRetryableStatus(0, retries);
      }
      const errorMessage = timedOut ? `Timeout sau ${Math.round(timeoutMs / 1000)} giây` : (err.message || 'Network Error');
      if (deferRateLimit) {
        if (!timedOut && isBrowserThrottleError(err)) {
          return { ok: false, status: 0, error: errorMessage, browserThrottle: true };
        }
        return { ok: false, status: 0, error: errorMessage, timedOut };
      }
      if (retries === maxRetries) return { ok: false, status: 0, error: errorMessage, timedOut };
      await delay(1000, job);
      retries++;
    }
  }
  return { ok: false, status: 0, error: 'Max retries exceeded' };
}

function toVnDateTime(dateStr, isEnd) {
  // Parse date string and format as VN format (dd/mm/yyyy) without timezone conversion
  let day, month, year;
  const value = String(dateStr || '');
  
  if (value.includes('-')) {
    // ISO format: YYYY-MM-DD
    const parts = value.split('-');
    year = parts[0];
    month = parts[1];
    day = parts[2];
  } else if (value.includes('/')) {
    // VN format: DD/MM/YYYY
    const parts = value.split('/');
    day = parts[0];
    month = parts[1];
    year = parts[2];
  } else {
    return value;
  }
  
  const time = isEnd ? 'T23:59:59' : 'T00:00:00';
  return `${day}/${month}/${year}${time}`;
}

function buildInvoiceSearch(fromDate, toDate, isCancelled, isAdjustment, extraFilters = []) {
  const searchPredicates = [
    `tdlap=ge=${toVnDateTime(fromDate, false)}`,
    `tdlap=le=${toVnDateTime(toDate, true)}`
  ];

  if (isCancelled) {
    searchPredicates.push('trthhd==6');
  }

  if (isAdjustment) {
    searchPredicates.push('trthhd=in=(2,3,4,5,6)');
  }

  extraFilters.forEach(filter => {
    if (filter) searchPredicates.push(filter);
  });

  return searchPredicates.join(';');
}

function invoiceListKey(inv) {
  if (!inv) return '';
  const core = [
    inv.nbmst || '',
    inv.khmshdon || '',
    inv.khhdon || '',
    inv.shdon || ''
  ];
  if (core.some(Boolean)) return core.join('|');

  return [
    inv.id || '',
    inv.mttcqt || '',
    inv.mtdtchieu || '',
    inv.tdlap || ''
  ].join('|');
}

function invoiceDirectionalListKey(inv, fallback = '') {
  const key = invoiceListKey(inv) || fallback || '';
  if (!key) return '';
  const invoiceType = normalizeInvoiceType(inv?.__hdInvoiceType);
  return invoiceType ? `${invoiceType}|${key}` : key;
}

function invoiceDateYmd(value) {
  if (isBlankValue(value)) return null;
  const raw = String(value).trim();

  const isoDateTimeWithZone = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})T.*(?:Z|[+-]\d{2}:?\d{2})$/i);
  if (isoDateTimeWithZone) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      const vietnamTime = new Date(parsed.getTime() + 7 * 60 * 60 * 1000);
      return [
        vietnamTime.getUTCFullYear(),
        String(vietnamTime.getUTCMonth() + 1).padStart(2, '0'),
        String(vietnamTime.getUTCDate()).padStart(2, '0')
      ].join('-');
    }
  }

  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) {
    return `${dmy[3]}-${String(dmy[2]).padStart(2, '0')}-${String(dmy[1]).padStart(2, '0')}`;
  }

  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) {
    return `${ymd[1]}-${String(ymd[2]).padStart(2, '0')}-${String(ymd[3]).padStart(2, '0')}`;
  }

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const vietnamTime = new Date(parsed.getTime() + 7 * 60 * 60 * 1000);
    return [
      vietnamTime.getUTCFullYear(),
      String(vietnamTime.getUTCMonth() + 1).padStart(2, '0'),
      String(vietnamTime.getUTCDate()).padStart(2, '0')
    ].join('-');
  }
  return null;
}

function filterInvoicesByDateRange(invoices, fromDate, toDate) {
  const fromYmd = invoiceDateYmd(fromDate);
  const toYmd = invoiceDateYmd(toDate);
  if (!fromYmd || !toYmd) return invoices;

  return (invoices || []).filter(inv => {
    const invYmd = invoiceDateYmd(inv?.tdlap);
    return !invYmd || (invYmd >= fromYmd && invYmd <= toYmd);
  });
}

function ymdParts(value) {
  const ymd = invoiceDateYmd(value);
  const match = ymd?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3])
  };
}

function formatYmdParts(parts) {
  return [
    String(parts.year).padStart(4, '0'),
    String(parts.month).padStart(2, '0'),
    String(parts.day).padStart(2, '0')
  ].join('-');
}

function daysInMonth(year, month) {
  return new Date(year, month, 0).getDate();
}

function nextCalendarDay(parts) {
  const lastDay = daysInMonth(parts.year, parts.month);
  if (parts.day < lastDay) {
    return { year: parts.year, month: parts.month, day: parts.day + 1 };
  }
  if (parts.month < 12) {
    return { year: parts.year, month: parts.month + 1, day: 1 };
  }
  return { year: parts.year + 1, month: 1, day: 1 };
}

function splitDateRangeByCalendarMonth(fromDate, toDate) {
  const from = ymdParts(fromDate);
  const to = ymdParts(toDate);
  if (!from || !to) return [{ fromDate, toDate }];

  const toYmd = formatYmdParts(to);
  if (formatYmdParts(from) > toYmd) return [{ fromDate, toDate }];

  const ranges = [];
  let cursor = from;
  while (formatYmdParts(cursor) <= toYmd) {
    const monthEnd = {
      year: cursor.year,
      month: cursor.month,
      day: daysInMonth(cursor.year, cursor.month)
    };
    const monthEndYmd = formatYmdParts(monthEnd);
    const end = monthEndYmd < toYmd ? monthEnd : to;
    ranges.push({
      fromDate: formatYmdParts(cursor),
      toDate: formatYmdParts(end)
    });
    cursor = nextCalendarDay(end);
  }

  return ranges;
}

function tagInvoiceSource(inv, family, variant, invoiceType) {
  if (!inv || typeof inv !== 'object') return inv;
  try {
    Object.defineProperties(inv, {
      __hdInvoiceType: { value: normalizeInvoiceType(invoiceType) || 'purchase', enumerable: false, configurable: true },
      __hdQueryPrefix: { value: family.prefix, enumerable: false, configurable: true },
      __hdQueryFamily: { value: family.key, enumerable: false, configurable: true },
      __hdQueryVariant: { value: variant?.key || 'all', enumerable: false, configurable: true }
    });
  } catch (_) {
    inv.__hdInvoiceType = normalizeInvoiceType(invoiceType) || 'purchase';
    inv.__hdQueryPrefix = family.prefix;
    inv.__hdQueryFamily = family.key;
    inv.__hdQueryVariant = variant?.key || 'all';
  }
  return inv;
}

function invoiceListRequestOptions(tabId, family, invoiceType = '') {
  const options = {
    longWaitMs: 3000,
    timeoutMs: INVOICE_LIST_TIMEOUT_MS,
    maxRetries: INVOICE_LIST_MAX_RETRIES,
    beforeAttempt: (job) => waitInvoiceApiRateLimit(job, invoiceType)
  };
  return options;
}

function invoiceResourceRequestOptions() {
  return {
    timeoutMs: INVOICE_RESOURCE_TIMEOUT_MS,
    maxRetries: 0,
    deferRateLimit: true,
    retryServerErrors: false
  };
}

function isRetryableEndpointFailure(error) {
  const status = failureStatus(error);
  return status === 0 || status === 429 || status >= 500;
}

function mergeInvoiceLists(groups) {
  const map = new Map();
  groups.flat().forEach(inv => {
    const key = invoiceDirectionalListKey(inv);
    if (!key) return;
    if (!map.has(key)) {
      map.set(key, inv);
      return;
    }

    const current = map.get(key);
    if (!current?.__hdQueryPrefix && inv?.__hdQueryPrefix) {
      map.set(key, inv);
    }
  });
  return Array.from(map.values());
}

function endpointTypeForInvoiceType(type) {
  return type === 'sold' ? 'sold' : 'purchase';
}

function normalizeInvoiceType(type) {
  return type === 'sold' ? 'sold' : (type === 'purchase' ? 'purchase' : '');
}

function normalizeInvoiceTypes(params) {
  const source = Array.isArray(params?.invoiceTypes)
    ? params.invoiceTypes
    : [params?.invoiceType || 'purchase'];
  const seen = new Set();
  const types = source
    .map(normalizeInvoiceType)
    .filter(Boolean)
    .filter(type => {
      if (seen.has(type)) return false;
      seen.add(type);
      return true;
    });
  return types.length > 0 ? types : [normalizeInvoiceType(params?.invoiceType) || 'purchase'];
}

function invoiceTypeForInvoice(inv, params = {}) {
  return normalizeInvoiceType(inv?.__hdInvoiceType)
    || normalizeInvoiceType(params?.invoiceType)
    || normalizeInvoiceTypes(params)[0]
    || 'purchase';
}

function invoiceTypeShortLabel(type) {
  return type === 'sold' ? 'bán ra' : 'mua vào';
}

function invoiceTypeProgressLabel(type) {
  return `hóa đơn ${invoiceTypeShortLabel(type)}`;
}

function invoiceTypeFolderName(type) {
  return type === 'sold' ? 'BAN-RA' : 'MUA-VAO';
}

function invoiceTypesFileSlug(params) {
  const types = normalizeInvoiceTypes(params);
  return types.length > 1
    ? types.map(invoiceTypeFolderName).join('-')
    : invoiceTypeFolderName(types[0] || params?.invoiceType);
}

function invoiceTypesReportLabel(params) {
  const types = normalizeInvoiceTypes(params);
  if (types.length > 1) return 'Mua vào + Bán ra';
  return types[0] === 'sold' ? 'Bán ra' : 'Mua vào';
}

function invoiceCountSummary(invoices, params) {
  const list = Array.isArray(invoices) ? invoices : [];
  const types = normalizeInvoiceTypes(params);
  if (types.length <= 1) return `${list.length} hóa đơn`;
  return types
    .map(type => `${list.filter(inv => invoiceTypeForInvoice(inv, params) === type).length} ${invoiceTypeShortLabel(type)}`)
    .join(', ');
}

function invoiceTypeParams(params, type) {
  return {
    ...params,
    invoiceType: type,
    invoiceTypes: [type]
  };
}

function filterInvoicesForType(invoices, type, params) {
  return (Array.isArray(invoices) ? invoices : [])
    .filter(inv => invoiceTypeForInvoice(inv, params) === type);
}

function filterDetailsForType(details, type, params) {
  return (Array.isArray(details) ? details : [])
    .filter(entry => invoiceTypeForInvoice(entry?.header || entry?.detail || {}, params) === type);
}

function invoiceTypeOutputGroups(invoices, fullDetails, noXmlInvoices, params) {
  const types = normalizeInvoiceTypes(params);
  return types.map(type => ({
    type,
    slug: invoiceTypeFolderName(type),
    params: invoiceTypeParams(params, type),
    invoices: filterInvoicesForType(invoices, type, params),
    fullDetails: filterDetailsForType(fullDetails, type, params),
    noXmlInvoices: filterInvoicesForType(noXmlInvoices, type, params)
  }));
}

function invoiceOutputRoot(inv, invRoot, params) {
  if (normalizeInvoiceTypes(params).length <= 1) return invRoot;
  return `${invoiceTypeFolderName(invoiceTypeForInvoice(inv, params))}/${invRoot}`;
}

function variantsForListFamily(family, type) {
  const endpointType = endpointTypeForInvoiceType(type);
  const variants = family.searchVariants?.[endpointType] || [{ key: 'all', label: 'tat ca' }];
  const primaryVariant = variants.find(variant => variant.key === 'all') || null;
  return primaryVariant ? [primaryVariant] : variants;
}

function listTaskKey(invoiceType, dateRangeIndex, family, variant) {
  return [
    'list',
    invoiceType,
    dateRangeIndex,
    family.key,
    variant?.key || 'all'
  ].join(':');
}

function listPageArtifactKey(task, pageIndex) {
  return `listPage:${task.key}:${pageIndex}`;
}

function createListQueueTasks(types, dateRanges) {
  const tasks = [];
  const invoiceTypes = normalizeInvoiceTypes({ invoiceTypes: types });
  dateRanges.forEach((dateRange, dateRangeIndex) => {
    invoiceTypes.forEach(invoiceType => {
      INVOICE_QUERY_FAMILIES.forEach(family => {
        variantsForListFamily(family, invoiceType).forEach(variant => {
          tasks.push({
            key: listTaskKey(invoiceType, dateRangeIndex, family, variant),
            invoiceType,
            dateRangeIndex,
            familyKey: family.key,
            variantKey: variant?.key || 'all',
            fromDate: dateRange.fromDate,
            toDate: dateRange.toDate,
            state: 'queued',
            cursor: '',
            pageIndex: 0,
            loadedCount: 0,
            total: 0,
            lastStatus: 0,
            lastError: '',
            updatedAt: Date.now()
          });
        });
      });
    });
  });
  return tasks;
}

function normalizeListTask(task, index = 0, defaultInvoiceType = 'purchase') {
  return {
    key: task?.key || `list:legacy:${index}`,
    invoiceType: normalizeInvoiceType(task?.invoiceType) || defaultInvoiceType,
    dateRangeIndex: Math.max(0, Number(task?.dateRangeIndex) || 0),
    familyKey: task?.familyKey || 'standard',
    variantKey: task?.variantKey || 'all',
    fromDate: task?.fromDate || '',
    toDate: task?.toDate || '',
    state: task?.state === 'done' ? 'done' : 'queued',
    cursor: task?.state === 'done' ? '' : (task?.cursor || ''),
    pageIndex: Math.max(0, Number(task?.pageIndex) || 0),
    loadedCount: Math.max(0, Number(task?.loadedCount) || 0),
    total: Math.max(0, Number(task?.total) || 0),
    useSlowListLimiter: !!task?.useSlowListLimiter,
    lastStatus: Number(task?.lastStatus) || 0,
    lastError: task?.lastError || '',
    updatedAt: task?.updatedAt || Date.now()
  };
}

function hydrateListSession(session) {
  const list = session?.list || {};
  const dateRanges = Array.isArray(list.dateRanges) ? list.dateRanges : [];
  const invoiceTypes = normalizeInvoiceTypes(session?.params || {});
  const params = {
    ...(session?.params || {}),
    invoiceType: invoiceTypes[0] || 'purchase',
    invoiceTypes
  };
  return {
    ...session,
    params,
    phase: 'list',
    list: {
      ...list,
      dateRanges,
      totalMonths: Number(list.totalMonths) || dateRanges.length || 1,
      tasks: (Array.isArray(list.tasks) ? list.tasks : []).map((task, index) => normalizeListTask(task, index, params.invoiceType))
    }
  };
}

function createListSession(params, formats, accountKey) {
  const dateRanges = splitDateRangeByCalendarMonth(params.fromDate, params.toDate);
  const now = Date.now();
  const invoiceTypes = normalizeInvoiceTypes(params);
  const normalizedParams = {
    ...params,
    invoiceType: invoiceTypes[0] || 'purchase',
    invoiceTypes
  };
  return {
    version: 3,
    phase: 'list',
    jobId: createDownloadJobId(),
    accountKey: accountKey || 'unknown',
    params: { ...normalizedParams, formats: [...formats] },
    formats: [...formats],
    timeStamp: '',
    createdAt: now,
    updatedAt: now,
    total: dateRanges.length,
    list: {
      dateRanges,
      totalMonths: dateRanges.length,
      tasks: createListQueueTasks(invoiceTypes, dateRanges)
    }
  };
}

function findListTaskFamily(task) {
  return INVOICE_QUERY_FAMILIES.find(family => family.key === task.familyKey) || null;
}

function findListTaskVariant(family, type, task) {
  return variantsForListFamily(family, type).find(variant => (variant?.key || 'all') === task.variantKey) || null;
}

function listTaskFailureMessage(task) {
  const status = task?.lastStatus ? `HTTP ${task.lastStatus}` : '';
  const lastError = String(task?.lastError || '').trim();
  const errorText = /^Timeout sau \d+ giây$/i.test(lastError) ? '' : lastError;
  return [status, errorText].filter(Boolean).join(' - ');
}

async function putListPageArtifact(jobId, task, invoices) {
  const pageIndex = Math.max(0, Number(task.pageIndex) || 0);
  await putResumeArtifact(jobId, listPageArtifactKey(task, pageIndex), {
    kind: 'listPage',
    taskKey: task.key,
    pageIndex,
    dateRangeIndex: task.dateRangeIndex,
    invoices: (invoices || []).map(serializeInvoiceForResume)
  });
}

async function getListInvoicesFromArtifacts(jobId, fromDate, toDate) {
  const artifacts = await getResumeArtifacts(jobId, artifact => artifact.kind === 'listPage');
  const pages = artifacts
    .filter(artifact => artifact.kind === 'listPage' && Array.isArray(artifact.invoices))
    .sort((a, b) => {
      const taskCompare = String(a.taskKey || '').localeCompare(String(b.taskKey || ''));
      if (taskCompare !== 0) return taskCompare;
      return (Number(a.pageIndex) || 0) - (Number(b.pageIndex) || 0);
    });
  const groups = pages.map(page => page.invoices || []);
  return filterInvoicesByDateRange(mergeInvoiceLists(groups), fromDate, toDate);
}

function sendListProgress(tabId, session, job) {
  const stats = listSessionMonthStats(session);
  const tasks = Array.isArray(session.list?.tasks) ? session.list.tasks : [];
  const loadedCount = tasks.reduce((sum, task) => sum + (Number(task.loadedCount) || 0), 0);
  const completedTasks = tasks.filter(task => task.state === 'done').length;
  const taskTotal = Math.max(1, tasks.length);
  const percent = Math.round(8 + (completedTasks / taskTotal) * 12);
  const invoiceTypes = normalizeInvoiceTypes(session.params || {});
  const invoiceTypeLabel = invoiceTypes.map(invoiceTypeProgressLabel).join(' + ');
  const loadedByType = invoiceTypes
    .map(type => `${tasks
      .filter(task => (task.invoiceType || session.params?.invoiceType) === type)
      .reduce((sum, task) => sum + (Number(task.loadedCount) || 0), 0)} ${invoiceTypeShortLabel(type)}`)
    .join(', ');
  const foundText = invoiceTypes.length > 1 ? loadedByType : `${loadedCount} ${invoiceTypeLabel}`;
  job.percent = Math.max(job.percent || 0, percent);
  safeSendMessage(tabId, {
    type: 'PROGRESS',
    percent: job.percent,
    message: `Đã quét ${invoiceTypeLabel} ${stats.completed}/${stats.total} tháng, tìm thấy ${foundText}...`
  });
}

async function fetchInvoicesFromListSession(tabId, token, session, job) {
  const params = session.params || {};
  const defaultType = normalizeInvoiceTypes(params)[0] || 'purchase';
  const isCancelled = params.mode === 'cancelled';
  const isAdjustment = !!params.isAdjustment;
  const tasks = session.list?.tasks || [];

  let flushQueue = Promise.resolve();
  const flushSession = async () => {
    flushQueue = flushQueue.catch(() => {}).then(async () => {
      session.updatedAt = Date.now();
      await saveResumeSession(session);
    });
    return flushQueue;
  };

  await flushSession();
  await sendResumeSessionState(tabId, session.accountKey);
  sendListProgress(tabId, session, job);

  const processListTask = async (task) => {
    if (task.state === 'done') return;
    throwIfStopped(job);

    const family = findListTaskFamily(task);
    const type = normalizeInvoiceType(task.invoiceType) || defaultType;
    const variant = family ? findListTaskVariant(family, type, task) : null;
    if (!family || !variant) {
      task.state = 'done';
      task.lastStatus = 0;
      task.lastError = '';
      task.updatedAt = Date.now();
      await flushSession();
      return;
    }

    const endpointType = endpointTypeForInvoiceType(type);
    const endpoint = `${family.prefix}/invoices/${endpointType}`;
    const actionHeader = family.actions?.[endpointType] || (type === 'sold' ? 'Tim kiem hoa don ban ra' : 'Tim kiem hoa don mua vao');
    const sort = 'tdlap:desc';
    const search = buildInvoiceSearch(task.fromDate, task.toDate, isCancelled, isAdjustment, variant.filters || []);

    while (task.state !== 'done') {
      throwIfStopped(job);
      const url = `${BASE_URL}${endpoint}?sort=${sort}&size=${PAGE_SIZE}&search=${encodeURIComponent(search)}${task.cursor ? `&state=${encodeURIComponent(task.cursor)}` : ''}`;
      const response = await makeRequest(url, token, actionHeader, 'arraybuffer', job, SEARCH_END_POINT, invoiceListRequestOptions(tabId, family, type));

      if (response.status === 429) {
        rateLimitOn429(job, type);
        task.lastStatus = response.status;
        task.lastError = responseMessage(response, 'Rate limited');
        task.updatedAt = Date.now();
        await flushSession();
        await sendResumeSessionState(tabId, session.accountKey);
        continue;
      }

      if (response.ok) {
        rateLimitOnSuccess(job, type);
      }

      if (!response.ok) {
        if (response.timedOut) rateLimitOnTimeout(job, type);
        let errorMsg = 'Unknown';
        try {
          const errText = new TextDecoder('utf-8').decode(new Uint8Array(response.body));
          const errJson = JSON.parse(errText);
          errorMsg = errJson.message || errJson.error || errText;
        } catch (e) {
          errorMsg = response.error || 'Internal Server Error';
        }
        // GDT returns 500 "Search with keywords ... is invalid" for empty
        // results on certain filter combinations (for example trthhd + ttxly).
        if (response.status === 500 && typeof errorMsg === 'string' && errorMsg.includes('is invalid')) {
          task.state = 'done';
          task.lastStatus = 500;
          task.lastError = errorMsg;
          task.updatedAt = Date.now();
          await flushSession();
          break;
        }
        task.lastStatus = response.status;
        task.lastError = errorMsg;
        task.updatedAt = Date.now();
        await flushSession();
        await sendResumeSessionState(tabId, session.accountKey);
        const failureDetail = listTaskFailureMessage(task);
        const error = new Error(`Lỗi quét danh sách ${family.label}. Đã lưu tiến độ quét, bấm Tiếp tục để quét tiếp.${failureDetail ? ` ${failureDetail}` : ''}`);
        error.status = response.status;
        error.family = family.key;
        throw error;
      }

      let data;
      try {
        const jsonText = new TextDecoder('utf-8').decode(new Uint8Array(response.body));
        data = JSON.parse(jsonText);
      } catch (parseErr) {
        task.lastStatus = 0;
        task.lastError = parseErr.message || 'Parse error';
        task.updatedAt = Date.now();
        await flushSession();
        throw createCompletenessError(`Không thể phân tích phản hồi ${family.key}. Đã lưu tiến độ quét, bấm Tiếp tục để thử lại.`, parseErr);
      }

      const datas = Array.isArray(data.datas) ? data.datas : [];
      datas.forEach(inv => tagInvoiceSource(inv, family, variant, type));
      await putListPageArtifact(session.jobId, task, datas);

      task.loadedCount += datas.length;
      task.total = Number(data.total) || task.total || task.loadedCount;

      const previousState = task.cursor || '';
      const nextState = data.state || '';
      const moreByTotal = Number.isFinite(Number(data.total)) && Number(data.total) > 0 && task.loadedCount < Number(data.total);
      const hasMore = datas.length > 0 && !!nextState && nextState !== previousState && (datas.length === PAGE_SIZE || moreByTotal);

      task.cursor = hasMore ? nextState : '';
      task.pageIndex += 1;
      task.lastStatus = 0;
      task.lastError = '';
      task.updatedAt = Date.now();
      if (!hasMore) task.state = 'done';
      await flushSession();
      sendListProgress(tabId, session, job);
    }
  };

  for (const task of tasks) {
    await processListTask(task);
  }

  await flushQueue.catch(() => {});
  return getListInvoicesFromArtifacts(session.jobId, params.fromDate, params.toDate);
}

function convertListSessionToDownloadSession(session, invoices, token) {
  const params = session.params || {};
  const formats = session.formats || params.formats || [];
  const queueInvoices = Array.isArray(invoices) ? invoices : [];
  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mnt = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return {
    ...session,
    phase: 'download',
    accountKey: session.accountKey || getAccountKeyFromToken(token) || 'unknown',
    params: { ...params, formats: [...formats] },
    formats: [...formats],
    timeStamp: session.timeStamp || `${yy}${mm}${dd}-${hh}${mnt}${ss}`,
    updatedAt: Date.now(),
    total: queueInvoices.length,
    items: createDownloadQueueItems(queueInvoices)
  };
}

async function fetchAllInvoicesResumable(tabId, token, params, job, existingSession = null) {
  const formats = Array.isArray(params.formats) ? params.formats : [];
  const accountKey = existingSession?.accountKey || job.accountKey || getAccountKeyFromToken(token) || 'unknown';
  const session = existingSession?.phase === 'list'
    ? hydrateListSession({ ...existingSession, accountKey })
    : createListSession(params, formats, accountKey);
  job.accountKey = accountKey;
  await saveResumeSession(session);
  const invoices = await fetchInvoicesFromListSession(tabId, token, session, job);
  return {
    session,
    invoices
  };
}


function invoiceRequestPrefixes(inv) {
  const knownPrefixes = INVOICE_QUERY_FAMILIES.map(family => family.prefix);
  if (knownPrefixes.includes(inv?.__hdQueryPrefix)) {
    return [inv.__hdQueryPrefix];
  }
  return ['/query', ...knownPrefixes.filter(prefix => prefix !== '/query')];
}

async function makeInvoiceResourceRequest(inv, token, resourcePath, action, returnType, job) {
  let firstFailure = null;
  const invoiceType = invoiceTypeForInvoice(inv);

  for (const prefix of invoiceRequestPrefixes(inv)) {
    throwIfStopped(job);
    await waitInvoiceApiRateLimit(job, invoiceType, { resource: true });
    const endpointOptions = invoiceResourceRequestOptions();
    const response = await makeRequest(
      `${BASE_URL}${prefix}/invoices/${resourcePath}`,
      token,
      action,
      returnType,
      job,
      SEARCH_END_POINT,
      endpointOptions
    );
    if (response.ok) return response;
    if (isRateLimitFailure(response)) return response;
    if (isChromeThrottleResponse(response)) return response;
    if (isExportXmlResource(resourcePath) && shouldSkipXmlSilently(response, responseMessage(response))) {
      return response;
    }
    if (!firstFailure) firstFailure = response;
  }

  return firstFailure || { ok: false, status: 0, error: 'No invoice endpoint tried' };
}

function getDownloadConcurrency() {
  return 3;
}

async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const CHUNK = 8192;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function runWorkerPool(items, concurrency, worker, job) {
  const total = items.length;
  const workerCount = Math.max(1, Math.min(concurrency, total));
  let nextIndex = 0;
  let firstError = null;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      if (firstError) return;
      try {
        throwIfStopped(job);
        const index = nextIndex;
        nextIndex += 1;
        if (index >= total) return;
        await worker(items[index], index);
      } catch (error) {
        if (!firstError && !isStoppedError(error)) {
          firstError = error;
          job?.controller?.abort();
        }
        if (firstError) return;
        throw error;
      }
    }
  });

  await Promise.all(workers);
  if (firstError) throw firstError;
}

function createDownloadJobId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function serializeInvoiceForResume(inv) {
  return {
    ...inv,
    __hdInvoiceType: inv?.__hdInvoiceType || '',
    __hdQueryPrefix: inv?.__hdQueryPrefix || '',
    __hdQueryFamily: inv?.__hdQueryFamily || '',
    __hdQueryVariant: inv?.__hdQueryVariant || ''
  };
}

function invoiceQueueKey(inv, fallback = '') {
  return invoiceDirectionalListKey(inv, fallback);
}

function normalizeResumeItemState(state) {
  if (state === 'detail_pending' || state === 'xml_pending' || state === 'retry_pending' || state === 'mst_deferred') return 'queued';
  if (state === 'done' || state === 'xml_missing' || state === 'failed') return state;
  return 'queued';
}

function downloadItemStateRank(state) {
  if (state === 'done') return 5;
  if (state === 'xml_missing') return 4;
  if (state === 'queued') return 3;
  if (state === 'failed') return 2;
  return 1;
}

function createQueueItem(inv, key) {
  const baseKey = invoiceListKey(inv);
  return {
    key,
    legacyKeys: baseKey && baseKey !== key ? [baseKey] : [],
    invoice: serializeInvoiceForResume(inv),
    state: 'queued',
    detailAttempts: 0,
    xmlAttempts: 0,
    lastStatus: 0,
    lastError: '',
    updatedAt: Date.now()
  };
}

function normalizeDownloadQueueItem(item, index) {
  const invoice = serializeInvoiceForResume(item?.invoice || {});
  const fallbackKey = item?.key || `invoice|${index}`;
  const stableKey = invoiceQueueKey(invoice, fallbackKey);
  const legacyKeys = new Set(Array.isArray(item?.legacyKeys) ? item.legacyKeys.filter(Boolean) : []);
  if (item?.key && item.key !== stableKey) legacyKeys.add(item.key);
  const baseKey = invoiceListKey(invoice);
  if (baseKey && baseKey !== stableKey) legacyKeys.add(baseKey);
  return {
    key: stableKey,
    legacyKeys: [...legacyKeys],
    invoice,
    state: normalizeResumeItemState(item?.state),
    detailAttempts: Math.max(0, Number(item?.detailAttempts) || 0),
    xmlAttempts: Math.max(0, Number(item?.xmlAttempts) || 0),
    lastStatus: Number(item?.lastStatus) || 0,
    lastError: item?.lastError || '',
    updatedAt: item?.updatedAt || Date.now()
  };
}

function mergeDownloadQueueItem(existing, next) {
  const legacyKeys = new Set([...(existing.legacyKeys || []), ...(next.legacyKeys || [])]);
  if (next.key && next.key !== existing.key) legacyKeys.add(next.key);
  existing.legacyKeys = [...legacyKeys];
  existing.detailAttempts = Math.max(existing.detailAttempts || 0, next.detailAttempts || 0);
  existing.xmlAttempts = Math.max(existing.xmlAttempts || 0, next.xmlAttempts || 0);
  if (downloadItemStateRank(next.state) > downloadItemStateRank(existing.state)) {
    existing.state = next.state;
    existing.lastStatus = next.lastStatus;
    existing.lastError = next.lastError;
  } else if (!existing.lastError && next.lastError) {
    existing.lastStatus = next.lastStatus;
    existing.lastError = next.lastError;
  }
  existing.updatedAt = Math.max(Number(existing.updatedAt) || 0, Number(next.updatedAt) || 0) || Date.now();
  return existing;
}

function createDownloadQueueItems(invoices) {
  const map = new Map();
  invoices.forEach((inv, index) => {
    const key = invoiceQueueKey(inv, `invoice|${index}`);
    if (!map.has(key)) {
      map.set(key, createQueueItem(inv, key));
    }
  });
  return Array.from(map.values());
}

function hydrateDownloadQueueItems(items) {
  const map = new Map();
  (items || []).forEach((item, index) => {
    const normalized = normalizeDownloadQueueItem(item, index);
    if (!map.has(normalized.key)) {
      map.set(normalized.key, normalized);
    } else {
      mergeDownloadQueueItem(map.get(normalized.key), normalized);
    }
  });
  return Array.from(map.values());
}

function createDownloadSession(params, formats, queueInvoices, timeStamp, accountKey) {
  const items = createDownloadQueueItems(queueInvoices);
  const now = Date.now();
  return {
    version: 1,
    jobId: createDownloadJobId(),
    accountKey: accountKey || 'unknown',
    params: { ...params, formats: [...formats] },
    formats: [...formats],
    timeStamp,
    createdAt: now,
    updatedAt: now,
    total: items.length,
    items
  };
}

function formatInvoiceFileInfo(inv, params) {
  const sanitize = (str) => String(str).replace(/[/\\?%*:|"<>]/g, '_');
  const invoiceType = invoiceTypeForInvoice(inv, params);
  let yymmdd = '';
  if (inv.tdlap) {
    const m1 = inv.tdlap.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (m1) yymmdd = `${m1[3].slice(-2)}${m1[2]}${m1[1]}`;
    else {
      const m2 = inv.tdlap.match(/(\d{4})-(\d{2})-(\d{2})/);
      if (m2) yymmdd = `${m2[1].slice(-2)}${m2[2]}${m2[3]}`;
      else yymmdd = String(inv.tdlap).replace(/[^0-9]/g, '').substring(0, 6);
    }
  }

  const mst = invoiceType === 'purchase' ? (inv.nbmst || '') : (inv.nmmst || '');
  const ten = invoiceType === 'purchase' ? (inv.nbten || '') : (inv.nmten || '');
  const khhd = inv.khhdon || '';
  const shd = inv.shdon || '';
  const rawFileNameBase = `${yymmdd}-${mst}-${khhd}-${shd}-${ten}`;
  const isMTT = String(inv.__hdQueryPrefix || '').toLowerCase().includes('sco')
    || String(inv.__hdQueryFamily || '').toLowerCase() === 'sco'
    || (inv.khhdon && typeof inv.khhdon === 'string' && inv.khhdon.charAt(0).toUpperCase() === 'M');

  return {
    fileNameBase: sanitize(rawFileNameBase),
    invRoot: isMTT ? 'HD-MAY-TINH-TIEN' : 'HD-DIEN-TU'
  };
}

function artifactHasDetail(artifact) {
  return artifact && artifact.detailData;
}

function artifactHasXml(artifact) {
  return !!(artifact && ((Array.isArray(artifact.xmlFiles) && artifact.xmlFiles.length > 0) || artifact.noXml));
}

function mergeResumeArtifact(base, next) {
  if (!next) return base || null;
  if (!base) return { ...next };
  return {
    ...base,
    invoice: base.invoice || next.invoice,
    fileNameBase: base.fileNameBase || next.fileNameBase,
    invRoot: base.invRoot || next.invRoot,
    detailData: base.detailData || next.detailData || null,
    xmlFiles: (Array.isArray(base.xmlFiles) && base.xmlFiles.length > 0)
      ? base.xmlFiles
      : (Array.isArray(next.xmlFiles) ? next.xmlFiles : []),
    noXml: !!((base.noXml || next.noXml) && !(
      (Array.isArray(base.xmlFiles) && base.xmlFiles.length > 0)
      || (Array.isArray(next.xmlFiles) && next.xmlFiles.length > 0)
    ))
  };
}

function getArtifactForItem(item, artifactByKey) {
  const keys = [item.key, ...(Array.isArray(item.legacyKeys) ? item.legacyKeys : [])].filter(Boolean);
  let artifact = null;
  for (const key of keys) {
    artifact = mergeResumeArtifact(artifact, artifactByKey.get(key));
  }
  return artifact;
}

function isArtifactCompleteForFormats(artifact, formats) {
  if (!artifact) return false;
  const needsDetail = formats.some(format => ['excel', 'html', 'pdf'].includes(format));
  if (needsDetail && !artifactHasDetail(artifact)) return false;
  if (formats.includes('xml') && !artifactHasXml(artifact)) return false;
  return true;
}

function canAttemptDownloadItem(item, formats) {
  if (isDownloadItemTerminal(item)) return false;
  const needsDetail = formats.some(format => ['excel', 'html', 'pdf'].includes(format));
  if (needsDetail && item.detailAttempts >= DOWNLOAD_ITEM_MAX_ATTEMPTS) return false;
  if (formats.includes('xml') && item.xmlAttempts >= DOWNLOAD_ITEM_MAX_ATTEMPTS) return false;
  return true;
}

function queueItemFailureMessage(item) {
  const status = item?.lastStatus ? `HTTP ${item.lastStatus}` : '';
  return [status, item?.lastError].filter(Boolean).join(' - ') || 'Khong tai duoc hoa don.';
}

/**
 * Downloads XML/HTML/PDF for each invoice and bundles into a ZIP with folder structure.
 */
async function downloadInvoicesBatch(tabId, token, invoices, formats, params, job, resumeSession = null) {
  const sanitize = (str) => String(str).replace(/[/\\?%*:|"<>]/g, '_');
  const concurrency = getDownloadConcurrency();
  resetGlobalRateLimiter(job, RATE_ADAPTIVE_FLOOR_MS);

  const d = new Date();
  const yy = String(d.getFullYear()).slice(-2);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mnt = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const newTimeStamp = `${yy}${mm}${dd}-${hh}${mnt}${ss}`;

  const typeStr = invoiceTypesFileSlug(params);
  const periodStr = `${String(params.fromDate || '').replace(/-/g, '_')}-${String(params.toDate || '').replace(/-/g, '_')}`;
  const needsXml = formats.includes('xml');
  const needsHtml = formats.includes('html');
  const needsPdf = formats.includes('pdf');
  const needsDetail = formats.some(format => ['excel', 'html', 'pdf'].includes(format));
  const accountKey = resumeSession?.accountKey || params.accountKey || getAccountKeyFromToken(token) || 'unknown';
  job.accountKey = job.accountKey || accountKey;
  const downloadDataUrl = async (url, filename, failurePrefix) => {
    await new Promise((resolve, reject) => {
      chrome.downloads.download({ url, filename }, () => {
        if (chrome.runtime.lastError) {
          reject(new Error(`${failurePrefix}: ${chrome.runtime.lastError.message}`));
        } else {
          resolve();
        }
      });
    });
  };

  const queueInvoices = resumeSession
    ? []
    : (Array.isArray(invoices) ? invoices : []);
  const session = resumeSession
    ? { ...resumeSession, accountKey, items: hydrateDownloadQueueItems(resumeSession.items), formats: [...formats], params: { ...params, formats: [...formats] } }
    : createDownloadSession(params, formats, queueInvoices, newTimeStamp, accountKey);
  session.timeStamp = session.timeStamp || newTimeStamp;
  session.total = session.items.length;
  await saveResumeSession(session);
  await sendResumeSessionState(tabId, accountKey);
  await deleteResumeArtifactsMatching(session.jobId, artifact => artifact.kind === 'listPage').catch(() => {});

  const artifactList = await getResumeArtifacts(session.jobId, artifact => artifact.kind !== 'listPage');
  const artifactByKey = new Map(artifactList.map(artifact => [artifact.itemKey, artifact]));
  const artifactMap = new Map();

  for (const item of session.items) {
    const artifact = getArtifactForItem(item, artifactByKey);
    if (artifact) {
      artifactMap.set(item.key, artifact);
      if (!artifactByKey.has(item.key)) {
        await putResumeArtifact(session.jobId, item.key, artifact);
      }
    }
  }

  for (const item of session.items) {
    const artifact = artifactMap.get(item.key);
    if (isArtifactCompleteForFormats(artifact, formats)) {
      item.state = artifact.noXml && needsXml && !(artifact.xmlFiles?.length) ? 'xml_missing' : 'done';
    } else if (isDownloadItemTerminal(item)) {
      item.state = 'queued';
    }
  }

  let completed = session.items.filter(isDownloadItemTerminal).length;
  let lastProgressPercent = Math.round(20 + (completed / Math.max(1, session.total)) * 70);

  const flushSession = async () => {
    session.updatedAt = Date.now();
    await saveResumeSession(session);
  };

  const markInvoiceCompleted = async (item) => {
    if (isJobStopped(job)) return;
    if (!isDownloadItemTerminal(item)) return;
    completed = session.items.filter(isDownloadItemTerminal).length;
    const percent = Math.round(20 + (completed / Math.max(1, session.total)) * 70);
    lastProgressPercent = Math.max(lastProgressPercent, percent);
    job.percent = lastProgressPercent;
    await flushSession();
    safeSendMessage(tabId, {
      type: 'PROGRESS',
      percent: lastProgressPercent,
      message: `Đã tải ${completed}/${session.total} hoá đơn...`
    });
  };

  const resourceInflight = new Map();
  let processedSinceTokenCheck = 0;
  let tokenCheckPromise = null;

  const ensureLoggedInEvery20Items = async () => {
    processedSinceTokenCheck += 1;
    if (processedSinceTokenCheck % 20 !== 0) return;

    if (!tokenCheckPromise) {
      tokenCheckPromise = getToken(tabId)
        .then((currentToken) => {
          if (!currentToken) throw createStoppedError();
          return currentToken;
        })
        .finally(() => {
          tokenCheckPromise = null;
        });
    }

    await tokenCheckPromise;
  };

  const runResourceOnce = async (item, kind, requestFactory) => {
    const resourceKey = `${item.key}:${kind}`;
    const current = resourceInflight.get(resourceKey);
    if (current) return current;
    const promise = Promise.resolve().then(requestFactory);
    resourceInflight.set(resourceKey, promise);
    try {
      return await promise;
    } finally {
      if (resourceInflight.get(resourceKey) === promise) {
        resourceInflight.delete(resourceKey);
      }
    }
  };

  const processItem = async (item) => {
    if (isDownloadItemTerminal(item)) return;
    throwIfStopped(job);
    await ensureLoggedInEvery20Items();

    let artifact = artifactMap.get(item.key);
    if (isArtifactCompleteForFormats(artifact, formats)) {
      item.state = artifact.noXml && needsXml && !(artifact.xmlFiles?.length) ? 'xml_missing' : 'done';
      await markInvoiceCompleted(item);
      return;
    }

    const inv = item.invoice;
    const itemInvoiceType = invoiceTypeForInvoice(inv, params);
    const { fileNameBase, invRoot } = formatInvoiceFileInfo(inv, params);
    const queryParams = `nbmst=${encodeURIComponent(inv.nbmst || '')}&khhdon=${encodeURIComponent(inv.khhdon || '')}&shdon=${encodeURIComponent(inv.shdon || '')}&khmshdon=${encodeURIComponent(inv.khmshdon || '')}`;
    artifact = artifact || {
      invoice: serializeInvoiceForResume(inv),
      fileNameBase,
      invRoot,
      detailData: null,
      xmlFiles: [],
      noXml: false
    };
    artifact.fileNameBase = fileNameBase;
    artifact.invRoot = invRoot;

    try {
      if (needsDetail && !artifactHasDetail(artifact)) {
        item.state = 'detail_pending';
        item.detailAttempts += 1;
        item.updatedAt = Date.now();
        await flushSession();

        const detailRes = await runResourceOnce(item, 'detail', () => (
          makeInvoiceResourceRequest(inv, token, `detail?${queryParams}`, 'Xem chi tiết', 'arraybuffer', job)
        ));
        if (detailRes.status === 429) {
          rateLimitOn429(job, itemInvoiceType);
        } else if (detailRes.timedOut) {
          rateLimitOnTimeout(job, itemInvoiceType);
        } else if (detailRes.ok) {
          rateLimitOnSuccess(job, itemInvoiceType);
        }
        if (isChromeThrottleResponse(detailRes)) {
          rateLimitOn429(job, itemInvoiceType);
          await sleep(rateLimitCurrentGap(job, itemInvoiceType));
        }
        if (!detailRes.ok || !detailRes.body) {
          throw createInvoiceFetchError(inv, 'chi tiết hóa đơn', detailRes);
        }

        try {
          const jsonText = new TextDecoder('utf-8').decode(new Uint8Array(detailRes.body));
          artifact.detailData = JSON.parse(jsonText);
          await putResumeArtifact(session.jobId, item.key, artifact);
          artifactMap.set(item.key, artifact);
        } catch (e) {
          console.error('[HoaDon] Detail parse error:', e);
          throw createCompletenessError(`Không đọc được chi tiết hóa đơn ${invoiceDisplayId(inv)}. Vui lòng thử lại.`, e);
        }
      }

      if (needsXml && !artifactHasXml(artifact)) {
        item.state = 'xml_pending';
        item.xmlAttempts += 1;
        item.updatedAt = Date.now();
        await flushSession();

        const res = await runResourceOnce(item, 'xml', () => (
          makeInvoiceResourceRequest(inv, token, `export-xml?${queryParams}`, 'Tải XML', 'arraybuffer', job)
        ));
        if (res.status === 429) {
          rateLimitOn429(job, itemInvoiceType);
        } else if (res.timedOut) {
          rateLimitOnTimeout(job, itemInvoiceType);
        } else if (res.ok) {
          rateLimitOnSuccess(job, itemInvoiceType);
        }
        if (isChromeThrottleResponse(res)) {
          rateLimitOn429(job, itemInvoiceType);
          await sleep(rateLimitCurrentGap(job, itemInvoiceType));
        }
        if (!res.ok || !res.body || res.body.byteLength === 0) {
          if (!res.ok) {
            const errMsg = responseMessage(res, 'Lỗi tải XML');
            if (shouldSkipXmlSilently(res, errMsg)) {
              rateLimitOnSoftBackoff(job, itemInvoiceType);
              artifact.noXml = true;
              await putResumeArtifact(session.jobId, item.key, artifact);
              artifactMap.set(item.key, artifact);
            } else {
              throw createInvoiceFetchError(inv, 'XML hóa đơn', res);
            }
          } else {
            rateLimitOnSoftBackoff(job, itemInvoiceType);
            artifact.noXml = true;
            await putResumeArtifact(session.jobId, item.key, artifact);
            artifactMap.set(item.key, artifact);
          }
        } else {
          const header = new Uint8Array(res.body, 0, Math.min(4, res.body.byteLength));
          const isPkZip = header[0] === 0x50 && header[1] === 0x4B;
          const xmlFiles = [];
          if (isPkZip) {
            try {
              const innerZip = await JSZip.loadAsync(res.body);
              const xmlFileNames = Object.keys(innerZip.files).filter(n => n.toLowerCase().endsWith('.xml') && !innerZip.files[n].dir);
              for (const xmlFileName of xmlFileNames) {
                const xmlBytes = await innerZip.files[xmlFileName].async('uint8array');
                const xmlContent = new TextDecoder('utf-8').decode(xmlBytes);
                const outName = xmlFileNames.length === 1 ? `${fileNameBase}.xml` : `${fileNameBase}_${xmlFileName.split('/').pop()}`;
                xmlFiles.push({ name: outName, content: xmlContent });
              }
            } catch (zipErr) {
              if (zipErr?.abortDownload) throw zipErr;
              console.warn(`[HoaDon] Failed to extract XML ZIP for ${inv.shdon}:`, zipErr);
              throw createCompletenessError(`Không đọc được XML của hóa đơn ${invoiceDisplayId(inv)}. Vui lòng thử lại.`, zipErr);
            }
          } else {
            const text = new TextDecoder().decode(res.body);
            const xmlContent = extractXmlContent(text);
            if (xmlContent) {
              xmlFiles.push({ name: `${fileNameBase}.xml`, content: xmlContent });
            } else {
              let xmlMessage = 'Hệ thống thuế không có file XML cho hóa đơn này';
              try {
                const errJson = JSON.parse(text);
                xmlMessage = errJson.message || 'Không có dữ liệu XML';
              } catch (_) {
                xmlMessage = 'Không có dữ liệu XML';
              }
              if (isMissingXmlMessage(xmlMessage) || !text.trim()) {
                rateLimitOnSoftBackoff(job, itemInvoiceType);
                artifact.noXml = true;
              } else {
                throw createCompletenessError(`Không đọc được XML của hóa đơn ${invoiceDisplayId(inv)}. Vui lòng thử lại.`);
              }
            }
          }
          if (xmlFiles.length > 0) {
            artifact.xmlFiles = xmlFiles;
            artifact.noXml = false;
          } else if (!artifact.noXml) {
            artifact.noXml = true;
          }
          await putResumeArtifact(session.jobId, item.key, artifact);
          artifactMap.set(item.key, artifact);
        }
      }

      item.state = artifact.noXml && needsXml && !(artifact.xmlFiles?.length) ? 'xml_missing' : 'done';
      item.lastStatus = 0;
      item.lastError = '';
      item.updatedAt = Date.now();
      await markInvoiceCompleted(item);
    } catch (e) {
      if (isStoppedError(e)) throw e;
      const status = failureStatus(e) || 0;
      item.lastStatus = status;
      item.lastError = e.userMessage || e.message || '';
      item.state = canAttemptDownloadItem(item, formats) ? 'retry_pending' : 'failed';
      item.updatedAt = Date.now();
      await flushSession();
      console.warn(`[HoaDon] Queue item failed for ${inv.shdon}:`, e);
    }
  };

  while (true) {
    throwIfStopped(job);
    const runnable = session.items.filter(item => !isDownloadItemTerminal(item) && canAttemptDownloadItem(item, formats));
    if (runnable.length === 0) break;
    await runWorkerPool(runnable, concurrency, processItem, job);
    await flushSession();
  }

  const unresolvedItems = session.items.filter(item => !isDownloadItemTerminal(item));
  if (unresolvedItems.length > 0) {
    await flushSession();
    await sendResumeSessionState(tabId, accountKey);
    const rateLimited = unresolvedItems.some(item => item.lastStatus === 429);
    const msg = rateLimited
      ? `Hệ thống thuế đang giới hạn tốc độ. Đã lưu tiến độ ${completed}/${session.total} hóa đơn, bấm Tiếp tục để tải phần còn lại.`
      : `Còn ${unresolvedItems.length} hóa đơn chưa tải được. Đã lưu tiến độ ${completed}/${session.total}, bấm Tiếp tục để thử lại.`;
    throw new Error(msg);
  }

  const outputInvoices = session.items.map(item => item.invoice);
  const outputArtifacts = await getResumeArtifacts(session.jobId, artifact => artifact.kind !== 'listPage');
  const outputMap = new Map(outputArtifacts.map(artifact => [artifact.itemKey, artifact]));
  const zip = new JSZip();
  const fullDetails = [];
  const pdfTasks = [];
  const noXmlInvoices = [];

  for (const item of session.items) {
    const artifact = outputMap.get(item.key);
    const inv = item.invoice;
    if (!isArtifactCompleteForFormats(artifact, formats)) {
      throw new Error(`Thiếu dữ liệu đã lưu của hóa đơn ${invoiceDisplayId(inv)}. Vui lòng bấm Tiếp tục để tải lại phần còn thiếu.`);
    }
    if (formats.includes('excel') && artifact.detailData) {
      fullDetails.push({ header: inv, detail: artifact.detailData });
    }
    if (needsXml) {
      if (Array.isArray(artifact.xmlFiles) && artifact.xmlFiles.length > 0) {
        const outputRoot = invoiceOutputRoot(inv, artifact.invRoot, params);
        artifact.xmlFiles.forEach(file => {
          zip.file(`${outputRoot}/XML/${file.name}`, file.content);
        });
      } else if (artifact.noXml) {
        noXmlInvoices.push(inv);
      }
    }
    const outputRoot = invoiceOutputRoot(inv, artifact.invRoot, params);
    if (needsHtml && artifact.detailData) {
      zip.file(`${outputRoot}/HTML/${artifact.fileNameBase}.html`, buildInvoiceHtml(inv, artifact.detailData));
    }
    if (needsPdf && artifact.detailData) {
      pdfTasks.push((async () => {
        try {
          throwIfStopped(job);
          const pdfBytes = await generatePdfBytesFromInvoice(inv, artifact.detailData);
          throwIfStopped(job);
          zip.file(`${outputRoot}/PDF/${artifact.fileNameBase}.pdf`, pdfBytes, { compression: 'STORE' });
        } catch (pdfErr) {
          if (isStoppedError(pdfErr)) throw pdfErr;
          console.warn(`[HoaDon] PDF generation failed for ${inv.shdon}:`, pdfErr);
          throw createCompletenessError(`Không tạo được PDF cho hóa đơn ${invoiceDisplayId(inv)}. Vui lòng thử lại.`, pdfErr);
        }
      })());
    }
  }
  const outputGroups = invoiceTypeOutputGroups(outputInvoices, fullDetails, noXmlInvoices, params);

  if (pdfTasks.length > 0) {
    throwIfStopped(job);
    safeSendMessage(tabId, { type: 'PROGRESS', percent: 92, message: `Đang tạo ${pdfTasks.length} file PDF...` });
    await Promise.all(pdfTasks);
    throwIfStopped(job);
  }

  if (formats.includes('excel')) {
    throwIfStopped(job);
    safeSendMessage(tabId, {
      type: 'PROGRESS',
      percent: 95,
      message: outputGroups.length > 1 ? `Đang tạo ${outputGroups.length} tệp Excel theo mẫu...` : 'Đang tạo tệp Excel theo mẫu...'
    });
    for (const group of outputGroups) {
      throwIfStopped(job);
      const excelBlob = await generateComprehensiveExcelBlob(group.invoices, group.fullDetails, group.params);
      throwIfStopped(job);
      const excelName = sanitize(`HD-EXCEL-${group.slug}-${periodStr}-${session.timeStamp}.xlsx`);
      const excelUrl = await blobToDataUrl(excelBlob);
      await downloadDataUrl(excelUrl, excelName, 'Lưu Excel thất bại');
    }
  }

  const hasZipFormats = formats.some(f => ['xml', 'html', 'pdf'].includes(f));

  if (hasZipFormats) {
    throwIfStopped(job);
    if (outputGroups.length > 1) {
      outputGroups.forEach(group => {
        zip.file(`BC-HD-TAI-VE-${group.slug}.html`, buildReportHtml(group.invoices, group.params, session.timeStamp, formats, group.noXmlInvoices));
      });
    } else {
      zip.file('BC-HD-TAI-VE.html', buildReportHtml(outputInvoices, params, session.timeStamp, formats, noXmlInvoices));
    }
    safeSendMessage(tabId, { type: 'PROGRESS', percent: 96, message: 'Đang đóng gói file ZIP...' });
    console.time('[ZIP] generateAsync');
    let lastZipProgressAt = 0;
    const zipBlob = await zip.generateAsync({ type: 'blob' }, (metadata) => {
      const now = Date.now();
      if (metadata.percent < 100 && now - lastZipProgressAt < 350) return;
      lastZipProgressAt = now;
      safeSendMessage(tabId, {
        type: 'PROGRESS',
        percent: Math.min(99, Math.round(96 + (metadata.percent / 100) * 3)),
        message: `Đang đóng gói file ZIP... ${Math.round(metadata.percent)}%`
      });
    });
    console.timeEnd('[ZIP] generateAsync');
    throwIfStopped(job);
    const fileName = sanitize(`HD-${typeStr}-${periodStr}-${session.timeStamp}.zip`);
    const zipUrl = await blobToDataUrl(zipBlob);
    chrome.downloads.download({ url: zipUrl, filename: fileName }, () => {
      if (isJobStopped(job)) return;
      if (chrome.runtime.lastError) {
        safeSendMessage(tabId, { type: 'ERROR', message: 'Tải xuống thất bại: ' + chrome.runtime.lastError.message });
      } else {
        clearResumeSession(session.jobId).then(() => sendResumeSessionState(tabId, accountKey));
        safeSendMessage(tabId, { type: 'DONE', fileName, count: session.total });
      }
    });
  } else if (formats.includes('excel')) {
    await clearResumeSession(session.jobId);
    await sendResumeSessionState(tabId, accountKey);
    safeSendMessage(tabId, { type: 'DONE', count: session.total });
  }
}

const SHEET_CONFIGS = {
  'tong-hop': { endCol: 24, quantityCols: [20] },
  'ds-hoadon': { endCol: 19 },
  'ds-sanpham': { endCol: 13, quantityCols: [9] }
};

const EXCEL_105PX_WIDTH = 14.28515625;

function isBlankValue(value) {
  return value === null || value === undefined || value === '';
}

function textCell(value) {
  return isBlankValue(value) ? null : { type: 'string', value: String(value) };
}

function numberCell(value) {
  if (isBlankValue(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? { type: 'number', value: num } : textCell(value);
}

function numberOrZeroCell(value) {
  if (isBlankValue(value)) return { type: 'number', value: 0 };
  const num = Number(value);
  return Number.isFinite(num) ? { type: 'number', value: num } : textCell(value);
}

function percentCell(value) {
  const cell = numberOrZeroCell(value);
  if (cell?.type === 'number') cell.style = 'percent';
  return cell;
}

function colName(index) {
  let name = '';
  while (index > 0) {
    index -= 1;
    name = String.fromCharCode(65 + (index % 26)) + name;
    index = Math.floor(index / 26);
  }
  return name;
}

function colIndex(ref) {
  const letters = String(ref || '').match(/[A-Z]+/i)?.[0] || 'A';
  let index = 0;
  for (const ch of letters.toUpperCase()) {
    index = index * 26 + ch.charCodeAt(0) - 64;
  }
  return index;
}

function excelSerialFromParts(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}

function invoiceDateSerial(value) {
  if (isBlankValue(value)) return null;
  if (typeof value === 'number') return value;

  const raw = String(value).trim();
  const zonedIso = /T.*(Z|[+-]\d{2}:?\d{2})$/i.test(raw);
  if (zonedIso) {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
      const vietnamTime = new Date(parsed.getTime() + 7 * 60 * 60 * 1000);
      return excelSerialFromParts(
        vietnamTime.getUTCFullYear(),
        vietnamTime.getUTCMonth() + 1,
        vietnamTime.getUTCDate()
      );
    }
  }

  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (dmy) return excelSerialFromParts(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));

  const ymd = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (ymd) return excelSerialFromParts(Number(ymd[1]), Number(ymd[2]), Number(ymd[3]));

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const vietnamTime = new Date(parsed.getTime() + 7 * 60 * 60 * 1000);
    return excelSerialFromParts(
      vietnamTime.getUTCFullYear(),
      vietnamTime.getUTCMonth() + 1,
      vietnamTime.getUTCDate()
    );
  }
  return raw;
}

function dateCell(value) {
  const serial = invoiceDateSerial(value);
  return typeof serial === 'number' ? numberCell(serial) : textCell(serial);
}

function invoiceKey(inv) {
  if (!inv) return '';
  return [
    inv.id || '',
    inv.nbmst || '',
    inv.khmshdon || '',
    inv.khhdon || '',
    inv.shdon || ''
  ].join('|');
}

function pairInvoicesWithDetails(invoices, fullDetailedData) {
  const detailMap = new Map();
  (fullDetailedData || []).forEach(entry => {
    if (!entry) return;
    const detail = entry.detail || {};
    const header = entry.header || {};
    detailMap.set(invoiceKey(header), detail);
    detailMap.set(invoiceKey(detail), detail);
  });

  return (invoices || []).map(header => {
    const detail = detailMap.get(invoiceKey(header)) || null;
    return {
      header,
      detail,
      data: {
        ...(header || {}),
        ...(detail || {}),
        __hdInvoiceType: header.__hdInvoiceType || detail.__hdInvoiceType || '',
        __hdQueryPrefix: header.__hdQueryPrefix || detail.__hdQueryPrefix || '',
        __hdQueryFamily: header.__hdQueryFamily || detail.__hdQueryFamily || '',
        __hdQueryVariant: header.__hdQueryVariant || detail.__hdQueryVariant || ''
      }
    };
  });
}

function getExtraValue(list, fieldName) {
  const found = Array.isArray(list)
    ? list.find(item => String(item?.ttruong || '').toLowerCase() === String(fieldName).toLowerCase())
    : null;
  return found ? found.dlieu : null;
}

function getExtraNumber(list, fieldName) {
  const value = getExtraValue(list, fieldName);
  if (isBlankValue(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function invoiceTemplateCode(inv) {
  const value = inv?.khmshdon;
  if (isBlankValue(value)) return '';
  const num = Number(value);
  return Number.isFinite(num) ? String(num).padStart(2, '0') : String(value).padStart(2, '0');
}

function selectedParty(inv, invoiceType) {
  const useSeller = invoiceType === 'purchase';
  return {
    mst: useSeller ? (inv?.nbmst || '') : (inv?.nmmst || ''),
    name: useSeller ? (inv?.nbten || '') : (inv?.nmten || '')
  };
}

function invoiceKindTextLegacy(inv) {
  const symbol = String(inv?.khhdon || '').trim().toUpperCase();
  return symbol.startsWith('M') ? 'HĐ Từ máy tính tiền' : 'HĐ Điện tử';
}

function invoiceKindText(inv) {
  const symbol = String(inv?.khhdon || '').trim().toUpperCase();
  const prefix = String(inv?.__hdQueryPrefix || '').toLowerCase();
  const family = String(inv?.__hdQueryFamily || '').toLowerCase();
  const isCashRegister = prefix.includes('sco') || family === 'sco' || symbol.startsWith('M');
  return isCashRegister ? 'HĐ Máy tính tiền' : 'HĐ Điện tử';
}

function invoiceStatusText(inv) {
  if (inv?.trthaiText) return inv.trthaiText;
  const code = Number(inv?.tthai);
  const map = {
    1: 'Hóa đơn mới',
    2: 'Hóa đơn thay thế',
    3: 'Hóa đơn điều chỉnh',
    4: 'Hóa đơn đã bị thay thế',
    5: 'Hóa đơn đã bị điều chỉnh',
    6: 'Hóa đơn đã hủy'
  };
  return map[code] || (isBlankValue(inv?.tthai) ? '' : String(inv.tthai));
}

function invoiceCheckText(inv) {
  if (inv?.kqcht) return inv.kqcht;
  const code = Number(inv?.ttxly);
  const map = {
    4: 'Đã cấp mã hóa đơn',
    5: 'Đã cấp mã hóa đơn',
    6: 'Tổng cục thuế đã nhận không mã',
    8: 'Tổng cục thuế đã nhận hóa đơn có mã khởi tạo từ máy tính tiền'
  };
  return map[code] || (isBlankValue(inv?.ttxly) ? '' : String(inv.ttxly));
}

function itemNatureText(code) {
  const map = {
    1: 'Hàng hóa, dịch vụ',
    2: 'Khuyến mại',
    3: 'Chiết khấu thương mại',
    4: 'Ghi chú, diễn giải'
  };
  map[5] = 'Hàng hóa đặc trưng';
  if (isBlankValue(code)) return '';
  return map[Number(code)] || String(code);
}

function taxRateValue(value) {
  if (isBlankValue(value)) return 0;
  if (typeof value === 'number') return value > 1 ? value / 100 : value;
  const raw = String(value).trim();
  const numeric = Number(raw.replace('%', '').replace(',', '.'));
  if (!Number.isFinite(numeric)) return raw;
  return raw.includes('%') || numeric > 1 ? numeric / 100 : numeric;
}

function invoiceItems(detail) {
  const items = detail?.hdhhdvu || detail?.hhonDs || detail?.hhdvu || [];
  return Array.isArray(items) && items.length > 0 ? items : [null];
}

function itemName(item) {
  return item?.ten || item?.thdon || item?.thhdon || '';
}

function itemQuantity(item) {
  return item?.sluong ?? item?.slvban ?? null;
}

function itemUnitPrice(item) {
  return item?.dgia ?? item?.dgban ?? null;
}

function itemAmount(item) {
  return item?.thtien ?? item?.thtcthue ?? null;
}

function itemTaxAmount(item) {
  if (!isBlankValue(item?.tthue)) return item.tthue;
  const vatAmount = getExtraNumber(item?.ttkhac, 'VATAmount');
  if (!isBlankValue(vatAmount)) return vatAmount;
  const amount = Number(itemAmount(item));
  const rate = taxRateValue(item?.tsuat ?? item?.ltsuat);
  return Number.isFinite(amount) && typeof rate === 'number' ? amount * rate : null;
}

function invoiceCommonCells(inv, paramsOrType, index) {
  const invoiceType = typeof paramsOrType === 'string' ? paramsOrType : invoiceTypeForInvoice(inv, paramsOrType);
  const party = selectedParty(inv, invoiceType);
  return [
    numberCell(index + 1),
    textCell(invoiceTemplateCode(inv)),
    textCell(inv?.khhdon),
    numberCell(inv?.shdon),
    dateCell(inv?.tdlap),
    textCell(party.mst),
    textCell(party.name),
    numberOrZeroCell(inv?.tgtcthue),
    numberOrZeroCell(inv?.tgtthue),
    numberOrZeroCell(inv?.ttcktmai),
    numberOrZeroCell(inv?.tgtphi),
    numberOrZeroCell(inv?.tgtttbso),
    textCell(inv?.dvtte),
    numberOrZeroCell(inv?.tgia),
    textCell(invoiceStatusText(inv)),
    textCell(invoiceCheckText(inv))
  ];
}

function productCells(item) {
  const rate = taxRateValue(item?.tsuat ?? item?.ltsuat);
  return [
    textCell(itemNatureText(item?.tchat)),
    textCell(itemName(item)),
    textCell(item?.dvtinh),
    numberOrZeroCell(itemQuantity(item)),
    numberOrZeroCell(itemUnitPrice(item)),
    typeof rate === 'number' ? percentCell(rate) : textCell(rate),
    numberOrZeroCell(itemAmount(item)),
    numberOrZeroCell(itemTaxAmount(item))
  ];
}

function buildTongHopRows(pairs, paramsOrType) {
  const rows = [];
  pairs.forEach((pair, invoiceIndex) => {
    const inv = pair.data || {};
    invoiceItems(pair.detail || inv).forEach((item, itemIndex) => {
      rows.push([
        ...(itemIndex === 0 ? invoiceCommonCells(inv, paramsOrType, invoiceIndex) : Array(16).fill(null)),
        ...productCells(item || {})
      ]);
    });
  });
  return rows;
}

function buildDsHoaDonRows(pairs, paramsOrType) {
  return pairs.map((pair, index) => {
    const inv = pair.data || {};
    const invoiceType = typeof paramsOrType === 'string' ? paramsOrType : invoiceTypeForInvoice(inv, paramsOrType);
    const party = selectedParty(inv, invoiceType);
    return [
      numberCell(index + 1),
      textCell(invoiceKindText(inv)),
      textCell(invoiceTemplateCode(inv)),
      textCell(inv?.khhdon),
      numberCell(inv?.shdon),
      dateCell(inv?.tdlap),
      textCell(party.mst),
      textCell(party.name),
      numberOrZeroCell(inv?.tgtcthue),
      numberOrZeroCell(inv?.tgtthue),
      numberOrZeroCell(inv?.ttcktmai),
      numberOrZeroCell(inv?.tgtphi),
      numberOrZeroCell(inv?.tgtttbso),
      textCell(inv?.dvtte),
      numberOrZeroCell(inv?.tgia),
      textCell(invoiceStatusText(inv)),
      textCell(invoiceCheckText(inv)),
      textCell(getExtraValue(inv?.ttkhac, 'PortalLink')),
      textCell(getExtraValue(inv?.ttkhac, 'Fkey'))
    ];
  });
}

function buildDsSanPhamRows(pairs, paramsOrType) {
  const rows = [];
  pairs.forEach((pair, invoiceIndex) => {
    const inv = pair.data || {};
    const invoiceType = typeof paramsOrType === 'string' ? paramsOrType : invoiceTypeForInvoice(inv, paramsOrType);
    const party = selectedParty(inv, invoiceType);
    const leadingCells = [
      numberCell(invoiceIndex + 1),
      dateCell(inv?.tdlap),
      textCell(party.mst),
      textCell(party.name),
      numberOrZeroCell(inv?.tgia)
    ];

    invoiceItems(pair.detail || inv).forEach((item, itemIndex) => {
      rows.push([
        ...(itemIndex === 0 ? leadingCells : Array(5).fill(null)),
        ...productCells(item || {})
      ]);
    });
  });
  return rows;
}

/**
 * Generates an Excel Blob from the template workbook and only replaces sheet data.
 */
async function generateComprehensiveExcelBlob(invoices, fullDetailedData, params) {
  const response = await fetch(chrome.runtime.getURL('template/invoice.xlsx'));
  if (!response.ok) throw new Error('Không tải được file Excel mẫu.');

  const zip = await JSZip.loadAsync(await response.arrayBuffer());
  const sheetEntries = await getWorkbookSheetEntries(zip);
  const styleIds = { percent: null };
  await updateWorkbookActiveSheet(zip, 'tong-hop');
  const pairs = pairInvoicesWithDetails(invoices, fullDetailedData);

  await updateTemplateSheet(zip, sheetEntries, 'tong-hop', buildTongHopRows(pairs, params), styleIds);
  await updateTemplateSheet(zip, sheetEntries, 'ds-hoadon', buildDsHoaDonRows(pairs, params), styleIds);
  await updateTemplateSheet(zip, sheetEntries, 'ds-sanpham', buildDsSanPhamRows(pairs, params), styleIds);

  const excelBuffer = await zip.generateAsync({ type: 'arraybuffer' });
  return new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

function xmlAttribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag || '').match(new RegExp(`\\s${escapedName}="([^"]*)"`, 'i'));
  return match ? decodeXmlText(match[1]) : '';
}

function decodeXmlText(value) {
  return String(value || '')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function encodeXmlText(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeXlsxPath(target) {
  if (!target) return '';
  const clean = String(target).replace(/\\/g, '/');
  if (clean.startsWith('/')) return clean.slice(1);
  return clean.startsWith('xl/') ? clean : `xl/${clean}`;
}

async function getWorkbookSheetEntries(zip) {
  const workbookXml = await zip.file('xl/workbook.xml').async('text');
  const relsXml = await zip.file('xl/_rels/workbook.xml.rels').async('text');
  const relMap = new Map();
  const relTags = relsXml.match(/<Relationship\b[^>]*\/?>/g) || [];

  relTags.forEach(tag => {
    const id = xmlAttribute(tag, 'Id');
    const target = xmlAttribute(tag, 'Target');
    if (id && target) relMap.set(id, normalizeXlsxPath(target));
  });

  const entries = new Map();
  const sheetTags = workbookXml.match(/<sheet\b[^>]*\/?>/g) || [];
  sheetTags.forEach(tag => {
    const name = xmlAttribute(tag, 'name');
    const id = xmlAttribute(tag, 'r:id');
    const entry = relMap.get(id);
    if (name && entry) entries.set(name, entry);
  });
  return entries;
}

function rowXmlByIndex(xmlText, rowIndex) {
  const rows = String(xmlText || '').match(/<row\b[^>]*>[\s\S]*?<\/row>/g) || [];
  return rows.find(row => Number(xmlAttribute(row.match(/^<row\b[^>]*>/)?.[0] || '', 'r')) === rowIndex) || '';
}

function rowTemplateAttrs(rowXml) {
  const open = String(rowXml || '').match(/^<row\b([^>]*)>/)?.[1] || '';
  return open
    .replace(/\sr="[^"]*"/i, '')
    .replace(/\sspans="[^"]*"/i, '');
}

function cellTemplateAttrs(cellXml) {
  const open = String(cellXml || '').match(/^<c\b([^>]*?)(?:\/>|>)/)?.[1] || '';
  return open
    .replace(/\sr="[^"]*"/i, '')
    .replace(/\st="[^"]*"/i, '');
}

function cellTemplatesByColumn(rowXml) {
  const cells = new Map();
  const cellTags = String(rowXml || '').match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || [];
  cellTags.forEach(cellXml => {
    const open = cellXml.match(/^<c\b[^>]*(?:\/>|>)/)?.[0] || '';
    const ref = xmlAttribute(open, 'r');
    if (ref) cells.set(colIndex(ref), cellTemplateAttrs(cellXml));
  });
  return cells;
}

function attrsWithStyle(attrs, styleId) {
  if (styleId === null || styleId === undefined) return attrs || '';
  const styleAttr = `s="${styleId}"`;
  if (/\ss="[^"]*"/i.test(attrs || '')) {
    return String(attrs || '').replace(/\ss="[^"]*"/i, ` ${styleAttr}`);
  }
  return `${attrs || ''} ${styleAttr}`;
}

function worksheetCellXml(rowIndex, columnIndex, templateAttrs, value, styleIds = {}) {
  const ref = `${colName(columnIndex)}${rowIndex}`;
  const attrs = attrsWithStyle(templateAttrs || '', value?.style === 'percent' ? styleIds.percent : null);
  if (isBlankValue(value)) return `<c r="${ref}"${attrs}/>`;

  if (value.type === 'number') {
    return `<c r="${ref}"${attrs}><v>${String(value.value)}</v></c>`;
  }

  const text = encodeXmlText(value.value);
  const preserve = /^\s|\s$/.test(String(value.value)) ? ' xml:space="preserve"' : '';
  return `<c r="${ref}"${attrs} t="inlineStr"><is><t${preserve}>${text}</t></is></c>`;
}

function worksheetRowXml(rowIndex, values, rowAttrs, cellTemplates, endCol, styleIds) {
  const cells = [];
  for (let columnIndex = 1; columnIndex <= endCol; columnIndex += 1) {
    cells.push(worksheetCellXml(
      rowIndex,
      columnIndex,
      cellTemplates.get(columnIndex) || '',
      values[columnIndex - 1] || null,
      styleIds
    ));
  }
  return `<row r="${rowIndex}" spans="1:${endCol}"${rowAttrs || ''}>${cells.join('')}</row>`;
}

function updateWorksheetColumnWidths(xmlText, config) {
  const quantityCols = config.quantityCols || [];
  if (quantityCols.length === 0) return xmlText;

  let output = String(xmlText || '');
  quantityCols.forEach(columnIndex => {
    const colPattern = new RegExp(`<col\\b(?=[^>]*\\bmin="${columnIndex}")(?=[^>]*\\bmax="${columnIndex}")[^>]*/>`);
    const replacement = `<col min="${columnIndex}" max="${columnIndex}" width="${EXCEL_105PX_WIDTH}" customWidth="1"/>`;
    if (colPattern.test(output)) {
      output = output.replace(colPattern, replacement);
    } else if (/<cols>/.test(output)) {
      output = output.replace(/<cols>/, `<cols>${replacement}`);
    } else {
      output = output.replace(/(<sheetFormatPr\b[^>]*\/>)/, `$1<cols>${replacement}</cols>`);
    }
  });
  return output;
}

function updateWorksheetXml(xmlText, rows, config, styleIds) {
  const headerRow = rowXmlByIndex(xmlText, 1);
  const rowTemplate = rowXmlByIndex(xmlText, 2);
  const rowAttrs = rowTemplateAttrs(rowTemplate);
  const cellTemplates = cellTemplatesByColumn(rowTemplate);
  const dataRows = rows.map((rowValues, index) =>
    worksheetRowXml(index + 2, rowValues, rowAttrs, cellTemplates, config.endCol, styleIds)
  );
  const newSheetData = `<sheetData>${headerRow}${dataRows.join('')}</sheetData>`;
  const lastRow = Math.max(1, rows.length + 1);
  const ref = `A1:${colName(config.endCol)}${lastRow}`;

  let output = String(xmlText || '').replace(/<sheetData\b[^>]*>[\s\S]*?<\/sheetData>/, newSheetData);
  if (/<dimension\b[^>]*\bref="/.test(output)) {
    output = output.replace(/(<dimension\b[^>]*\bref=")[^"]*("[^>]*\/?>)/, `$1${ref}$2`);
  } else {
    output = output.replace(/(<worksheet\b[^>]*>)/, `$1<dimension ref="${ref}"/>`);
  }
  return updateWorksheetColumnWidths(output, config);
}

async function updateTemplateSheet(zip, sheetEntries, sheetName, rows, styleIds) {
  const entry = sheetEntries.get(sheetName);
  const config = SHEET_CONFIGS[sheetName];
  if (!entry || !config) throw new Error(`Excel mau thieu sheet ${sheetName}.`);
  const file = zip.file(entry);
  if (!file) throw new Error(`Excel mau thieu file ${entry}.`);
  const xml = await file.async('text');
  zip.file(entry, updateWorksheetXml(xml, rows, config, styleIds));
}

async function updateWorkbookStyles(zip) {
  const file = zip.file('xl/styles.xml');
  if (!file) return { percent: null };

  let stylesXml = await file.async('text');
  stylesXml = stylesXml.replace(/<borders\b[^>]*>[\s\S]*?<\/borders>/, block =>
    block.replace(/style="(?:thin|hair)"/g, 'style="dotted"')
  );

  const cellXfsMatch = stylesXml.match(/<cellXfs\b[^>]*\bcount="(\d+)"[^>]*>/);
  const percentStyleId = cellXfsMatch ? Number(cellXfsMatch[1]) : null;
  if (percentStyleId !== null) {
    const percentXf = '<xf numFmtId="10" fontId="0" fillId="0" borderId="8" xfId="1" applyNumberFormat="1" applyFont="1" applyBorder="1"/>';
    stylesXml = stylesXml.replace(/(<cellXfs\b[^>]*\bcount=")(\d+)("[^>]*>)/, (_m, start, count, end) =>
      `${start}${Number(count) + 1}${end}`
    );
    stylesXml = stylesXml.replace('</cellXfs>', `${percentXf}</cellXfs>`);
  }

  zip.file('xl/styles.xml', stylesXml);
  return { percent: percentStyleId };
}

async function updateWorkbookActiveSheet(zip, sheetName) {
  const file = zip.file('xl/workbook.xml');
  if (!file) return;

  let workbookXml = await file.async('text');
  const sheetTags = workbookXml.match(/<sheet\b[^>]*\/?>/g) || [];
  const activeIndex = Math.max(0, sheetTags.findIndex(tag => xmlAttribute(tag, 'name') === sheetName));

  if (/<workbookView\b[^>]*\/?>/.test(workbookXml)) {
    workbookXml = workbookXml.replace(/<workbookView\b[^>]*\/?>/, tag => {
      let next = tag;
      if (/\bactiveTab="/.test(next)) next = next.replace(/\bactiveTab="[^"]*"/, `activeTab="${activeIndex}"`);
      else next = next.replace(/\/?>$/, ` activeTab="${activeIndex}"$&`);

      if (/\bfirstSheet="/.test(next)) next = next.replace(/\bfirstSheet="[^"]*"/, `firstSheet="${activeIndex}"`);
      else next = next.replace(/\/?>$/, ` firstSheet="${activeIndex}"$&`);
      return next;
    });
  } else {
    workbookXml = workbookXml.replace(/(<workbookPr\b[^>]*\/?>)/, `$1<bookViews><workbookView activeTab="${activeIndex}" firstSheet="${activeIndex}"/></bookViews>`);
  }

  zip.file('xl/workbook.xml', workbookXml);
}

/**
 * Builds a properly formatted invoice HTML from JSON detail data.
 * Used for both HTML and PDF (print-ready) output files.
 */
function buildInvoiceHtml(inv, detail) {
  const d = detail || {};
  const invoiceBgUrl = extensionAssetUrl('template/viewinvoice-bg.jpg');
  const signCheckUrl = extensionAssetUrl('template/sign-check.jpg');

  // Parse chữ ký số từ nbcks (JSON string)
  let cksInfo = null;
  try { if (d.nbcks) cksInfo = JSON.parse(d.nbcks); } catch (_) {}
  const signingTime = cksInfo?.SigningTime ? String(cksInfo.SigningTime) : '';

  const fmtNum = (n) => {
    if (n === null || n === undefined || n === '') return '';
    const num = Number(n);
    if (isNaN(num)) return String(n);
    return num.toLocaleString('vi-VN');
  };

  const fmtDate = (s) => {
    if (!s) return '';
    s = String(s);
    let day, month, year;
    if (s.includes('/')) { [day, month, year] = s.split('/'); }
    else if (s.includes('-')) { const p = s.split('T')[0].split('-'); year = p[0]; month = p[1]; day = p[2]; }
    else return s;
    return `Ng&agrave;y ${day} th&aacute;ng ${month} n&abreve;m ${year}`;
  };

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const hdon = String(d.hdon || inv.hdon || '01');
  const titleMap = { '01': 'HO&Aacute; &#272;&#416;N GI&Aacute; TR&#7882; GIA T&#258;NG', '02': 'HO&Aacute; &#272;&#416;N B&Aacute;N H&Agrave;NG', '03': 'HO&Aacute; &#272;&#416;N B&Aacute;N H&Agrave;NG', '04': 'HO&Aacute; &#272;&#416;N B&Aacute;N T&Agrave;I S&#7842;N C&Ocirc;NG' };
  const invoiceTitle = titleMap[hdon] || titleMap['01'];

  const httoanMap = { 1: 'Tiền mặt', 2: 'Chuyển khoản', 3: 'Tiền mặt/Chuyển khoản', 4: 'Thẻ', 5: 'Tiền mặt/Thẻ', 6: 'Chuyển khoản/Thẻ', 7: 'Tiền mặt/Chuyển khoản/Thẻ', 8: 'Bù trừ công nợ', 9: 'Khác' };

  const khmshdon = d.khmshdon || inv.khmshdon || '';
  const khhdon   = d.khhdon   || inv.khhdon   || '';
  const shdon    = d.shdon    || inv.shdon    || '';
  const tdlap    = d.tdlap    || inv.tdlap    || '';
  const mccqt    = d.mttcqt   || inv.mttcqt   || d.mtdtchieu || inv.mtdtchieu || '';

  const nbten    = d.nbten    || inv.nbten    || '';
  const nbmst    = d.nbmst    || inv.nbmst    || '';
  const nbmaCh   = d.nbmcuahang || d.nbmch || d.nbmchhang || '';
  const nbtenCh  = d.nbtencuahang || d.nbtch || d.nbtchhang || '';
  const nbdchi   = d.nbdchi   || '';
  const nbdt     = d.nbsdthoai || d.nbdt      || '';
  const nbstk    = d.nbstkhoan || '';
  const nbnh     = d.nbtnhang  || '';
  const signerSubject = cksInfo?.Subject || cksInfo?.X509SubjectName || nbten || '';

  const nmten    = d.nmten    || inv.nmten    || '';
  const nmHoTen  = d.nmhoten || d.nmhvt || d.nmtennguoimua || '';
  const nmmst    = d.nmmst    || inv.nmmst    || '';
  const nmDvcq   = d.nmdvcqhvnsnn || d.nmdvcq || d.madvcqhvnsnn || '';
  const nmCccd   = d.nmcccd || d.nmcmnd || d.nmshcccd || '';
  const nmHoChieu = d.nmhochieu || d.nmshochieu || d.nmshchieu || '';
  const nmdchi   = d.nmdchi   || '';
  const nmstk    = d.nmstkhoan || '';
  const soBangKe = d.sobke || d.sbke || '';
  const ngayBangKe = d.ngaybke || d.nbke || '';
  const httoanText = String(d.thtttoan || '');
  const httoanCode = Number(d.htttoan);
  const httoan     = httoanText || (!isNaN(httoanCode) && httoanMap[httoanCode]) || '';

  const tgtcthue  = d.tgtcthue  || inv.tgtcthue  || 0;
  const tgtthue   = d.tgtthue   || inv.tgtthue   || 0;
  const tgtttbso  = d.tgtttbso  || inv.tgtttbso  || 0;
  const tgtttbchu = d.tgtttbchu || inv.tgtttbchu || '';
  const tgtphi    = d.tgtphi    || 0;
  const tgtcktm   = d.tgtcktm   || d.tgtck || inv.tgtck || 0;

  const items = (d.hdhhdvu || d.hhonDs || d.hhdvu || []).filter(Boolean);
  const tchatMap = { '1': 'H&agrave;ng h&oacute;a, d&#7883;ch v&#7909;', '2': 'Khuy&#7871;n m&#7841;i', '3': 'Chi&#7871;t kh&#7845;u th&#432;&#417;ng m&#7841;i', '4': 'Ghi ch&uacute;, di&#7877;n gi&#7843;i', '5': 'H&agrave;ng h&oacute;a &#273;&#7863;c tr&#432;ng' };

  const itemRows = items.map((item, i) => {
    const chat = String(item.tchat || '1');
    return `<tr>
      <td class="tx-center">${item.stt || i + 1}</td>
      <td class="tx-left">${tchatMap[chat] || esc(chat)}</td>
      <td class="tx-left" style="max-width:150px;word-wrap:break-word"></td>
      <td class="tx-left">${esc(itemName(item))}</td>
      <td class="tx-left">${esc(item.dvtinh || '')}</td>
      <td class="tx-center">${fmtNum(itemQuantity(item))}</td>
      <td class="tx-center">${fmtNum(itemUnitPrice(item))}</td>
      <td class="tx-center">${item.stckhau != null ? fmtNum(item.stckhau) : ''}</td>
      <td class="tx-center">${esc(item.ltsuat || '')}</td>
      <td class="tx-center">${fmtNum(itemAmount(item))}</td>
    </tr>`;
  }).join('');

  const taxEntries = d.thttltsuat || [];
  const taxRows = taxEntries.length > 0
    ? taxEntries.map(t => `<tr>
      <td class="tx-center">${esc(t.tsuat || '')}</td>
      <td class="tx-center">${fmtNum(t.thtien)}</td>
      <td class="tx-center">${fmtNum(t.tthue)}</td>
    </tr>`).join('')
    : `<tr><td class="tx-center">&mdash;</td><td class="tx-center">${fmtNum(tgtcthue)}</td><td class="tx-center">${fmtNum(tgtthue)}</td></tr>`;

  const dataItemContent = (label, val, style = '') => `<div class="data-item"${style ? ` style="${style}"` : ''}><div class="di-label"><span>${label}:</span></div><div class="di-value"><div>${val}</div></div></div>`;
  const dataItem = (label, val) => `<li>${dataItemContent(label, val)}</li>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>H&oacute;a &#273;&#417;n ${esc(String(khhdon))}-${esc(String(shdon))}</title>
<style>
*{box-sizing:border-box;-moz-box-sizing:border-box}
html{font-size:100%}
body{width:100%;height:100%;margin:0 auto;padding:0;font-size:13pt;font-family:"Times New Roman",serif;background:#fff}
.print-page{width:${INVOICE_HTML_WIDTH_MM}mm;min-height:297mm;margin:0 auto;background:#fff}
.main-page{max-width:${INVOICE_HTML_WIDTH_MM}mm;padding:20px 20px 10px;margin:auto;background-image:url("${invoiceBgUrl}");background-repeat:no-repeat;background-position:center center;background-size:180%;border:3px double rgba(145,87,21,.69);line-height:1.5;box-shadow:0 0 9px 2px rgba(222,226,230,.7)}
.heading-content .main-title{font-size:20pt;text-align:center;display:block;font-weight:bold;text-transform:uppercase}
.heading-content p{font-size:13pt;text-align:right}
.heading-content p.day{text-align:center;display:block}
.heading-content .top-content{display:flex;justify-content:space-between}
.heading-content .code-content{display:inline-block;text-align:right;font-size:13pt;padding-bottom:5px}
.day{font-size:13pt;text-align:center;display:block;margin:2px 0}
.vip-divide{width:100%;height:0;border-bottom:1px solid rgba(145,87,21,.69)}
.flex-li{display:flex}
.content-info{padding-top:5px}
.content-info .list-fill-out{list-style:none;padding-inline-start:0;margin-top:5px;margin-bottom:5px}
.content-info .list-fill-out li{font-size:13pt}
.table-horizontal-wrapper{display:flex;justify-content:space-between}
.res-tb{border-collapse:collapse;border-spacing:0;width:100%;overflow-x:auto;margin:10px 0;min-width:250px}
.res-tb tr td{border:1px solid #000;padding:6px 4px;vertical-align:baseline}
.res-tb tr td.tx-center{text-align:center}
.res-tb tr td.tx-left{text-align:left}
.res-tb tr td.tx-right{text-align:right}
.res-tb thead tr th{border:1px solid #000;vertical-align:middle;text-align:center;padding:6px 4px}
.res-tb thead tr th.tb-stt{width:70px;text-align:center}
.res-tb thead tr th.tb-thh{width:200px;text-align:center}
.res-tb thead tr th.tb-dvt{width:100px;text-align:center}
.res-tb thead tr th.tb-sl{width:80px;text-align:center}
.res-tb thead tr th.tb-dg{width:80px;text-align:center}
.res-tb thead tr th.tb-ts{width:80px;text-align:center}
.res-tb thead tr th.tb-ttct{width:250px;text-align:center}
.ft-sign{padding-top:20px}
.ft-sign .sign-dx{display:flex;flex-wrap:wrap;justify-content:space-around;align-items:flex-start}
.ft-sign .sign-dx h3{font-weight:normal;margin:0;text-align:center}
.ft-sign .sign-dx h3 p{text-align:center;font-size:13pt;font-weight:100;margin:1em 0}
.ft-sign .sign-dx h3 p:nth-child(2){font-size:14px;font-weight:normal}
.ft-sign .fd-end{padding-top:120px;text-align:center}
.sign-box{width:260px!important;padding:5px!important;border:2px solid #23b709!important;background-image:url("${signCheckUrl}")!important;background-repeat:no-repeat!important;background-position:right 45px bottom 10px!important;background-size:70px 60px!important;margin-top:10px!important;font-weight:500}
.span-sign-box{display:inline!important}
.sign-box span{color:#23b709!important;font-size:13pt!important;text-align:left!important;display:block}
.data-item{width:100%;display:flex;justify-content:left;align-items:flex-start;font-size:13pt;color:#000}
.data-item .di-label{min-height:25px;height:auto;border-bottom:1px dashed transparent;display:flex;align-items:flex-start}
.data-item .di-value{box-sizing:border-box;flex:1;min-height:25px;height:auto;border-bottom:1px dashed #e8e8e8;display:flex;align-items:flex-start;padding-left:10px;justify-content:flex-start}
@page{size:A4;margin:0!important}
@media print{*{-webkit-print-color-adjust:exact;print-color-adjust:exact}body{width:auto;height:auto;margin:0 auto}table,tr,td{page-break-inside:avoid}table thead{display:table-row-group!important}.table-horizontal-wrapper{page-break-inside:avoid;padding-top:5px}.main-page{margin:0;width:initial;min-height:296mm;background:none;border:none}.ft-sign{page-break-inside:avoid!important;page-break-after:auto}.fd-end{padding-top:0!important}.sign-box{line-height:1.2!important}}
</style>
</head>
<body>
<div class="print-page">
<div class="main-page">
  <div class="heading-content">
    <div class="top-content">
      <div style="width:80px;min-height:20px"><div id="qrcodeTable"></div></div>
      <div class="code-content">
        <b>M&#7851;u s&#7889;: ${esc(String(khmshdon))}</b><br>
        <b>K&yacute; hi&#7879;u: ${esc(String(khhdon))}</b><br>
        <b>S&#7889;: ${esc(String(shdon))}</b>
      </div>
    </div>
    <div class="title-heading">
      <h2 class="main-title">${invoiceTitle}</h2>
      <p class="day">${fmtDate(tdlap)}</p>
      ${mccqt ? `<p class="day">MCCQT: ${esc(String(mccqt))}</p>` : ''}
    </div>
  </div>
  <div class="vip-divide"></div>
  <div class="content-info">
    <ul class="list-fill-out">
      ${dataItem('T&ecirc;n ng&#432;&#7901;i b&aacute;n', esc(nbten))}
      ${dataItem('M&atilde; s&#7889; thu&#7871;', esc(nbmst))}
      ${dataItem('M&atilde; c&#7917;a h&agrave;ng', esc(nbmaCh))}
      ${dataItem('T&ecirc;n c&#7917;a h&agrave;ng', esc(nbtenCh))}
      ${dataItem('&#272;&#7883;a ch&#7881;', esc(nbdchi))}
      ${dataItem('&#272;i&#7879;n tho&#7841;i', esc(nbdt))}
      ${dataItem('S&#7889; t&agrave;i kho&#7843;n', esc(nbstk) + (nbnh ? '&nbsp;&nbsp;&nbsp;' + esc(nbnh) : ''))}
      <li><div class="vip-divide" style="margin:5px 0"></div></li>
      ${dataItem('T&ecirc;n ng&#432;&#7901;i mua', esc(nmten))}
      ${dataItem('H&#7885; t&ecirc;n ng&#432;&#7901;i mua', esc(nmHoTen))}
      ${dataItem('M&atilde; s&#7889; thu&#7871;', esc(nmmst))}
      ${dataItem('M&atilde; &#272;VCQHVNSNN', esc(nmDvcq))}
      ${dataItem('CCCD ng&#432;&#7901;i mua', esc(nmCccd))}
      ${dataItem('S&#7889; h&#7897; chi&#7871;u', esc(nmHoChieu))}
      ${dataItem('&#272;&#7883;a ch&#7881;', esc(nmdchi))}
      ${dataItem('S&#7889; t&agrave;i kho&#7843;n', esc(nmstk))}
      ${dataItem('H&igrave;nh th&#7913;c thanh to&aacute;n', esc(httoan))}
      <li class="flex-li">
        ${dataItemContent('S&#7889; b&#7843;ng k&ecirc;', esc(soBangKe), 'width:50%')}
        ${dataItemContent('Ng&agrave;y b&#7843;ng k&ecirc;', esc(ngayBangKe), 'width:50%')}
      </li>
    </ul>
    <table class="res-tb">
      <thead style="text-align:center"><tr>
        <th class="tb-stt">STT</th>
        <th class="tb-stt">T&iacute;nh ch&#7845;t</th>
        <th class="tb-stt">Lo&#7841;i h&agrave;ng ho&aacute; &#273;&#7863;c tr&#432;ng</th>
        <th class="tb-thh">T&ecirc;n h&agrave;ng h&oacute;a, d&#7883;ch v&#7909;</th>
        <th class="tb-dvt">&#272;&#417;n v&#7883; t&iacute;nh</th>
        <th class="tb-sl">S&#7889; l&#432;&#7907;ng</th>
        <th class="tb-dg">&#272;&#417;n gi&aacute;</th>
        <th class="tb-dg">Chi&#7871;t kh&#7845;u</th>
        <th class="tb-ts">Thu&#7871; su&#7845;t</th>
        <th class="tb-ttct">Th&agrave;nh ti&#7873;n ch&#432;a c&oacute; thu&#7871; GTGT</th>
      </tr></thead>
      <tbody>${itemRows || '<tr><td colspan="10" class="tx-center">&mdash;</td></tr>'}</tbody>
    </table>
    <div class="table-horizontal-wrapper">
      <div style="margin-right:10px">
        <table class="res-tb">
          <thead style="text-align:center"><tr>
            <th>Thu&#7871; su&#7845;t</th>
            <th>T&#7893;ng ti&#7873;n ch&#432;a thu&#7871;</th>
            <th>T&#7893;ng ti&#7873;n thu&#7871;</th>
          </tr></thead>
          <tbody>${taxRows}</tbody>
        </table>
      </div>
      <div style="flex:1">
        <table class="res-tb">
          <tbody>
            <tr><td class="tx-center">T&#7893;ng ti&#7873;n ch&#432;a thu&#7871;<br><small>(T&#7893;ng c&#7897;ng th&agrave;nh ti&#7873;n ch&#432;a c&oacute; thu&#7871;)</small></td><td class="tx-center" style="min-width:200px;max-width:300px">${fmtNum(tgtcthue)}</td></tr>
            <tr><td class="tx-center">T&#7893;ng ti&#7873;n thu&#7871; (T&#7893;ng c&#7897;ng ti&#7873;n thu&#7871;)</td><td class="tx-center" style="min-width:200px;max-width:300px">${fmtNum(tgtthue)}</td></tr>
            <tr><td class="tx-center">T&#7893;ng ti&#7873;n ph&iacute;</td><td class="tx-center" style="min-width:200px;max-width:300px">${fmtNum(tgtphi)}</td></tr>
            <tr><td class="tx-center">T&#7893;ng ti&#7873;n chi&#7871;t kh&#7845;u th&#432;&#417;ng m&#7841;i</td><td class="tx-center" style="min-width:200px;max-width:300px">${fmtNum(tgtcktm)}</td></tr>
            <tr><td class="tx-center">T&#7893;ng ti&#7873;n thanh to&aacute;n b&#7857;ng s&#7889;</td><td class="tx-center" style="min-width:200px;max-width:300px">${fmtNum(tgtttbso)}</td></tr>
            <tr><td class="tx-center">T&#7893;ng ti&#7873;n thanh to&aacute;n b&#7857;ng ch&#7919;</td><td class="tx-center" style="min-width:200px;max-width:300px">${esc(tgtttbchu)}</td></tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
  <div class="vip-divide"></div>
  <div class="ft-sign">
    <div class="sign-dx">
      <h3>
        <p>NG&#431;&#7900;I MUA H&Agrave;NG</p>
        <p><i>(Ch&#7919; k&yacute; s&#7889; (n&#7871;u c&oacute;))</i></p>
      </h3>
      <h3>
        <p>NG&#431;&#7900;I B&Aacute;N H&Agrave;NG</p>
        <p><i>(Ch&#7919; k&yacute; &#273;i&#7879;n t&#7917;, ch&#7919; k&yacute; s&#7889;)</i></p>
        ${(signerSubject || cksInfo) ? `<div class="sign-box"><span>Signature Valid</span><span class="span-sign-box">K&yacute; b&#7903;i&nbsp;</span><span id="cks" class="span-sign-box">${esc(signerSubject)}</span><span></span>${signingTime ? `<span class="span-sign-box">K&yacute; ng&agrave;y:&nbsp;</span><span class="span-sign-box">${esc(signingTime)}</span>` : ''}</div>` : ''}
      </h3>
    </div>
    <div class="fd-end"><p><i>(C&#7847;n ki&#7875;m tra, &#273;&#7889;i chi&#7871;u khi l&#7853;p, nh&#7853;n h&oacute;a &#273;&#417;n)</i></p></div>
  </div>
</div>
<input type="hidden" id="qrcodeContent" value="">
</div>
</body>
</html>`;
}

/**
 * Builds a summary report HTML file listing all invoices and their download status.
 */
function buildReportHtml(invoices, params, timeStamp, formats, noXmlInvoices = []) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmtNum = (n) => { const x = Number(n); return isNaN(x) ? '' : x.toLocaleString('vi-VN'); };
  const fmtDateShort = (s) => {
    if (!s) return '';
    const iso = String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
    return String(s).split('T')[0];
  };

  const typeLabel = invoiceTypesReportLabel(params);
  const formatsLabel = (formats || []).join(', ').toUpperCase();
  const now = new Date();
  const nowStr = `${String(now.getDate()).padStart(2,'0')}/${String(now.getMonth()+1).padStart(2,'0')}/${now.getFullYear()} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;

  const noXmlSet = new Set(noXmlInvoices);
  const needsXmlReport = (formats || []).includes('xml');

  const rows = invoices.map((inv, i) => {
    const isNoXml = needsXmlReport && noXmlSet.has(inv);
    const statusCell = isNoXml
      ? `<td class="no-xml">&#9888; Kh&ocirc;ng c&oacute; XML g&#7889;c</td>`
      : `<td class="ok">&#10004; &#272;&atilde; t&#7843;i</td>`;
    return `<tr>
      <td class="tc">${i + 1}</td>
      ${statusCell}
      <td class="tc">${esc(fmtDateShort(inv.tdlap))}</td>
      <td class="tc">${esc(inv.khmshdon || '')}</td>
      <td class="tc">${esc(inv.khhdon || '')}-${esc(String(inv.shdon || ''))}</td>
      <td>${esc(inv.nbten || '')}</td>
      <td class="tc">${esc(inv.nbmst || '')}</td>
      <td>${esc(inv.nmten || '')}</td>
      <td class="tc">${esc(inv.nmmst || '')}</td>
      <td class="tr">${fmtNum(inv.tgtcthue)}</td>
      <td class="tr">${fmtNum(inv.tgtthue)}</td>
      <td class="tr"><b>${fmtNum(inv.tgtttbso)}</b></td>
    </tr>`;
  }).join('');

  const totalTtbso = invoices.reduce((s, inv) => s + (Number(inv.tgtttbso) || 0), 0);
  const totalCthue = invoices.reduce((s, inv) => s + (Number(inv.tgtcthue) || 0), 0);
  const totalThue  = invoices.reduce((s, inv) => s + (Number(inv.tgtthue)  || 0), 0);

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>B&aacute;o c&aacute;o t&#7843;i h&oacute;a &#273;&#417;n</title>
<style>
*{box-sizing:border-box}
body{font-family:"Times New Roman",serif;font-size:12pt;background:#f5f5f5;margin:0;padding:12px}
.pg{max-width:100%;background:#fff;padding:20px;border:2px solid #1a73e8;border-radius:4px}
h2{text-align:center;font-size:16pt;margin:0 0 4px;color:#1a73e8}
.sub{text-align:center;font-size:11pt;color:#555;margin:2px 0 16px}
.stats{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.stat-box{flex:1;min-width:120px;padding:12px 16px;border-radius:6px;text-align:center}
.stat-box .num{font-size:22pt;font-weight:bold;display:block}
.s-total{background:#eff6ff;border:1px solid #bfdbfe;color:#1e40af}
.s-ok{background:#f0fdf4;border:1px solid #bbf7d0;color:#15803d}
table{border-collapse:collapse;width:100%;font-size:10pt}
th{background:#1a73e8;color:#fff;padding:6px 5px;text-align:center;white-space:nowrap}
td{border:1px solid #e2e8f0;padding:5px;vertical-align:middle}
.tc{text-align:center}.tr{text-align:right}
.ok{color:#15803d;font-weight:bold;text-align:center}
.no-xml{color:#b45309;font-weight:bold;text-align:center}
.s-warn{background:#fffbeb;border:1px solid #fde68a;color:#92400e}
tfoot td{background:#f1f5f9;font-weight:bold}
</style>
</head>
<body>
<div class="pg">
  <h2>B&Aacute;O C&Aacute;O T&#7842;I H&Oacute;A &#272;&#416;N &#272;I&#7878;N T&#7916;</h2>
  <p class="sub">Lo&#7841;i: ${esc(typeLabel)} &nbsp;|&nbsp; K&#7923; h&#7841;n: ${esc(params.fromDate)} &rarr; ${esc(params.toDate)} &nbsp;|&nbsp; &#272;&#7883;nh d&#7841;ng: ${formatsLabel} &nbsp;|&nbsp; Th&#7901;i &#273;i&#7875;m t&#7843;i: ${nowStr}</p>
  <div class="stats">
    <div class="stat-box s-total"><span class="num">${invoices.length}</span>T&#7893;ng s&#7889; h&oacute;a &#273;&#417;n</div>
    <div class="stat-box s-ok"><span class="num">${invoices.length - noXmlInvoices.length}</span>T&#7843;i &#273;&#7847;y &#273;&#7911;</div>
    ${needsXmlReport && noXmlInvoices.length > 0 ? `<div class="stat-box s-warn"><span class="num">${noXmlInvoices.length}</span>Kh&ocirc;ng c&oacute; XML g&#7889;c</div>` : ''}
  </div>
  <table>
    <thead><tr>
      <th>STT</th><th>Tr&#7841;ng th&aacute;i</th><th>Ng&agrave;y l&#7853;p</th>
      <th>M&#7851;u s&#7889;</th><th>K&yacute; hi&#7879;u &mdash; S&#7889;</th>
      <th>T&ecirc;n ng&#432;&#7901;i b&aacute;n</th><th>MST b&aacute;n</th>
      <th>T&ecirc;n ng&#432;&#7901;i mua</th><th>MST mua</th>
      <th>Ti&#7873;n ch&#432;a thu&#7871;</th><th>Ti&#7873;n thu&#7871;</th><th>T&#7893;ng thanh to&aacute;n</th>
    </tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr>
      <td colspan="9" class="tr">T&#7893;ng c&#7897;ng:</td>
      <td class="tr">${fmtNum(totalCthue)}</td>
      <td class="tr">${fmtNum(totalThue)}</td>
      <td class="tr">${fmtNum(totalTtbso)}</td>
    </tr></tfoot>
  </table>
</div>
</body>
</html>`;
}

/**
 * Extracts XML string from a raw response body.
 * Handles: direct XML, JSON-wrapped XML string, JSON-wrapped base64 XML.
 */
function extractXmlContent(responseBody) {
  if (!responseBody) return null;
  const trimmed = responseBody.trim();

  // Direct XML response
  if (trimmed.startsWith('<')) return trimmed;

  // JSON-wrapped XML
  try {
    const json = JSON.parse(trimmed);
    const candidate = json.fileContent || json.data || json.xml || json.content || json.fileXml || json.body;
    if (!candidate) return null;

    // Base64-encoded XML
    try {
      const decoded = atob(candidate);
      if (decoded.trim().startsWith('<')) return decoded;
    } catch (_) {}

    // Raw XML string inside JSON
    if (candidate.trim().startsWith('<')) return candidate;
  } catch (_) {}

  return null;
}

function pdfValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (!isBlankValue(value)) return value;
  }
  return '';
}

function pdfFormatNumber(value) {
  if (isBlankValue(value)) return '';
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toLocaleString('vi-VN') : String(value);
}

function pdfDateText(value) {
  if (isBlankValue(value)) return '';
  const raw = String(value);
  let day;
  let month;
  let year;
  if (raw.includes('/')) {
    [day, month, year] = raw.split('/');
  } else if (raw.includes('-')) {
    const parts = raw.split('T')[0].split('-');
    [year, month, day] = parts;
  }
  return day && month && year ? `Ngày ${day} tháng ${month} năm ${year}` : raw;
}

function pdfInvoiceTitle(inv, detail) {
  const hdon = String(firstNonBlank(detail?.hdon, inv?.hdon, '01'));
  const titleMap = {
    '01': 'HOÁ ĐƠN GIÁ TRỊ GIA TĂNG',
    '02': 'HOÁ ĐƠN BÁN HÀNG',
    '03': 'HOÁ ĐƠN BÁN HÀNG',
    '04': 'HOÁ ĐƠN BÁN TÀI SẢN CÔNG'
  };
  return titleMap[hdon] || titleMap['01'];
}

function pdfPaymentText(detail) {
  const paymentMap = {
    1: 'Tiền mặt',
    2: 'Chuyển khoản',
    3: 'Tiền mặt/Chuyển khoản',
    4: 'Thẻ',
    5: 'Tiền mặt/Thẻ',
    6: 'Chuyển khoản/Thẻ',
    7: 'Tiền mặt/Chuyển khoản/Thẻ',
    8: 'Bù trừ công nợ',
    9: 'Khác'
  };
  const code = Number(detail?.htttoan);
  return pdfValue(detail?.thtttoan) || (!Number.isNaN(code) && paymentMap[code]) || '';
}

function pdfItemNatureText(code) {
  const map = {
    1: 'Hàng hóa, dịch vụ',
    2: 'Khuyến mại',
    3: 'Chiết khấu thương mại',
    4: 'Ghi chú, diễn giải',
    5: 'Hàng hóa đặc trưng'
  };
  if (isBlankValue(code)) return '';
  return map[Number(code)] || String(code);
}

function pdfTaxRateText(value) {
  if (isBlankValue(value)) return '';
  if (typeof value === 'number') {
    const percent = value > 1 ? value : value * 100;
    return `${Number(percent.toFixed(6)).toLocaleString('vi-VN')}%`;
  }
  return String(value).trim();
}

function pdfArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function pdfLine(lineWidth = 0.5, margin = [0, 8, 0, 8]) {
  return {
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 567, y2: 0, lineWidth, lineColor: '#9a6529' }],
    margin
  };
}

function pdfInfoRow(label, value, labelWidth = 96) {
  return {
    table: {
      widths: [labelWidth, '*'],
      body: [[
        { text: `${label}:`, border: [false, false, false, false] },
        { text: pdfValue(value) || ' ', border: [false, false, false, false] }
      ]]
    },
    layout: 'hdDashedField',
    margin: [0, 0, 0, 1]
  };
}

function pdfTwoInfoRow(leftLabel, leftValue, rightLabel, rightValue) {
  return {
    columns: [
      { width: '*', stack: [pdfInfoRow(leftLabel, leftValue, 78)] },
      { width: '*', stack: [pdfInfoRow(rightLabel, rightValue, 86)] }
    ],
    columnGap: 12
  };
}

function pdfTableLayout(lineWidth = 0.55, padding = 6, horizontalPadding = 4) {
  return {
    hLineWidth: () => lineWidth,
    vLineWidth: () => lineWidth,
    hLineColor: () => '#000000',
    vLineColor: () => '#000000',
    paddingLeft: () => horizontalPadding,
    paddingRight: () => horizontalPadding,
    paddingTop: () => padding,
    paddingBottom: () => padding
  };
}

function pdfHeaderCell(text, options = {}) {
  return {
    text,
    bold: true,
    alignment: 'center',
    fontSize: 12,
    lineHeight: 1.15,
    ...options
  };
}

function pdfBodyCell(text, options = {}) {
  return {
    text: pdfValue(text),
    fontSize: 12,
    lineHeight: 1.2,
    ...options
  };
}

function pdfSignatureInfo(detail, sellerName) {
  let parsed = null;
  try {
    if (detail?.nbcks) parsed = JSON.parse(detail.nbcks);
  } catch (_) {}

  return {
    signer: pdfValue(parsed?.Subject || parsed?.X509SubjectName || sellerName),
    signingTime: pdfValue(parsed?.SigningTime || '')
  };
}

function splitLongSignatureToken(token, maxLength) {
  const text = pdfValue(token);
  if (text.length <= maxLength) return [text];

  const parts = [];
  for (let i = 0; i < text.length; i += maxLength) {
    parts.push(text.slice(i, i + maxLength));
  }
  return parts;
}

function wrapSignatureLine(line, maxLength = 36) {
  const words = pdfValue(line).trim().split(/\s+/).filter(Boolean);
  const wrapped = [];
  let current = '';

  words.forEach(word => {
    const wordParts = splitLongSignatureToken(word, maxLength);
    wordParts.forEach(part => {
      if (!current) {
        current = part;
      } else if (`${current} ${part}`.length <= maxLength) {
        current += ` ${part}`;
      } else {
        wrapped.push(current);
        current = part;
      }
    });
  });

  if (current) wrapped.push(current);
  return wrapped;
}

function pdfSignatureSubjectLines(value) {
  const normalized = pdfValue(value)
    .replace(/\s+/g, ' ')
    .replace(/OID\.[\d.]+=MST:/gi, 'MST:')
    .replace(/OID\.[\d.]+=/gi, '')
    .trim();

  if (!normalized) return [];

  return normalized
    .split(/,\s*/)
    .map(part => part.trim())
    .filter(Boolean)
    .flatMap(part => wrapSignatureLine(part));
}

async function generatePdfBytesFromInvoice(inv, detail) {
  return generatePdfBytesFromInvoiceWithPdfMakeTemplate(inv, detail);
}

async function generatePdfBytesFromInvoiceWithPdfMakeTemplate(inv, detail) {
  const d = detail || {};

  const khmshdon = pdfValue(firstNonBlank(d.khmshdon, inv?.khmshdon));
  const khhdon = pdfValue(firstNonBlank(d.khhdon, inv?.khhdon));
  const shdon = pdfValue(firstNonBlank(d.shdon, inv?.shdon));
  const tdlap = firstNonBlank(d.tdlap, inv?.tdlap);
  const mccqt = pdfValue(firstNonBlank(d.mttcqt, inv?.mttcqt, d.mtdtchieu, inv?.mtdtchieu));

  const sellerName = pdfValue(firstNonBlank(d.nbten, inv?.nbten));
  const sellerTaxCode = pdfValue(firstNonBlank(d.nbmst, inv?.nbmst));
  const sellerStoreCode = pdfValue(firstNonBlank(d.nbmcuahang, d.nbmch, d.nbmchhang));
  const sellerStoreName = pdfValue(firstNonBlank(d.nbtencuahang, d.nbtch, d.nbtchhang));
  const sellerAddress = pdfValue(d.nbdchi);
  const sellerPhone = pdfValue(firstNonBlank(d.nbsdthoai, d.nbdt));
  const sellerBank = [d.nbstkhoan, d.nbtnhang].filter(value => !isBlankValue(value)).join('     ');

  const buyerName = pdfValue(firstNonBlank(d.nmten, inv?.nmten));
  const buyerFullName = pdfValue(firstNonBlank(d.nmhoten, d.nmhvt, d.nmtennguoimua));
  const buyerTaxCode = pdfValue(firstNonBlank(d.nmmst, inv?.nmmst));
  const buyerBudgetCode = pdfValue(firstNonBlank(d.nmdvcqhvnsnn, d.nmdvcq, d.madvcqhvnsnn));
  const buyerId = pdfValue(firstNonBlank(d.nmcccd, d.nmcmnd, d.nmshcccd));
  const buyerPassport = pdfValue(firstNonBlank(d.nmhochieu, d.nmshochieu, d.nmshchieu));
  const buyerAddress = pdfValue(d.nmdchi);
  const buyerBank = pdfValue(d.nmstkhoan);
  const paymentText = pdfPaymentText(d);
  const listNo = pdfValue(firstNonBlank(d.sobke, d.sbke));
  const listDate = pdfValue(firstNonBlank(d.ngaybke, d.nbke));

  const totalBeforeTax = firstNonBlank(d.tgtcthue, inv?.tgtcthue, 0);
  const totalTax = firstNonBlank(d.tgtthue, inv?.tgtthue, 0);
  const totalAmount = firstNonBlank(d.tgtttbso, inv?.tgtttbso, 0);
  const amountInWords = pdfValue(firstNonBlank(d.tgtttbchu, inv?.tgtttbchu));
  const totalFees = firstNonBlank(d.tgtphi, 0);
  const totalDiscount = firstNonBlank(d.tgtcktm, d.tgtck, inv?.tgtck, 0);

  const items = pdfArray(d.hdhhdvu || d.hhonDs || d.hhdvu);
  const itemRows = items.length > 0
    ? items.map((item, index) => [
        pdfBodyCell(firstNonBlank(item.stt, index + 1), { alignment: 'center' }),
        pdfBodyCell(pdfItemNatureText(item.tchat)),
        pdfBodyCell(''),
        pdfBodyCell(itemName(item)),
        pdfBodyCell(item.dvtinh, { alignment: 'center' }),
        pdfBodyCell(pdfFormatNumber(itemQuantity(item)), { alignment: 'center' }),
        pdfBodyCell(pdfFormatNumber(itemUnitPrice(item)), { alignment: 'right' }),
        pdfBodyCell(!isBlankValue(item.stckhau) ? pdfFormatNumber(item.stckhau) : '', { alignment: 'center' }),
        pdfBodyCell(pdfTaxRateText(firstNonBlank(item.tsuat, item.ltsuat)), { alignment: 'center' }),
        pdfBodyCell(pdfFormatNumber(itemAmount(item)), { alignment: 'right' })
      ])
    : [[
        { text: '', colSpan: 10, border: [true, true, true, true], margin: [0, 12, 0, 12] },
        {}, {}, {}, {}, {}, {}, {}, {}, {}
      ]];

  const taxEntries = pdfArray(d.thttltsuat);
  const taxRows = taxEntries.length > 0
    ? taxEntries.map(tax => [
        pdfBodyCell(pdfTaxRateText(tax.tsuat), { alignment: 'center' }),
        pdfBodyCell(pdfFormatNumber(tax.thtien), { alignment: 'right' }),
        pdfBodyCell(pdfFormatNumber(tax.tthue), { alignment: 'right' })
      ])
    : [[
        pdfBodyCell('', { alignment: 'center' }),
        pdfBodyCell(pdfFormatNumber(totalBeforeTax), { alignment: 'right' }),
        pdfBodyCell(pdfFormatNumber(totalTax), { alignment: 'right' })
      ]];

  const totalsRows = [
    [pdfBodyCell('Tổng tiền chưa thuế\n(Tổng cộng thành tiền\nchưa có thuế)', { alignment: 'center' }), pdfBodyCell(pdfFormatNumber(totalBeforeTax), { alignment: 'center' })],
    [pdfBodyCell('Tổng tiền thuế (Tổng cộng\ntiền thuế)', { alignment: 'center' }), pdfBodyCell(pdfFormatNumber(totalTax), { alignment: 'center' })],
    [pdfBodyCell('Tổng tiền phí', { alignment: 'center' }), pdfBodyCell(pdfFormatNumber(totalFees), { alignment: 'center' })],
    [pdfBodyCell('Tổng tiền chiết khấu\nthương mại', { alignment: 'center' }), pdfBodyCell(pdfFormatNumber(totalDiscount), { alignment: 'center' })],
    [pdfBodyCell('Tổng tiền thanh toán bằng\nsố', { alignment: 'center' }), pdfBodyCell(pdfFormatNumber(totalAmount), { alignment: 'center' })],
    [pdfBodyCell('Tổng tiền thanh toán bằng\nchữ', { alignment: 'center' }), pdfBodyCell(amountInWords, { alignment: 'center' })]
  ];

  const signature = pdfSignatureInfo(d, sellerName);
  const signatureSubjectLines = pdfSignatureSubjectLines(signature.signer);
  const sellerSignatureBox = signature.signer
    ? {
        table: {
          widths: ['*'],
          body: [[{
            stack: [
              { text: 'Signature Valid', color: '#23b709', fontSize: 10 },
              { text: 'Ký bởi', color: '#23b709', fontSize: 8.8, lineHeight: 1.05 },
              ...signatureSubjectLines.map(line => ({
                text: line,
                color: '#23b709',
                fontSize: 8.8,
                lineHeight: 1.05
              })),
              ...(signature.signingTime ? [{
                text: `Ký ngày: ${signature.signingTime}`,
                color: '#23b709',
                fontSize: 8.8,
                lineHeight: 1.05
              }] : [])
            ],
            margin: [7, 5, 7, 5]
          }]]
        },
        layout: 'hdSignatureBox',
        margin: [12, 10, 12, 0]
      }
    : { text: '', margin: [0, 60, 0, 0] };

  const docDef = {
    pageSize: { width: 655, height: 842 },
    pageMargins: [14, 18, 14, 22],
    defaultStyle: { font: 'NotoSerif', fontSize: 12, lineHeight: 1.22 },
    styles: {
      title: { bold: true, fontSize: 19, alignment: 'center' },
      subTitle: { fontSize: 13, alignment: 'center' }
    },
    content: [
      {
        columns: [
          { width: '*', text: '' },
          {
            width: 135,
            stack: [
              { text: `Mẫu số: ${khmshdon}`, bold: true, fontSize: 12.5 },
              { text: `Ký hiệu: ${khhdon}`, bold: true, fontSize: 12.5, margin: [0, 6, 0, 0] },
              { text: `Số: ${shdon}`, bold: true, fontSize: 12.5, margin: [0, 6, 0, 0] }
            ]
          }
        ],
        margin: [0, 0, 0, 30]
      },
      { text: pdfInvoiceTitle(inv, d), style: 'title', margin: [0, 0, 0, 16] },
      { text: pdfDateText(tdlap), style: 'subTitle', margin: [0, 0, 0, 22] },
      ...(mccqt ? [{ text: `MCCQT: ${mccqt}`, style: 'subTitle', margin: [0, 0, 0, 22] }] : []),
      pdfLine(0.45, [0, 0, 0, 10]),

      pdfInfoRow('Tên người bán', sellerName, 92),
      pdfInfoRow('Mã số thuế', sellerTaxCode, 78),
      pdfInfoRow('Mã cửa hàng', sellerStoreCode, 86),
      pdfInfoRow('Tên cửa hàng', sellerStoreName, 92),
      pdfInfoRow('Địa chỉ', sellerAddress, 56),
      pdfInfoRow('Điện thoại', sellerPhone, 72),
      pdfInfoRow('Số tài khoản', sellerBank, 88),
      pdfLine(0.45, [0, 5, 0, 5]),

      pdfInfoRow('Tên người mua', buyerName, 94),
      pdfInfoRow('Họ tên người mua', buyerFullName, 112),
      pdfInfoRow('Mã số thuế', buyerTaxCode, 78),
      pdfInfoRow('Mã ĐVCQHVNSNN', buyerBudgetCode, 116),
      pdfInfoRow('CCCD người mua', buyerId, 108),
      pdfInfoRow('Số hộ chiếu', buyerPassport, 86),
      pdfInfoRow('Địa chỉ', buyerAddress, 56),
      pdfInfoRow('Số tài khoản', buyerBank, 88),
      pdfInfoRow('Hình thức thanh toán', paymentText, 132),
      pdfTwoInfoRow('Số bảng kê', listNo, 'Ngày bảng kê', listDate),

      {
        pageBreak: 'before',
        table: {
          headerRows: 1,
          widths: [29, 36, 38, '*', 40, 38, 82, 40, 38, 110],
          body: [
            [
              pdfHeaderCell('STT'),
              pdfHeaderCell('Tính\nchất'),
              pdfHeaderCell('Loại\nhàng\nhoá\nđặc\ntrưng'),
              pdfHeaderCell('Tên hàng hóa,\ndịch vụ'),
              pdfHeaderCell('Đơn vị\ntính'),
              pdfHeaderCell('Số\nlượng'),
              pdfHeaderCell('Đơn giá'),
              pdfHeaderCell('Chiết\nkhấu'),
              pdfHeaderCell('Thuế\nsuất'),
              pdfHeaderCell('Thành tiền chưa có\nthuế GTGT')
            ],
            ...itemRows
          ]
        },
        layout: 'hdInvoiceTable',
        margin: [0, 0, 0, 14]
      },

      {
        columns: [
          {
            width: 'auto',
            table: {
              headerRows: 1,
              widths: [55, 95, 70],
              body: [
                [pdfHeaderCell('Thuế suất'), pdfHeaderCell('Tổng tiền chưa thuế'), pdfHeaderCell('Tổng tiền thuế')],
                ...taxRows
              ]
            },
            layout: 'hdInvoiceTableCompact'
          },
          { width: 14, text: '' },
          {
            width: '*',
            table: {
              widths: [155, '*'],
              body: totalsRows
            },
            layout: 'hdInvoiceTableCompact'
          }
        ],
        margin: [0, 0, 0, 8]
      },

      pdfLine(0.45, [0, 4, 0, 14]),

      {
        columns: [
          {
            width: '*',
            stack: [
              { text: 'NGƯỜI MUA HÀNG', alignment: 'center', fontSize: 13 },
              { text: '(Chữ ký số (nếu có))', alignment: 'center', italics: true, fontSize: 11, margin: [0, 14, 0, 0] }
            ]
          },
          {
            width: '*',
            stack: [
              { text: 'NGƯỜI BÁN HÀNG', alignment: 'center', fontSize: 13 },
              { text: '(Chữ ký điện tử, chữ ký số)', alignment: 'center', italics: true, fontSize: 11, margin: [0, 14, 0, 0] },
              sellerSignatureBox
            ]
          }
        ],
        columnGap: 20,
        margin: [0, 0, 0, 8]
      },

      {
        text: '(Cần kiểm tra, đối chiếu khi lập, nhận hóa đơn)',
        alignment: 'center',
        italics: true,
        fontSize: 11,
        width: 655,
        absolutePosition: { x: 0, y: 822 }
      }
    ]
  };

  return renderPdfBytesWithPdfMake(docDef);
}

/**
 * Fallback renderer for browsers where offscreen HTML rendering is unavailable.
 * Uses pdfmake, so it is less visually faithful than the HTML path.
 */
async function generatePdfBytesFromInvoiceWithPdfMake(inv, detail) {
  const d = detail || {};

  const fmtNum = (n) => {
    if (n === null || n === undefined || n === '') return '';
    const num = Number(n);
    return isNaN(num) ? String(n) : num.toLocaleString('vi-VN');
  };

  const fmtDate = (s) => {
    if (!s) return '';
    s = String(s);
    let day, month, year;
    if (s.includes('/')) { [day, month, year] = s.split('/'); }
    else if (s.includes('-')) { const p = s.split('T')[0].split('-'); year = p[0]; month = p[1]; day = p[2]; }
    else return s;
    return `Ngày ${day} tháng ${month} năm ${year}`;
  };

  const str = (v) => String(v || '');

  const hdon = str(d.hdon || inv.hdon || '01');
  const titleMap = {
    '01': 'HÓA ĐƠN GIÁ TRỊ GIA TĂNG',
    '02': 'HÓA ĐƠN BÁN HÀNG',
    '03': 'HÓA ĐƠN BÁN HÀNG',
    '04': 'HÓA ĐƠN BÁN TÀI SẢN CÔNG'
  };
  const invoiceTitle = titleMap[hdon] || titleMap['01'];

  const khmshdon = str(d.khmshdon || inv.khmshdon);
  const khhdon   = str(d.khhdon   || inv.khhdon);
  const shdon    = str(d.shdon    || inv.shdon);
  const tdlap    = str(d.tdlap    || inv.tdlap);
  const mccqt    = str(d.mttcqt   || inv.mttcqt || d.mtdtchieu || inv.mtdtchieu);

  const nbten  = str(d.nbten  || inv.nbten);
  const nbmst  = str(d.nbmst  || inv.nbmst);
  const nbdchi = str(d.nbdchi);
  const nbdt   = str(d.nbsdthoai || d.nbdt);
  const nbstk  = str(d.nbstkhoan);
  const nbnh   = str(d.nbtnhang);

  const nmten  = str(d.nmten  || inv.nmten);
  const nmmst  = str(d.nmmst  || inv.nmmst);
  const nmdchi = str(d.nmdchi);
  const nmstk  = str(d.nmstkhoan);

  const httoanMap = { 1:'Tiền mặt', 2:'Chuyển khoản', 3:'Tiền mặt/Chuyển khoản', 4:'Thẻ', 5:'Tiền mặt/Thẻ', 6:'Chuyển khoản/Thẻ', 7:'Tiền mặt/Chuyển khoản/Thẻ', 8:'Bù trừ công nợ', 9:'Khác' };
  const httoanCode = Number(d.htttoan);
  const httoan = str(d.thtttoan) || (!isNaN(httoanCode) && httoanMap[httoanCode]) || '';

  const tgtcthue  = d.tgtcthue  || inv.tgtcthue  || 0;
  const tgtthue   = d.tgtthue   || inv.tgtthue   || 0;
  const tgtttbso  = d.tgtttbso  || inv.tgtttbso  || 0;
  const tgtttbchu = str(d.tgtttbchu || inv.tgtttbchu);
  const tgtphi    = d.tgtphi    || 0;
  const tgtcktm   = d.tgtcktm   || d.tgtck || inv.tgtck || 0;

  let pdfCksInfo = null;
  try { if (d.nbcks) pdfCksInfo = JSON.parse(d.nbcks); } catch (_) {}
  const pdfSigningTime = pdfCksInfo?.SigningTime
    ? (() => { const t = new Date(pdfCksInfo.SigningTime); return `${String(t.getDate()).padStart(2,'0')}/${String(t.getMonth()+1).padStart(2,'0')}/${t.getFullYear()} ${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`; })()
    : '';

  const items = d.hdhhdvu || [];
  const tchatMap = { '1': 'Hàng hóa, dịch vụ', '2': 'Khuyến mại', '3': 'Chiết khấu thương mại', '4': 'Ghi chú, diễn giải', '5': 'Hàng hóa đặc trưng' };
  const taxEntries = d.thttltsuat || [];

  const labelVal = (label, value) => ({
    table: {
      widths: [120, '*'],
      body: [[ { text: label + ':', bold: true }, { text: value } ]]
    },
    layout: {
      defaultBorder: false,
      hLineWidth: (i) => (i === 1 ? 0.5 : 0),
      vLineWidth: () => 0,
      hLineColor: () => '#cccccc',
      hLineStyle: () => ({ dash: { length: 3, space: 3 } }),
      paddingLeft: (i) => (i === 0 ? 0 : 8),
      paddingRight: () => 0,
      paddingTop: () => 2,
      paddingBottom: () => 2,
    },
    margin: [0, 1, 0, 2]
  });

  const goldLine = (w) => ({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 523, y2: 0, lineWidth: w, lineColor: '#9A6529' }],
    margin: [0, 6, 0, 8]
  });

  const itemsTableBody = [
    [
      { text: 'STT',                    style: 'th', alignment: 'center' },
      { text: 'Tính chất',              style: 'th', alignment: 'center' },
      { text: 'Loại đặc trưng',         style: 'th', alignment: 'center' },
      { text: 'Tên hàng hóa, dịch vụ', style: 'th' },
      { text: 'ĐVT',                    style: 'th', alignment: 'center' },
      { text: 'Số lượng',               style: 'th', alignment: 'center' },
      { text: 'Đơn giá',                style: 'th', alignment: 'right' },
      { text: 'Chiết khấu',             style: 'th', alignment: 'center' },
      { text: 'Thuế suất',              style: 'th', alignment: 'center' },
      { text: 'Thành tiền',             style: 'th', alignment: 'right' },
    ],
    ...items.map((item, i) => [
      { text: str(item.stt || i + 1), alignment: 'center', fontSize: 9 },
      { text: tchatMap[str(item.tchat)] || str(item.tchat), fontSize: 9 },
      { text: '', fontSize: 9 },
      { text: str(item.ten), fontSize: 9 },
      { text: str(item.dvtinh), alignment: 'center', fontSize: 9 },
      { text: fmtNum(item.sluong), alignment: 'center', fontSize: 9 },
      { text: fmtNum(item.dgia), alignment: 'right', fontSize: 9 },
      { text: item.stckhau != null ? fmtNum(item.stckhau) : '', alignment: 'center', fontSize: 9 },
      { text: str(item.ltsuat), alignment: 'center', fontSize: 9 },
      { text: fmtNum(item.thtien), alignment: 'right', fontSize: 9 },
    ])
  ];

  const taxBody = [
    [
      { text: 'Thuế suất',       style: 'th', alignment: 'center' },
      { text: 'Tiền chưa thuế', style: 'th', alignment: 'right' },
      { text: 'Tiền thuế',       style: 'th', alignment: 'right' },
    ],
    ...(taxEntries.length > 0
      ? taxEntries.map(t => [
          { text: str(t.tsuat), alignment: 'center', fontSize: 9 },
          { text: fmtNum(t.thtien), alignment: 'right', fontSize: 9 },
          { text: fmtNum(t.tthue), alignment: 'right', fontSize: 9 },
        ])
      : [[
          { text: '—', alignment: 'center', fontSize: 9 },
          { text: fmtNum(tgtcthue), alignment: 'right', fontSize: 9 },
          { text: fmtNum(tgtthue), alignment: 'right', fontSize: 9 },
        ]]
    )
  ];

  const totalsBody = [
    [{ text: 'Tổng tiền chưa thuế:', bold: true, fontSize: 9 }, { text: fmtNum(tgtcthue), alignment: 'right', fontSize: 9 }],
    [{ text: 'Tổng tiền thuế:', bold: true, fontSize: 9 }, { text: fmtNum(tgtthue), alignment: 'right', fontSize: 9 }],
    ...(Number(tgtphi)  ? [[{ text: 'Tổng tiền phí:', bold: true, fontSize: 9 }, { text: fmtNum(tgtphi), alignment: 'right', fontSize: 9 }]] : []),
    ...(Number(tgtcktm) ? [[{ text: 'Chiết khấu thương mại:', bold: true, fontSize: 9 }, { text: fmtNum(tgtcktm), alignment: 'right', fontSize: 9 }]] : []),
    [{ text: 'Tổng thanh toán bằng số:', bold: true, fontSize: 9 }, { text: fmtNum(tgtttbso), alignment: 'right', bold: true, fontSize: 9 }],
    ...(tgtttbchu ? [[{ text: 'Bằng chữ:', bold: true, fontSize: 9 }, { text: tgtttbchu, italics: true, fontSize: 9 }]] : []),
  ];

  const signBoxContent = (nbten || pdfCksInfo)
    ? {
        table: {
          widths: ['*'],
          body: [[{
            stack: [
              { text: 'Signature Valid', color: '#23b709', fontSize: 10 },
              { text: `Ký bởi ${nbten}`, color: '#23b709', fontSize: 10 },
              ...(pdfSigningTime ? [{ text: `Ký ngày: ${pdfSigningTime}`, color: '#23b709', fontSize: 10 }] : [])
            ],
            margin: [4, 4, 4, 4]
          }]]
        },
        layout: {
          hLineWidth: () => 1.5,
          vLineWidth: () => 1.5,
          hLineColor: () => '#23b709',
          vLineColor: () => '#23b709',
        },
        margin: [0, 6, 0, 0]
      }
    : { text: '', margin: [0, 6, 0, 0] };

  const docDef = {
    pageSize: 'A4',
    pageMargins: [36, 36, 36, 36],
    defaultStyle: { font: 'Roboto', fontSize: 10, lineHeight: 1.3 },
    styles: {
      th: { bold: true, fontSize: 9, fillColor: '#f0f0f0' },
    },
    content: [
      {
        alignment: 'right',
        stack: [
          { text: `Mẫu số: ${khmshdon}`, bold: true, fontSize: 10 },
          { text: `Ký hiệu: ${khhdon}`, bold: true, fontSize: 10 },
          { text: `Số: ${shdon}`, bold: true, fontSize: 10 },
        ],
        margin: [0, 0, 0, 6]
      },
      { text: invoiceTitle, bold: true, fontSize: 16, alignment: 'center', margin: [0, 0, 0, 4] },
      { text: fmtDate(tdlap), fontSize: 11, alignment: 'center', margin: [0, 0, 0, 2] },
      ...(mccqt ? [{ text: `MCCQT: ${mccqt}`, fontSize: 10, alignment: 'center', margin: [0, 0, 0, 2] }] : []),
      goldLine(1),

      labelVal('Tên người bán', nbten),
      labelVal('Mã số thuế', nbmst),
      ...(nbdchi ? [labelVal('Địa chỉ', nbdchi)] : []),
      ...(nbdt   ? [labelVal('Điện thoại', nbdt)] : []),
      ...(nbstk  ? [labelVal('Số tài khoản', nbstk + (nbnh ? '  ' + nbnh : ''))] : []),

      goldLine(0.5),

      labelVal('Tên người mua', nmten),
      labelVal('Mã số thuế', nmmst),
      ...(nmdchi ? [labelVal('Địa chỉ', nmdchi)] : []),
      ...(nmstk  ? [labelVal('Số tài khoản', nmstk)] : []),
      ...(httoan ? [labelVal('Hình thức thanh toán', httoan)] : []),

      goldLine(1),

      {
        table: {
          headerRows: 1,
          widths: [18, 50, 42, '*', 28, 30, 48, 30, 28, 48],
          body: itemsTableBody
        },
        margin: [0, 0, 0, 10]
      },

      {
        columns: [
          {
            width: 'auto',
            table: { headerRows: 1, widths: [38, 75, 65], body: taxBody }
          },
          { width: '*', text: '' },
          {
            width: 220,
            table: { widths: ['*', 100], body: totalsBody }
          }
        ],
        margin: [0, 0, 0, 10]
      },

      goldLine(1),

      {
        columns: [
          {
            stack: [
              { text: 'NGƯỜI MUA HÀNG', bold: true, alignment: 'center' },
              { text: '(Chữ ký số nếu có)', italics: true, fontSize: 9, alignment: 'center' }
            ]
          },
          {
            stack: [
              { text: 'NGƯỜI BÁN HÀNG', bold: true, alignment: 'center' },
              { text: '(Chữ ký điện tử, chữ ký số)', italics: true, fontSize: 9, alignment: 'center' },
              signBoxContent
            ]
          }
        ],
        margin: [0, 0, 0, 36]
      },

      { text: '(Cần kiểm tra, đối chiếu khi lập, nhận hóa đơn)', italics: true, alignment: 'center', fontSize: 9 }
    ]
  };

  return renderPdfBytesWithPdfMake(docDef);
}
