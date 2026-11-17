'use strict';

/**
 * lancache-warmer 预热面板。
 *
 * 纯原生 JS，无框架、无构建步骤。页面只通过同源相对路径访问服务端：
 * 登录、游戏库（浏览器本地保存）、预填充任务、SSE 日志。任何请求失败都会
 * 以 toast 或登录卡片内的提示呈现，不会被静默吞掉。
 */

const POLL_INTERVAL_MS = 2000;
const QR_TTL_MS = 120 * 1000;
const LOG_LIMIT = 500;
const LIBRARY_STORAGE_KEY = 'lancache-warmer.library.v1';
const LOGIN_HINT_KEY = 'lancache-warmer.logged-in.v1';
const MAX_LIBRARY_ITEMS = 2000;
const MAX_NAME_LENGTH = 120;
const REQUEST_TIMEOUT_MS = 15000;

const API = Object.freeze({
  health: '/health',
  loginQr: '/api/login/qr',
  loginStatus: '/api/login/status',
  logout: '/api/logout',
  prefill: '/api/prefill',
  task: '/api/task',
  cancel: '/api/cancel',
  logs: '/api/logs',
});

const TASK_STATE_LABELS = Object.freeze({
  idle: '空闲',
  running: '运行中',
  done: '已完成',
  failed: '失败',
  cancelled: '已停止',
});

/** @type {Record<string, HTMLElement>} */
const dom = {};

const state = {
  loggedIn: false,
  storageAvailable: true,

  library: [],
  // appid → 该游戏的 DLC appid 列表（由 /api/depot-names 提供）
  dlcMap: {},
  selected: new Set(),

  task: null,
  taskRunning: false,
  taskVisible: false,
  taskFetching: false,
  taskPollErrorShown: false,
  startingTask: false,
  stoppingTask: false,
  cancelRequested: false,
  logoutBusy: false,

  login: {
    sessionId: '',
    expiresAt: 0,
    starting: false,
    polling: false,
    pollTimer: 0,
    countdownTimer: 0,
    pollFailed: false,
  },

  logSource: null,
  taskTimer: 0,
};

const noticeTimes = new Map();
const activeToasts = new Map();

class ApiError extends Error {
  /**
   * @param {string} message
   * @param {number} status HTTP status, or 0 when the request never reached the server.
   * @param {unknown} [payload]
   */
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/**
 * @param {string} id
 * @returns {HTMLElement}
 */
function byId(id) {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`missing DOM node #${id}`);
  }
  return node;
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function errorText(error) {
  if (error instanceof Error && error.message.trim() !== '') {
    return error.message;
  }
  return '未知错误';
}

/**
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value === 0) {
    return '0 B';
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }

  const digits = unit === 0 || scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)} ${units[unit]}`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/**
 * @param {string | null | undefined} value
 * @returns {string}
 */
function formatClock(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function countOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

/**
 * @param {string} message
 * @param {'error' | 'warning' | 'success' | 'info'} [kind]
 * @param {{ duration?: number }} [options]
 */
function notify(message, kind = 'error', options = {}) {
  const text = String(message ?? '').trim();
  if (text === '') {
    return;
  }

  const safeKind = kind === 'warning' || kind === 'success' || kind === 'info'
    ? kind
    : 'error';
  const duration = Number.isFinite(options.duration)
    ? Number(options.duration)
    : safeKind === 'error'
      ? 7000
      : 4200;

  const existing = activeToasts.get(`${safeKind}:${text}`);
  if (existing !== undefined && !existing.classList.contains('is-leaving')) {
    clearTimeout(existing._timer);
    existing._timer = window.setTimeout(() => dismissToast(existing), duration);
    return;
  }

  if (dom.toasts.children.length >= 4) {
    dismissToast(dom.toasts.firstElementChild);
  }

  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.dataset.kind = safeKind;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = safeKind === 'error'
    ? '!'
    : safeKind === 'warning'
      ? '!'
      : safeKind === 'success'
        ? '✓'
        : 'i';

  const body = document.createElement('span');
  body.className = 'toast-text';
  body.textContent = text;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-close';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.addEventListener('click', () => dismissToast(toast));

  toast.append(icon, body, close);
  toast._timer = window.setTimeout(() => dismissToast(toast), duration);
  activeToasts.set(`${safeKind}:${text}`, toast);
  dom.toasts.append(toast);
}

/**
 * 同一类轮询错误只提示一次，避免每 2 秒刷一条。
 *
 * @param {string} key
 * @param {string} message
 * @param {'error' | 'warning' | 'success' | 'info'} [kind]
 * @param {number} [cooldownMs]
 */
function notifyOnce(key, message, kind = 'error', cooldownMs = 10000) {
  const now = Date.now();
  const last = noticeTimes.get(key) ?? 0;
  if (now - last < cooldownMs) {
    return;
  }
  noticeTimes.set(key, now);
  notify(message, kind);
}

/**
 * @param {Element | null} toast
 */
function dismissToast(toast) {
  if (toast === null || !(toast instanceof HTMLElement)) {
    return;
  }
  if (toast.classList.contains('is-leaving')) {
    return;
  }

  clearTimeout(toast._timer);
  for (const [key, active] of activeToasts) {
    if (active === toast) {
      activeToasts.delete(key);
    }
  }

  toast.classList.add('is-leaving');
  window.setTimeout(() => toast.remove(), 190);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

/**
 * @param {string} path
 * @param {{ method?: string, body?: unknown, timeoutMs?: number }} [options]
 * @returns {Promise<any>}
 */
async function request(path, options = {}) {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);

  /** @type {RequestInit} */
  const init = {
    method,
    headers: { Accept: 'application/json' },
    credentials: 'same-origin',
    cache: 'no-store',
    signal: controller.signal,
  };

  if (options.body !== undefined) {
    /** @type {Record<string, string>} */ (init.headers)['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }

  let response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    window.clearTimeout(timer);
    if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
      throw new ApiError('请求超时，请检查网络或服务状态', 0);
    }
    throw new ApiError('无法连接服务端，请检查网络', 0);
  }
  window.clearTimeout(timer);

  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }

  let payload = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const message = payload !== null
      && typeof payload === 'object'
      && typeof Reflect.get(payload, 'error') === 'string'
      && String(Reflect.get(payload, 'error')).trim() !== ''
      ? String(Reflect.get(payload, 'error')).trim()
      : `请求失败（HTTP ${response.status}）`;
    throw new ApiError(message, response.status, payload);
  }

  return payload;
}

