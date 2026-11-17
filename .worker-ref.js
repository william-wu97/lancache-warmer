'use strict';
/**
 * Steam Cache Worker —— 常驻 HTTP 服务
 *
 * 用 steam-user 直连 Steam，拉 depot 内容并经 lancache 填充缓存。
 * 所有 chunk 流式读取后丢弃，不落盘。
 *
 * 与 steam-prefill 的区别：
 *   - CM 连接稳定（实测 10/10，SteamPrefill 同环境 0/5）
 *   - 只使用 steamcontent.com 域名（公网 CDN 对国内 IP 返 403）
 *   - 有明确的字节数 / 命中数 / 缓存增量
 *
 * API:
 *   GET  /health
 *   GET  /status
 *   POST /prefill   {"app_ids":[413100],"cell":35}
 *   GET  /events    SSE 日志流
 *   POST /cancel
 */
const http = require('http');
const fs = require('fs');
const dns = require('dns');
const net = require('net');
const { performance } = require('perf_hooks');

const PORT = Number(process.env.PORT || 8090);
const ACCOUNT_FILE = process.env.ACCOUNT_FILE || '/Config/account.config';
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY || 16);
const DEFAULT_CELL = Number(process.env.DEFAULT_CELL || 35);
const OS_FILTER = (process.env.OS_FILTER || 'windows').toLowerCase();

// 与 prefill 容器一致：显式 DNS，确保命中本机缓存
const DNS_SERVERS = (process.env.DNS_SERVERS || '192.168.31.3,223.5.5.5').split(',');
const resolver = new dns.Resolver();
resolver.setServers(DNS_SERVERS);
dns.lookup = (host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    options = options || {};
    if (net.isIP(host)) {
        return process.nextTick(() => callback(null,
            options.all ? [{ address: host, family: net.isIP(host) }] : host,
            net.isIP(host)));
    }
    resolver.resolve4(host, (error, addresses) => {
        if (error) return callback(error);
        callback(null,
            options.all ? addresses.map(a => ({ address: a, family: 4 })) : addresses[0],
            4);
    });
};

const SteamUser = require('steam-user');
const Manifest = require('steam-user/components/content_manifest');
const { LoginSession, EAuthTokenPlatformType } = require('steam-session');

const TOKEN_FILE = process.env.TOKEN_FILE || '/work/steam-token.json';

// ---------------- 状态 ----------------
const state = {
    running: false,
    app_ids: [],
    started_at: null,
    finished_at: null,
    cell: DEFAULT_CELL,
    logs: [],
    progress: { app: null, app_index: 0, app_total: 0, chunks_ok: 0, chunks_failed: 0, bytes: 0, cache_hit: 0, cache_miss: 0 },
    result: null,
    cancel_requested: false
};

const subscribers = new Set();

function log(line) {
    const entry = `[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${line}\n`;
    state.logs.push(entry);
    if (state.logs.length > 2000) state.logs = state.logs.slice(-2000);
    for (const res of subscribers) {
        try { res.write(`data: ${JSON.stringify(entry)}\n\n`); } catch (e) { /* ignore */ }
    }
    process.stdout.write(entry);
}

function statusPayload() {
    return {
        running: state.running,
        app_ids: state.app_ids,
        started_at: state.started_at,
        finished_at: state.finished_at,
        cell: state.cell,
        progress: state.progress,
        result: state.result,
        logs: state.logs.slice(-300)
    };
}

// ---------------- 凭据 ----------------
/**
 * 取可用的 refreshToken。
 * 优先用扫码登录保存的明文 JWT；它比 SteamPrefill 的 account.config 可靠，
 * 后者存的是加密 blob，steam-user 无法直接使用。
 */
