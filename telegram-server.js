/**
 * telegram-server.js — Server Telegram Bot độc lập
 *
 * Chức năng:
 *  - Nhận webhook từ Telegram
 *  - Xác thực KEY bằng cách gọi API /api/verify của index server (KEY_SERVER_URL)
 *  - Xác thực ID Free Fire qua unlockffbeta.com (Puppeteer hoặc HTTP fallback)
 *  - Quản lý session theo chatId (key, ID, auto-reverify)
 *
 * Biến môi trường:
 *  TELEGRAM_BOT_TOKEN   — bot token (bắt buộc)
 *  KEY_SERVER_URL       — URL của index server (vd: https://your-keyvault.onrender.com)
 *  KEY_SERVER_APP_ID    — appId đăng ký trong dashboard index server (bắt buộc)
 *  PORT                 — cổng lắng nghe (mặc định 4000)
 *  RENDER_EXTERNAL_URL  — URL public của telegram-server này (để đăng ký webhook)
 *
 * Cài đặt:
 *  npm install puppeteer-core @sparticuz/chromium  (trên Render/server)
 *  hoặc: npm install puppeteer                     (local dev)
 *
 * Chạy:
 *  node telegram-server.js
 */

'use strict';

const http   = require('http');
const https  = require('https');
const crypto = require('crypto');
const url    = require('url');

/* ─── CẤU HÌNH ─────────────────────────────────────────────────────────────── */
// Bỏ qua tải Chromium của puppeteer-core vì dùng @sparticuz/chromium riêng
process.env.PUPPETEER_SKIP_CHROMIUM_DOWNLOAD = 'true';

const BOT_TOKEN      = process.env.TELEGRAM_BOT_TOKEN || '8714375866:AAG9r0aCCFOKtgR6B-LcFYBAnJ7x9yMs-8o';
const KEY_SERVER_URL = (process.env.KEY_SERVER_URL || 'https://serverkey-u8w6.onrender.com').replace(/\/+$/, '');
const KEY_APP_ID     = process.env.KEY_SERVER_APP_ID || 'telegram-bot';
const TG_SHARED_SECRET = process.env.TELEGRAM_SHARED_SECRET || '';   // phải khớp với index server
const PORT           = parseInt(process.env.TGSERVER_PORT || process.env.PORT || '4000', 10);
const TG_API_BASE    = 'https://api.telegram.org/bot' + BOT_TOKEN;

/* ─── SESSION store (in-memory) ────────────────────────────────────────────── */
// sessions[chatId] = {
//   keyVerified, savedKey, savedId, accountId,
//   waitingForKey, waitingForId,
//   expires, accessState, reverifyTimer
// }
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
/**
 * Gọi /api/verify của index server để xác thực key.
 * Trả về object: { valid, reason, status, expiresAt, message, ... }
 */
