/**
 * telegram-server.js v14.0 — Server Telegram Bot độc lập
 *
 * NÂNG CẤP v14.0 — Đồng bộ hoàn toàn với BackgroundWebVerifier.java + MainActivity.java:
 *
 *  ✅ FIX: _pgGetState() — đọc step chính xác như getStep() trong Java
 *       • 'access granted' check TRƯỚC 'unlocking', 'unlocked', rồi mới 'step1'
 *       • readGrantedTimer() — 3 pass (leaf node đơn → ghép 2-3 node → fullbody)
 *       • readUnlockTimer() — TreeWalker text node tìm "Xs" / "Xm Ys"
 *
 *  ✅ FIX: _pgFillInput() — dùng React native setter giống setVal() Java
 *
 *  ✅ FIX: _pgFindAndClickContinue() — 4 pass priority giống findContinueBtn() Java:
 *       0) exact "continue without discord"
 *       1) chứa "without"+"discord", không "join"
 *       2) bắt đầu "continue without"
 *       3) chứa "continue", không join/discord/restart/cancel, len<80
 *
 *  ✅ FIX: Flow 4 bước giống BackgroundWebVerifier.java:
 *       step1   → điền ID + click CWD (đọc countdown trước nếu có)
 *       bước 2-4: unlocking → đợi countdown đúng giây → unlocked → click Continue
 *       → lặp đến khi 'granted'
 *
 *  ✅ FIX: Thông báo tiến độ chi tiết từng bước (Bước 1/4 … 4/4)
 *
 *  ✅ FIX: _handleSuccess() — format thời gian "Xh Ym Zs" như Java
 *
 *  ✅ GIỮ NGUYÊN: key auth, session, webhook, anti-sleep, tất cả lệnh bot
 *
 * Biến môi trường:
 *  TELEGRAM_BOT_TOKEN   — bot token (bắt buộc)
 *  KEY_SERVER_URL       — URL của index server
 *  KEY_SERVER_APP_ID    — appId đăng ký trong dashboard index server
 *  PORT                 — cổng lắng nghe (mặc định 4000)
 *  RENDER_EXTERNAL_URL  — URL public của server này (để đăng ký webhook)
 *
 * Cài đặt:
 *  npm install puppeteer-core @sparticuz/chromium
 *  hoặc: npm install puppeteer  (local dev)
 */

'use strict';

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const url    = require('url');

/* ─── CẤU HÌNH ─────────────────────────────────────────────────────────────── */
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '8352545543:AAGLqW1IkCgqN9_jtIiZaiTKAjBpf38zghs';
const KEY_SERVER_URL = (process.env.KEY_SERVER_URL || 'https://serverkey-u8w6.onrender.com').replace(/\/+$/, '');
const KEY_APP_ID     = process.env.KEY_SERVER_APP_ID || 'telegram-bot';
const TG_SHARED_SECRET = process.env.TELEGRAM_SHARED_SECRET || '';
const PORT           = parseInt(process.env.TGSERVER_PORT || process.env.PORT || '4000', 10);
const TG_API_BASE    = 'https://api.telegram.org/bot' + BOT_TOKEN;

/* ─── SESSION store (in-memory) ────────────────────────────────────────────── */
let sessions = {};

/* ══════════════════════════════════════════════════════════════════════════════
   TELEGRAM API HELPER
   ══════════════════════════════════════════════════════════════════════════════ */
function tgCall(method, params) {
  return new Promise(resolve => {
    try {
      const payload = Buffer.from(JSON.stringify(params || {}), 'utf8');
      const req = https.request(TG_API_BASE + '/' + method, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length
        }
      }, r => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => {
          try { resolve(JSON.parse(data)); } catch (_) { resolve(null); }
        });
      });
      req.on('error', () => resolve(null));
      req.write(payload);
      req.end();
    } catch (_) { resolve(null); }
  });
}

function sendMsg(chatId, text, extra) {
  return tgCall('sendMessage', Object.assign({
    chat_id: chatId,
    text,
    parse_mode: 'HTML'
  }, extra || {}));
}

/* ══════════════════════════════════════════════════════════════════════════════
   XÁC THỰC KEY QUA API CỦA INDEX SERVER
   ══════════════════════════════════════════════════════════════════════════════ */