// ---------------------------------------------------------------------------
// 登录
// ---------------------------------------------------------------------------

/**
 * @returns {boolean}
 */
function readLoginHint() {
  try {
    return window.localStorage.getItem(LOGIN_HINT_KEY) === '1';
  } catch {
    return false;
  }
}

/**
 * 只作为一个浏览器侧提示：有记录时先向服务端确认，没有记录时直接出二维码。
 * 这样可以避免未登录的首次访问在控制台留下一个预期内的 404。
 *
 * @param {boolean} value
 */
function setLoginHint(value) {
  try {
    if (value) {
      window.localStorage.setItem(LOGIN_HINT_KEY, '1');
    } else {
      window.localStorage.removeItem(LOGIN_HINT_KEY);
    }
  } catch {
    // 存储不可用时不影响登录流程。
  }
}

/**
 * @param {string} value
 * @param {'unknown' | 'ok' | 'off'} chipState
 */
function setLoginChip(value, chipState) {
  dom.loginValue.textContent = value;
  dom.loginChip.dataset.state = chipState;
}

/**
 * @param {string} text
 * @param {'error' | 'success' | ''} [tone]
 */
function setLoginStatus(text, tone = '') {
  if (dom.loginStatus.textContent !== text) {
    dom.loginStatus.textContent = text;
  }
  if (tone === '') {
    dom.loginStatus.removeAttribute('data-tone');
    dom.loginStatus.removeAttribute('role');
  } else {
    dom.loginStatus.dataset.tone = tone;
    // 倒计时每 0.5 秒变化一次，不能放在 live region 里；只有错误状态需要播报。
    if (tone === 'error') {
      if (dom.loginStatus.getAttribute('role') !== 'alert') {
        dom.loginStatus.setAttribute('role', 'alert');
      }
    } else {
      dom.loginStatus.removeAttribute('role');
    }
  }
}

/**
 * @param {'loading' | 'ready' | 'error' | 'expired'} overlayState
 * @param {string} text
 */
function setQrOverlay(overlayState, text) {
  dom.qrStage.dataset.state = overlayState;
  dom.qrOverlay.hidden = overlayState === 'ready';
  dom.qrSpinner.hidden = overlayState !== 'loading';
  dom.qrOverlayText.textContent = text;
}

/**
 * @param {boolean} visible
 */
function setRegenerateVisible(visible) {
  dom.regenerateButton.hidden = !visible;
}

/**
 * 只把服务端生成的正规 SVG 插进页面：解析后导入，而不是直接 innerHTML。
 *
 * @param {string} svgText
 */
function renderQrSvg(svgText) {
  const parsed = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const svg = parsed.documentElement;
  const parserError = parsed.getElementsByTagName('parsererror')[0];

  if (parserError !== undefined || svg === null || svg.nodeName.toLowerCase() !== 'svg') {
    throw new ApiError('服务端返回的二维码格式无效', 0);
  }

  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', 'Steam 登录二维码');
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  dom.qrCode.replaceChildren(document.importNode(svg, true));
}

async function checkInitialLogin() {
  try {
    const status = await request(API.loginStatus, { timeoutMs: 8000 });
    if (status !== null && typeof status === 'object' && status.state === 'ok') {
      enterApp();
      return;
    }
    void startQrLogin();
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      setLoginHint(false);
      void startQrLogin();
      return;
    }
    setLoginChip('未登录', 'off');
    setQrOverlay('error', '无法检查登录状态');
    setLoginStatus(`无法检查登录状态：${errorText(error)}`, 'error');
    setRegenerateVisible(true);
  }
}

async function startQrLogin() {
  if (state.login.starting || state.loggedIn) {
    return;
  }

  state.login.starting = true;
  setLoginChip('未登录', 'off');
  stopLoginTimers();
  state.login.sessionId = '';
  state.login.expiresAt = 0;
  setQrOverlay('loading', '正在生成二维码…');
  setLoginStatus('正在生成二维码…');
  setRegenerateVisible(false);

  try {
    const data = await request(API.loginQr, { method: 'POST', timeoutMs: 25000 });

    if (state.loggedIn) {
      return;
    }

    const qrSvg = data !== null && typeof data === 'object' ? data.qrSvg : null;
    if (typeof qrSvg !== 'string' || qrSvg.trim() === '') {
      throw new ApiError('服务端没有返回二维码', 0);
    }

    renderQrSvg(qrSvg);
    state.login.sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    state.login.expiresAt = Date.now() + QR_TTL_MS;
    state.login.pollFailed = false;
    setQrOverlay('ready', '');
    setLoginStatus('等待扫码…（二维码 2:00 后过期）');
    startLoginPolling();
    startCountdown();
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      enterApp({ message: '已登录 Steam，已进入游戏库' });
      return;
    }

    const message = errorText(error);
    setQrOverlay('error', message);
    setLoginStatus(`登录失败：${message}`, 'error');
    setRegenerateVisible(true);
  } finally {
    state.login.starting = false;
  }
}

function startLoginPolling() {
  stopLoginPolling();
  state.login.pollTimer = window.setInterval(() => {
    void pollLoginStatus();
  }, POLL_INTERVAL_MS);

  // 给服务端注册会话一点点时间，然后立刻查一次。
  window.setTimeout(() => {
    void pollLoginStatus();
  }, 1000);
}

function stopLoginPolling() {
  if (state.login.pollTimer !== 0) {
    window.clearInterval(state.login.pollTimer);
    state.login.pollTimer = 0;
  }
}

function startCountdown() {
  stopCountdown();
  updateCountdown();
  state.login.countdownTimer = window.setInterval(updateCountdown, 500);
}

function stopCountdown() {
  if (state.login.countdownTimer !== 0) {
    window.clearInterval(state.login.countdownTimer);
    state.login.countdownTimer = 0;
  }
}

function stopLoginTimers() {
  stopLoginPolling();
  stopCountdown();
}