function getRefreshToken() {
    if (fs.existsSync(TOKEN_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
            if (data && data.refreshToken) return data.refreshToken;
        } catch (e) { /* 落到下面的回退 */ }
    }
    try {
        return readRefreshToken(ACCOUNT_FILE);
    } catch (e) {
        throw new Error('尚未登录：请访问 /login 用 Steam 手机 App 扫码，或确认 account.config 可用');
    }
}

/** 解析 SteamPrefill 的 account.config（protobuf，field 5） */
function readRefreshToken(file) {
    const buffer = fs.readFileSync(file);
    let pos = 0;
    let token = null;
    const varint = () => {
        let n = 0, shift = 0, b;
        do { b = buffer[pos++]; n += (b & 127) * 2 ** shift; shift += 7; } while (b & 128);
        return n;
    };
    while (pos < buffer.length) {
        const tag = varint();
        const field = tag >> 3;
        const wire = tag & 7;
        if (wire === 0) { varint(); continue; }
        if (wire !== 2) throw new Error('unsupported credential wire type');
        const len = varint();
        if (field === 5) token = buffer.subarray(pos, pos + len).toString();
        pos += len;
    }
    if (!token) throw new Error('account.config 中未找到 refreshToken（可能尚未登录）');
    return token;
}

// ---------------- 下载 ----------------
async function fetchChunk(host, depot, sha, expectedSize, signal) {
    const url = `http://${host}/depot/${depot}/chunk/${sha}`;
    const res = await fetch(url, {
        signal,
        headers: {
            'User-Agent': 'Valve/Steam HTTP Client 1.0',
            'Accept': '*/*'
        }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const cacheStatus = (res.headers.get('x-cache-status') || '').toUpperCase();
    let received = 0;
    // 逐块读出后立即丢弃，内存占用与 chunk 大小无关
    for await (const chunk of res.body) {
        received += chunk.length;
        state.progress.bytes += chunk.length;
    }
    if (expectedSize && received !== expectedSize) {
        throw new Error(`长度不符 got=${received} want=${expectedSize}`);
    }
    return cacheStatus;
}

async function runPool(items, worker, concurrency, shouldStop) {
    let idx = 0;
    const n = Math.min(concurrency, items.length);
    await Promise.all(new Array(n).fill(0).map(async () => {
        while (true) {
            if (shouldStop && shouldStop()) return;
            const i = idx++;
            if (i >= items.length) return;
            await worker(items[i]);
        }
    }));
}

// ---------------- 主流程 ----------------
function collectDepots(appInfo, appId) {
    const out = [];
    const depots = appInfo.depots || {};
    for (const key of Object.keys(depots)) {
        const d = depots[key];
        if (!d || !d.manifests || !d.manifests.public) continue;
        const oslist = d.config && d.config.oslist ? String(d.config.oslist).toLowerCase() : '';
        // oslist 为空的多为共享/公共 depot，保留
        if (oslist && OS_FILTER && !oslist.includes(OS_FILTER)) continue;
        const gid = d.manifests.public.gid || d.manifests.public;
        out.push({ depotId: Number(key), manifestId: String(gid), size: Number(d.maxsize || 0) });
    }
    return out;
}

async function prefillApp(user, appId, hosts, cellTag) {
    log(`>>> 读取 App ${appId} 的元数据`);
    const info = await user.getProductInfo([appId], [], true);
    const app = info.apps[appId];
    if (!app || !app.appinfo) throw new Error(`App ${appId} 无元数据`);

    const name = (app.appinfo.common && app.appinfo.common.name) || `App ${appId}`;
    const depots = collectDepots(app.appinfo, appId);
    log(`>>> ${name}：选中 ${depots.length} 个 depot（OS 过滤=${OS_FILTER || '无'}）`);
    if (!depots.length) throw new Error('没有可下载的 depot');

    let hostIdx = 0;
    const nextHost = () => hosts[hostIdx++ % hosts.length];

    let depotDone = 0;
    for (const d of depots) {
        if (state.cancel_requested) throw new Error('已取消');

        let parsed;
        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                const raw = await user.getRawManifest(appId, d.depotId, d.manifestId, 'public');
                parsed = Manifest.parse(raw.manifest);
                break;
            } catch (e) {
                if (attempt === 3) throw new Error(`depot ${d.depotId} manifest 获取失败：${e.message}`);
                log(`    depot ${d.depotId} manifest 重试 ${attempt}/3`);
            }
        }

        const chunks = new Map();
        for (const file of parsed.files || []) {
            for (const c of file.chunks || []) {
                if (!chunks.has(c.sha)) chunks.set(c.sha, Number(c.cb_compressed) || 0);
            }
        }
        const list = [...chunks].map(([sha, size]) => ({ sha, size }));
        depotDone++;
        log(`    depot ${d.depotId}：${list.length} 个 chunk（${depotDone}/${depots.length}）`);

        await runPool(list, async (item) => {
            // 单个 chunk 最多试 3 次，每次换一个 host
            let lastErr;
            for (let attempt = 1; attempt <= 3; attempt++) {
                const host = nextHost();
                try {
                    const status = await fetchChunk(host, d.depotId, item.sha, item.size, undefined);
                    if (status === 'HIT') state.progress.cache_hit++;
                    else if (status === 'MISS') state.progress.cache_miss++;
                    state.progress.chunks_ok++;
                    return;
                } catch (e) {
                    lastErr = e;
                }
            }
            state.progress.chunks_failed++;
            if (state.progress.chunks_failed <= 5) {
                log(`    chunk ${item.sha.slice(0, 12)} 失败：${lastErr.message}`);
            }
        }, CONCURRENCY, () => state.cancel_requested);
    }
    return { appId, name, depots: depots.length };
}