function checkKeyWithServer(keyValue) {
  return new Promise((resolve, reject) => {
    try {
      const parsed   = new URL(KEY_SERVER_URL);
      const isHttps  = parsed.protocol === 'https:';
      const proto    = isHttps ? https : http;
      // Gọi đúng endpoint /api/verify của index server, kèm app ID để server nhận diện bot
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

    // Tính thời gian còn lại nếu có
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
   PUPPETEER ENGINE (xác thực ID Free Fire)
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

const AD_DOMAINS = [
  'doubleclick.net','googlesyndication.com','adsterra.com','propellerads.com',
  'popads.net','exoclick.com','popcash.net','adcash.com','onclickmega.com',
  'onclickads.net','clickadu.com','evadav.com','onesignal.com','pushcrew.com',
  'subscribers.com','pushwoosh.com','izooto.com','webpushr.com','sendpulse.com',
  'wonderpush.com','pushassist.com','innity.com','admicro.vn','adtima.vn',
  'eclick.vn','mgid.com','taboola.com','outbrain.com','activerevenue.com',
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

async function _pgFillInput(page, accountId) {
  const selectors = [
    'input[type="number"]',
    'input[placeholder*="ID"]',
    'input[placeholder*="id"]',
    'input[placeholder*="account"]',
    'input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]):not([type="submit"])',
  ];
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (!el) continue;
    const visible = await el.isIntersectingViewport().catch(() => true);
    if (!visible) continue;
    await el.click({ clickCount: 3 });
    await el.type(accountId, { delay: 50 });
    await page.evaluate(s => {
      const inp = document.querySelector(s);
      if (!inp) return;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(inp, inp.value);
      ['input','change','keyup'].forEach(ev => inp.dispatchEvent(new Event(ev, { bubbles: true })));
    }, sel);
    return true;
  }
  return false;
}

async function _pgClickCWD(page) {
  try {
    return await page.evaluate(() => {
      function forceTap(el) {
        try { el.scrollIntoView({ block: 'center', behavior: 'instant' }); } catch(_) {}
        try { el.removeAttribute('disabled'); } catch(_) {}
        try { el.style.pointerEvents = 'auto'; el.style.opacity = '1'; } catch(_) {}
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        const opts = { bubbles:true, cancelable:true, view:window, clientX:cx, clientY:cy, button:0 };
        ['mousedown','mouseup','click'].forEach(t => el.dispatchEvent(new MouseEvent(t, opts)));
        try { el.click(); } catch(_) {}
        return true;
      }
      const all = Array.from(document.querySelectorAll('*'));
      for (const el of all) {
        const t = (el.innerText||el.textContent||'').toLowerCase().replace(/\s+/g,' ').trim();
        if (t === 'continue without discord') return forceTap(el);
      }
      for (const el of all) {
        const t = (el.innerText||el.value||el.textContent||'').toLowerCase().replace(/\s+/g,' ').trim();
        if (t.includes('without') && t.includes('discord') && !t.includes('join') && t.length < 120) return forceTap(el);
      }
      for (const el of all) {
        const t = (el.innerText||el.value||el.textContent||'').toLowerCase().replace(/\s+/g,' ').trim();
        if (t.startsWith('continue without') && t.length < 120) return forceTap(el);
      }
      return false;
    });
  } catch (e) {
    console.warn('[TgServer] _pgClickCWD lỗi:', e.message);
    return false;
  }
}

async function _pgClickGeneric(page) {
  try {
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button,a,[role="button"],[class*="btn"],[class*="continue"]'));
      for (const el of btns) {
        const t = (el.innerText||el.textContent||'').toLowerCase().trim();
        if (t.includes('continue') && !t.includes('discord') && !t.includes('join') && !t.includes('restart') && t.length < 80) {
          try { el.removeAttribute('disabled'); el.click(); } catch(_) {}
          return true;
        }
      }
    });
  } catch(_) {}
}

async function _pgGetState(page) {
  try {
    return await page.evaluate(() => {
      const granted = /access\s*granted/i.test(document.body.innerHTML);
      let expires = -1;
      if (granted) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const t = (node.nodeValue||'').trim();
          let m;
          m = t.match(/^(\d+)h\s*(\d+)m\s*(\d+)s$/); if (m) { expires = +m[1]*3600 + +m[2]*60 + +m[3]; break; }
          m = t.match(/^(\d+)m\s*(\d+)s$/);           if (m) { expires = +m[1]*60 + +m[2]; break; }
          m = t.match(/^(\d+)s$/);                    if (m && +m[1] < 7200) { expires = +m[1]; break; }
        }
        if (expires <= 0) {
          const html = document.body.innerHTML;
          let mm = html.match(/(\d+)h\s*(\d+)m\s*(\d+)s/);
          if (mm) expires = +mm[1]*3600 + +mm[2]*60 + +mm[3];
          else { mm = html.match(/(\d+)m\s*(\d+)s/); if (mm) expires = +mm[1]*60 + +mm[2]; }
        }
        if (expires <= 0) expires = 3600;
        return { granted: true, expires, countdown: 0 };
      }
      let countdown = 0;
      for (const el of Array.from(document.querySelectorAll('*'))) {
        if (el.children.length > 0) continue;
        const t = (el.innerText||el.textContent||'').trim();
        const m = t.match(/^(\d+)s?$/) || t.match(/^(\d+)\s*s(?:ec)?$/i);
        if (m) { const v = parseInt(m[1]); if (v >= 1 && v <= 60) { countdown = v; break; } }
      }
      return { granted: false, expires: -1, countdown };
    });
  } catch (e) {
    return { granted: false, expires: -1, countdown: 0 };
  }
}