function updateCountdown() {
  if (state.loggedIn) {
    return;
  }

  const remaining = state.login.expiresAt - Date.now();
  if (state.login.expiresAt > 0 && remaining <= 0) {
    expireQr();
    return;
  }

  if (state.login.pollFailed) {
    setLoginStatus('登录状态检查失败，正在重试…', 'error');
    return;
  }

  if (dom.qrStage.dataset.state !== 'ready') {
    return;
  }

  setLoginStatus(`等待扫码…（二维码 ${formatCountdown(remaining)} 后过期）`);
}

function expireQr() {
  stopLoginTimers();
  state.login.sessionId = '';
  state.login.expiresAt = 0;
  setQrOverlay('expired', '二维码已过期');
  setLoginStatus('二维码已过期，请点击「重新生成」', 'error');
  setRegenerateVisible(true);
}

async function pollLoginStatus() {
  if (!state.loggedIn && state.login.sessionId === '') {
    return;
  }
  if (state.login.polling || state.loggedIn || state.login.sessionId === '') {
    return;
  }

  const sessionIdAtStart = state.login.sessionId;
  state.login.polling = true;
  try {
    const status = await request(
      `${API.loginStatus}?sessionId=${encodeURIComponent(sessionIdAtStart)}`,
      { timeoutMs: 8000 },
    );

    // 用户可能在这 2 秒内点了「重新生成」或退出登录；旧会话的结果不能覆盖新状态。
    if (state.loggedIn || state.login.sessionId !== sessionIdAtStart) {
      return;
    }

    state.login.pollFailed = false;

    if (status === null || typeof status !== 'object' || typeof status.state !== 'string') {
      return;
    }

    if (status.state === 'ok') {
      enterApp({ message: '登录成功，已进入游戏库' });
      return;
    }

    if (status.state === 'error') {
      stopLoginTimers();
      state.login.sessionId = '';
      const message = typeof status.message === 'string' && status.message.trim() !== ''
        ? status.message.trim()
        : 'Steam 登录失败';
      setQrOverlay('error', message);
      setLoginStatus(`登录失败：${message}`, 'error');
      setRegenerateVisible(true);
      return;
    }

  } catch (error) {
    if (state.loggedIn || state.login.sessionId !== sessionIdAtStart) {
      return;
    }

    if (error instanceof ApiError && error.status === 404) {
      stopLoginTimers();
      state.login.sessionId = '';
      setQrOverlay('expired', '登录会话已失效');
      setLoginStatus('登录会话已失效，请重新生成二维码', 'error');
      setRegenerateVisible(true);
      return;
    }

    state.login.pollFailed = true;
    setLoginStatus('登录状态检查失败，正在重试…', 'error');
  } finally {
    state.login.polling = false;
  }
}

/**
 * @param {{ message?: string }} [options]
 */
function enterApp(options = {}) {
  const wasLoggedIn = state.loggedIn;
  state.loggedIn = true;
  setLoginHint(true);
  stopLoginTimers();
  state.login.sessionId = '';
  state.login.expiresAt = 0;
  setQrOverlay('ready', '');
  setLoginChip('已登录', 'ok');
  hideBootView();
  dom.loginView.hidden = true;
  dom.libraryView.hidden = false;
  dom.logoutButton.hidden = false;
  updateActionBarVisibility();
  renderLibrary();
  updateSelectionUi();

  if (!wasLoggedIn && typeof options.message === 'string' && options.message !== '') {
    notify(options.message, 'success');
  }

  if (!wasLoggedIn) {
    void refreshTask();
  }
}

/**
 * 隐藏启动占位。两个真实视图在 HTML 里初始都是 hidden，
 * 避免已登录用户刷新时先看到登录框闪一下。
 */
function hideBootView() {
  if (dom.bootView !== null && dom.bootView !== undefined) {
    dom.bootView.hidden = true;
  }
}

function showLogin() {
  state.loggedIn = false;
  stopLoginTimers();
  state.login.sessionId = '';
  state.login.expiresAt = 0;
  setLoginChip('未登录', 'off');
  hideBootView();
  dom.loginView.hidden = false;
  dom.libraryView.hidden = true;
  dom.logoutButton.hidden = true;
  updateActionBarVisibility();
}