async function runJob(appIds, cell) {
    state.running = true;
    state.cancel_requested = false;
    state.app_ids = appIds;
    state.started_at = Date.now();
    state.finished_at = null;
    state.cell = cell;
    state.logs = [];
    state.result = null;
    state.progress = {
        app: null, app_index: 0, app_total: appIds.length,
        chunks_ok: 0, chunks_failed: 0, bytes: 0, cache_hit: 0, cache_miss: 0
    };

    const t0 = performance.now();
    let user;
    try {
        const token = getRefreshToken();
        log('>>> 使用已保存的 Steam 凭据登录');

        user = new SteamUser({
            dataDirectory: '/tmp/steam-state',
            autoRelogin: true,
            renewRefreshTokens: false,
            enablePicsCache: false,
            saveAppTickets: false,
            protocol: SteamUser.EConnectionProtocol.Auto
        });

        const api = user._apiRequest.bind(user);
        user._apiRequest = (method, iface, name, version, parameters, ...rest) => {
            if (name === 'GetCMListForConnect') parameters = { ...parameters, cellid: cell };
            if (name === 'GetServersForSteamPipe') parameters = { ...parameters, cell_id: cell };
            return api(method, iface, name, version, parameters, ...rest);
        };

        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('登录超时（60s）')), 60000);
            user.once('loggedOn', () => { clearTimeout(timer); resolve(); });
            user.once('error', (e) => { clearTimeout(timer); reject(e); });
            user.logOn({ refreshToken: token, logonID: 30993, machineName: 'NAS cache worker' });
        });
        log('>>> Steam 登录成功');

        const cdnRes = await user.getContentServers();
        const servers = Array.isArray(cdnRes) ? cdnRes : (cdnRes && cdnRes.servers) || [];
        const allHosts = servers.map(s => s && (s.Host || s.host)).filter(Boolean);
        const hosts = allHosts.filter(h => /steamcontent\.com$/i.test(h));
        if (!hosts.length) throw new Error('没有可用的 steamcontent.com CDN 节点');
        log(`>>> 可用缓存节点 ${hosts.length} 个（已跳过 ${allHosts.length - hosts.length} 个公网 CDN）`);

        const done = [];
        for (let i = 0; i < appIds.length; i++) {
            if (state.cancel_requested) break;
            const id = appIds[i];
            state.progress.app = id;
            state.progress.app_index = i + 1;
            log('');
            log(`>>> [${i + 1}/${appIds.length}] 开始处理 App ${id}`);
            try {
                done.push(await prefillApp(user, id, hosts, cell));
            } catch (e) {
                log(`>>> App ${id} 失败：${e.message}`);
            }
            log(`>>> 累计：${(state.progress.bytes / 1048576).toFixed(1)} MB，`
                + `成功 ${state.progress.chunks_ok}，失败 ${state.progress.chunks_failed}，`
                + `命中 ${state.progress.cache_hit}，回源 ${state.progress.cache_miss}`);
        }

        const ok = state.progress.chunks_failed === 0 && done.length === appIds.length;
        state.result = {
            ok,
            apps: done,
            elapsed_s: +((performance.now() - t0) / 1000).toFixed(1),
            ...state.progress
        };
        log(`>>> 任务结束：${ok ? '成功' : '部分失败'}，耗时 ${state.result.elapsed_s}s`);
    } catch (e) {
        state.result = { ok: false, error: String(e.message || e), elapsed_s: +((performance.now() - t0) / 1000).toFixed(1) };
        log(`>>> 任务失败：${e.message || e}`);
    } finally {
        try { user && user.logOff(); } catch (e) { /* ignore */ }
        state.running = false;
        state.finished_at = Date.now();
    }
}