async function _pgWaitCountdown(page, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await _pgSleep(500);
    const st = await _pgGetState(page).catch(() => ({ countdown: 0 }));
    if (st.granted) return 'granted';
    if (!st.countdown || st.countdown <= 0) return 'done';
  }
  return 'timeout';
}

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
        '--no-sandbox','--disable-setuid-sandbox',
        '--disable-dev-shm-usage','--disable-gpu',
        '--disable-extensions','--mute-audio',
        '--no-first-run','--disable-notifications',
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
      if (['image','media','font','stylesheet'].includes(rt)) { req.abort(); return; }
      if (isAdUrl(req.url())) { req.abort(); return; }
      req.continue();
    });
    page.on('dialog', async dlg => { try { await dlg.dismiss(); } catch(_) {} });

    await sendMsg(chatId, `⏳ <b>Đang mở trình duyệt...</b>\n🆔 ID: <code>${accountId}</code>\n<i>Bước 0/4: Tải trang...</i>`);
    await page.goto('https://www.unlockffbeta.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await _pgSleep(1500);

    await sendMsg(chatId, `📝 <b>Bước 1/4:</b> Điền ID và click nút tím...\n🆔 ID: <code>${accountId}</code>`);
    await _pgFillInput(page, accountId);
    await _pgSleep(600);
    await _pgClickCWD(page);
    await _pgSleep(1200);

    let expiresSecs = -1, grantedFound = false;
    for (let step = 2; step <= 5 && !grantedFound; step++) {
      const state = await _pgGetState(page);
      if (state.granted) { grantedFound = true; expiresSecs = state.expires; break; }
      if (state.countdown > 0) {
        const wait = Math.min(state.countdown + 2, 35);
        await sendMsg(chatId, `⏱ <b>Bước ${step-1}/4:</b> Đợi ${wait}s...\n🆔 ID: <code>${accountId}</code>`);
        await _pgWaitCountdown(page, wait * 1000);
      }
      await sendMsg(chatId, `🖱 <b>Bước ${step}/4:</b> Click tiếp tục...\n🆔 ID: <code>${accountId}</code>`);
      const clicked = await _pgClickCWD(page);
      if (!clicked) await _pgClickGeneric(page);
      await _pgSleep(1500);
      const stateAfter = await _pgGetState(page);
      if (stateAfter.granted) { grantedFound = true; expiresSecs = stateAfter.expires; break; }
    }

    if (grantedFound && expiresSecs > 0) {
      await _handleSuccess(chatId, accountId, expiresSecs);
    } else {
      const finalState = await _pgGetState(page);
      if (finalState.granted && finalState.expires > 0) {
        await _handleSuccess(chatId, accountId, finalState.expires);
      } else {
        await sendMsg(chatId,
          `❌ <b>Xác thực thất bại.</b>\n🆔 ID: <code>${accountId}</code>\n\n` +
          `Không nhận được "Access Granted".\n\n↩️ Gửi lại ID để thử lại.`
        );
      }
    }
  } catch (e) {
    console.error('[TgServer] Puppeteer lỗi:', e && e.message);
    await sendMsg(chatId, `❌ <b>Lỗi trình duyệt.</b>\n<code>${String(e && e.message || e).slice(0,150)}</code>\n\n↩️ Gửi lại ID để thử lại.`);
  } finally {
    if (browser) { try { await browser.close(); } catch(_) {} }
  }
}