async function logout() {
  if (state.logoutBusy) {
    return;
  }

  state.logoutBusy = true;
  dom.logoutButton.disabled = true;
  try {
    await request(API.logout, { method: 'POST', timeoutMs: 10000 });
    setLoginHint(false);
    state.selected.clear();
    updateSelectionUi();
    showLogin();
    setQrOverlay('loading', '正在生成二维码…');
    setLoginStatus('已退出登录，正在生成二维码…');
    setRegenerateVisible(false);
    notify('已退出登录', 'success');
    void startQrLogin();
  } catch (error) {
    notify(`退出登录失败：${errorText(error)}`, 'error');
  } finally {
    state.logoutBusy = false;
    dom.logoutButton.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 游戏库（浏览器本地保存）
// ---------------------------------------------------------------------------

function loadLibrary() {
  let raw = null;
  try {
    raw = window.localStorage.getItem(LIBRARY_STORAGE_KEY);
  } catch {
    state.storageAvailable = false;
    notify('浏览器禁用了本地存储，游戏库无法保存', 'warning');
    return;
  }

  if (raw === null || raw === '') {
    return;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }

  if (!Array.isArray(parsed)) {
    try {
      window.localStorage.removeItem(LIBRARY_STORAGE_KEY);
    } catch {
      // 存储不可用时没必要再次报错。
    }
    notify('本地游戏库数据已损坏，已重置', 'warning');
    return;
  }

  const seen = new Set();
  const items = [];
  for (const candidate of parsed) {
    if (candidate === null || typeof candidate !== 'object') {
      continue;
    }
    const appid = Number(candidate.appid);
    if (!Number.isSafeInteger(appid) || appid <= 0 || seen.has(appid)) {
      continue;
    }
    const name = typeof candidate.name === 'string'
      ? candidate.name.trim().slice(0, MAX_NAME_LENGTH)
      : '';
    seen.add(appid);
    items.push({ appid, name });
    if (items.length >= MAX_LIBRARY_ITEMS) {
      break;
    }
  }

  state.library = items.sort((left, right) => left.appid - right.appid);
}

/**
 * 首次打开时把旧 Python 面板的下载历史搬进游戏库。
 *
 * 只在库为空时执行，避免覆盖用户自己维护的列表；旧面板把记录存在
 * data/history.json，接口在 /api/legacy-history。
 */
async function importLegacyHistory() {
  // 幂等：只补库里还没有的 appid。之前是"库非空就跳过"，
  // 结果旧面板漏记的第三个游戏（990380）永远补不进来。
  let data;
  try {
    data = await request('/api/legacy-history', { timeoutMs: 8000 });
  } catch {
    return;
  }

  if (!data || !data.available || !Array.isArray(data.entries) || data.entries.length === 0) {
    return;
  }

  const known = new Set(state.library.map((item) => item.appid));
  let added = 0;
  for (const entry of data.entries) {
    if (!Number.isSafeInteger(entry.appid) || known.has(entry.appid)) {
      continue;
    }
    // 名字后续由 /api/depot-names 反查补上，这里先用占位。
    state.library.push({ appid: entry.appid, name: `App ${entry.appid}` });
    known.add(entry.appid);
    added += 1;
  }

  if (added === 0) {
    return;
  }

  state.library.sort((left, right) => left.appid - right.appid);
  saveLibrary();
  renderLibrary();
  notify(`已从旧面板导入 ${added} 个游戏`, 'info');

  // history.json 只有 appid，名字要连 Steam 查。拿到后原地更新，不阻塞导入。
  await fillMissingNames();
}

/**
 * 把库里仍是占位名（`App <id>`）的条目补成真实游戏名。
 * 只查占位名的，避免每次刷新都打一遍 Steam。
 */
async function fillMissingNames() {
  const placeholders = state.library.filter(
    (item) => item.name === `App ${item.appid}` || item.name === '' || item.name == null,
  );
  if (placeholders.length === 0) {
    return;
  }

  const ids = placeholders.map((item) => item.appid).join(',');

  // refresh=1 强制重查。depot-names 查询过程会把 appid→名字顺带写进
  // app-names 缓存，所以先触发它，再读缓存拿结果。
  try {
    await request(`/api/depot-names?refresh=1&appids=${ids}`, { timeoutMs: 90000 });
  } catch {
    // 查不到就保持占位名，不打扰用户
  }

  let resolved;
  try {
    resolved = await request(`/api/app-names?appids=${ids}`, { timeoutMs: 20000 });
  } catch {
    return;
  }

  const names = resolved && resolved.names ? resolved.names : {};
  let changed = 0;
  for (const item of state.library) {
    const name = names[String(item.appid)];
    if (typeof name === 'string' && name !== '' && item.name !== name) {
      item.name = name;
      changed += 1;
    }
  }

  if (changed > 0) {
    saveLibrary();
    renderLibrary();
  }
}

function saveLibrary() {
  if (!state.storageAvailable) {
    return;
  }
  try {
    window.localStorage.setItem(LIBRARY_STORAGE_KEY, JSON.stringify(state.library));
  } catch {
    notify('保存游戏库失败：浏览器存储空间不足或被禁用', 'error');
  }
}

/**
 * @param {{ appid: number, name: string }} item
 * @returns {HTMLElement}
 */
function createGameRow(item) {
  const row = document.createElement('div');
  row.className = 'game-row';
  row.dataset.appid = String(item.appid);
  if (state.selected.has(item.appid)) {
    row.classList.add('is-selected');
  }

  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.className = 'game-check';
  checkbox.id = `game-${item.appid}`;
  checkbox.checked = state.selected.has(item.appid);
  checkbox.setAttribute(
    'aria-label',
    `选择 ${item.name === '' ? `AppID ${item.appid}` : item.name}`,
  );
  checkbox.addEventListener('change', () => {
    toggleSelection(item.appid, checkbox.checked);
  });

  const appidLabel = document.createElement('label');
  appidLabel.className = 'game-appid';
  appidLabel.htmlFor = checkbox.id;
  appidLabel.textContent = `#${item.appid}`;

  // 名称来自 Steam，只读展示：用户手改的名字和真实游戏名混在一起没意义
  const nameSpan = document.createElement('span');
  nameSpan.className = 'game-name';
  nameSpan.textContent = item.name !== '' ? item.name : `App ${item.appid}`;
  nameSpan.title = item.name !== '' ? item.name : '尚未取得名称，正在查询…';

  // 不提供「移除」：lancache 是全量缓存，无法按游戏删除。把条目从列表
  // 里去掉只会让人误以为缓存也清了，反而更困惑。

  row.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('input, button, label') !== null) {
      return;
    }
    checkbox.checked = !checkbox.checked;
    toggleSelection(item.appid, checkbox.checked);
  });

  // 有 DLC 时标注数量（DLC 本身不在库里，只做提示）
  const dlcIds = state.dlcMap[String(item.appid)] ?? [];
  if (Array.isArray(dlcIds) && dlcIds.length > 0) {
    const dlcBadge = document.createElement('span');
    dlcBadge.className = 'game-dlc';
    dlcBadge.textContent = `含 ${dlcIds.length} 个附加内容`;
    dlcBadge.title = dlcIds.map((id) => `AppID ${id}`).join('\n');
    row.append(checkbox, appidLabel, nameSpan, dlcBadge);
    return row;
  }

  row.append(checkbox, appidLabel, nameSpan);
  return row;
}

function renderLibrary() {
  const known = new Set(state.library.map((item) => item.appid));
  for (const appid of [...state.selected]) {
    if (!known.has(appid)) {
      state.selected.delete(appid);
    }
  }

  dom.gameList.replaceChildren();
  for (const item of state.library) {
    dom.gameList.append(createGameRow(item));
  }

  const count = state.library.length;
  dom.libraryCount.textContent = `共 ${count} 个游戏`;
  dom.libraryEmpty.hidden = count !== 0;
  dom.gameList.hidden = count === 0;
  updateSelectionUi();
}

/**
 * @param {number} appid
 * @param {boolean} selected
 */