// ---------------- HTTP ----------------
function send(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
}

// ---------------- 扫码登录 ----------------
let loginSession = null;
let loginState = { status: 'idle', url: null, error: null, steamID: null, saved_at: null };

try { fs.mkdirSync('/work', { recursive: true }); } catch (e) { /* ignore */ }

async function startQrLogin() {
    if (loginSession) {
        try { loginSession.cancelLoginAttempt(); } catch (e) { /* ignore */ }
    }
    // 必须显式指定平台类型；SteamClient 才能拿到可用于 CM 登录的 refreshToken
    const session = new LoginSession(EAuthTokenPlatformType.SteamClient);
    loginSession = session;
    loginState = { status: 'starting', url: null, error: null, steamID: null, saved_at: null };

    session.on('authenticated', () => {
        try {
            fs.writeFileSync(
                TOKEN_FILE,
                JSON.stringify({ refreshToken: session.refreshToken, saved_at: Date.now() }),
                { mode: 0o600 }
            );
            loginState = {
                status: 'ok',
                url: loginState.url,
                error: null,
                steamID: session.steamID ? session.steamID.toString() : null,
                saved_at: Date.now()
            };
            log('>>> 扫码登录成功，凭据已保存到 worker');
        } catch (e) {
            loginState = { status: 'error', url: loginState.url, error: '保存凭据失败：' + e.message };
        }
    });
    session.on('error', (e) => {
        loginState = { status: 'error', url: loginState.url, error: String(e.message || e) };
    });
    session.on('timeout', () => {
        loginState = { status: 'timeout', url: loginState.url, error: '二维码已过期，请重新生成' };
    });

    const r = await session.startWithQR();
    loginState = { status: 'pending', url: r.qrChallengeUrl, error: null, steamID: null, saved_at: null };
    return loginState;
}