async function _runHttpFallback(chatId, accountId) {
  try {
    const UA = 'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 Chrome/124.0.0.0 Mobile Safari/537.36';
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
   HANDLE SUCCESS: lưu session + notify + auto-reverify
   ══════════════════════════════════════════════════════════════════════════════ */
async function _handleSuccess(chatId, accountId, expiresSecs) {
  if (!expiresSecs || expiresSecs <= 0) expiresSecs = 3600;
  const h = Math.floor(expiresSecs / 3600);
  const m = Math.floor((expiresSecs % 3600) / 60);
  const s = expiresSecs % 60;
  const timeStr = h > 0 ? `${h}h ${m}m ${s}s` : m > 0 ? `${m}m ${s}s` : `${s}s`;
  const expiresAt = Date.now() + expiresSecs * 1000;
  const expDateStr = new Date(expiresAt).toLocaleString('vi-VN');

  const prev = sessions[String(chatId)] || {};
  sessions[String(chatId)] = {
    ...prev,
    accountId,
    savedId: prev.savedId || accountId,
    expires: expiresAt,
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
  console.log(`[TgServer] ✅ chatId=${chatId} ID=${accountId} expires=${expiresSecs}s reverifyIn=${Math.round(reverifyIn/1000)}s`);
}

/* ══════════════════════════════════════════════════════════════════════════════
   XỬ LÝ XÁC THỰC ID — /verify <id>
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
    savedId: prev.savedId || accountId,
    startedAt: Date.now(),
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
      `<b>🆔 Xác thực ID Free Fire:</b>\n<code>/verify 15886913287</code>\n→ Bot kết nối unlockffbeta.com và xác thực\n→ Khi còn ≤ 60 giây, bot <b>tự động xác thực lại</b>\n\n` +
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
        expStr = remainSec > 0 ? (rh > 0 ? `${rh}h ${rm}m ${rs}s còn lại` : rm > 0 ? `${rm}m ${rs}s còn lại` : `${rs}s còn lại`) : 'Đã hết hạn';
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

  /* Tin nhắn thường (không phải lệnh /) — xử lý trạng thái chờ nhập */
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
      // Gửi số nguyên → coi là ID
      await doVerifyId(chatId, text.trim());
    } else {
      // Lệnh không nhận ra
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

  // Health check
  if (path === '/' || path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'telegram-server', uptime: process.uptime() }));
    return;
  }

  // Webhook endpoint
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
    console.log(`\n🤖 Telegram Server đang chạy tại port ${PORT}`);
    console.log(`   BOT_TOKEN  : ${BOT_TOKEN.slice(0, 10)}...`);
    console.log(`   KEY_SERVER : ${KEY_SERVER_URL}`);
    console.log(`   KEY_APP_ID : ${KEY_APP_ID}`);

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
        { command: 'verify', description: 'Xác thực ID Free Fire' },
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

    // Khởi động chống ngủ đông
    startAntiSleep();
    console.log('');
  });
}

/* ══════════════════════════════════════════════════════════════════════════════
   CHỐNG NGỦ ĐÔNG (Render Free) — tự ping /health mỗi 4 phút
   ══════════════════════════════════════════════════════════════════════════════ */
function startAntiSleep() {
  const selfUrl = (process.env.RENDER_EXTERNAL_URL || process.env.SELF_URL || '').replace(/\/+$/, '');
  if (!selfUrl) {
    console.log('   ⚠️  [Anti-sleep] Chưa có RENDER_EXTERNAL_URL — bỏ qua tự ping.');
    console.log('        Nên cấu hình UptimeRobot/cron-job.org để ping từ bên ngoài.');
    return;
  }
  const target = selfUrl + '/health';
  console.log(`   🔄 [Anti-sleep] Tự ping ${target} mỗi 4 phút để chống ngủ đông.`);
  setInterval(() => {
    try {
      https.get(target, r => { r.resume(); }).on('error', e => {
        console.warn('[Anti-sleep] Ping thất bại (không nghiêm trọng):', e.message);
      });
    } catch (e) { /* bỏ qua, không ảnh hưởng server chính */ }
  }, 4 * 60 * 1000);
}

process.on('SIGINT',  () => { console.log('\n[TgServer] Đang tắt...'); server.close(() => process.exit(0)); });
process.on('SIGTERM', () => { server.close(() => process.exit(0)); });

start();
