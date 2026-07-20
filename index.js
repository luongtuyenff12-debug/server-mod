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
app.use(helmet());
app.use(express.json());
app.use(rateLimit({
  windowMs: 60 * 1000, max: 30,
  standardHeaders: true, legacyHeaders: false,
  message: { status: 'RATE_LIMITED', error: 'Too many requests', message: 'Server returned error: 429' }
}));

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

// ─── 404 / error ─────────────────────────────────────────────────────────────
app.use((req, res) => err(res, 'NOT_FOUND', 'Endpoint not found', 404));
app.use((e, req, res, next) => err(res, 'SERVER_ERROR', e.message, 500));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Key server running on port ${PORT}`));