function toggleSelection(appid, selected) {
  if (selected) {
    state.selected.add(appid);
  } else {
    state.selected.delete(appid);
  }
  syncRowSelection(appid);
  updateSelectionUi();
}

/**
 * @param {number} appid
 */
function syncRowSelection(appid) {
  const row = dom.gameList.querySelector(`.game-row[data-appid="${appid}"]`);
  if (row === null) {
    return;
  }
  const checkbox = row.querySelector('.game-check');
  const selected = state.selected.has(appid);
  if (checkbox instanceof HTMLInputElement) {
    checkbox.checked = selected;
  }
  row.classList.toggle('is-selected', selected);
}

function syncAllCheckboxes() {
  for (const row of dom.gameList.querySelectorAll('.game-row')) {
    const appid = Number(row.dataset.appid);
    const checkbox = row.querySelector('.game-check');
    const selected = state.selected.has(appid);
    if (checkbox instanceof HTMLInputElement) {
      checkbox.checked = selected;
    }
    row.classList.toggle('is-selected', selected);
  }
}

function selectAll() {
  for (const item of state.library) {
    state.selected.add(item.appid);
  }
  syncAllCheckboxes();
  updateSelectionUi();
}

function clearSelection() {
  state.selected.clear();
  syncAllCheckboxes();
  updateSelectionUi();
}

/**
 * @param {string} raw
 */
function addGame(raw) {
  const text = String(raw ?? '').trim();
  if (text === '') {
    notify('请输入 Steam AppID', 'warning');
    dom.appidInput.focus();
    return;
  }

  // 名称由 Steam 决定，这里只接受纯数字 AppID（兼容旧习惯：多余的尾巴忽略）
  const match = /^(\d+)(?:\s+.*)?$/.exec(text);
  if (match === null) {
    notify('AppID 必须是正整数', 'error');
    dom.appidInput.focus();
    return;
  }

  const appid = Number(match[1]);
  if (!Number.isSafeInteger(appid) || appid <= 0) {
    notify('AppID 必须是正整数', 'error');
    dom.appidInput.focus();
    return;
  }

  if (state.library.length >= MAX_LIBRARY_ITEMS) {
    notify(`游戏库最多保存 ${MAX_LIBRARY_ITEMS} 个游戏`, 'warning');
    return;
  }

  // 名字一律留空，交给 fillMissingNames 从 Steam 补
  const name = '';
  const existing = state.library.find((item) => item.appid === appid);

  if (existing !== undefined) {
    if (name !== '') {
      existing.name = name;
    }
    state.selected.add(appid);
    saveLibrary();
    renderLibrary();
    scrollRowIntoView(appid);
    dom.appidInput.value = '';
    dom.appidInput.focus();
    notify(`AppID ${appid} 已在游戏库中`, 'info', { duration: 3000 });
    return;
  }

  state.library.push({ appid, name });
  state.library.sort((left, right) => left.appid - right.appid);
  state.selected.add(appid);
  saveLibrary();
  renderLibrary();

  const row = dom.gameList.querySelector(`.game-row[data-appid="${appid}"]`);
  if (row !== null) {
    row.classList.add('is-new');
    window.setTimeout(() => row.classList.remove('is-new'), 1200);
  }
  scrollRowIntoView(appid);

  dom.appidInput.value = '';
  dom.appidInput.focus();

  // 新加的游戏通常还没名字，触发一次查询补上
  void fillMissingNames();
}

/**
 * @param {number} appid
 */
function scrollRowIntoView(appid) {
  const row = dom.gameList.querySelector(`.game-row[data-appid="${appid}"]`);
  if (row !== null) {
    row.scrollIntoView({ block: 'nearest' });
  }
}

/**
 * @param {number} appid
 */
function updateSelectionUi() {
  const count = state.selected.size;
  dom.selectedCount.textContent = String(count);
  dom.selectionCount.textContent = `已选 ${count} 个`;

  if (state.taskRunning) {
    dom.selectedNote.textContent = '任务运行中，完成或停止后可再次启动';
  } else if (state.task !== null && state.task.state === 'done' && count > 0) {
    // 已完成时说明复跑的实际行为，避免误以为要重新下载
    dom.selectedNote.textContent = '上一轮已完成；再次运行会重新校验，通常全部命中缓存';
  } else if (count === 0) {
    dom.selectedNote.textContent = '勾选游戏后开始预填充';
  } else {
    const names = state.library
      .filter((item) => state.selected.has(item.appid))
      .slice(0, 3)
      .map((item) => (item.name === '' ? `#${item.appid}` : item.name));
    const suffix = count > names.length ? ` 等 ${count} 个` : '';
    dom.selectedNote.textContent = `将预填充：${names.join('、')}${suffix}`;
  }

  updateButtons();
  updateActionBarVisibility();
}

function updateActionBarVisibility() {
  dom.actionBar.hidden = !state.loggedIn && !state.taskRunning;
}

function updateButtons() {
  const running = state.taskRunning;
  dom.startButton.disabled = !state.loggedIn
    || state.selected.size === 0
    || running
    || state.startingTask;
  if (state.startingTask) {
    dom.startButton.textContent = '正在启动…';
  } else if (!running && state.task !== null && state.task.state === 'done') {
    // 上一轮已结束：按钮仍可用（允许复跑校验），但文案要说明是「再次」
    dom.startButton.textContent = '再次预填充';
  } else {
    dom.startButton.textContent = '开始预填充';
  }

  dom.stopButton.disabled = !running || state.stoppingTask || state.cancelRequested;
  dom.stopButton.textContent = state.stoppingTask
    ? '正在停止…'
    : state.cancelRequested
      ? '正在停止…'
      : '停止';
}

// ---------------------------------------------------------------------------
// 预填充任务
// ---------------------------------------------------------------------------