const LOGIN_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Steam 扫码登录</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#111;color:#eee;
      display:flex;flex-direction:column;align-items:center;padding:40px 20px;margin:0}
 h1{font-size:18px;font-weight:500;margin:0 0 8px}
 p{font-size:13px;color:#999;margin:6px 0;text-align:center}
 #qr{background:#fff;padding:16px;border-radius:12px;margin:20px 0;min-width:300px;min-height:300px;
     display:flex;align-items:center;justify-content:center}
 #msg{font-size:14px;font-weight:500}
 .ok{color:#4ade80}.err{color:#f87171}
 code{font-size:11px;color:#666;word-break:break-all;max-width:340px;display:block;margin-top:10px}
</style></head>
<body>
<h1>Steam 扫码登录</h1>
<p>打开手机 Steam App → 右下角「Steam 令牌」→ 扫描二维码</p>
<div id="qr">生成中…</div>
<div id="msg"></div>
<code id="url"></code>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>
let rendered = false;
function poll(){
  fetch('/login/qr/state').then(r=>r.json()).then(s=>{
    const msg = document.getElementById('msg');
    if (s.status === 'ok') { msg.className='ok'; msg.textContent='登录成功，凭据已保存'; return; }
    if (s.status === 'error' || s.status === 'timeout') { msg.className='err'; msg.textContent=s.error||'失败'; return; }
    if (s.status === 'pending'){
      msg.className=''; msg.textContent='等待扫码…';
      if (!rendered && s.url) {
        rendered = true;
        document.getElementById('qr').innerHTML='';
        if (window.QRCode) {
          new QRCode(document.getElementById('qr'), {text:s.url, width:300, height:300});
        } else {
          document.getElementById('qr').textContent='二维码库加载失败，请手动打开下方链接';
        }
        document.getElementById('url').textContent = s.url;
      }
    }
    setTimeout(poll, 1500);
  }).catch(()=>setTimeout(poll,2000));
}
fetch('/login/qr/start',{method:'POST'}).then(()=>poll());
</script>
</body></html>`;

const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === 'GET' && url.pathname === '/login') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(LOGIN_HTML);
        return;
    }

    if (req.method === 'POST' && url.pathname === '/login/qr/start') {
        startQrLogin()
            .then(s => send(res, 200, s))
            .catch(e => send(res, 500, { error: String(e.message || e) }));
        return;
    }

    if (req.method === 'GET' && url.pathname === '/login/qr/state') {
        return send(res, 200, loginState);
    }

    if (req.method === 'GET' && url.pathname === '/auth') {
        let has = false;
        try {
            if (fs.existsSync(TOKEN_FILE)) {
                const d = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
                has = !!(d && d.refreshToken);
            }
        } catch (e) { /* ignore */ }
        return send(res, 200, {
            has_token: has,
            steam_id: loginState.status === 'ok' ? loginState.steamID : null,
            login_status: loginState.status
        });
    }

    if (req.method === 'GET' && url.pathname === '/health') {
        return send(res, 200, { ok: true, running: state.running, version: 1 });
    }

    if (req.method === 'GET' && url.pathname === '/status') {
        return send(res, 200, statusPayload());
    }

    if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        });
        res.write('\n');
        subscribers.add(res);
        req.on('close', () => subscribers.delete(res));
        return;
    }

    if (req.method === 'POST' && url.pathname === '/cancel') {
        state.cancel_requested = true;
        log('>>> 收到取消请求，正在停止…');
        return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && url.pathname === '/prefill') {
        let body = '';
        req.on('data', d => { body += d; });
        req.on('end', () => {
            if (state.running) return send(res, 409, { error: '已有任务在运行中' });
            let payload;
            try { payload = JSON.parse(body || '{}'); } catch (e) {
                return send(res, 400, { error: 'JSON 解析失败' });
            }
            const appIds = (payload.app_ids || []).map(Number).filter(n => Number.isInteger(n) && n > 0);
            if (!appIds.length) return send(res, 400, { error: 'app_ids 不能为空' });
            const cell = Number(payload.cell || DEFAULT_CELL);

            runJob(appIds, cell).catch(e => log(`>>> 未捕获异常：${e.message}`));
            return send(res, 200, { ok: true, app_ids: appIds, cell });
        });
        return;
    }

    send(res, 404, { error: 'not found' });
});

server.listen(PORT, '0.0.0.0', () => {
    log(`worker 已启动，端口 ${PORT}，OS 过滤=${OS_FILTER}，并发=${CONCURRENCY}`);
});