function checkKeyWithServer(keyValue) {
  return new Promise((resolve, reject) => {
    try {
      const parsed   = new URL(KEY_SERVER_URL);
      const isHttps  = parsed.protocol === 'https:';
      const proto    = isHttps ? https : http;
      const path     = `/api/verify?key=${encodeURIComponent(keyValue)}&app=${encodeURIComponent(KEY_APP_ID)}`;
      const headers  = {
        'User-Agent': 'TelegramBot-KeyVerifier/2.0',
        'Accept': 'application/json'
      };
      if (TG_SHARED_SECRET) headers['X-TG-Secret'] = TG_SHARED_SECRET;
      const options  = {
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path,
        method: 'GET',
        headers
      };
      const req = proto.request(options, r => {
        let data = '';
        r.on('data', c => { data += c; });
        r.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve(json);
          } catch (_) {
            resolve({ valid: false, reason: 'parse_error' });
          }
        });
      });
      req.on('error', err => reject(err));
      req.setTimeout(15000, () => {
        req.destroy();
        reject(new Error('timeout kết nối tới key server'));
      });
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
   XỬ LÝ XÁC THỰC KEY — /key <value>
   ══════════════════════════════════════════════════════════════════════════════ */
async function verifyKeyForChat(chatId, keyVal) {
  if (!keyVal || !keyVal.trim()) {
    await sendMsg(chatId, '❌ <b>Key không hợp lệ.</b>\n\nVui lòng nhập lại key:\n/key');
    return;
  }
  keyVal = keyVal.trim();
  await sendMsg(chatId, `🔄 <b>Đang xác thực key...</b>\n🔑 Key: <code>${keyVal}</code>`);

  try {
    const result = await checkKeyWithServer(keyVal);

    if (!result.valid) {
      let errMsg = '❌ <b>Key không hợp lệ.</b>';
      switch (result.reason) {
        case 'key_not_found':
          errMsg += '\nKey không tồn tại trong hệ thống.\n\n<i>Mua key tại /start</i>';
          break;
        case 'banned':
          errMsg = '🚫 <b>Key đã bị khoá.</b>\nVui lòng liên hệ admin.';
          break;
        case 'expired':
          errMsg = '⏰ <b>Key đã hết hạn.</b>\n\n<i>Gia hạn tại /start</i>';
          break;
        case 'app_denied':
          errMsg = '⛔ <b>Bot chưa được admin cấp quyền.</b>\nVui lòng liên hệ admin hệ thống.';
          break;
        case 'app_pending_approval':
          errMsg = '⏳ <b>Bot đang chờ admin phê duyệt.</b>\nVui lòng liên hệ admin hệ thống.';
          break;
        case 'too_many_failures':
          errMsg = `⚠️ <b>Tạm khoá do nhập sai nhiều lần.</b>\n${result.message || ''}`;
          break;
        case 'rate_limited':
          errMsg = '⏱ <b>Quá nhiều yêu cầu.</b> Thử lại sau 1 phút.';
          break;
        default:
          if (result.message) errMsg += '\n' + result.message;
      }
      await sendMsg(chatId, errMsg);
      return;
    }

    // Key hợp lệ
    sessions[String(chatId)] = sessions[String(chatId)] || {};
    sessions[String(chatId)].savedKey    = keyVal;
    sessions[String(chatId)].keyVerified = true;
    sessions[String(chatId)].waitingForKey = false;

    let expLine = '', remainLine = '';
    const expiresAt = result.expiresAt || result.expires_at;
    if (expiresAt) {
      const expDate   = new Date(expiresAt);
      const remainMs  = expDate.getTime() - Date.now();
      const remainSec = Math.max(0, Math.floor(remainMs / 1000));
      const rh = Math.floor(remainSec / 3600);
      const rm = Math.floor((remainSec % 3600) / 60);
      const rs = remainSec % 60;
      const remainStr = rh > 0 ? `${rh}h ${rm}m ${rs}s` : rm > 0 ? `${rm}m ${rs}s` : `${rs}s`;
      expLine    = `\n📅 Hết hạn: <b>${expDate.toLocaleString('vi-VN')}</b>`;
      remainLine = `\n⏱ Còn lại: <b>${remainStr}</b>`;
    } else {
      expLine = '\n📅 Hạn dùng: <b>Vĩnh viễn ♾️</b>';
    }

    await sendMsg(chatId,
      `✅ <b>Kích hoạt thành công!</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `🔑 Key: <code>${keyVal}</code>` +
      expLine + remainLine + `\n\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n` +
      `<b>📋 Bạn có thể sử dụng các lệnh:</b>\n` +
      `• Gửi <b>ID Free Fire</b> của bạn để xác thực ngay\n` +
      `• /verify — Xác thực ID Free Fire\n` +
      `• /setid &lt;ID&gt; — Lưu ID mặc định (auto-reverify)\n` +
      `• /status — Xem trạng thái phiên\n` +
      `• /cancel — Huỷ phiên xác thực\n` +
      `• /help — Hướng dẫn chi tiết\n\n` +
      `💡 <i>Bây giờ hãy gửi ID Free Fire của bạn để xác thực!</i>`
    );
  } catch (err) {
    console.error('[TgServer] Lỗi gọi key server:', err && err.message);
    await sendMsg(chatId,
      `❌ <b>Không kết nối được tới server xác thực key.</b>\n` +
      `<code>${String(err && err.message || err).slice(0, 100)}</code>\n\n` +
      `Thử lại sau ít phút.`
    );
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   PUPPETEER ENGINE — Đồng bộ hoàn toàn với BackgroundWebVerifier.java
   ══════════════════════════════════════════════════════════════════════════════ */
let _puppeteerMod = null;
let _chromiumMod  = null;
let _puppeteerChecked = false;

async function _loadPuppeteer() {
  if (_puppeteerChecked) return { puppeteer: _puppeteerMod, chromium: _chromiumMod };
  _puppeteerChecked = true;
  try {
    _puppeteerMod = require('puppeteer-core');
    _chromiumMod  = require('@sparticuz/chromium');
    console.log('[TgServer] Engine: puppeteer-core + @sparticuz/chromium');
    return { puppeteer: _puppeteerMod, chromium: _chromiumMod };
  } catch (_) {}
  try {
    _puppeteerMod = require('puppeteer-core');
    _chromiumMod  = require('chrome-aws-lambda');
    console.log('[TgServer] Engine: puppeteer-core + chrome-aws-lambda');
    return { puppeteer: _puppeteerMod, chromium: _chromiumMod };
  } catch (_) {}
  try {
    _puppeteerMod = require('puppeteer');
    _chromiumMod  = null;
    console.log('[TgServer] Engine: puppeteer (local)');
    return { puppeteer: _puppeteerMod, chromium: null };
  } catch (_) {}
  console.warn('[TgServer] Không có Puppeteer — dùng HTTP fallback');
  return { puppeteer: null, chromium: null };
}

/* ── Ad domain list (đồng bộ với BackgroundWebVerifier.java AD_DOMAINS) ───── */
const AD_DOMAINS = [
  'doubleclick.net','googlesyndication.com','adsterra.com','propellerads.com',
  'popads.net','exoclick.com','popcash.net','adcash.com','onclickmega.com',
  'onclickads.net','clickadu.com','evadav.com','onesignal.com','pushcrew.com',
  'subscribers.com','pushwoosh.com','izooto.com','webpushr.com','sendpulse.com',
  'wonderpush.com','pushassist.com','innity.com','admicro.vn','adtima.vn',
  'eclick.vn','mgid.com','taboola.com','outbrain.com','activerevenue.com',
  'trustedmediabrands.com','clicksfly.com','cut-urls.com','clksite.com','linkvertise.com',
  'google-analytics.com','googletagmanager.com','adservice.google.com',
];
function isAdUrl(u) {
  try {
    const h = new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    return AD_DOMAINS.some(d => h === d || h.endsWith('.' + d));
  } catch (_) { return false; }
}

async function _pgSleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/* ── Helper: kiểm tra lỗi navigation/context bị huỷ ───────────────────────── */
function _isNavError(e) {
  if (!e) return false;
  const m = (e.message || '').toLowerCase();
  return m.includes('execution context was destroyed')
      || m.includes('context was destroyed')
      || m.includes('target closed')
      || m.includes('session closed')
      || m.includes('detached');
}

/* ── Helper: evaluate an toàn, retry khi gặp navigation error ──────────────── */
async function _safeEval(page, fn, fallback) {
  for (let i = 0; i < 4; i++) {
    try {
      return await page.evaluate(fn);
    } catch (e) {
      if (_isNavError(e)) {
        await _pgSleep(1200);
        try { await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 8000 }); } catch(_) {}
        await _pgSleep(800);
        continue;
      }
      console.warn(`[safeEval] lần ${i+1} lỗi:`, e.message);
      await _pgSleep(600);
    }
  }
  return fallback;
}

/* ══════════════════════════════════════════════════════════════════════════════
   _pgGetState() — Đồng bộ CHÍNH XÁC với BackgroundWebVerifier.java / MainActivity.java:
   
   Thứ tự check getStep() (QUAN TRỌNG — phải đúng thứ tự):
     1. 'access granted' → granted     ← LUÔN CHECK TRƯỚC
     2. 'unlocking'      → unlocking
     3. 'unlocked' + 'continue' → unlocked
     4. 'verify'/'without discord'/'account' + input → step1
   
   readGrantedTimer() — 3 pass:
     Pass 1: từng leaf node match "Xh Ym Zs" / "Xm Ys" / "Xs"
     Pass 2: ghép 3 node liền kề → hoặc 2 node liền kề
     Pass 3: fullBody text replace whitespace
   
   readUnlockTimer() — TreeWalker text node:
     Match "Xs" (<=120) hoặc "Xm Ys" (<3 phút)
   ══════════════════════════════════════════════════════════════════════════════ */
async function _pgGetState(page) {
  return await _safeEval(page, () => {
    const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    const bodyL    = bodyText.toLowerCase();

    // ── getStep() — ĐÚNG THỨ TỰ ƯU TIÊN như Java ──
    // 'access granted' PHẢI check TRƯỚC 'unlocking'/'unlocked'/'step1'
    // vì trang granted vẫn chứa chữ "Account: ID" bên dưới
    let step = 'unknown';
    if (bodyL.includes('access granted')) {
      step = 'granted';
    } else if (bodyL.includes('unlocking')) {
      step = 'unlocking';
    } else if (bodyL.includes('unlocked') && bodyL.includes('continue')) {
      step = 'unlocked';
    } else if (bodyL.includes('verify') || bodyL.includes('without discord') || bodyL.includes('account')) {
      // Kiểm tra thêm input hoặc STATE<=1 (JS không có STATE nên check input)
      const inp = document.querySelector(
        'input[type="number"],input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])'
      );
      if (inp) step = 'step1';
      else step = 'step1'; // giống Java STATE<=1 fallback
    }

    // ── readGrantedTimer() — đồng bộ BackgroundWebVerifier.java ──
    // Quét leaf node tìm "Xh Ym Zs", hỗ trợ timer bị tách thành nhiều node
    let expires = -1;
    if (step === 'granted') {
      // Thu thập tất cả leaf text node
      const parts = [];
      document.querySelectorAll('*').forEach(el => {
        if (el.children.length === 0) {
          const t = (el.innerText || el.textContent || '').trim();
          if (t) parts.push(t);
        }
      });

      // Pass 1: từng node đơn
      for (const t of parts) {
        let m = t.match(/^(\d+)h\s*(\d+)m\s*(\d+)s$/);
        if (m) { expires = +m[1]*3600 + +m[2]*60 + +m[3]; break; }
        m = t.match(/^(\d+)m\s*(\d+)s$/);
        if (m) { expires = +m[1]*60 + +m[2]; break; }
        m = t.match(/^(\d+)s$/);
        if (m && +m[1] < 7200) { expires = +m[1]; break; }
      }

      // Pass 2: ghép 3 node liền kề (ví dụ: "1h" "6m" "0s" là 3 node riêng)
      if (expires <= 0) {
        for (let i = 0; i < parts.length - 2; i++) {
          const joined = parts[i] + ' ' + parts[i+1] + ' ' + parts[i+2];
          const m = joined.match(/(\d+)h\s*(\d+)m\s*(\d+)s/);
          if (m) { expires = +m[1]*3600 + +m[2]*60 + +m[3]; break; }
        }
      }
      // Pass 2b: ghép 2 node liền kề
      if (expires <= 0) {
        for (let i = 0; i < parts.length - 1; i++) {
          const joined = parts[i] + ' ' + parts[i+1];
          const m = joined.match(/(\d+)m\s*(\d+)s/);
          if (m) { expires = +m[1]*60 + +m[2]; break; }
        }
      }

      // Pass 3: fallback quét toàn bộ body text
      if (expires <= 0) {
        const bodyClean = bodyText.replace(/\s+/g, ' ');
        let m2 = bodyClean.match(/(\d+)h\s*(\d+)m\s*(\d+)s/);
        if (m2) expires = +m2[1]*3600 + +m2[2]*60 + +m2[3];
        if (expires <= 0) {
          m2 = bodyClean.match(/(\d+)m\s*(\d+)s/);
          if (m2) expires = +m2[1]*60 + +m2[2];
        }
      }

      return { step, expires, countdown: -1 };
    }

    // ── readUnlockTimer() — TreeWalker text node (đồng bộ BackgroundWebVerifier.java) ──
    // Tìm countdown "Xs" hoặc "Xm Ys" trong các step unlocking/unlocked/step1
    let countdown = -1;
    if (step === 'unlocking' || step === 'unlocked' || step === 'step1') {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
      let node;
      while ((node = walker.nextNode())) {
        const t = (node.nodeValue || '').trim();
        if (!t) continue;
        // Match "Xs" (tối đa 120 giây) — đồng bộ BackgroundWebVerifier
        let m = t.match(/^(\d+)s$/);
        if (m && +m[1] <= 120) { countdown = +m[1]; break; }
        // Match "Xm Ys" (nhỏ hơn 3 phút)
        m = t.match(/^(\d+)m\s*(\d+)s$/);
        if (m && +m[1] < 3) { countdown = +m[1]*60 + +m[2]; break; }
      }
    }

    return { step, expires: -1, countdown };
  }, { step: 'unknown', expires: -1, countdown: -1 });
}

/* ══════════════════════════════════════════════════════════════════════════════
   _pgFillInput() — Đồng bộ với setVal() trong BackgroundWebVerifier.java
   Dùng React native setter để trigger onchange/oninput của React/Vue
   ══════════════════════════════════════════════════════════════════════════════ */
async function _pgFillInput(page, accountId) {
  const selectors = [
    'input[type="number"]',
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="submit"]):not([type="button"])',
  ];
  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      await el.click({ clickCount: 3 });
      await el.type(accountId, { delay: 60 });
      // Trigger React/Vue events — đúng như setVal() trong Java
      await page.evaluate((s, val) => {
        const inp = document.querySelector(s);
        if (!inp) return;
        try {
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          if (setter) setter.call(inp, val);
        } catch(_) { inp.value = val; }
        ['input', 'change', 'keyup', 'keydown'].forEach(ev =>
          inp.dispatchEvent(new Event(ev, { bubbles: true, cancelable: true }))
        );
      }, sel, accountId);
      console.log(`[TgServer] Điền ID vào input: ${sel}`);
      return true;
    } catch(e) {
      if (_isNavError(e)) await _pgSleep(1000);
    }
  }
  return false;
}

/* ══════════════════════════════════════════════════════════════════════════════
   _pgFindAndClickContinue() — Đồng bộ findContinueBtn() trong Java:
   
   Ưu tiên 0: exact "continue without discord"
   Ưu tiên 1: chứa "without" + "discord", không "join"
   Ưu tiên 2: bắt đầu "continue without"
   Ưu tiên 3: chứa "continue", không join/discord/restart/cancel, len<80
   
   Mỗi pass: forceEnableBtn trước khi click (xóa disabled/aria-disabled)
   forceTap: dispatch mousedown → mouseup → click → .click()
   ══════════════════════════════════════════════════════════════════════════════ */
async function _pgFindAndClickContinue(page) {
  return await _safeEval(page, () => {
    function forceEnableBtn(el) {
      try { el.removeAttribute('disabled'); } catch(_) {}
      try { el.removeAttribute('aria-disabled'); } catch(_) {}
      try { el.style.pointerEvents = 'auto'; } catch(_) {}
      try { el.style.opacity = '1'; } catch(_) {}
    }
    function forceTap(el) {
      if (!el) return false;
      forceEnableBtn(el);
      try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch(_) {}
      const r  = el.getBoundingClientRect();
      const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0, buttons: 1 };
      try { el.dispatchEvent(new MouseEvent('mousedown', opts)); } catch(_) {}
      try { el.dispatchEvent(new MouseEvent('mouseup',   opts)); } catch(_) {}
      try { el.dispatchEvent(new MouseEvent('click', Object.assign({}, opts, { detail: 1 }))); } catch(_) {}
      try { el.click(); } catch(_) {}
      return true;
    }
    function getAllElements(selector, root) {
      root = root || document;
      let r = Array.from(root.querySelectorAll(selector));
      root.querySelectorAll('*').forEach(el => {
        if (el.shadowRoot) r = r.concat(getAllElements(selector, el.shadowRoot));
      });
      return r;
    }
    function isVisible(el) {
      try {
        const s = window.getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) return false;
      } catch(_) {}
      return true;
    }

    const SEL = 'button,a,[role="button"],[class*="btn"],[class*="Btn"],[class*="button"],[class*="Button"],[class*="continue"],[class*="Continue"],[class*="action"],[class*="Action"]';
    const all = getAllElements(SEL);

    function txt(el) {
      return (el.innerText || el.value || el.textContent || '').toLowerCase().replace(/[\s\n\r]+/g, ' ').trim();
    }

    // globalForceEnable — enable tất cả nút "continue" trước khi tìm
    for (const el of all) {
      const t = txt(el);
      if (t.includes('continue') && !t.includes('restart') && !t.includes('join')) forceEnableBtn(el);
    }

    // Ưu tiên 0: exact "continue without discord"
    for (const el of all) {
      if (!isVisible(el)) continue;
      if (txt(el) === 'continue without discord') return forceTap(el);
    }
    // Ưu tiên 1: chứa "without" + "discord", không "join"
    for (const el of all) {
      if (!isVisible(el)) continue;
      const t = txt(el);
      if (t.includes('without') && t.includes('discord') && !t.includes('join')) return forceTap(el);
    }
    // Ưu tiên 2: bắt đầu "continue without"
    for (const el of all) {
      if (!isVisible(el)) continue;
      if (txt(el).startsWith('continue without')) return forceTap(el);
    }
    // Ưu tiên 3: chứa "continue", không join/discord/restart/cancel, len<80
    for (const el of all) {
      if (!isVisible(el)) continue;
      const t = txt(el);
      if (t.includes('continue') && !t.includes('join') && !t.includes('discord') &&
          !t.includes('restart') && !t.includes('cancel') && t.length < 80) return forceTap(el);
    }
    return false;
  }, false);
}

/* ══════════════════════════════════════════════════════════════════════════════
   _runWithPuppeteer() — Flow 4 bước đồng bộ BackgroundWebVerifier.java:
   
   Bước 0: Load trang unlockffbeta.com
   Bước 1 (step1):
     - Đọc countdown ở step1 (giống readUnlockTimer() khi step='step1' trong Java)
     - Nếu countdown > 0 → đợi hết giây (giống busyUntil += step1Timer)
     - Điền accountId (setVal)
     - Click "Continue without Discord" (findContinueBtn priority 0-3)
   
   Bước 2-4 (unlocking → unlocked):
     - Đọc step hiện tại
     - Nếu unlocking: đọc countdown thực tế → đợi đúng giây → poll đến unlocked/granted
     - Nếu unlocked: click Continue (priority 3 — chứa continue, không discord/join/restart)
     - Poll 400ms/lần đến khi step thay đổi
     - Lặp tối đa 3 lần (pass 2, 3, 4)
   
   Kết quả: granted → _handleSuccess() với expires từ readGrantedTimer()
   ══════════════════════════════════════════════════════════════════════════════ */
async function _runWithPuppeteer(chatId, accountId, puppeteer, chromium) {
  const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36';
  let browser = null;
  try {
    let execPath, launchArgs;
    if (chromium) {
      execPath   = await chromium.executablePath();
      launchArgs = chromium.args || [];
    } else {
      execPath   = undefined;
      launchArgs = [];
    }
    browser = await puppeteer.launch({
      executablePath: execPath,
      headless: chromium ? chromium.headless : true,
      args: [
        ...launchArgs,
        '--no-sandbox', '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', '--disable-gpu',
        '--disable-extensions', '--mute-audio',
        '--no-first-run', '--disable-notifications',
        '--blink-settings=imagesEnabled=false',
      ],
      defaultViewport: { width: 390, height: 844, isMobile: true, hasTouch: true },
      timeout: 30000,
    });

    const page = await browser.newPage();
    await page.setUserAgent(UA);
    await page.setRequestInterception(true);

    page.on('request', req => {
      const rt = req.resourceType();
      if (['image', 'media', 'font', 'stylesheet'].includes(rt)) { req.abort(); return; }
      if (isAdUrl(req.url())) { req.abort(); return; }
      req.continue();
    });
    page.on('dialog', async dlg => { try { await dlg.dismiss(); } catch(_) {} });
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame())
        console.log(`[TgServer] Navigate → ${frame.url()}`);
    });

    /* ── Bước 0: Tải trang ── */
    await sendMsg(chatId,
      `⏳ <b>Đang mở trang...</b>\n` +
      `🆔 ID: <code>${accountId}</code>\n` +
      `<i>Bước 0/4: Tải unlockffbeta.com...</i>`
    );
    await page.goto('https://www.unlockffbeta.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await _pgSleep(2000);

    /* ── Bước 1 (step1): Điền ID + click "Continue without Discord" ── */
    let st = await _pgGetState(page);
    console.log(`[TgServer] Bước 0 → step=${st.step} countdown=${st.countdown}`);

    // Đọc countdown ở step1 trước khi điền (giống readUnlockTimer() với step='step1' trong Java)
    // Java: if(step1Timer>0){busyUntil=now+Math.min(step1Timer*1000+500,6000);return;}
    if (st.step === 'step1' && st.countdown > 0) {
      const waitSec = Math.min(st.countdown + 1, 8); // thêm 1s buffer như Java (+500ms)
      await sendMsg(chatId,
        `⏱ <b>Bước 1/4:</b> Đợi ${st.countdown}s trước khi điền ID...\n` +
        `🆔 ID: <code>${accountId}</code>`
      );
      console.log(`[TgServer] Bước 1 countdown=${st.countdown}s → đợi ${waitSec}s`);
      await _pgSleep(waitSec * 1000);
      st = await _pgGetState(page);
    }

    await sendMsg(chatId,
      `📝 <b>Bước 1/4:</b> Điền ID + click nút tím...\n` +
      `🆔 ID: <code>${accountId}</code>`
    );
    await _pgFillInput(page, accountId);
    await _pgSleep(600);
    const step1Clicked = await _pgFindAndClickContinue(page);
    console.log(`[TgServer] Bước 1 click CWD: ${step1Clicked}`);

    /* ── Poll nhanh sau bước 1: trang có thể granted ngay sau 1 click ── */
    // Giống BackgroundWebVerifier loop() chạy 200ms — poll 400ms tối đa 12s
    let expiresSecs = -1;
    let grantedFound = false;
    {
      const deadline = Date.now() + 12000;
      while (Date.now() < deadline) {
        await _pgSleep(400);
        st = await _pgGetState(page);
        console.log(`[TgServer] Poll bước 1: step=${st.step} expires=${st.expires}`);
        if (st.step === 'granted') {
          grantedFound = true;
          expiresSecs  = st.expires > 0 ? st.expires : 3600;
          break;
        }
        if (st.step === 'unlocking' || st.step === 'unlocked') break;
      }
    }

    /* ── Bước 2 → 4 (unlocking/unlocked, lặp tối đa 3 lần) ── */
    // Giống BackgroundWebVerifier loop() xử lý 'unlocking' và 'unlocked'
    for (let pass = 2; pass <= 4 && !grantedFound; pass++) {
      st = await _pgGetState(page);
      console.log(`[TgServer] Pass ${pass}: step=${st.step} countdown=${st.countdown} expires=${st.expires}`);

      if (st.step === 'granted') {
        grantedFound = true;
        expiresSecs  = st.expires > 0 ? st.expires : 3600;
        break;
      }

      // UNLOCKING: đọc countdown thực tế, đợi đúng giây, poll đến unlocked/granted
      // Giống BackgroundWebVerifier: if(t>0){lastTimerSec=t;timerActive=true;}
      //   → sau đó timerActive=false → click Continue
      if (st.step === 'unlocking') {
        const waitSec = st.countdown > 0 ? st.countdown : 8;
        await sendMsg(chatId,
          `⏱ <b>Bước ${pass}/4:</b> Đang xử lý... đợi ${waitSec}s\n` +
          `🆔 ID: <code>${accountId}</code>`
        );
        console.log(`[TgServer] Bước ${pass} unlocking countdown=${waitSec}s → đợi`);
        await _pgSleep((waitSec + 1) * 1000); // +1s buffer

        // Poll tối đa 30s cho đến khi step thay đổi (giống BackgroundWebVerifier)
        const dl1 = Date.now() + 30000;
        while (Date.now() < dl1) {
          st = await _pgGetState(page);
          console.log(`[TgServer] Poll sau unlocking: step=${st.step} countdown=${st.countdown}`);
          if (st.step === 'granted') {
            grantedFound = true;
            expiresSecs  = st.expires > 0 ? st.expires : 3600;
            break;
          }
          if (st.step === 'unlocked' || (st.step === 'unlocking' && st.countdown <= 0)) break;
          await _pgSleep(500);
        }
        if (grantedFound) break;
      }

      // Re-read trạng thái sau đợi
      st = await _pgGetState(page);
      if (st.step === 'granted') {
        grantedFound = true;
        expiresSecs  = st.expires > 0 ? st.expires : 3600;
        break;
      }

      // UNLOCKED hoặc hết countdown: click Continue
      // Giống BackgroundWebVerifier step 'unlocked': tìm nút continue, forceTap
      if (['unlocked', 'unlocking', 'step1'].includes(st.step)) {
        await sendMsg(chatId,
          `🖱 <b>Bước ${pass}/4:</b> Click tiếp tục...\n` +
          `🆔 ID: <code>${accountId}</code>`
        );
        const clicked = await _pgFindAndClickContinue(page);
        console.log(`[TgServer] Pass ${pass} click Continue: ${clicked}`);
        await _pgSleep(2000);

        // Đóng tab quảng cáo mở thêm (giống BackgroundWebVerifier shouldOverrideUrlLoading)
        try {
          const pages = await browser.pages();
          for (const p of pages) {
            if (p !== page && !p.isClosed()) {
              console.log(`[TgServer] Đóng tab ad: ${p.url()}`);
              await p.close();
            }
          }
        } catch(_) {}

        // Poll 400ms/lần tối đa 8s sau click
        const dl2 = Date.now() + 8000;
        while (Date.now() < dl2) {
          await _pgSleep(400);
          st = await _pgGetState(page);
          if (st.step === 'granted') {
            grantedFound = true;
            expiresSecs  = st.expires > 0 ? st.expires : 3600;
            break;
          }
          if (st.step !== 'unlocked') break;
        }
        if (grantedFound) break;
      }
    }

    // Kiểm tra lần cuối phòng render chậm (giống BackgroundWebVerifier onPageFinished delays)
    if (!grantedFound) {
      await _pgSleep(2500);
      st = await _pgGetState(page);
      console.log(`[TgServer] Check cuối: step=${st.step} expires=${st.expires}`);
      if (st.step === 'granted') {
        grantedFound = true;
        expiresSecs  = st.expires > 0 ? st.expires : 3600;
      }
    }

    if (grantedFound) {
      await _handleSuccess(chatId, accountId, expiresSecs);
    } else {
      await sendMsg(chatId,
        `❌ <b>Xác thực thất bại.</b>\n` +
        `🆔 ID: <code>${accountId}</code>\n\n` +
        `Không nhận được "Access Granted".\n\n` +
        `↩️ Gửi lại ID để thử lại.`
      );
    }

  } catch (e) {
    console.error('[TgServer] Puppeteer lỗi:', e && e.message);
    const msg = _isNavError(e)
      ? `⚠️ <b>Lỗi navigation.</b>\n<code>${String(e.message).slice(0, 120)}</code>\n\n↩️ Gửi lại ID để thử lại.`
      : `❌ <b>Lỗi trình duyệt.</b>\n<code>${String(e.message).slice(0, 150)}</code>\n\n↩️ Gửi lại ID để thử lại.`;
    await sendMsg(chatId, msg);
  } finally {
    if (browser) {
      try {
        const pages = await browser.pages().catch(() => []);
        for (const p of pages) { try { await p.close(); } catch(_) {} }
        await browser.close();
      } catch(_) {}
    }
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   HTTP FALLBACK — dùng khi không có Puppeteer
   ══════════════════════════════════════════════════════════════════════════════ */
async function _runHttpFallback(chatId, accountId) {
  try {
    const UA   = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
    const HOST = 'www.unlockffbeta.com';
    function _req(opts, body) {
      return new Promise((res, rej) => {
        const req = https.request(opts, r => {
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', rej);
        req.setTimeout(20000, () => { req.destroy(); rej(new Error('timeout')); });
        if (body) req.write(body);
        req.end();
      });
    }
    async function _get(path, cookies) {
      const r = await _req({
        protocol: 'https:', hostname: HOST, path, method: 'GET',
        headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*', 'Referer': 'https://' + HOST + '/', 'Cookie': cookies || '' }
      });
      const sc = r.headers['set-cookie'];
      const nc = sc ? (Array.isArray(sc) ? sc : [sc]).map(c => c.split(';')[0]).join('; ') : '';
      return { body: r.body, cookies: nc ? (cookies ? cookies + '; ' + nc : nc) : (cookies || '') };
    }
    await sendMsg(chatId, `⏳ <b>[HTTP mode] Đang xác thực...</b>\n🆔 ID: <code>${accountId}</code>`);
    let { body, cookies } = await _get('/', '');
    const hasGranted = h => /access\s*granted/i.test(h);
    const parseExp   = h => {
      let m = h.match(/(\d+)h\s*(\d+)m\s*(\d+)s/); if (m) return +m[1]*3600 + +m[2]*60 + +m[3];
      m = h.match(/(\d+)m\s*(\d+)s/); if (m) return +m[1]*60 + +m[2];
      return 3600;
    };
    let r2 = await _get(`/?account_id=${encodeURIComponent(accountId)}`, cookies);
    cookies = r2.cookies; body = r2.body;
    if (hasGranted(body)) return _handleSuccess(chatId, accountId, parseExp(body));
    for (let i = 2; i <= 5; i++) {
      const wait = Math.min(parseInt((body.match(/\b(\d+)s\b/) || [])[1] || '8') + 1, 20);
      await sendMsg(chatId, `⏱ <b>Bước ${i-1}/4:</b> Đợi ${wait}s...\n🆔 ID: <code>${accountId}</code>`);
      await _pgSleep(wait * 1000);
      const r3 = await _get(`/?account_id=${encodeURIComponent(accountId)}&step=${i}`, cookies);
      cookies = r3.cookies; body = r3.body;
      if (hasGranted(body)) return _handleSuccess(chatId, accountId, parseExp(body));
    }
    await sendMsg(chatId,
      `❌ <b>Xác thực thất bại (HTTP mode).</b>\n🆔 ID: <code>${accountId}</code>\n\n` +
      `Gợi ý: Cài <code>puppeteer-core</code> + <code>@sparticuz/chromium</code>.\n\n↩️ Gửi lại ID để thử lại.`
    );
  } catch (e) {
    console.error('[TgServer] HTTP fallback lỗi:', e.message);
    await sendMsg(chatId, `❌ <b>Lỗi HTTP.</b>\n<code>${String(e && e.message).slice(0,150)}</code>\n\n↩️ Thử lại.`);
  }
}

async function runVerifyId(chatId, accountId) {
  const { puppeteer, chromium } = await _loadPuppeteer();
  if (puppeteer) {
    await _runWithPuppeteer(chatId, accountId, puppeteer, chromium);
  } else {
    await _runHttpFallback(chatId, accountId);
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   _handleSuccess() — Lưu session + notify + auto-reverify
   
   Format thời gian: "Xh Ym Zs" / "Xm Ys" / "Zs" — đồng bộ AutoVerifyService.java
   Ngưỡng reverify: 60s — đồng bộ REVERIFY_THRESHOLD_SECS trong AutoVerifyService.java
   ══════════════════════════════════════════════════════════════════════════════ */
async function _handleSuccess(chatId, accountId, expiresSecs) {
  if (!expiresSecs || expiresSecs <= 0) expiresSecs = 3600;

  // Format thời gian đồng bộ AutoVerifyService.buildNotification()
  const h = Math.floor(expiresSecs / 3600);
  const m = Math.floor((expiresSecs % 3600) / 60);
  const s = expiresSecs % 60;
  const timeStr = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;

  const expiresAt  = Date.now() + expiresSecs * 1000;
  const expDateStr = new Date(expiresAt).toLocaleString('vi-VN');

  const prev = sessions[String(chatId)] || {};
  sessions[String(chatId)] = {
    ...prev,
    accountId,
    savedId:     prev.savedId || accountId,
    expires:     expiresAt,
    accessState: 1,
  };

  await sendMsg(chatId,
    `✅ <b>Xác thực thành công!</b>\n` +
    `━━━━━━━━━━━━━━━━━━━━━━\n` +
    `🆔 ID: <code>${accountId}</code>\n` +
    `⏱ Còn lại: <b>${timeStr}</b>\n` +
    `📅 Hết hạn: <b>${expDateStr}</b>\n\n` +
    `🔄 <i>Bot sẽ tự xác thực lại khi còn ≤ 60 giây.</i>`
  );

  // Auto-reverify khi còn 60s — đồng bộ REVERIFY_THRESHOLD_SECS = 60s trong Java
  const reverifyIn = Math.max(0, (expiresSecs - 60) * 1000);
  const sess = sessions[String(chatId)];
  if (sess && sess.reverifyTimer) clearTimeout(sess.reverifyTimer);
  if (sess) {
    sess.reverifyTimer = setTimeout(async () => {
      const cur = sessions[String(chatId)];
      if (!cur || cur.accountId !== accountId) return;
      if (cur.expires && cur.expires > Date.now() + 70000) return;
      const idToUse = (cur && cur.savedId) || accountId;
      await sendMsg(chatId, `🔄 <b>Tự động xác thực lại...</b>\n🆔 ID: <code>${idToUse}</code>`);
      runVerifyId(chatId, idToUse).catch(e => {
        console.error('[TgServer] Auto-reverify lỗi:', e && e.message);
        sendMsg(chatId, `⚠️ <b>Tự động xác thực lại thất bại.</b>\nGửi ID <code>${idToUse}</code> để thử lại.`);
      });
    }, reverifyIn);
  }
  console.log(`[TgServer] ✅ chatId=${chatId} ID=${accountId} expires=${expiresSecs}s (${timeStr}) reverifyIn=${Math.round(reverifyIn/1000)}s`);
}

/* ══════════════════════════════════════════════════════════════════════════════
   doVerifyId() — Khởi chạy xác thực ID
   ══════════════════════════════════════════════════════════════════════════════ */
async function doVerifyId(chatId, accountId) {
  if (!accountId || !/^\d{6,15}$/.test(accountId)) {
    await sendMsg(chatId, '❌ <b>ID không hợp lệ.</b>\nID phải là dãy số từ 6–15 chữ số.');
    return;
  }
  const prev = sessions[String(chatId)] || {};
  sessions[String(chatId)] = {
    ...prev,
    accountId,
    savedId:     prev.savedId || accountId,
    startedAt:   Date.now(),
    waitingForId: false,
  };
  await sendMsg(chatId,
    `⏳ <b>Đang xác thực ID:</b> <code>${accountId}</code>\n\n` +
    `🌐 Bot đang kết nối unlockffbeta.com...\n` +
    `🚫 Đang chặn quảng cáo & tự động click các nút...\n\n` +
    `<i>Vui lòng chờ vài giây.</i>`
  );
  runVerifyId(chatId, accountId).catch(e => {
    console.error('[TgServer] Lỗi xác thực ID:', e && e.message);
    sendMsg(chatId, '❌ <b>Xác thực thất bại.</b>\nServer gặp lỗi. Thử lại sau ít phút.');
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
   WEBHOOK HANDLER — xử lý tin nhắn từ Telegram
   ══════════════════════════════════════════════════════════════════════════════ */
async function handleUpdate(update) {
  // Callback query (bấm nút inline)
  if (update && update.callback_query) {
    const cbq = update.callback_query;
    const cbId = cbq.message && cbq.message.chat && cbq.message.chat.id;
    try { await tgCall('answerCallbackQuery', { callback_query_id: cbq.id }); } catch(_) {}
    if (cbId && cbq.data === 'enter_key') {
      sessions[String(cbId)] = sessions[String(cbId)] || {};
      sessions[String(cbId)].waitingForKey = true;
      await sendMsg(cbId,
        '🔑 <b>Nhập key kích hoạt của bạn:</b>\n\n' +
        '<i>Gửi key trực tiếp vào đây</i>\n\n' +
        '💡 Chưa có key? Liên hệ admin'
      );
    }
    return;
  }

  const msg = update && update.message;
  if (!msg || !msg.from || typeof msg.text !== 'string') return;

  const text     = msg.text.trim();
  const textLow  = text.toLowerCase();
  const chatId   = msg.chat.id;
  const tgUser   = msg.from;

  /* /start */
  if (textLow.startsWith('/start')) {
    const name = tgUser.first_name || tgUser.username || 'bạn';
    const sess = sessions[String(chatId)];
    const hasKey = sess && sess.keyVerified && sess.savedKey;
    await sendMsg(chatId,
      `🎮 <b>FF Unlocker Bot</b>\n` +
      `━━━━━━━━━━━━━━━━━━━━━━\n\n` +
      `Xin chào <b>${String(name).replace(/[<>&]/g, '')}</b> 👋\n\n` +
      `🔓 Bot hỗ trợ <b>xác thực ID Free Fire</b> tự động.\n\n` +
      (hasKey
        ? `✅ Tài khoản của bạn đã kích hoạt!\n\n<b>Các lệnh sử dụng:</b>\n• Gửi <b>ID Free Fire</b> để xác thực\n• /status — Xem trạng thái\n• /cancel — Huỷ phiên\n• /help — Hướng dẫn`
        : `🔑 <b>Để sử dụng, bạn cần kích hoạt key trước.</b>\n\nGửi lệnh /key để nhập key.`),
      !hasKey ? { reply_markup: { inline_keyboard: [[{ text: '🔑 Nhập key kích hoạt', callback_data: 'enter_key' }]] } } : {}
    );
    return;
  }

  /* /help */
  if (textLow === '/help' || textLow.startsWith('/help ')) {
    await sendMsg(chatId,
      `📖 <b>Hướng dẫn sử dụng FF Unlocker Bot</b>\n\n` +
      `<b>🔐 Xác thực key:</b>\n<code>/key YOUR_KEY</code>\n→ Kiểm tra key với server\n\n` +
      `<b>🆔 Xác thực ID Free Fire:</b>\n<code>/verify 15886913287</code>\n→ Bot kết nối unlockffbeta.com và tự động click qua 4 bước\n→ Khi còn ≤ 60 giây, bot <b>tự động xác thực lại</b>\n\n` +
      `<b>💾 Lưu ID mặc định:</b>\n<code>/setid 15886913287</code>\n→ Bot nhớ ID để tự reverify\n\n` +
      `<b>📊 Kiểm tra trạng thái:</b>\n<code>/status</code>\n\n` +
      `<b>❌ Huỷ phiên:</b>\n<code>/cancel</code>`
    );
    return;
  }

  /* /key */
  if (textLow === '/key' || textLow.startsWith('/key ')) {
    const parts  = text.split(/\s+/);
    const keyVal = (parts[1] || '').trim();
    if (!keyVal) {
      sessions[String(chatId)] = sessions[String(chatId)] || {};
      sessions[String(chatId)].waitingForKey = true;
      await sendMsg(chatId,
        '🔑 <b>Nhập key kích hoạt của bạn:</b>\n\n' +
        '<i>Gửi key trực tiếp vào đây (không cần gõ /key nữa)</i>'
      );
    } else {
      await verifyKeyForChat(chatId, keyVal);
    }
    return;
  }

  /* /setid */
  if (textLow.startsWith('/setid')) {
    const parts = text.split(/\s+/);
    const newId = (parts[1] || '').trim();
    if (!newId) {
      const cur = sessions[String(chatId)];
      const curId = cur && (cur.savedId || cur.accountId) || '';
      await sendMsg(chatId, curId
        ? `💾 <b>ID mặc định:</b> <code>${curId}</code>\n\nĐổi: <code>/setid &lt;ID_mới&gt;</code>`
        : '💾 <b>Chưa có ID mặc định.</b>\n\nDùng: <code>/setid &lt;ID&gt;</code>'
      );
    } else if (!/^\d{6,15}$/.test(newId)) {
      await sendMsg(chatId, '❌ <b>ID không hợp lệ.</b> ID phải là dãy số 6–15 chữ số.');
    } else {
      sessions[String(chatId)] = sessions[String(chatId)] || {};
      sessions[String(chatId)].savedId = newId;
      await sendMsg(chatId,
        `✅ <b>Đã lưu ID mặc định:</b> <code>${newId}</code>\n\n🔄 Bot sẽ tự reverify ID này khi phiên còn ≤ 60 giây.\n\nXác thực ngay: <code>/verify ${newId}</code>`
      );
    }
    return;
  }

  /* /cancel */
  if (textLow === '/cancel' || textLow.startsWith('/cancel ')) {
    const sess = sessions[String(chatId)];
    if (!sess || (!sess.accountId && !sess.savedId)) {
      await sendMsg(chatId, 'ℹ️ <b>Không có phiên nào đang chạy.</b>');
    } else {
      if (sess.reverifyTimer) clearTimeout(sess.reverifyTimer);
      delete sessions[String(chatId)];
      await sendMsg(chatId, '🛑 <b>Đã huỷ phiên xác thực.</b>\nAuto-reverify đã dừng.\n\nBắt đầu lại: <code>/verify &lt;ID&gt;</code>');
    }
    return;
  }

  /* /status */
  if (textLow === '/status' || textLow.startsWith('/status ')) {
    const sess = sessions[String(chatId)];
    if (!sess || (!sess.accountId && !sess.savedId && !sess.keyVerified)) {
      await sendMsg(chatId,
        'ℹ️ <b>Trạng thái phiên</b>\n\n' +
        '🔑 Key: Chưa kích hoạt\n🆔 ID: Chưa xác thực\n\n' +
        'Bắt đầu: /key → /verify'
      );
    } else {
      const keyStr = sess.savedKey ? `<code>${sess.savedKey}</code>` : 'Chưa kích hoạt';
      const idStr  = sess.accountId || sess.savedId || 'Chưa xác thực';
      let expStr = 'Không có';
      if (sess.expires) {
        const remainMs  = Math.max(0, sess.expires - Date.now());
        const remainSec = Math.floor(remainMs / 1000);
        const rh = Math.floor(remainSec/3600), rm = Math.floor((remainSec%3600)/60), rs = remainSec%60;
        expStr = remainSec > 0
          ? (rh > 0 ? `${rh}h ${rm}m ${rs}s còn lại` : rm > 0 ? `${rm}m ${rs}s còn lại` : `${rs}s còn lại`)
          : 'Đã hết hạn';
      }
      await sendMsg(chatId,
        `📊 <b>Trạng thái phiên</b>\n` +
        `━━━━━━━━━━━━━━━━━━━━━━\n` +
        `🔑 Key: ${keyStr}\n` +
        `🆔 ID: <code>${idStr}</code>\n` +
        `⏱ Phiên: <b>${expStr}</b>\n` +
        `💾 ID mặc định: <code>${sess.savedId || 'Chưa lưu'}</code>`
      );
    }
    return;
  }

  /* /verify */
  if (textLow === '/verify' || textLow.startsWith('/verify ')) {
    const parts = text.split(/\s+/);
    let accountId = (parts[1] || '').trim();
    const sess = sessions[String(chatId)] || {};
    if (!sess.keyVerified) {
      await sendMsg(chatId, '⚠️ <b>Bạn chưa kích hoạt key!</b>\n\nVui lòng nhập key trước:\n/key');
    } else if (!accountId) {
      const fallback = sess.savedId || '';
      if (fallback) {
        await sendMsg(chatId, `💡 <b>Dùng ID đã lưu:</b> <code>${fallback}</code>\n\n⏳ Đang xác thực...`);
        await doVerifyId(chatId, fallback);
      } else {
        sessions[String(chatId)].waitingForId = true;
        await sendMsg(chatId,
          '🆔 <b>Nhập ID Free Fire của bạn:</b>\n\n' +
          '<i>Gửi ID trực tiếp vào đây</i>\n\n' +
          '💡 Ví dụ: <code>15886913287</code>'
        );
      }
    } else if (!/^\d{6,15}$/.test(accountId)) {
      await sendMsg(chatId, '❌ <b>ID không hợp lệ.</b>\nID phải là dãy số 6–15 chữ số.');
    } else {
      await doVerifyId(chatId, accountId);
    }
    return;
  }

  /* Tin nhắn thường — xử lý trạng thái chờ nhập */
  if (!textLow.startsWith('/')) {
    const sess2 = sessions[String(chatId)] || {};
    if (sess2.waitingForKey) {
      sessions[String(chatId)].waitingForKey = false;
      await verifyKeyForChat(chatId, text.trim());
    } else if (sess2.waitingForId) {
      sessions[String(chatId)].waitingForId = false;
      if (!/^\d{6,15}$/.test(text.trim())) {
        await sendMsg(chatId, '❌ <b>ID không hợp lệ.</b>\nID phải là dãy số 6–15 chữ số.');
      } else {
        await doVerifyId(chatId, text.trim());
      }
    } else if (sess2.keyVerified && /^\d{6,15}$/.test(text.trim())) {
      await doVerifyId(chatId, text.trim());
    } else {
      await sendMsg(chatId,
        'ℹ️ Gửi /help để xem hướng dẫn.\n\n' +
        (sess2.keyVerified
          ? 'Hoặc gửi <b>ID Free Fire</b> của bạn để xác thực.'
          : 'Gửi /key để nhập key kích hoạt.')
      );
    }
    return;
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   HTTP SERVER — nhận webhook từ Telegram
   ══════════════════════════════════════════════════════════════════════════════ */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 512 * 1024) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => { try { resolve(JSON.parse(data)); } catch (_) { resolve({}); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url || '/');
  const path   = parsed.pathname || '/';

  if (path === '/' || path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'telegram-server', uptime: process.uptime() }));
    return;
  }

  if (path === '/webhook' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    try {
      const update = await readBody(req);
      handleUpdate(update).catch(e => console.error('[TgServer] handleUpdate lỗi:', e && e.message));
    } catch (e) {
      console.error('[TgServer] webhook read lỗi:', e && e.message);
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

/* ══════════════════════════════════════════════════════════════════════════════
   KHỞI ĐỘNG
   ══════════════════════════════════════════════════════════════════════════════ */
async function start() {
  server.listen(PORT, '0.0.0.0', async () => {
    console.log(`\n🤖 Telegram Server v14.0 đang chạy tại port ${PORT}`);
    console.log(`   BOT_TOKEN  : ${BOT_TOKEN.slice(0, 10)}...`);
    console.log(`   KEY_SERVER : ${KEY_SERVER_URL}`);
    console.log(`   KEY_APP_ID : ${KEY_APP_ID}`);
    console.log(`   Flow: 4 bước đồng bộ BackgroundWebVerifier.java`);
    console.log(`   Reverify ngưỡng: 60s (đồng bộ AutoVerifyService.REVERIFY_THRESHOLD_SECS)`);

    const publicUrl = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').replace(/\/+$/, '');
    if (publicUrl) {
      const webhookUrl = `${publicUrl}/webhook`;
      const result = await tgCall('setWebhook', { url: webhookUrl });
      if (result && result.ok) {
        console.log(`   ✅ Webhook đã đăng ký: ${webhookUrl}`);
      } else {
        console.warn(`   ⚠️  Đăng ký webhook thất bại:`, result && result.description);
      }
      await tgCall('setMyCommands', { commands: [
        { command: 'start',  description: 'Chào mừng & giới thiệu' },
        { command: 'key',    description: 'Nhập key kích hoạt' },
        { command: 'verify', description: 'Xác thực ID Free Fire (4 bước tự động)' },
        { command: 'setid',  description: 'Lưu ID mặc định (auto-reverify)' },
        { command: 'status', description: 'Xem trạng thái phiên' },
        { command: 'cancel', description: 'Huỷ phiên xác thực' },
        { command: 'help',   description: 'Hướng dẫn sử dụng chi tiết' },
      ]});
      console.log(`   ✅ Đã cập nhật danh sách lệnh`);
    } else {
      console.log(`   ⚠️  Chưa có RENDER_EXTERNAL_URL — webhook chưa được đăng ký tự động.`);
      console.log(`   Webhook URL cần trỏ tới: http(s)://<domain>:<port>/webhook`);
    }

    startAntiSleep();
    console.log('');
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
   CHỐNG NGỦ ĐÔNG — tự ping /health mỗi 4 phút
   ══════════════════════════════════════════════════════════════════════════════ */
function startAntiSleep() {
  const selfUrl = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').replace(/\/+$/, '');
  if (!selfUrl) {
    console.log('   ⚠️  [Anti-sleep] Chưa có RENDER_EXTERNAL_URL — bỏ qua tự ping.');
    return;
  }
  const target = selfUrl + '/health';
  console.log(`   🔄 [Anti-sleep] Tự ping ${target} mỗi 4 phút.`);
  setInterval(() => {
    try {
      https.get(target, r => { r.resume(); }).on('error', e => {
        console.warn('[Anti-sleep] Ping thất bại:', e.message);
      });
    } catch (e) {}
  }, 4 * 60 * 1000);
}

process.on('SIGINT',  () => { console.log('\n[TgServer] Đang tắt...'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

start();