async function startPrefill() {
  if (state.startingTask || state.taskRunning || !state.loggedIn) {
    return;
  }

  const appIds = state.library
    .filter((item) => state.selected.has(item.appid))
    .map((item) => item.appid);
  if (appIds.length === 0) {
    notify('请先勾选要预填充的游戏', 'warning');
    return;
  }

  state.startingTask = true;
  updateButtons();

  try {
    await request(API.prefill, {
      method: 'POST',
      body: { appIds },
      timeoutMs: 20000,
    });
    state.cancelRequested = false;
    notify(`已开始预填充 ${appIds.length} 个游戏`, 'success');
    await refreshTask();
  } catch (error) {
    if (error instanceof ApiError && error.status === 428) {
      setLoginHint(false);
      notify('登录已失效，请重新扫码登录', 'error');
      showLogin();
      setQrOverlay('loading', '正在生成二维码…');
      setLoginStatus('登录已失效，请重新扫码登录');
      void startQrLogin();
    } else if (error instanceof ApiError && error.status === 409) {
      notify('已有预填充任务在运行', 'warning');
      await refreshTask();
    } else {
      notify(`启动预填充失败：${errorText(error)}`, 'error');
    }
  } finally {
    state.startingTask = false;
    updateButtons();
  }
}

async function stopTask() {
  if (!state.taskRunning || state.stoppingTask || state.cancelRequested) {
    return;
  }

  state.stoppingTask = true;
  updateButtons();

  try {
    const result = await request(API.cancel, { method: 'POST', timeoutMs: 10000 });
    if (result !== null && typeof result === 'object' && result.cancelled === true) {
      state.cancelRequested = true;
      notify('已请求停止，正在结束当前下载块…', 'info');
    } else {
      notify('当前没有运行中的任务', 'info');
    }
    await refreshTask();
  } catch (error) {
    notify(`停止任务失败：${errorText(error)}`, 'error');
  } finally {
    state.stoppingTask = false;
    updateButtons();
  }
}

function startTaskPolling() {
  if (state.taskTimer !== 0) {
    return;
  }
  state.taskTimer = window.setInterval(() => {
    void refreshTask();
  }, POLL_INTERVAL_MS);
  void refreshTask();
}

async function refreshTask() {
  if (state.taskFetching) {
    return;
  }

  state.taskFetching = true;
  try {
    const raw = await request(API.task, { timeoutMs: 8000 });
    state.taskPollErrorShown = false;
    applyTaskSnapshot(raw);
  } catch (error) {
    if (!state.taskPollErrorShown) {
      state.taskPollErrorShown = true;
      notify(`读取任务状态失败：${errorText(error)}`, 'error');
    }
  } finally {
    state.taskFetching = false;
  }
}

/**
 * @param {unknown} raw
 * @returns {{
 *   state: string,
 *   appIds: number[],
 *   progress: {
 *     appsDone: number,
 *     appsTotal: number,
 *     chunksOk: number,
 *     chunksFailed: number,
 *     bytes: number,
 *     hit: number,
 *     miss: number,
 *   },
 *   startedAt: string | null,
 *   finishedAt: string | null,
 *   error: string | null,
 * }}
 */
function normalizeTaskSnapshot(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const progress = source.progress !== null && typeof source.progress === 'object'
    ? source.progress
    : {};
  const allowed = ['idle', 'running', 'done', 'failed', 'cancelled'];
  const taskState = allowed.includes(source.state) ? source.state : 'idle';

  return {
    state: taskState,
    appIds: Array.isArray(source.appIds)
      ? source.appIds.filter((id) => Number.isSafeInteger(id) && id > 0)
      : [],
    progress: {
      appsDone: countOrZero(progress.appsDone),
      appsTotal: countOrZero(progress.appsTotal),
      chunksOk: countOrZero(progress.chunksOk),
      chunksFailed: countOrZero(progress.chunksFailed),
      bytes: countOrZero(progress.bytes),
      hit: countOrZero(progress.hit),
      miss: countOrZero(progress.miss),
    },
    startedAt: typeof source.startedAt === 'string' ? source.startedAt : null,
    finishedAt: typeof source.finishedAt === 'string' ? source.finishedAt : null,
    error: typeof source.error === 'string' && source.error !== '' ? source.error : null,
  };
}

/**
 * @param {unknown} raw
 */
function applyTaskSnapshot(raw) {
  const snapshot = normalizeTaskSnapshot(raw);
  const previousState = state.task === null ? null : state.task.state;
  const wasVisible = state.taskVisible;

  state.task = snapshot;
  state.taskRunning = snapshot.state === 'running';

  if (state.taskRunning) {
    if (previousState !== 'running') {
      state.cancelRequested = false;
    }
    if (!wasVisible) {
      showTaskPanel();
    }
  } else {
    state.cancelRequested = false;
    if (previousState === 'running') {
      if (!wasVisible) {
        showTaskPanel();
      }
      announceTaskResult(snapshot);
    } else if (snapshot.state === 'idle' && wasVisible) {
      hideTaskPanel();
    }
  }

  dom.taskClose.hidden = state.taskRunning;
  renderTask(snapshot);
  updateButtons();
  updateSelectionUi();
}

/**
 * @param {ReturnType<typeof normalizeTaskSnapshot>} snapshot
 */
function announceTaskResult(snapshot) {
  if (snapshot.state === 'done') {
    notify(`预填充完成：${snapshot.progress.appsTotal} 个游戏`, 'success');
  } else if (snapshot.state === 'failed') {
    notify(`预填充失败：${snapshot.error ?? '未知错误'}`, 'error');
  } else if (snapshot.state === 'cancelled') {
    notify('预填充已停止', 'info');
  }
}

function showTaskPanel() {
  state.taskVisible = true;
  dom.taskPanel.hidden = false;
  // 面板隐藏期间日志仍在累积；打开时直接落到最新一行。
  dom.logList.scrollTop = dom.logList.scrollHeight;
}

function hideTaskPanel() {
  state.taskVisible = false;
  dom.taskPanel.hidden = true;
}

/**
 * @param {ReturnType<typeof normalizeTaskSnapshot>} snapshot
 */
