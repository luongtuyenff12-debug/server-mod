const express  = require('express');
const rateLimit = require('express-rate-limit');
const helmet   = require('helmet');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const app      = express();

// ─── Config ──────────────────────────────────────────────────────────────────
const CONFIG = {
  HTTP_USER_AGENT:     'CakModsLoader',
  JSON_STATUS_SUCCESS: 'SUCCESS',
  LIBS: {
    'libCakMods.so': {
      file_url: process.env.LIB_FILE_URL || 'https://imgui.ngocthinhmodder.site/loadlibv16/libCakMods.so',
      sha256:    process.env.LIB_SHA256  || 'e95aad805482ab6bfd365160ef515e7d15355f1b65cf3bd36822a242cc9eee3f',
      version:   process.env.LIB_VERSION || '1.0.0',
    }
  },
  KEY_VALIDATION_MODE: process.env.KEY_VALIDATION_MODE || 'local',
  KEYVAULT_URL:        process.env.KEYVAULT_URL  || null,
  KEYVAULT_SECRET:     process.env.KEYVAULT_SECRET || null,
  ADMIN_SECRET:        process.env.ADMIN_SECRET  || 'changeme',
};

// Keys lưu trong memory (reset khi restart) — đổi sang file nếu cần persist
// Hoặc đặt KEYS_FILE_PATH để dùng file JSON
const KEYS_FILE = process.env.KEYS_FILE_PATH || null;
let KEYS = {};
if (KEYS_FILE && fs.existsSync(KEYS_FILE)) {
  try { KEYS = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')); } catch {}
}

function saveKeys() {
  if (KEYS_FILE) fs.writeFileSync(KEYS_FILE, JSON.stringify(KEYS, null, 2));
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json());
app.use(rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'RATE_LIMITED', error: 'Too many requests', message: 'Server returned error: 429' }
}));

// ─── CORS — cho phép web admin truy cập ──────────────────────────────────────
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type, x-admin-secret');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ─── Helper ───────────────────────────────────────────────────────────────────
function err(res, code, detail, http = 400) {
  return res.status(http).json({ status: code, error: detail, message: `Server returned error: ${http}` });
}

