/**
 * telegram-server.js v14.3 — Server Telegram Bot độc lập
 *
 * FIX v14.3 — Đồng bộ hoàn toàn JS với BackgroundWebVerifier.java:
 *
 *  ✅ THAY TOÀN BỘ _runWithPuppeteer() — không còn dùng _pgGetState() poll chậm
 *
 *  ✅ INJECT JS (_buildInjectJs) y hệt buildAutoJs() trong BackgroundWebVerifier.java:
 *       - loop 200ms + MutationObserver — cùng tốc độ với app Android
 *       - getStep() / findContinueWithoutDiscordBtn() / forceEnableBtn() / forceTap()
 *       - setVal() trigger React/Vue events — đồng bộ setVal() trong Java
 *       - Kết quả ghi vào window.__result = {status, expires}
 *
 *  ✅ Node.js chỉ poll window.__result mỗi 500ms, tối đa 4 phút
 *       - Re-inject sau mỗi page load/navigate (đồng bộ onPageFinished delays Java)
 *       - Re-inject mỗi 10s phòng SPA navigation xóa JS
 *
 *  ✅ GIỮ NGUYÊN: key auth, session, webhook, anti-sleep, auto-reverify 60s
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
   _pgDumpDebug() — Dump 800 ký tự innerText + tất cả nút bấm để debug
   ══════════════════════════════════════════════════════════════════════════════ */
async function _pgDumpDebug(page) {
  return await _safeEval(page, () => {
    const body = (document.body && document.body.innerText || '').slice(0, 800).replace(/\s+/g,' ');
    const btns = Array.from(document.querySelectorAll('button,a,[role="button"]'))
      .map(b => '['+((b.innerText||b.textContent||'').trim().slice(0,40))+'|cls:'+(b.className.toString().slice(0,30))+']')
      .join(' | ');
    const inputs = Array.from(document.querySelectorAll('input'))
      .map(i => '[type='+i.type+' val='+(i.value||'').slice(0,20)+']').join(', ');
    return { body, btns, inputs };
  }, { body: 'ERR', btns: '', inputs: '' });
}

/* ══════════════════════════════════════════════════════════════════════════════
   _pgGetState() — Detect trạng thái trang CHÍNH XÁC v2
   
   FIX: Trang step2/3/4 vẫn có "Account: ID" -> detect nhầm step1 mãi
   
   Logic mới ưu tiên theo độ tin cậy:
   1. 'access granted'                      -> granted
   2. 'unlocking...' hoặc 'unlocking' kèm timer -> unlocking
   3. 'continue (an ad' OR 'unlocked'+no-input  -> unlocked
   4. Có input + 'without discord'/'step 1' -> step1
   5. stepNum>=2 + 'continue'               -> unlocked fallback
   ══════════════════════════════════════════════════════════════════════════════ */