function renderTask(snapshot) {
  const progress = snapshot.progress;
  const percent = snapshot.state === 'done'
    ? 100
    : progress.appsTotal === 0
      ? 0
      : Math.max(0, Math.min(100, (progress.appsDone / progress.appsTotal) * 100));
  const rounded = Math.round(percent);

  dom.taskState.textContent = TASK_STATE_LABELS[snapshot.state] ?? snapshot.state;
  dom.taskState.dataset.state = snapshot.state;

  dom.progressFill.style.width = `${percent}%`;
  dom.progressPercent.textContent = `${rounded}%`;
  dom.progressBar.setAttribute('aria-valuenow', String(rounded));

  if (snapshot.state === 'running') {
    dom.progressLabel.textContent = `正在预填充 ${progress.appsDone} / ${progress.appsTotal} 个应用`;
  } else if (snapshot.state === 'done') {
    dom.progressLabel.textContent = `全部完成 · ${progress.appsTotal} 个应用`;
  } else if (snapshot.state === 'failed') {
    dom.progressLabel.textContent = `任务失败${snapshot.error === null ? '' : `：${snapshot.error}`}`;
  } else if (snapshot.state === 'cancelled') {
    dom.progressLabel.textContent = `已停止 · 完成 ${progress.appsDone} / ${progress.appsTotal} 个应用`;
  } else {
    dom.progressLabel.textContent = '等待任务';
  }

  dom.statApps.textContent = `${progress.appsDone} / ${progress.appsTotal}`;
  dom.statChunks.textContent = `${progress.chunksOk} 成功 · ${progress.chunksFailed} 失败`;
  dom.statBytes.textContent = formatBytes(progress.bytes);
  dom.statHit.textContent = `${progress.hit} / ${progress.miss}`;
}

// ---------------------------------------------------------------------------
// 实时日志（SSE）
// ---------------------------------------------------------------------------

function connectLogs() {
  if (typeof EventSource === 'undefined') {
    setLogStatus('error', '浏览器不支持实时日志');
    return;
  }

  let source;
  try {
    source = new EventSource(API.logs);
  } catch {
    setLogStatus('error', '日志连接失败');
    notify('无法建立实时日志连接', 'error');
    return;
  }

  state.logSource = source;

  source.addEventListener('open', () => {
    setLogStatus('live', '实时');
  });

  source.addEventListener('error', () => {
    // EventSource 会自己重连；这里只反映状态，不刷 toast。
    setLogStatus('reconnecting', '重连中…');
  });

  source.addEventListener('message', (event) => {
    let entry = null;
    try {
      entry = JSON.parse(event.data);
    } catch {
      entry = null;
    }
    if (entry === null || typeof entry !== 'object') {
      return;
    }
    appendLog(entry);
  });
}

/**
 * @param {'live' | 'connecting' | 'reconnecting' | 'error'} status
 * @param {string} text
 */
function setLogStatus(status, text) {
  dom.logStatus.dataset.state = status;
  dom.logStatusText.textContent = text;
}

/**
 * @param {{ at?: unknown, level?: unknown, message?: unknown }} entry
 */
function appendLog(entry) {
  if (typeof entry.message !== 'string' || entry.message === '') {
    return;
  }

  const list = dom.logList;
  const stickToBottom = isNearBottom(list);

  const level = entry.level === 'warn' || entry.level === 'error' ? entry.level : 'info';
  const at = typeof entry.at === 'string' ? entry.at : '';

  const line = document.createElement('li');
  line.className = `log-line log-${level}`;

  const time = document.createElement('time');
  time.className = 'log-time';
  time.dateTime = at;
  time.textContent = formatClock(at);

  const levelLabel = document.createElement('span');
  levelLabel.className = 'log-level';
  levelLabel.textContent = level === 'warn' ? 'WARN' : level === 'error' ? 'ERROR' : 'INFO';

  const message = document.createElement('span');
  message.className = 'log-msg';
  message.textContent = entry.message;

  line.append(time, levelLabel, message);
  list.append(line);

  while (list.children.length > LOG_LIMIT) {
    list.firstElementChild?.remove();
  }

  dom.logCount.textContent = `${list.children.length} 行`;
  if (stickToBottom) {
    list.scrollTop = list.scrollHeight;
  }
}

/**
 * @param {HTMLElement} list
 * @returns {boolean}
 */
function isNearBottom(list) {
  return list.scrollHeight - list.scrollTop - list.clientHeight < 48;
}

// ---------------------------------------------------------------------------
// 版本信息
// ---------------------------------------------------------------------------

async function fetchVersion() {
  try {
    const health = await request(API.health, { timeoutMs: 8000 });
    const version = health !== null
      && typeof health === 'object'
      && typeof health.version === 'string'
      && health.version !== ''
      ? health.version
      : '';
    dom.versionValue.textContent = version === '' ? '未知' : `v${version}`;
  } catch (error) {
    dom.versionValue.textContent = '未知';
    notifyOnce('version', `读取服务版本失败：${errorText(error)}`, 'error');
  }
}

// ---------------------------------------------------------------------------
// 缓存占用
// ---------------------------------------------------------------------------

async function fetchCacheStats() {
  // 扫描大目录可能要几秒，给长一点的超时，失败时保留占位符而不是报错。
  try {
    const stats = await request('/api/cache', { timeoutMs: 30000 });
    if (stats && stats.available) {
      dom.cacheValue.textContent = formatBytes(stats.bytes);
      const count = Number.isFinite(stats.files) ? stats.files : 0;
      dom.cacheChip.title = `共 ${count.toLocaleString()} 个缓存文件（只读统计）`;
    } else {
      dom.cacheValue.textContent = '不可用';
      dom.cacheChip.title = '缓存目录未挂载，检查 CACHE_DATA_DIR';
    }
  } catch (error) {
    dom.cacheValue.textContent = '—';
    dom.cacheChip.title = `读取缓存占用失败：${errorText(error)}`;
  }
}