// ─── Key validation ───────────────────────────────────────────────────────────
async function validateKey(key, hwid) {
  if (CONFIG.KEY_VALIDATION_MODE === 'keyvault' && CONFIG.KEYVAULT_URL) {
    try {
      const r = await fetch(`${CONFIG.KEYVAULT_URL}/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-secret': CONFIG.KEYVAULT_SECRET || '' },
        body: JSON.stringify({ key, hwid })
      });
      const d = await r.json();
      return d.status === 'SUCCESS' ? { valid: true } : { valid: false, code: d.status, detail: d.error || 'KeyVault từ chối' };
    } catch {
      return { valid: false, code: 'KEYVAULT_ERROR', detail: 'Không kết nối được KeyVault' };
    }
  }

  // Local validation
  const e = KEYS[key];
  if (!e)          return { valid: false, code: 'INVALID_KEY',  detail: 'Key không tồn tại' };
  if (!e.active)   return { valid: false, code: 'KEY_DISABLED', detail: 'Key đã bị vô hiệu hóa' };
  if (e.expires && new Date(e.expires) < new Date())
                   return { valid: false, code: 'KEY_EXPIRED',  detail: 'Key đã hết hạn' };
  if (hwid) {
    if (!e.hwid)  { KEYS[key].hwid = hwid; saveKeys(); }
    else if (e.hwid !== hwid)
                   return { valid: false, code: 'HWID_MISMATCH', detail: 'HWID không khớp' };
  }
  return { valid: true };
}

// ─── POST /loadlibv16/check.php ───────────────────────────────────────────────
app.all('/loadlibv16/check.php', async (req, res) => {
  const ua = req.headers['user-agent'] || '';
  if (!ua.includes(CONFIG.HTTP_USER_AGENT)) return err(res, 'UA_BLOCKED', 'User-Agent không hợp lệ', 403);

  const { key, hwid, lib = 'libCakMods.so' } = { ...req.query, ...req.body };
  if (!key) return err(res, 'MISSING_KEY', 'Thiếu tham số key', 400);

  const libEntry = CONFIG.LIBS[lib];
  if (!libEntry) return err(res, 'INVALID_LIB', `Lib '${lib}' không tồn tại`, 404);

  const result = await validateKey(key, hwid || null);
  if (!result.valid) return err(res, result.code, result.detail, 403);

  res.json({
    status:   CONFIG.JSON_STATUS_SUCCESS,
    file_url: libEntry.file_url,
    sha256:   libEntry.sha256,
    version:  libEntry.version,
    message:  'OK'
  });
});

// ─── GET /loadlibv16/:file — redirect tới CDN ────────────────────────────────
app.get('/loadlibv16/:libFile', (req, res) => {
  const ua = req.headers['user-agent'] || '';
  if (!ua.includes(CONFIG.HTTP_USER_AGENT)) return err(res, 'UA_BLOCKED', 'User-Agent không hợp lệ', 403);
  const libEntry = CONFIG.LIBS[req.params.libFile];
  if (!libEntry) return err(res, 'NOT_FOUND', `File không tìm thấy`, 404);
  res.redirect(302, libEntry.file_url);
});

// ─── Admin: auth middleware ───────────────────────────────────────────────────
function adminAuth(req, res, next) {
  if (req.headers['x-admin-secret'] !== CONFIG.ADMIN_SECRET)
    return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function genKey(prefix = 'KEY') {
  const r = crypto.randomBytes(6).toString('hex').toUpperCase();
  return `${prefix}-${r.slice(0,4)}-${r.slice(4,8)}-${r.slice(8,12)}`;
}

app.get('/admin/keys',              adminAuth, (req, res) => {
  res.json({ total: Object.keys(KEYS).length, keys: Object.entries(KEYS).map(([k,v]) => ({ key: k, ...v })) });
});
app.post('/admin/keys',             adminAuth, (req, res) => {
  const { prefix = 'KEY', expires = null, note = '', count = 1 } = req.body;
  const created = [];
  for (let i = 0; i < Math.min(count, 100); i++) {
    const k = genKey(prefix);
    KEYS[k] = { active: true, hwid: null, expires, note };
    created.push(k);
  }
  saveKeys();
  res.status(201).json({ created });
});
app.patch('/admin/keys/:key',       adminAuth, (req, res) => {
  if (!KEYS[req.params.key]) return res.status(404).json({ error: 'Key not found' });
  ['active','expires','hwid','note'].forEach(f => { if (req.body[f] !== undefined) KEYS[req.params.key][f] = req.body[f]; });
  saveKeys();
  res.json({ key: req.params.key, ...KEYS[req.params.key] });
});
app.delete('/admin/keys/:key',      adminAuth, (req, res) => {
  if (!KEYS[req.params.key]) return res.status(404).json({ error: 'Key not found' });
  delete KEYS[req.params.key]; saveKeys();
  res.json({ deleted: req.params.key });
});
app.post('/admin/keys/:key/reset-hwid', adminAuth, (req, res) => {
  if (!KEYS[req.params.key]) return res.status(404).json({ error: 'Key not found' });
  KEYS[req.params.key].hwid = null; saveKeys();
  res.json({ message: 'HWID reset', key: req.params.key });
});

// ─── Web Admin UI ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Key Admin Panel</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@300;400;500;600&display=swap');
:root{--bg:#0d0f14;--surface:#151820;--card:#1c2030;--border:#252a3a;--accent:#4f8ef7;--accent2:#7c3aed;--green:#22c55e;--red:#ef4444;--yellow:#f59e0b;--text:#e2e8f0;--muted:#64748b;--mono:'JetBrains Mono',monospace;--sans:'Inter',sans-serif}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:var(--sans);font-size:14px;min-height:100vh}
#login-screen{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px;background:radial-gradient(ellipse at 50% 0%,#1a2040 0%,var(--bg) 60%)}
.login-box{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:40px 32px;width:100%;max-width:360px}
.login-logo{text-align:center;margin-bottom:32px}
.login-logo .icon{width:56px;height:56px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:14px;display:inline-flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:12px}
.login-logo h1{font-size:20px;font-weight:600}
.login-logo p{color:var(--muted);font-size:13px;margin-top:4px}
label{display:block;font-size:12px;color:var(--muted);margin-bottom:6px;font-weight:500;letter-spacing:.5px;text-transform:uppercase}
input,select{width:100%;background:var(--surface);border:1px solid var(--border);border-radius:8px;color:var(--text);font-family:var(--sans);font-size:14px;padding:10px 12px;outline:none;transition:border-color .15s}
input:focus,select:focus{border-color:var(--accent)}
.field{margin-bottom:16px}
.btn{display:inline-flex;align-items:center;gap:6px;padding:9px 16px;border-radius:8px;font-family:var(--sans);font-size:13px;font-weight:500;cursor:pointer;border:none;transition:opacity .15s,transform .1s}
.btn:active{transform:scale(.97)}
.btn-primary{background:var(--accent);color:#fff}
.btn-danger{background:var(--red);color:#fff}
.btn-ghost{background:var(--border);color:var(--text)}
.btn-sm{padding:5px 10px;font-size:12px}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-full{width:100%;justify-content:center}
#app{display:none;flex-direction:column;min-height:100vh}
#app.show{display:flex}
header{background:var(--surface);border-bottom:1px solid var(--border);padding:0 20px;display:flex;align-items:center;justify-content:space-between;height:56px;position:sticky;top:0;z-index:100}
.header-left{display:flex;align-items:center;gap:10px}
.header-logo{width:32px;height:32px;background:linear-gradient(135deg,var(--accent),var(--accent2));border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:14px}
.header-title{font-weight:600;font-size:15px}
.server-url{font-size:11px;color:var(--muted);font-family:var(--mono)}
.nav-tabs{display:flex;gap:4px;padding:12px 20px;background:var(--surface);border-bottom:1px solid var(--border);overflow-x:auto;scrollbar-width:none}
.nav-tabs::-webkit-scrollbar{display:none}
.tab{padding:7px 14px;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;color:var(--muted);background:none;border:none;white-space:nowrap;transition:all .15s}
.tab.active{background:var(--card);color:var(--text);border:1px solid var(--border)}
.tab:hover:not(.active){color:var(--text)}
main{flex:1;padding:20px;max-width:900px;margin:0 auto;width:100%}
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
.stat-card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px}
.stat-label{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px}
.stat-value{font-size:26px;font-weight:600;font-family:var(--mono)}
.stat-value.green{color:var(--green)}
.stat-value.yellow{color:var(--yellow)}
.stat-value.red{color:var(--red)}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;margin-bottom:16px}
.card-header{padding:16px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
.card-title{font-size:14px;font-weight:600}
.table-wrap{overflow-x:auto}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;padding:10px 16px;border-bottom:1px solid var(--border);white-space:nowrap}
td{padding:11px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:rgba(255,255,255,.02)}
.badge{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:20px;font-size:11px;font-weight:500}
.badge-green{background:rgba(34,197,94,.15);color:var(--green)}
.badge-red{background:rgba(239,68,68,.15);color:var(--red)}
.badge-yellow{background:rgba(245,158,11,.15);color:var(--yellow)}
.badge-blue{background:rgba(79,142,247,.15);color:var(--accent)}
.key-mono{font-family:var(--mono);font-size:12px;color:var(--accent)}
.actions{display:flex;gap:6px;flex-wrap:wrap}
.modal-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:200;align-items:center;justify-content:center;padding:20px}
.modal-backdrop.open{display:flex}
.modal{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:28px 24px;width:100%;max-width:420px}
.modal h2{font-size:16px;margin-bottom:20px}
.modal-footer{display:flex;gap:8px;margin-top:20px;justify-content:flex-end}
#toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 18px;font-size:13px;font-weight:500;z-index:999;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}
#toast.show{opacity:1}
#toast.ok{border-color:var(--green);color:var(--green)}
#toast.err{border-color:var(--red);color:var(--red)}
.empty{text-align:center;padding:40px;color:var(--muted)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.search-bar{position:relative}
.search-bar input{padding-left:32px}
.search-icon{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--muted);font-size:14px;pointer-events:none}
.dot{width:7px;height:7px;border-radius:50%;display:inline-block}
.dot-green{background:var(--green)}
.dot-red{background:var(--red)}
.section-title{font-size:13px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.5px;margin-bottom:12px}
#page-keys,#page-create,#page-test{display:none}
#page-keys.active,#page-create.active,#page-test.active{display:block}
.test-result{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px;font-family:var(--mono);font-size:12px;line-height:1.7;white-space:pre-wrap;word-break:break-all;margin-top:12px;min-height:80px;color:var(--text)}
.copy-btn{cursor:pointer;background:none;border:none;color:var(--muted);font-size:13px;padding:2px}
.copy-btn:hover{color:var(--text)}
@media(max-width:480px){.stats-grid{grid-template-columns:repeat(3,1fr);gap:8px}.stat-card{padding:12px}.stat-value{font-size:20px}main{padding:12px}td,th{padding:9px 10px}.row2{grid-template-columns:1fr}}
</style>
</head>
<body>

<div id="login-screen">
  <div class="login-box">
    <div class="login-logo">
      <div class="icon">🔑</div>
      <h1>Key Admin</h1>
      <p>Quản lý license keys</p>
    </div>
    <div class="field">
      <label>Admin Secret</label>
      <input id="inp-secret" type="password" placeholder="••••••••">
    </div>
    <div id="login-err" style="color:var(--red);font-size:12px;margin-bottom:12px;display:none"></div>
    <button class="btn btn-primary btn-full" onclick="doLogin()">Đăng nhập →</button>
  </div>
</div>

<div id="app">
  <header>
    <div class="header-left">
      <div class="header-logo">🔑</div>
      <div>
        <div class="header-title">Key Admin</div>
        <div class="server-url" id="disp-url"></div>
      </div>
    </div>
    <button class="btn btn-ghost btn-sm" onclick="doLogout()">Đăng xuất</button>
  </header>
  <nav class="nav-tabs">
    <button class="tab active" onclick="switchTab('keys',this)">📋 Danh sách Keys</button>
    <button class="tab" onclick="switchTab('create',this)">➕ Tạo Keys</button>
    <button class="tab" onclick="switchTab('test',this)">🧪 Test API</button>
  </nav>
  <main>
    <div id="page-keys" class="active">
      <div class="stats-grid">
        <div class="stat-card"><div class="stat-label">Tổng keys</div><div class="stat-value" id="s-total">—</div></div>
        <div class="stat-card"><div class="stat-label">Active</div><div class="stat-value green" id="s-active">—</div></div>
        <div class="stat-card"><div class="stat-label">Đã dùng</div><div class="stat-value yellow" id="s-used">—</div></div>
      </div>
      <div class="card">
        <div class="card-header">
          <div class="card-title">Tất cả Keys</div>
          <div style="display:flex;gap:8px;flex:1;max-width:320px">
            <div class="search-bar" style="flex:1">
              <span class="search-icon">🔍</span>
              <input id="search" type="text" placeholder="Tìm key..." oninput="filterKeys()">
            </div>
            <button class="btn btn-ghost btn-sm" onclick="loadKeys()">↻</button>
          </div>
        </div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Key</th><th>Trạng thái</th><th>HWID</th><th>Hết hạn</th><th>Ghi chú</th><th>Thao tác</th></tr></thead>
            <tbody id="keys-body"><tr><td colspan="6" class="empty">Đang tải...</td></tr></tbody>
          </table>
        </div>
      </div>
    </div>

    <div id="page-create">
      <div class="card">
        <div class="card-header"><div class="card-title">Tạo Keys mới</div></div>
        <div style="padding:20px">
          <div class="row2">
            <div class="field"><label>Prefix</label><input id="c-prefix" type="text" placeholder="CAK" value="CAK"></div>
            <div class="field"><label>Số lượng (tối đa 100)</label><input id="c-count" type="number" min="1" max="100" value="1"></div>
          </div>
          <div class="field"><label>Hết hạn (để trống = vĩnh viễn)</label><input id="c-expires" type="datetime-local"></div>
          <div class="field"><label>Ghi chú</label><input id="c-note" type="text" placeholder="VD: Gói VIP tháng 7"></div>
          <button class="btn btn-primary" onclick="createKeys()">➕ Tạo Keys</button>
        </div>
      </div>
      <div class="card" id="created-box" style="display:none">
        <div class="card-header">
          <div class="card-title">✅ Keys vừa tạo</div>
          <button class="btn btn-ghost btn-sm" onclick="copyText(document.getElementById('created-list').textContent)">📋 Copy tất cả</button>
        </div>
        <div style="padding:16px"><div class="test-result" id="created-list"></div></div>
      </div>
    </div>

    <div id="page-test">
      <div class="card">
        <div class="card-header"><div class="card-title">🧪 Test check.php</div></div>
        <div style="padding:20px">
          <div class="field"><label>Key</label><input id="t-key" type="text" placeholder="CAK-XXXX-XXXX-XXXX"></div>
          <div class="row2">
            <div class="field"><label>HWID (tuỳ chọn)</label><input id="t-hwid" type="text" placeholder="android_device_id"></div>
            <div class="field"><label>Lib file</label><input id="t-lib" type="text" value="libCakMods.so"></div>
          </div>
          <button class="btn btn-primary" onclick="testApi()">Gửi Request →</button>
          <div id="test-result" class="test-result" style="display:none"></div>
        </div>
      </div>
      <div class="card">
        <div class="card-header"><div class="card-title">📡 Endpoints</div></div>
        <div style="padding:16px;display:flex;flex-direction:column;gap:10px">
          <div><div class="section-title">Check key</div><div class="test-result" style="margin-top:4px" id="ep-check"></div></div>
          <div><div class="section-title">Admin — list keys</div><div class="test-result" style="margin-top:4px" id="ep-admin"></div></div>
        </div>
      </div>
    </div>
  </main>
</div>

<div class="modal-backdrop" id="modal-edit">
  <div class="modal">
    <h2>✏️ Chỉnh sửa Key</h2>
    <input type="hidden" id="edit-key">
    <div class="field"><label>Key</label><input id="edit-key-disp" readonly style="opacity:.5"></div>
    <div class="field"><label>Trạng thái</label><select id="edit-active"><option value="true">✅ Active</option><option value="false">🔴 Disabled</option></select></div>
    <div class="field"><label>Hết hạn (để trống = vĩnh viễn)</label><input id="edit-expires" type="datetime-local"></div>
    <div class="field"><label>Ghi chú</label><input id="edit-note" type="text"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-edit')">Huỷ</button>
      <button class="btn btn-primary" onclick="saveEdit()">Lưu</button>
    </div>
  </div>
</div>

<div class="modal-backdrop" id="modal-del">
  <div class="modal">
    <h2>🗑️ Xoá Key?</h2>
    <p style="color:var(--muted);margin-bottom:8px">Key này sẽ bị xoá vĩnh viễn:</p>
    <div class="key-mono" id="del-key-disp" style="margin-bottom:16px"></div>
    <div class="modal-footer">
      <button class="btn btn-ghost" onclick="closeModal('modal-del')">Huỷ</button>
      <button class="btn btn-danger" onclick="confirmDelete()">Xoá</button>
    </div>
  </div>
</div>

<div id="toast"></div>

<script>
const SERVER = window.location.origin;
let SECRET = '', ALL_KEYS = [];

function doLogin() {
  const secret = document.getElementById('inp-secret').value.trim();
  const errEl  = document.getElementById('login-err');
  errEl.style.display = 'none';
  if (!secret) { showErr(errEl,'Vui lòng nhập secret'); return; }
  SECRET = secret;
  fetch(SERVER+'/admin/keys',{headers:{'x-admin-secret':secret}})
    .then(r => {
      if(r.status===401){SECRET='';showErr(errEl,'Secret không đúng');return;}
      return r.json().then(d => {
        document.getElementById('disp-url').textContent = SERVER.replace('https://','');
        document.getElementById('login-screen').style.display='none';
        document.getElementById('app').classList.add('show');
        setEndpoints();
        ALL_KEYS = d.keys||[];
        renderKeys(ALL_KEYS);
        updateStats(ALL_KEYS);
      });
    })
    .catch(()=>showErr(errEl,'Không kết nối được server'));
}

function showErr(el,msg){el.textContent=msg;el.style.display='block'}

function doLogout(){
  SECRET='';
  document.getElementById('app').classList.remove('show');
  document.getElementById('login-screen').style.display='flex';
  document.getElementById('inp-secret').value='';
}

function api(path,method='GET',body=null){
  const opts={method,headers:{'x-admin-secret':SECRET,'Content-Type':'application/json'}};
  if(body)opts.body=JSON.stringify(body);
  return fetch(SERVER+path,opts);
}

function loadKeys(){
  api('/admin/keys').then(r=>r.json()).then(d=>{
    ALL_KEYS=d.keys||[];
    renderKeys(ALL_KEYS);
    updateStats(ALL_KEYS);
  }).catch(()=>toast('Lỗi tải keys','err'));
}

function filterKeys(){
  const q=document.getElementById('search').value.toLowerCase();
  renderKeys(q?ALL_KEYS.filter(k=>k.key.toLowerCase().includes(q)||(k.note||'').toLowerCase().includes(q)):ALL_KEYS);
}

function renderKeys(keys){
  const tbody=document.getElementById('keys-body');
  if(!keys.length){tbody.innerHTML='<tr><td colspan="6" class="empty">Không có key nào</td></tr>';return;}
  tbody.innerHTML=keys.map(k=>{
    const active=k.active!==false;
    const expired=k.expires&&new Date(k.expires)<new Date();
    const status=!active?'<span class="badge badge-red"><span class="dot dot-red"></span>Tắt</span>'
                :expired?'<span class="badge badge-yellow">Hết hạn</span>'
                        :'<span class="badge badge-green"><span class="dot dot-green"></span>Active</span>';
    const hwid=k.hwid?'<span class="badge badge-blue" title="'+k.hwid+'">Đã bind</span>':'<span style="color:var(--muted)">—</span>';
    const exp=k.expires?new Date(k.expires).toLocaleDateString('vi-VN'):'<span style="color:var(--muted)">Vĩnh viễn</span>';
    const kesc=k.key.replace(/'/g,"\\'");
    const kdata=JSON.stringify(k).replace(/"/g,'&quot;');
    return '<tr><td><span class="key-mono">'+k.key+'</span> <button class="copy-btn" onclick="copyText(\''+kesc+'\')">📋</button></td>'
      +'<td>'+status+'</td><td>'+hwid+'</td><td>'+exp+'</td>'
      +'<td style="max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+(k.note||'<span style="color:var(--muted)">—</span>')+'</td>'
      +'<td><div class="actions">'
      +'<button class="btn btn-ghost btn-sm" onclick="openEdit('+kdata+')">✏️</button>'
      +(k.hwid?'<button class="btn btn-ghost btn-sm" onclick="resetHwid(\''+kesc+'\')" title="Reset HWID">🔓</button>':'')
      +'<button class="btn btn-danger btn-sm" onclick="openDelete(\''+kesc+'\')">🗑️</button>'
      +'</div></td></tr>';
  }).join('');
}

function updateStats(keys){
  const active=keys.filter(k=>k.active!==false&&!(k.expires&&new Date(k.expires)<new Date())).length;
  document.getElementById('s-total').textContent=keys.length;
  document.getElementById('s-active').textContent=active;
  document.getElementById('s-used').textContent=keys.filter(k=>k.hwid).length;
}

function createKeys(){
  const prefix=document.getElementById('c-prefix').value.trim()||'KEY';
  const count=parseInt(document.getElementById('c-count').value)||1;
  const expires=document.getElementById('c-expires').value;
  const note=document.getElementById('c-note').value.trim();
  api('/admin/keys','POST',{prefix,count,expires:expires?new Date(expires).toISOString():null,note})
    .then(r=>r.json()).then(d=>{
      if(!d.created){toast('Lỗi tạo keys','err');return;}
      document.getElementById('created-list').textContent=d.created.join('\\n');
      document.getElementById('created-box').style.display='block';
      toast('✅ Đã tạo '+d.created.length+' key','ok');
      loadKeys();
    }).catch(()=>toast('Lỗi tạo keys','err'));
}

function openEdit(k){
  document.getElementById('edit-key').value=k.key;
  document.getElementById('edit-key-disp').value=k.key;
  document.getElementById('edit-active').value=String(k.active!==false);
  document.getElementById('edit-note').value=k.note||'';
  if(k.expires){const d=new Date(k.expires);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());document.getElementById('edit-expires').value=d.toISOString().slice(0,16);}
  else document.getElementById('edit-expires').value='';
  document.getElementById('modal-edit').classList.add('open');
}

function saveEdit(){
  const key=document.getElementById('edit-key').value;
  const active=document.getElementById('edit-active').value==='true';
  const expires=document.getElementById('edit-expires').value;
  const note=document.getElementById('edit-note').value.trim();
  api('/admin/keys/'+encodeURIComponent(key),'PATCH',{active,expires:expires?new Date(expires).toISOString():null,note})
    .then(()=>{closeModal('modal-edit');toast('✅ Đã lưu','ok');loadKeys();})
    .catch(()=>toast('Lỗi lưu','err'));
}

let pendingDelete='';
function openDelete(key){pendingDelete=key;document.getElementById('del-key-disp').textContent=key;document.getElementById('modal-del').classList.add('open');}
function confirmDelete(){
  api('/admin/keys/'+encodeURIComponent(pendingDelete),'DELETE')
    .then(()=>{closeModal('modal-del');toast('🗑️ Đã xoá','ok');loadKeys();})
    .catch(()=>toast('Lỗi xoá','err'));
}

function resetHwid(key){
  if(!confirm('Reset HWID cho key:\\n'+key+'?'))return;
  api('/admin/keys/'+encodeURIComponent(key)+'/reset-hwid','POST')
    .then(()=>{toast('🔓 HWID đã reset','ok');loadKeys();})
    .catch(()=>toast('Lỗi reset HWID','err'));
}

function testApi(){
  const key=document.getElementById('t-key').value.trim();
  const hwid=document.getElementById('t-hwid').value.trim();
  const lib=document.getElementById('t-lib').value.trim();
  const el=document.getElementById('test-result');
  el.style.display='block';el.textContent='Đang gửi...';el.style.color='var(--text)';
  const params=new URLSearchParams({key,lib});
  if(hwid)params.set('hwid',hwid);
  fetch(SERVER+'/loadlibv16/check.php?'+params,{headers:{'User-Agent':'CakModsLoader'}})
    .then(r=>r.json().then(d=>{
      el.textContent='HTTP '+r.status+'\\n\\n'+JSON.stringify(d,null,2);
      el.style.color=d.status==='SUCCESS'?'var(--green)':'var(--red)';
    })).catch(e=>{el.textContent='Lỗi: '+e.message;el.style.color='var(--red)';});
}

function setEndpoints(){
  document.getElementById('ep-check').textContent='POST '+SERVER+'/loadlibv16/check.php\\nUser-Agent: CakModsLoader\\nBody: { "key": "...", "hwid": "...", "lib": "libCakMods.so" }';
  document.getElementById('ep-admin').textContent='GET '+SERVER+'/admin/keys\\nHeader: x-admin-secret: ••••••';
}

function switchTab(page,el){
  document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
  el.classList.add('active');
  document.querySelectorAll('#page-keys,#page-create,#page-test').forEach(p=>p.classList.remove('active'));
  document.getElementById('page-'+page).classList.add('active');
  if(page==='keys')loadKeys();
}

function closeModal(id){document.getElementById(id).classList.remove('open');}

function copyText(txt){
  navigator.clipboard.writeText(txt).then(()=>toast('📋 Đã copy','ok'));
}

let toastTimer;
function toast(msg,type='ok'){
  const el=document.getElementById('toast');
  el.textContent=msg;el.className='show '+type;
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>el.className='',2200);
}

window.addEventListener('keydown',e=>{
  if(e.key==='Escape')document.querySelectorAll('.modal-backdrop.open').forEach(m=>m.classList.remove('open'));
});
</script>
</body>
</html>`);
});

// ─── 404 / error ─────────────────────────────────────────────────────────────
app.use((req, res) => err(res, 'NOT_FOUND', 'Endpoint not found', 404));
app.use((e, req, res, next) => err(res, 'SERVER_ERROR', e.message, 500));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Key server running on port ${PORT}`));