async function _pgGetState(page) {
  return await _safeEval(page, () => {
    const bodyText = document.body ? (document.body.innerText || document.body.textContent || '') : '';
    const bodyL    = bodyText.toLowerCase().replace(/\s+/g, ' ');

    // ── 0. TRANG LOGIN ĐẦU (chọn Sign in / Continue without Discord, chưa có input số) ──
    var hasStepNum0 = /step\s+\d\s+of\s+4/.test(bodyL);
    var hasInput0 = !!document.querySelector('input[type="number"],input[type="text"],input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="submit"]):not([type="button"])');
    if (!hasStepNum0 && !hasInput0 &&
        (bodyL.includes('sign in with discord') || bodyL.includes('continue without discord')) &&
        !bodyL.includes('access granted') && !bodyL.includes('unlocking') && !bodyL.includes('unlocked')) {
      return { step: 'login', expires: -1, countdown: -1 };
    }

    // ── 1. GRANTED ──
    if (bodyL.includes('access granted')) {
      const parts = [];
      document.querySelectorAll('*').forEach(function(el) {
        if (el.children.length === 0) {
          var t = (el.innerText || el.textContent || '').trim();
          if (t) parts.push(t);
        }
      });
      var expires = -1;
      for (var pi = 0; pi < parts.length; pi++) {
        var t = parts[pi];
        var m = t.match(/^(\d+)h\s*(\d+)m\s*(\d+)s$/);
        if (m) { expires = +m[1]*3600 + +m[2]*60 + +m[3]; break; }
        m = t.match(/^(\d+)m\s*(\d+)s$/);
        if (m) { expires = +m[1]*60 + +m[2]; break; }
        m = t.match(/^(\d+)s$/);
        if (m && +m[1] > 30 && +m[1] < 7200) { expires = +m[1]; break; }
      }
      if (expires <= 0) {
        for (var pi2 = 0; pi2 < parts.length - 2; pi2++) {
          var j3 = parts[pi2]+' '+parts[pi2+1]+' '+parts[pi2+2];
          var m3 = j3.match(/(\d+)h\s*(\d+)m\s*(\d+)s/);
          if (m3) { expires = +m3[1]*3600 + +m3[2]*60 + +m3[3]; break; }
        }
      }
      if (expires <= 0) {
        for (var pi3 = 0; pi3 < parts.length - 1; pi3++) {
          var j2 = parts[pi3]+' '+parts[pi3+1];
          var m2 = j2.match(/(\d+)m\s*(\d+)s/);
          if (m2) { expires = +m2[1]*60 + +m2[2]; break; }
        }
      }
      if (expires <= 0) {
        var bc = bodyText.replace(/\s+/g,' ');
        var mf = bc.match(/(\d+)h\s*(\d+)m\s*(\d+)s/);
        if (mf) expires = +mf[1]*3600 + +mf[2]*60 + +mf[3];
        if (expires <= 0) { mf = bc.match(/(\d+)m\s*(\d+)s/); if (mf) expires = +mf[1]*60 + +mf[2]; }
      }
      return { step: 'granted', expires: expires > 0 ? expires : 3600, countdown: -1 };
    }

    // ── Helper: đọc countdown từ text nodes ──
    function readCountdown() {
      var cd = -1;
      try {
        var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
        var node;
        while ((node = walker.nextNode())) {
          var t = (node.nodeValue || '').trim();
          if (!t) continue;
          var m = t.match(/^(\d+)s$/);
          if (m && +m[1] >= 1 && +m[1] <= 120) { cd = +m[1]; break; }
          m = t.match(/^(\d+)m\s*(\d+)s$/);
          if (m && +m[1] < 3) { cd = +m[1]*60 + +m[2]; break; }
        }
      } catch(e) {}
      return cd;
    }

    // ── Detect "Step X of 4" ──
    var stepMatch = bodyL.match(/step\s+(\d)\s+of\s+4/);
    var stepNum = stepMatch ? parseInt(stepMatch[1]) : 0;

    // ── Check input tồn tại ──
    var hasInput = !!document.querySelector(
      'input[type="number"],input[type="text"],input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="search"]):not([type="submit"]):not([type="button"])'
    );

    // ── 2. UNLOCKING ──
    // "Unlocking..." với dấu chấm, hoặc có progress bar + chữ unlocking
    if (bodyL.includes('unlocking...') || bodyL.includes('unlocking \u2026')) {
      return { step: 'unlocking', expires: -1, countdown: readCountdown() };
    }
    // "unlocking" + có timer countdown (đang đếm ngược)
    if (bodyL.includes('unlocking') && !bodyL.includes('unlocked') && readCountdown() > 0) {
      return { step: 'unlocking', expires: -1, countdown: readCountdown() };
    }
    // "unlocking" mà step >= 2 (trang bước 2/3/4 đang unlock)
    if (bodyL.includes('unlocking') && stepNum >= 2) {
      return { step: 'unlocking', expires: -1, countdown: readCountdown() };
    }

    // ── 3. UNLOCKED ──
    // Dấu hiệu mạnh nhất: nút "Continue (an ad will open)" xuất hiện
    var hasAdContinue = bodyL.includes('continue (an ad') || bodyL.includes('an ad will open');
    var hasUnlocked   = bodyL.includes('\u25cf unlocked') || bodyL.includes('• unlocked') ||
                        (bodyL.includes('unlocked') && !bodyL.includes('unlocking'));
    var hasManage     = bodyL.includes('manage your account');

    if (hasAdContinue || hasManage || (hasUnlocked && !hasInput && stepNum >= 2)) {
      return { step: 'unlocked', expires: -1, countdown: readCountdown() };
    }

    // ── 4. STEP1 ──
    // Có input VÀ đây là bước đầu tiên (step 1 hoặc chưa có step number)
    var hasStep1Signs = bodyL.includes('without discord') || bodyL.includes('sign in with discord') ||
                        bodyL.includes('continue without') || stepNum <= 1;
    if (hasInput && hasStep1Signs) {
      return { step: 'step1', expires: -1, countdown: readCountdown() };
    }

    // ── 5. UNLOCKED fallback — step 2/3/4 + có Continue + không input ──
    if (stepNum >= 2 && bodyL.includes('continue') && !hasInput) {
      return { step: 'unlocked', expires: -1, countdown: readCountdown() };
    }

    // ── 6. Input còn đó nhưng không rõ bước ──
    if (hasInput) {
      return { step: 'step1', expires: -1, countdown: readCountdown() };
    }

    return { step: 'unknown', expires: -1, countdown: -1 };
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

    // Ưu tiên -1: nút "Continue without Discord" trên trang login (không có số step)
    // Đây là nút chữ trắng nền tối, không phải nút tím có input
    for (const el of all) {
      if (!isVisible(el)) continue;
      const t0 = txt(el);
      if (t0 === 'continue without discord') return forceTap(el);
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
   _closeAdTabs() — Đóng tất cả tab quảng cáo mở thêm, giữ lại tab chính
   ══════════════════════════════════════════════════════════════════════════════ */
async function _closeAdTabs(browser, mainPage) {
  try {
    const pages = await browser.pages();
    for (const p of pages) {
      if (p !== mainPage && !p.isClosed()) {
        console.log(`[TgServer] Đóng tab ad: ${p.url()}`);
        try { await p.close(); } catch(_) {}
      }
    }
  } catch(_) {}
}

/* ══════════════════════════════════════════════════════════════════════════════
   _waitForCountdown() — Đợi countdown timer hết giây, poll 500ms/lần
   Trả về true khi countdown về 0, false nếu timeout
   ══════════════════════════════════════════════════════════════════════════════ */
async function _waitForCountdown(page, initialSecs, label) {
  // Đợi thêm (countdown + 2s buffer) để chắc chắn timer hết
  const totalWait = (initialSecs + 2) * 1000;
  const deadline  = Date.now() + totalWait;
  console.log(`[TgServer] ${label} countdown=${initialSecs}s → đợi ${initialSecs+2}s`);
  while (Date.now() < deadline) {
    await _pgSleep(500);
    const st = await _pgGetState(page);
    // Nếu countdown đã biến mất hoặc về 0 → thoát sớm
    if (st.countdown <= 0 && st.step !== 'unknown') return st;
    // Nếu step đã thay đổi → thoát ngay
    if (st.step === 'unlocked' || st.step === 'granted') return st;
  }
  return await _pgGetState(page);
}

/* ══════════════════════════════════════════════════════════════════════════════
   _buildInjectJs() — Build JS y hệt BackgroundWebVerifier.java buildAutoJs()
   
   Chạy trực tiếp trên trang, dùng loop 200ms + MutationObserver.
   Kết quả trả về qua window.__result = { status, expires, step }
   
   Đồng bộ hoàn toàn với:
     - buildAutoJs() trong BackgroundWebVerifier.java
     - getStep() / findContinueWithoutDiscordBtn() / findContinueBtn()
     - setVal() / forceEnableBtn() / forceTap()
   ══════════════════════════════════════════════════════════════════════════════ */
function _buildInjectJs(accountId) {
  const MYID = JSON.stringify(String(accountId));
  return `(function(){
if(window.__tgbot_v14)return;
window.__tgbot_v14=true;
window.__result=null;
window.__bgClickPending=false;
window.__bgLastClick=0;
var MYID=${MYID};
var STATE=0;var busyUntil=0;var grantedMode=false;
var clickCount=0;

function setVal(el,v){
  try{var s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
  s.call(el,v);
  ['input','change','keyup','keydown'].forEach(function(n){
    el.dispatchEvent(new Event(n,{bubbles:true,cancelable:true}));
  });}catch(ex){el.value=v;['input','change'].forEach(function(n){
    el.dispatchEvent(new Event(n,{bubbles:true,cancelable:true}));
  });}
}

function forceEnableBtn(el){
  if(!el)return;
  try{el.removeAttribute('disabled');}catch(e){}
  try{el.removeAttribute('aria-disabled');}catch(e){}
  try{el.style.pointerEvents='auto';}catch(e){}
  try{el.style.opacity='1';}catch(e){}
}

function forceTap(el){
  if(!el)return false;
  forceEnableBtn(el);
  try{el.scrollIntoView({block:'center',behavior:'instant'});}catch(e){}
  var r=el.getBoundingClientRect();
  var cx=r.left+r.width/2,cy=r.top+r.height/2;
  var mOpts={bubbles:true,cancelable:true,view:window,clientX:cx,clientY:cy,button:0,buttons:1};
  try{el.dispatchEvent(new MouseEvent('mousedown',mOpts));}catch(e){}
  try{el.dispatchEvent(new MouseEvent('mouseup',mOpts));}catch(e){}
  try{el.dispatchEvent(new MouseEvent('click',Object.assign({},mOpts,{detail:1})));}catch(e){}
  try{el.click();}catch(e){}
  return true;
}

function getAllElements(sel,root){
  root=root||document;
  var r=Array.from(root.querySelectorAll(sel));
  root.querySelectorAll('*').forEach(function(el){
    if(el.shadowRoot)r=r.concat(getAllElements(sel,el.shadowRoot));
  });
  return r;
}

function isClickable(el){
  try{var r=el.getBoundingClientRect();
  if(r.width===0&&r.height===0)return false;
  var cs=window.getComputedStyle(el);
  if(cs.display==='none'||cs.visibility==='hidden'||cs.opacity==='0')return false;
  }catch(e){}
  return true;
}

function findContinueWithoutDiscordBtn(){
  var allEls=getAllElements('*');
  // Pass 1: exact match
  for(var i=0;i<allEls.length;i++){
    var el=allEls[i];if(!isClickable(el))continue;
    var raw=(el.innerText||el.textContent||'').toLowerCase().replace(/\s+/g,' ').trim();
    if(raw==='continue without discord')return el;
  }
  // Pass 2: "without"+"discord", no "join"
  for(var i=0;i<allEls.length;i++){
    var el=allEls[i];if(!isClickable(el))continue;
    var raw2=(el.innerText||el.value||el.textContent||'').toLowerCase().replace(/\s+/g,' ').trim();
    if(raw2.indexOf('without')>=0&&raw2.indexOf('discord')>=0&&raw2.indexOf('join')<0&&raw2.length<120)return el;
  }
  // Pass 3: starts with "continue without"
  for(var i=0;i<allEls.length;i++){
    var el=allEls[i];if(!isClickable(el))continue;
    var raw3=(el.innerText||el.value||el.textContent||'').toLowerCase().replace(/\s+/g,' ').trim();
    if(raw3.startsWith('continue without')&&raw3.length<120)return el;
  }
  return null;
}

function findContinueBtn(){
  var cwd=findContinueWithoutDiscordBtn();
  if(cwd)return cwd;
  var sels='button,a,[role="button"],[class*="btn"],[class*="continue"],[class*="Continue"]';
  var all=getAllElements(sels);
  for(var i=0;i<all.length;i++){
    var t=(all[i].innerText||all[i].value||all[i].textContent||'').toLowerCase().trim();
    if(t.indexOf('continue')>=0&&t.indexOf('join')<0&&t.indexOf('discord')<0&&t.indexOf('restart')<0&&t.length<80)return all[i];
  }
  return null;
}

function readGrantedTimer(){
  var texts=[];
  document.querySelectorAll('*').forEach(function(el){
    if(el.children.length===0){var t=(el.innerText||el.textContent||'').trim();if(t)texts.push(t);}
  });
  for(var i=0;i<texts.length;i++){
    var t=texts[i];var m;
    m=t.match(/^(\d+)h\s*(\d+)m\s*(\d+)s$/);if(m)return +m[1]*3600+ +m[2]*60+ +m[3];
    m=t.match(/^(\d+)m\s*(\d+)s$/);if(m)return +m[1]*60+ +m[2];
    m=t.match(/^(\d+)s$/);if(m&&+m[1]<7200)return +m[1];
  }
  var b=document.body.innerText||'';
  var m2=b.match(/(\d+)h\s*(\d+)m\s*(\d+)s/);if(m2)return +m2[1]*3600+ +m2[2]*60+ +m2[3];
  m2=b.match(/(\d+)m\s*(\d+)s/);if(m2)return +m2[1]*60+ +m2[2];
  return -1;
}

function getStep(){
  var b=(document.body&&(document.body.innerText||document.body.textContent)||'').toLowerCase();
  if(b.indexOf('access granted')>=0)return 'granted';
  if(b.indexOf('unlocking')>=0)return 'unlocking';
  if(b.indexOf('unlocked')>=0&&b.indexOf('continue')>=0)return 'unlocked';
  if(b.indexOf('verify')>=0||b.indexOf('without discord')>=0||b.indexOf('account')>=0){
    var inp=document.querySelector('input[type="number"],input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
    if(inp||STATE<=1)return 'step1';
  }
  if(findContinueWithoutDiscordBtn())return 'step1';
  return 'unknown';
}

function globalForceEnable(){
  try{
    var all=getAllElements('button,a,[role="button"],[class*="btn"]');
    for(var i=0;i<all.length;i++){
      var t=(all[i].innerText||all[i].textContent||'').toLowerCase();
      if(t.indexOf('continue')>=0&&t.indexOf('restart')<0&&t.indexOf('join')<0){forceEnableBtn(all[i]);}
    }
  }catch(e){}
}
if(window.__fev14)clearInterval(window.__fev14);
window.__fev14=setInterval(globalForceEnable,500);

// MutationObserver — bắt nút tím ngay khi DOM thay đổi
var done_flag=false;var _moTimer=null;
var _mo=new MutationObserver(function(){
  if(done_flag)return;
  clearTimeout(_moTimer);
  _moTimer=setTimeout(function(){
    var now2=Date.now();
    if(now2>=busyUntil&&!window.__bgClickPending){
      var cwd2=findContinueWithoutDiscordBtn();
      if(cwd2&&now2-window.__bgLastClick>800){
        globalForceEnable();
        window.__bgClickPending=true;
        var _e2=cwd2;
        setTimeout(function(){
          window.__bgClickPending=false;
          var fresh2=findContinueWithoutDiscordBtn()||_e2;
          if(fresh2){forceEnableBtn(fresh2);window.__bgLastClick=Date.now();
            forceTap(fresh2);clickCount++;STATE=Math.max(STATE,2);busyUntil=Date.now()+2500;}
        },250);
      }
    }
  },120);
});
try{_mo.observe(document.body||document.documentElement,
  {childList:true,subtree:true,attributes:true,characterData:false});}catch(e){}

// MAIN LOOP 200ms — y hệt BackgroundWebVerifier.java
var timerActive=false,lastTimerSec=-1;
function loop(){
  try{
    var now=Date.now();
    if(now<busyUntil)return;
    var step=getStep();

    // GRANTED
    if(step==='granted'){
      done_flag=true;
      if(window.__fev14)clearInterval(window.__fev14);
      if(window.__bgiv14)clearInterval(window.__bgiv14);
      var secs=readGrantedTimer();
      if(secs>0){
        window.__result={status:'granted',expires:secs,step:'granted'};
      }else if(!grantedMode){
        grantedMode=true;STATE=10;
        window.__result={status:'granted',expires:3600,step:'granted'};
      }
      return;
    }

    // UNLOCKING — chờ countdown rồi click Continue
    if(step==='unlocking'){
      var walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,null,false);
      var node;var t=-1;
      while(node=walker.nextNode()){var txt=(node.nodeValue||'').trim();
        var mm=txt.match(/^(\d+)s$/);if(mm&&+mm[1]<=120){t=+mm[1];break;}
        mm=txt.match(/^(\d+)m\s*(\d+)s$/);if(mm){t=+mm[1]*60+ +mm[2];break;}
      }
      if(t>0){lastTimerSec=t;timerActive=true;}
      else if(timerActive||lastTimerSec===0){
        timerActive=false;lastTimerSec=-1;
        var cbs=getAllElements('button,[role="button"],[class*="btn"],[class*="continue"]');
        var target=null;
        for(var i=0;i<cbs.length;i++){var bt=(cbs[i].innerText||'').toLowerCase().trim();
          if(bt.indexOf('continue')>=0&&bt.indexOf('discord')<0&&bt.indexOf('join')<0){target=cbs[i];break;}
        }
        if(target&&now-window.__bgLastClick>2000){window.__bgLastClick=now;forceTap(target);busyUntil=now+3000;}
      }
      return;
    }

    // UNLOCKED — click Continue
    if(step==='unlocked'){
      var abs=getAllElements('button,[role="button"]');var t2=null;
      for(var i=0;i<abs.length;i++){var bt=(abs[i].innerText||'').toLowerCase().trim();
        if(bt.indexOf('continue')>=0&&bt.indexOf('cancel')<0&&bt.indexOf('discord')<0&&bt.indexOf('restart')<0){t2=abs[i];break;}
      }
      if(t2&&now-window.__bgLastClick>2000){window.__bgLastClick=now;forceTap(t2);busyUntil=now+3000;}
      return;
    }

    // STEP 1 — điền ID + click "Continue without Discord"
    if(step==='step1'){
      var inp=document.querySelector('input[type="number"]');
      if(!inp)inp=document.querySelector('input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"])');
      if(inp&&inp.value!==MYID&&MYID!==''){
        inp.focus();setVal(inp,MYID);STATE=1;
        setTimeout(globalForceEnable,200);
        busyUntil=now+600;return;
      }
      if(!window.__bgClickPending&&now-window.__bgLastClick>800){
        var cBtn=findContinueWithoutDiscordBtn();
        if(cBtn){
          forceEnableBtn(cBtn);
          window.__bgClickPending=true;
          var _b=cBtn;
          setTimeout(function(){window.__bgClickPending=false;
            var fresh=findContinueWithoutDiscordBtn()||_b;
            if(fresh){forceEnableBtn(fresh);window.__bgLastClick=Date.now();
              forceTap(fresh);clickCount++;STATE=Math.max(STATE,2);busyUntil=Date.now()+2000;}
          },200);
        }else{
          window.scrollTo(0,document.body.scrollHeight/2);busyUntil=now+150;
        }
      }
      return;
    }

    // FALLBACK unknown — nếu thấy nút tím thì điền ID + click
    var fb=findContinueWithoutDiscordBtn();
    if(fb&&!window.__bgClickPending&&now-window.__bgLastClick>2000){
      var inp2=document.querySelector('input');
      if(inp2&&inp2.value!==MYID&&MYID!==''){setVal(inp2,MYID);busyUntil=now+800;return;}
      forceEnableBtn(fb);
      window.__bgClickPending=true;
      var _fb=fb;
      setTimeout(function(){window.__bgClickPending=false;
        var ff=findContinueWithoutDiscordBtn()||_fb;
        if(ff){forceEnableBtn(ff);window.__bgLastClick=Date.now();forceTap(ff);clickCount++;busyUntil=Date.now()+2500;}
      },300);
    }

  }catch(e){}
}

if(window.__bgiv14)clearInterval(window.__bgiv14);
window.__bgiv14=setInterval(loop,200);
setTimeout(loop,100);setTimeout(loop,500);
setTimeout(loop,1000);setTimeout(loop,2000);setTimeout(loop,3500);
})();`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   _runWithPuppeteer() — Flow 4 bước CHẮC CHẮN:
   
   Dùng _buildInjectJs() — JS y hệt BackgroundWebVerifier.java
   Inject 1 lần sau khi trang load, JS tự chạy loop 200ms + MutationObserver.
   Node.js chỉ cần poll window.__result mỗi 500ms, tối đa 4 phút.
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

    // ── Hàm inject JS vào trang (safe, retry khi navigation) ──
    const injectAutoJs = async () => {
      const js = _buildInjectJs(accountId);
      for (let i = 0; i < 3; i++) {
        try {
          await page.evaluate(js);
          return true;
        } catch (e) {
          if (_isNavError(e)) { await _pgSleep(800); continue; }
          console.warn(`[TgServer] inject lần ${i+1} lỗi:`, e.message);
          await _pgSleep(400);
        }
      }
      return false;
    };

    page.on('load', () => {
      console.log(`[TgServer] page load — re-inject JS sau 800ms`);
      // Đợi React/Vue render trước khi inject (như Java: delays 300, 700, 1400...)
      setTimeout(() => injectAutoJs().catch(() => {}), 800);
      setTimeout(() => injectAutoJs().catch(() => {}), 1800);
      setTimeout(() => injectAutoJs().catch(() => {}), 3500);
    });

    /* ════════════════════════════════════════════
       BƯỚC 0: Tải trang + inject JS lần đầu
       ════════════════════════════════════════════ */
    await sendMsg(chatId,
      `⏳ <b>Đang xác thực...</b>\n` +
      `🆔 ID: <code>${accountId}</code>\n` +
      `<i>Bot đang tự động click qua 4 bước, vui lòng chờ...</i>`
    );

    await page.goto('https://www.unlockffbeta.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Đợi React/Vue render rồi inject lần đầu
    // (scheduleReInject không cần ở đây vì guard __tgbot_v14 sẽ block các lần sau;
    //  page.on('load') sẽ re-inject khi SPA navigate thực sự)
    await _pgSleep(1500);
    await injectAutoJs();

    // Debug dump ban đầu
    _pgDumpDebug(page).then(d => {
      console.log(`[DEBUG] body: ${d.body.slice(0, 300)}`);
      console.log(`[DEBUG] btns: ${d.btns.slice(0, 300)}`);
      console.log(`[DEBUG] inputs: ${d.inputs}`);
    }).catch(() => {});

    /* ════════════════════════════════════════════
       VÒNG POLL CHÍNH — poll window.__result mỗi 500ms
       Tối đa 4 phút (JS loop tự xử lý mọi bước)
       ════════════════════════════════════════════ */
    const MASTER_DEADLINE = Date.now() + 4 * 60 * 1000;
    let lastReportedStep = '';
    let pollCount = 0;

    while (Date.now() < MASTER_DEADLINE) {
      await _pgSleep(500);
      pollCount++;

      // Đọc window.__result và step hiện tại từ trang
      let result = null;
      let currentStep = 'unknown';
      try {
        const pageData = await page.evaluate(() => ({
          result: window.__result || null,
          // Step detect CHỈ dùng để log/progress — không dùng 'account' tránh false positive trang step2+
          step: (function() {
            var b = (document.body && (document.body.innerText || document.body.textContent) || '').toLowerCase();
            if (b.indexOf('access granted') >= 0) return 'granted';
            if (b.indexOf('unlocking') >= 0) return 'unlocking';
            if (b.indexOf('unlocked') >= 0 && b.indexOf('continue') >= 0) return 'unlocked';
            if (b.indexOf('without discord') >= 0) return 'step1';
            return 'unknown';
          })(),
        }));
        result      = pageData.result;
        currentStep = pageData.step;
      } catch (e) {
        if (_isNavError(e)) {
          await _pgSleep(1000);
          await injectAutoJs().catch(() => {});
          continue;
        }
      }

      // Log khi step thay đổi
      if (currentStep !== lastReportedStep) {
        console.log(`[TgServer] Step: ${lastReportedStep || 'init'} → ${currentStep}`);
        lastReportedStep = currentStep;

        // Gửi thông báo progress khi bước thay đổi
        if (currentStep === 'unlocking') {
          await sendMsg(chatId,
            `⏱ <b>Đang mở khóa...</b>\n🆔 ID: <code>${accountId}</code>\n<i>JS đang chờ countdown...</i>`
          ).catch(() => {});
        } else if (currentStep === 'unlocked') {
          await sendMsg(chatId,
            `🖱 <b>Đang click tiếp tục...</b>\n🆔 ID: <code>${accountId}</code>`
          ).catch(() => {});
        }
      }

      // Debug + force re-inject mỗi 20 lần poll (~10s)
      if (pollCount % 20 === 0) {
        _pgDumpDebug(page).then(d =>
          console.log(`[DEBUG-POLL-${pollCount}] step=${currentStep} body: ${d.body.slice(0, 150)}`)
        ).catch(() => {});
        // Reset guard rồi inject lại — phòng JS bị mất do SPA soft-navigate (không fire 'load')
        try {
          await page.evaluate(() => { window.__tgbot_v14 = false; });
          await injectAutoJs();
        } catch(_) {}
      }

      // Kiểm tra kết quả
      if (result && result.status === 'granted') {
        const expiresSecs = result.expires > 0 ? result.expires : 3600;
        console.log(`[TgServer] ✅ GRANTED! expires=${expiresSecs}s`);
        await _handleSuccess(chatId, accountId, expiresSecs);
        return;
      }
    }

    // Timeout — kiểm tra lần cuối
    let finalResult = null;
    try {
      finalResult = await page.evaluate(() => window.__result || null);
    } catch (_) {}

    if (finalResult && finalResult.status === 'granted') {
      await _handleSuccess(chatId, accountId, finalResult.expires > 0 ? finalResult.expires : 3600);
    } else {
      await sendMsg(chatId,
        `❌ <b>Xác thực thất bại.</b>\n` +
        `🆔 ID: <code>${accountId}</code>\n\n` +
        `Timeout sau 4 phút — không nhận được "Access Granted".\n\n` +
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
    console.log(`\n🤖 Telegram Server v14.3 đang chạy tại port ${PORT}`);
    console.log(`   BOT_TOKEN  : ${BOT_TOKEN.slice(0, 10)}...`);
    console.log(`   KEY_SERVER : ${KEY_SERVER_URL}`);
    console.log(`   KEY_APP_ID : ${KEY_APP_ID}`);
    console.log(`   Flow: JS inject y hệt BackgroundWebVerifier.java buildAutoJs()`);
    console.log(`   Poll: window.__result mỗi 500ms, timeout 4 phút`);
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