async function fetchCachedDepots() {
  // SteamPrefill 自己记的账，比扫 nginx 缓存目录准。
  try {
    const data = await request('/api/cached-depots', { timeoutMs: 10000 });
    if (data && data.available) {
      const count = Array.isArray(data.depots) ? data.depots.length : 0;
      dom.depotValue.textContent = `${count} depot`;
      const manifests = Number.isFinite(data.manifestCount) ? data.manifestCount : 0;

      // 名字要连着 Steam 查，慢且可能失败；拿不到就只显示 id。
      let names = {};
      try {
        // 游戏库在浏览器里，服务端读不到，必须把 appid 带上它才能反查。
        const appIds = state.library.map((item) => item.appid).join(',');
        const url = appIds === '' ? '/api/depot-names' : `/api/depot-names?appids=${appIds}`;
        const resolved = await request(url, { timeoutMs: 30000 });
        names = resolved && resolved.names ? resolved.names : {};
        // 后端顺带返回了 appid → DLC appid 列表，库里用它标「含 N 个附加内容」
        state.dlcMap = resolved && resolved.dlc ? resolved.dlc : {};
      } catch {
        names = {};
      }

      const lines = count > 0
        ? data.depots.map((item) => {
          const name = names[String(item.depotId)];
          return name ? `${item.depotId}  ${name}` : `${item.depotId}  （未识别）`;
        })
        : ['（空）'];
      dom.depotChip.title = `已缓存 ${count} 个 depot / ${manifests} 个 manifest\n\n${lines.join('\n')}`;
    } else {
      dom.depotValue.textContent = '无记录';
      dom.depotChip.title = data && data.file
        ? `未找到 ${data.file}，检查 PREFILL_STATE_DIR 挂载`
        : '未配置 PREFILL_STATE_DIR';
    }
  } catch (error) {
    dom.depotValue.textContent = '—';
    dom.depotChip.title = `读取已缓存清单失败：${errorText(error)}`;
  }
}

// ---------------------------------------------------------------------------
// 初始化
// ---------------------------------------------------------------------------

function cacheDom() {
  dom.bootView = byId('boot-view');
  dom.loginChip = byId('login-chip');
  dom.loginValue = byId('login-value');
  dom.cacheChip = byId('cache-chip');
  dom.cacheValue = byId('cache-value');
  dom.depotChip = byId('depot-chip');
  dom.depotValue = byId('depot-value');
  dom.versionValue = byId('version-value');
  dom.logoutButton = byId('logout-button');

  dom.loginView = byId('login-view');
  dom.qrStage = byId('qr-stage');
  dom.qrCode = byId('qr-code');
  dom.qrOverlay = byId('qr-overlay');
  dom.qrSpinner = byId('qr-spinner');
  dom.qrOverlayText = byId('qr-overlay-text');
  dom.loginStatus = byId('login-status');
  dom.regenerateButton = byId('regenerate-button');

  dom.libraryView = byId('library-view');
  dom.libraryCount = byId('library-count');
  dom.selectionCount = byId('selection-count');
  dom.gameList = byId('game-list');
  dom.libraryEmpty = byId('library-empty');
  dom.addForm = byId('add-form');
  dom.appidInput = byId('appid-input');
  dom.selectAllButton = byId('select-all-button');
  dom.clearSelectionButton = byId('clear-selection-button');

  dom.taskPanel = byId('task-panel');
  dom.taskState = byId('task-state');
  dom.taskClose = byId('task-close');
  dom.progressLabel = byId('progress-label');
  dom.progressPercent = byId('progress-percent');
  dom.progressBar = byId('progress-bar');
  dom.progressFill = byId('progress-fill');
  dom.statApps = byId('stat-apps');
  dom.statChunks = byId('stat-chunks');
  dom.statBytes = byId('stat-bytes');
  dom.statHit = byId('stat-hit');
  dom.logList = byId('log-list');
  dom.logCount = byId('log-count');
  dom.logStatus = byId('log-status');
  dom.logStatusText = byId('log-status-text');

  dom.actionBar = byId('action-bar');
  dom.selectedCount = byId('selected-count');
  dom.selectedNote = byId('selected-note');
  dom.startButton = byId('start-button');
  dom.stopButton = byId('stop-button');

  dom.toasts = byId('toasts');
}

function bindEvents() {
  dom.regenerateButton.addEventListener('click', () => {
    void startQrLogin();
  });

  dom.logoutButton.addEventListener('click', () => {
    void logout();
  });

  dom.addForm.addEventListener('submit', (event) => {
    event.preventDefault();
    addGame(dom.appidInput.value);
  });

  dom.selectAllButton.addEventListener('click', selectAll);
  dom.clearSelectionButton.addEventListener('click', clearSelection);

  dom.startButton.addEventListener('click', () => {
    void startPrefill();
  });
  dom.stopButton.addEventListener('click', () => {
    void stopTask();
  });

  dom.taskClose.addEventListener('click', () => {
    hideTaskPanel();
    updateActionBarVisibility();
  });

  window.addEventListener('online', () => {
    notify('网络已恢复', 'success');
  });
  window.addEventListener('offline', () => {
    notify('网络已断开，部分功能可能不可用', 'warning');
  });

  window.addEventListener('beforeunload', () => {
    if (state.logSource !== null) {
      state.logSource.close();
    }
  });
}

async function boot() {
  try {
    cacheDom();
  } catch {
    // 页面结构不完整时没有可用的提示容器，直接放弃初始化。
    return;
  }

  bindEvents();
  loadLibrary();
  renderLibrary();
  connectLogs();

  const hasLoginHint = readLoginHint();

  if (hasLoginHint) {
    // 之前登录过：保持 boot-view 占位，等 checkLogin 决定显示哪个视图。
    // 这里绝不能先 showLogin()——那正是刷新时登录框一闪而过的原因。
    setLoginChip('检查中', 'unknown');
    setQrOverlay('loading', '正在检查登录状态…');
    setLoginStatus('正在检查登录状态…');
  } else {
    // 明确没有登录记录，直接显示登录视图
    showLogin();
    setLoginChip('未登录', 'off');
    setQrOverlay('loading', '正在生成二维码…');
    setLoginStatus('正在生成二维码…');
  }

  void fetchVersion();
  void fetchCacheStats();
  // 串行：depot 查询会把 appid→游戏名写进缓存，之后补名字才能命中。
  // 两者都慢（要连 Steam），但不阻塞页面渲染。
  void (async () => {
    await fetchCachedDepots();
    await importLegacyHistory();
    await fillMissingNames();
  })();
  if (hasLoginHint) {
    await checkInitialLogin();
  } else {
    void startQrLogin();
  }
  startTaskPolling();
}

boot().catch((error) => {
  try {
    notify(`页面初始化失败：${errorText(error)}`, 'error');
  } catch {
    // 没有可用的 DOM 时只能放弃。
  }
});
