// ==UserScript==
// @name         抖音网页版聊天记录导出器
// @namespace    https://www.douyin.com/
// @version      1.0.0
// @description  在网页版抖音私信页自动滚动加载并提取聊天记录，支持导出 JSON / HTML / TXT / CSV。纯本地运行，不向任何第三方发送数据，不主动调用接口、不破解签名，只读取你本人浏览器里已经加载出来的会话数据。
// @author       you
// @match        https://www.douyin.com/*
// @match        https://www.iesdouyin.com/*
// @run-at       document-start
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 原理（双保险）：
 *  1) DOM 提取（主）：网页版抖音是 React SPA，每条私信是一个类名含 message-item 的节点，
 *     自己发出的消息类名含 self。脚本自动把消息面板反复滚动到顶部，触发历史消息分页加载，
 *     再按 DOM 顺序提取 发送方 / 时间 / 文本 / 图片 / 视频。
 *  2) 网络捕获（辅）：在页面脚本运行前 hook fetch / XMLHttpRequest / WebSocket，
 *     被动保存浏览器本来就会请求到的 IM 相关 JSON 响应（含消息ID、精确时间戳等），
 *     随 JSON 导出一并落盘，DOM 漏提取时可作为原始数据兜底。
 *
 * 用法：
 *  1. 浏览器装 Tampermonkey 扩展，把本文件拖入扩展页完成安装（或 F12 控制台整段粘贴运行）。
 *  2. 打开 https://www.douyin.com 登录，点顶部「私信」进入与某人的聊天窗口。
 *  3. 页面右上角出现「抖音导出」面板，确认/修改会话名，点「开始加载历史」。
 *  4. 脚本自动滚动到顶部加载，计数不再增长即完成；再点对应格式按钮导出到本地。
 *
 * 注意：仅可用于备份你本人账号的聊天数据；自动化操作存在被平台风控的可能，频率已刻意调慢。
 */

(function () {
  'use strict';
  if (window.__DY_CHAT_EXPORTER__) return;
  window.__DY_CHAT_EXPORTER__ = true;

  /* ---------------- 状态 ---------------- */
  const state = {
    convName: '',          // 当前会话名（可在面板手动改）
    msgs: new Map(),       // DOM 提取的消息，key -> 消息对象（同 key 覆盖以刷新顺序）
    netMsgs: new Map(),    // 从网络 JSON 中启发式抽到的消息
    raw: [],               // 原始 IM 网络响应
    auto: false,
    timer: null,
    ticks: 0,
    lastNodeCount: 0,
    sameCount: 0,
  };
  const MAX_TICKS = 220;        // 最多约 220*1.3s ≈ 4.8 分钟，防失控
  const SCROLL_INTERVAL = 1300; // 滚动间隔，刻意放慢，降低风控概率
  const MAX_RAW_BYTES = 3 * 1024 * 1024;

  /* ---------------- 通用工具 ---------------- */
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));

  function classText(el) {
    if (!el || !el.className) return '';
    return typeof el.className === 'string' ? el.className : (el.className.baseVal || '');
  }

  function log(msg) {
    const el = $('#dyce-log');
    const line = `[${new Date().toLocaleTimeString()}] ${msg}`;
    if (el) { el.textContent = line; }
    try { console.log('%c[抖音导出]', 'color:#0b8', msg); } catch (e) {}
  }

  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }
  function safeName(s) {
    return (s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim().slice(0, 40) || '未知会话';
  }
  function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escCsv(s) {
    s = String(s == null ? '' : s);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function download(filename, content, mime) {
    const blob = (content instanceof Blob) ? content : new Blob([content], { type: mime || 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  /* ---------------- DOM 定位（多级候选，适应类名变化） ---------------- */
  // 消息节点候选选择器，按命中数量取最多的一组
  const MSG_SELECTORS = [
    '[class*="message-item"]', '[class*="messageItem"]',
    '[class*="chat-message"]', '[class*="chatMessage"]',
    '[class*="msg-item"]', '[class*="bubble-item"]',
  ];

  function msgNodes() {
    let best = [];
    for (const sel of MSG_SELECTORS) {
      const list = $$(sel).filter(el => {
        // 过滤纯容器：至少要有文本或图片/视频
        return (el.innerText || '').trim() || el.querySelector('img,video');
      });
      if (list.length > best.length) best = list;
    }
    return best;
  }

  function findScrollParent(el) {
    let p = el && el.parentElement;
    while (p) {
      const st = getComputedStyle(p);
      if (/(auto|scroll)/.test(st.overflowY) && p.scrollHeight > p.clientHeight + 40) return p;
      p = p.parentElement;
    }
    return null;
  }

  // 判断一条消息是自己发的还是对方发的：类名分词匹配 self/mine/owner 等，位置（右/左）兜底
  function classify(el) {
    const SELF = /(^|[\s_-])(self|mine|owner|from-me|fromme|right)($|[\s_-])/i;
    const OTHER = /(^|[\s_-])(other|peer|friend|received|left|from-other)($|[\s_-])/i;
    let p = el, depth = 0;
    while (p && depth < 7) {
      const c = classText(p);
      if (SELF.test(c)) return 'self';
      if (OTHER.test(c)) return 'other';
      p = p.parentElement;
      depth++;
    }
    // 位置兜底：气泡中心在面板右半边视为自己
    const r = el.getBoundingClientRect();
    const sc = findScrollParent(el);
    const sr = sc ? sc.getBoundingClientRect() : { left: 0, width: window.innerWidth };
    return (r.left + r.right) / 2 > sr.left + sr.width / 2 ? 'self' : 'other';
  }

  // 从面板标题区猜测会话名（启发式，允许用户在面板手动覆盖）
  function detectConvName() {
    const n = msgNodes()[0];
    if (!n) return '';
    let root = n;
    for (let i = 0; i < 6 && root; i++) root = root.parentElement;
    root = root || document.body;
    const heads = $$('[class*="title"],[class*="Title"],[class*="name"],[class*="Name"],header', root);
    const ban = /^(私信|消息|发起聊天|通知消息|粉丝|互动消息|陌生人消息|你的账号|设置|更多)$/;
    for (const h of heads) {
      const tx = (h.innerText || '').trim();
      if (tx && tx.length >= 1 && tx.length <= 16 && !ban.test(tx) && !/[。！？\n]/.test(tx)
        && h.querySelector('img,video,input,textarea,button') === null) {
        return tx;
      }
    }
    return '';
  }

  /* ---------------- DOM 提取 ---------------- */
  function ingest() {
    const nodes = msgNodes();
    if (!nodes.length) { updatePanel(); return 0; }
    const sc = findScrollParent(nodes[0]);

    // 时间分隔条：叶子节点、短文本、像时间
    const timeEls = sc ? $$('*', sc).filter(e =>
      e.children.length === 0 &&
      (e.innerText || '').trim().length <= 24 &&
      /(凌晨|早上|上午|中午|下午|晚上|昨天|今天|\d{1,2}[:：]\d{2}|\d{1,2}月\d{1,2}日|星期[日一二三四五六]|周[日一二三四五六]|20\d{2}\/\d{1,2})/.test((e.innerText || '').trim())
    ) : [];

    let added = 0;
    nodes.forEach((el, idx) => {
      const sender = classify(el);
      const cls = classText(el);
      const rawText = (el.innerText || '').replace(/\u200b/g, '').trim();
      const img = el.querySelector('img');
      const vid = el.querySelector('video');

      let kind = 'text', text = rawText, media = '';
      if (vid) {
        kind = 'video';
        media = vid.src || (vid.querySelector('source') && vid.querySelector('source').src) || '';
        if (!text) text = '[视频]';
      } else if (img && (!rawText || /图片|照片|图片消息/.test(rawText))) {
        kind = 'image';
        media = img.src || '';
        text = rawText || '[图片]';
      } else if (!rawText && img) {
        kind = 'image'; media = img.src; text = '[图片]';
      }
      if (/(^|[\s_-])(system|notice|tip|tips|time|date)($|[\s_-])/i.test(cls) && !img && !vid) {
        kind = 'system';
      }

      // 归属最近的时间分隔条（DOM 中位于该消息之前）
      let time = '';
      for (const te of timeEls) {
        if (te.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) time = (te.innerText || '').trim();
        else break;
      }

      const key = `${sender}|${kind}|${text}|${media ? 'm' : 't'}`;
      if (!state.msgs.has(key)) added++;
      state.msgs.set(key, { sender, time, kind, text, media, domIndex: idx, source: 'dom' });
    });

    if (!state.convName) {
      const guess = detectConvName();
      if (guess) { state.convName = guess; const inp = $('#dyce-name'); if (inp && !inp.value) inp.value = guess; }
    }
    updatePanel();
    return added;
  }

  function domMessagesSorted() {
    return Array.from(state.msgs.values()).sort((a, b) => a.domIndex - b.domIndex);
  }

  /* ---------------- 网络被动捕获 ---------------- */
  const IM_URL_RE = /\/im\b|im_|message|conversation|\/chat|chat_/i;

  // 从结构未知的 IM JSON 对象里尽力找出消息文本字段
  function pickText(o) {
    if (typeof o.text === 'string') return o.text;
    if (o.content && typeof o.content === 'object') {
      if (typeof o.content.text === 'string') return o.content.text;
      if (typeof o.content.default_text === 'string') return o.content.default_text;
    } else if (typeof o.content === 'string') {
      return o.content;
    }
    if (typeof o.msg_content === 'string') return o.msg_content;
    if (typeof o.message === 'string') return o.message;
    return null;
  }

  function harvestJson(o, depth, url) {
    if (!o || depth > 9 || typeof o !== 'object') return;
    if (Array.isArray(o)) { for (const x of o) harvestJson(x, depth + 1, url); return; }
    const keys = Object.keys(o);
    const textVal = pickText(o);
    const hasText = textVal !== null && textVal.length > 0 && textVal.length < 5000;
    const hasSenderHint = ['sender', 'from', 'from_user', 'user', 'is_self', 'self', 'from_me', 'direction', 'conversation_id', 'conv_id', 'sender_type', 'msg_type'].some(k => k in o);
    if (hasText && hasSenderHint) {
      const selfFlag = o.is_self === true || o.is_self === 1 || o.self === true || o.from_me === true
        || o.direction === 1 || o.direction === 'right'
        || (o.sender_type === 0) || (o.senderType === 0);
      const key = `net|${selfFlag ? 'self' : 'other'}|${textVal}`;
      if (!state.netMsgs.has(key)) {
        state.netMsgs.set(key, {
          sender: selfFlag ? 'self' : 'other',
          time: o.create_time || o.created_at || o.timestamp || o.send_time || '',
          kind: typeof textVal === 'string' && /^https?:\/\//.test(textVal) ? 'media' : 'text',
          text: String(textVal), media: '', source: 'network',
        });
      }
    }
    for (const k of keys) {
      const v = o[k];
      if (v && typeof v === 'object') harvestJson(v, depth + 1, url);
    }
  }

  function maybeSave(url, text) {
    try {
      if (!url || !IM_URL_RE.test(url)) return;
      if (!text || text.length > MAX_RAW_BYTES) return;
      let json = null;
      try { json = JSON.parse(text); } catch (e) { return; }
      state.raw.push({ url: String(url).split('?')[0], capturedAt: new Date().toISOString(), data: json });
      if (state.raw.length > 200) state.raw.shift();
      harvestJson(json, 0, url);
      updatePanel();
    } catch (e) {}
  }

  function installNetworkHooks() {
    // fetch
    const _fetch = window.fetch;
    if (typeof _fetch === 'function') {
      window.fetch = function () {
        const args = arguments;
        return _fetch.apply(this, args).then(resp => {
          try {
            const url = String((args[0] && args[0].url) || args[0] || '');
            const ct = resp.headers && resp.headers.get('content-type') || '';
            if (/json|text/i.test(ct)) resp.clone().text().then(tx => maybeSave(url, tx)).catch(() => {});
          } catch (e) {}
          return resp;
        });
      };
    }
    // XHR
    const XHR = window.XMLHttpRequest;
    if (XHR && XHR.prototype) {
      const _open = XHR.prototype.open, _send = XHR.prototype.send;
      XHR.prototype.open = function (m, u) { this.__dyceUrl = u; return _open.apply(this, arguments); };
      XHR.prototype.send = function () {
        this.addEventListener('load', () => {
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              maybeSave(String(this.__dyceUrl || ''), this.responseText);
            }
          } catch (e) {}
        });
        return _send.apply(this, arguments);
      };
    }
    // WebSocket（必须在 document-start 安装才能包住页面自己的连接）
    const NativeWS = window.WebSocket;
    if (NativeWS) {
      function PatchedWS(url, protocols) {
        const ws = protocols ? new NativeWS(url, protocols) : new NativeWS(url);
        ws.addEventListener('message', ev => {
          try {
            if (typeof ev.data === 'string' && ev.data.length < MAX_RAW_BYTES && /msg|message|conv|chat/i.test(ev.data)) {
              maybeSave('wss://' + url, ev.data);
            }
          } catch (e) {}
        });
        return ws;
      }
      PatchedWS.prototype = NativeWS.prototype;
      PatchedWS.CONNECTING = NativeWS.CONNECTING;
      PatchedWS.OPEN = NativeWS.OPEN;
      PatchedWS.CLOSING = NativeWS.CLOSING;
      PatchedWS.CLOSED = NativeWS.CLOSED;
      window.WebSocket = PatchedWS;
    }
  }

  /* ---------------- 自动滚动加载 ---------------- */
  function scrollTick() {
    state.ticks++;
    const nodes = msgNodes();
    const count = nodes.length;
    ingest();

    const sc = nodes.length ? findScrollParent(nodes[0]) : document.scrollingElement;
    if (count !== state.lastNodeCount) {
      state.lastNodeCount = count;
      state.sameCount = 0;
    } else {
      state.sameCount++;
    }

    if (sc) {
      const before = sc.scrollTop;
      sc.scrollTop = 0;
      if (typeof sc.scrollTo === 'function') sc.scrollTo({ top: 0 });
      // 已在顶部且计数连续 7 次不增长 → 加载完
      if (before === 0 && sc.scrollTop === 0 && state.sameCount >= 7) {
        stopAuto(true);
        return;
      }
    }
    if (state.sameCount >= 12) { stopAuto(true); return; }
    if (state.ticks >= MAX_TICKS) { stopAuto(false, true); }
  }

  function startAuto() {
    if (state.auto) return;
    if (!msgNodes().length) {
      log('未检测到消息：请先在网页版抖音打开一个私信会话窗口');
      return;
    }
    state.auto = true;
    state.ticks = 0;
    state.sameCount = 0;
    markRunning(true);
    log('开始加载历史消息，自动滚动到顶部，请勿切换会话…');
    scrollTick();
    state.timer = setInterval(scrollTick, SCROLL_INTERVAL);
  }

  function stopAuto(finished, timeout) {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    state.auto = false;
    markRunning(false);
    ingest();
    if (timeout) log('达到最长加载时间已停止，可再次点「开始」继续加载');
    else if (finished) log(`加载完成，共提取 ${state.msgs.size} 条消息，可点按钮导出`);
    else log('已停止');
  }

  /* ---------------- 导出 ---------------- */
  function baseName(ext) {
    return `抖音私信_${safeName(state.convName || detectConvName())}_${stamp()}.${ext}`;
  }

  function exportJSON() {
    ingest();
    const payload = {
      meta: {
        conversation: state.convName || detectConvName() || '',
        exportedAt: new Date().toISOString(),
        pageUrl: location.href,
        domMessageCount: state.msgs.size,
        networkMessageCount: state.netMsgs.size,
        rawResponseCount: state.raw.length,
        note: 'DOM 提取结果在 messages；网络被动捕获的原始 IM 响应在 rawResponses，可用于找回 DOM 未覆盖的字段',
      },
      messages: domMessagesSorted(),
      networkMessages: Array.from(state.netMsgs.values()),
      rawResponses: state.raw,
    };
    download(baseName('json'), JSON.stringify(payload, null, 2), 'application/json;charset=utf-8');
    log(`已导出 JSON（${state.msgs.size} 条消息 + ${state.raw.length} 个原始响应）`);
  }

  function exportHTML() {
    ingest();
    const msgs = domMessagesSorted();
    let lastTime = '';
    const body = msgs.map(m => {
      let head = '';
      if (m.time && m.time !== lastTime) { head = `<div class="time">${escHtml(m.time)}</div>`; lastTime = m.time; }
      if (m.kind === 'system') return `${head}<div class="sys">${escHtml(m.text)}</div>`;
      const media = m.media
        ? (m.kind === 'video'
          ? `<video src="${escHtml(m.media)}" controls preload="none"></video>`
          : `<a href="${escHtml(m.media)}" target="_blank"><img src="${escHtml(m.media)}" loading="lazy"></a>`)
        : '';
      return `${head}<div class="msg ${m.sender}"><div class="bubble">${media}${escHtml(m.text)}</div></div>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>抖音私信归档 - ${escHtml(state.convName || '')}</title>
<style>
body{font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;background:#f2f3f5;margin:0;padding:16px;color:#1a1b1c;}
.wrap{max-width:760px;margin:0 auto;}
h1{font-size:16px;font-weight:600;text-align:center;margin:8px 0 4px;}
.sub{text-align:center;color:#9aa0a6;font-size:12px;margin-bottom:16px;}
.time{text-align:center;color:#9aa0a6;font-size:12px;margin:16px 0 8px;}
.sys{text-align:center;color:#9aa0a6;font-size:12px;margin:8px 0;}
.msg{display:flex;margin:8px 0;}
.msg.self{justify-content:flex-end;}
.bubble{max-width:72%;padding:9px 12px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:#fff;box-shadow:0 1px 1px rgba(0,0,0,.06);}
.msg.self .bubble{background:#9cc4ff;}
.bubble img,.bubble video{max-width:240px;max-height:320px;border-radius:8px;display:block;margin-bottom:4px;}
</style></head>
<body><div class="wrap">
<h1>${escHtml(state.convName || '抖音私信归档')}</h1>
<div class="sub">共 ${msgs.length} 条 · 导出时间 ${new Date().toLocaleString()}</div>
${body}
</div></body></html>`;
    download(baseName('html'), html, 'text/html;charset=utf-8');
    log(`已导出 HTML（${msgs.size} 条）`);
  }

  function exportTXT() {
    ingest();
    const msgs = domMessagesSorted();
    const lines = msgs.map(m => {
      if (m.kind === 'system') return `\n----- ${m.text} -----\n`;
      const who = m.sender === 'self' ? '我' : '对方';
      const t = m.time ? `[${m.time}] ` : '';
      return `${t}${who}: ${m.text}`;
    });
    const head = `抖音私信备份\n会话：${state.convName || ''}\n导出时间：${new Date().toLocaleString()}\n共 ${msgs.size} 条\n${'='.repeat(40)}\n\n`;
    download(baseName('txt'), head + lines.join('\n'), 'text/plain;charset=utf-8');
    log(`已导出 TXT（${msgs.size} 条）`);
  }

  function exportCSV() {
    ingest();
    const msgs = domMessagesSorted();
    const rows = [['时间', '发送方', '类型', '内容', '媒体链接']];
    msgs.forEach(m => rows.push([
      m.time || '',
      m.sender === 'self' ? '我' : (m.kind === 'system' ? '系统' : '对方'),
      m.kind, m.text, m.media || '',
    ]));
    const csv = '\ufeff' + rows.map(r => r.map(escCsv).join(',')).join('\r\n');
    download(baseName('csv'), csv, 'text/csv;charset=utf-8');
    log(`已导出 CSV（${msgs.size} 条）`);
  }

  function clearAll() {
    if (!confirm('确定清空当前已捕获的全部消息和原始响应？')) return;
    state.msgs.clear();
    state.netMsgs.clear();
    state.raw.length = 0;
    state.lastNodeCount = 0;
    state.sameCount = 0;
    updatePanel();
    log('已清空');
  }

  /* ---------------- 面板 UI ---------------- */
  function updatePanel() {
    const c = $('#dyce-count');
    if (c) c.textContent = `DOM ${state.msgs.size} 条 · 网络 ${state.netMsgs.size} 条 · 原始包 ${state.raw.length}`;
    const inp = $('#dyce-name');
    if (inp && document.activeElement !== inp) {
      const g = state.convName || detectConvName();
      if (g && inp.value !== g) inp.value = g;
    }
  }
  function markRunning(running) {
    const btn = $('#dyce-start');
    if (btn) {
      btn.textContent = running ? '⏳ 加载中…点击停止' : '▶ 开始加载历史';
      btn.style.background = running ? '#e8686a' : '#161823';
    }
  }

  function buildPanel() {
    if ($('#dyce-panel')) return;
    const box = document.createElement('div');
    box.id = 'dyce-panel';
    box.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:248px;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;font-size:13px;color:#1a1b1c;background:#fff;border:1px solid rgba(0,0,0,.12);border-radius:12px;box-shadow:0 4px 18px rgba(0,0,0,.15);overflow:hidden;';
    box.innerHTML = `
      <div id="dyce-head" style="background:#161823;color:#fff;padding:9px 12px;font-weight:600;cursor:move;display:flex;justify-content:space-between;align-items:center;">
        <span>抖音聊天导出</span><span id="dyce-min" style="cursor:pointer;font-size:14px;">—</span>
      </div>
      <div id="dyce-body" style="padding:10px 12px;display:block;">
        <label style="display:block;font-size:11px;color:#6b7280;margin-bottom:3px;">会话名（用于文件名）</label>
        <input id="dyce-name" placeholder="打开私信后自动识别，也可手填" style="width:100%;box-sizing:border-box;padding:6px 8px;border:1px solid #ddd;border-radius:7px;font-size:12px;margin-bottom:8px;">
        <div id="dyce-count" style="font-size:11px;color:#6b7280;margin-bottom:8px;">DOM 0 条 · 网络 0 条 · 原始包 0</div>
        <button id="dyce-start" style="width:100%;padding:9px;border:0;border-radius:8px;background:#161823;color:#fff;font-size:13px;cursor:pointer;margin-bottom:6px;">▶ 开始加载历史</button>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:6px;">
          <button data-act="json" class="dyce-btn">导出 JSON</button>
          <button data-act="html" class="dyce-btn">导出 HTML</button>
          <button data-act="txt" class="dyce-btn">导出 TXT</button>
          <button data-act="csv" class="dyce-btn">导出 CSV</button>
        </div>
        <button id="dyce-clear" style="width:100%;padding:6px;border:1px solid #e0e0e0;border-radius:8px;background:#fafafa;font-size:12px;cursor:pointer;">清空已捕获数据</button>
        <div id="dyce-log" style="margin-top:8px;font-size:11px;color:#6b7280;line-height:1.5;word-break:break-all;">就绪：打开一个私信会话后点「开始」</div>
      </div>`;
      document.documentElement.appendChild(box);

    const style = document.createElement('style');
    style.textContent = '.dyce-btn{padding:7px 0;border:1px solid #d8d8d8;border-radius:8px;background:#fff;font-size:12px;cursor:pointer;}.dyce-btn:hover{background:#f3f4f6;}';
    document.documentElement.appendChild(style);

    $('#dyce-name', box).addEventListener('input', e => { state.convName = e.target.value; });
    const startBtn = $('#dyce-start', box);
    startBtn.addEventListener('click', () => { state.auto ? stopAuto(false) : startAuto(); });
    const acts = { json: exportJSON, html: exportHTML, txt: exportTXT, csv: exportCSV };
    $$('button[data-act]', box).forEach(b => b.addEventListener('click', () => {
      try { acts[b.dataset.act](); } catch (e) { log('导出失败：' + e.message); }
    }));
    $('#dyce-clear', box).addEventListener('click', clearAll);

    // 折叠
    $('#dyce-min', box).addEventListener('click', () => {
      const body = $('#dyce-body', box);
      const hide = body.style.display !== 'none';
      body.style.display = hide ? 'none' : 'block';
      $('#dyce-min', box).textContent = hide ? '+' : '—';
    });

    // 简单拖动
    const head = $('#dyce-head', box);
    head.addEventListener('mousedown', e => {
      const sx = e.clientX, sy = e.clientY, bl = box.offsetLeft, bt = box.offsetTop;
      const move = ev => {
        box.style.left = Math.max(0, bl - (ev.clientX - sx)) + 'px';
        box.style.top = Math.max(0, bt + (ev.clientY - sy)) + 'px';
        box.style.right = 'auto';
      };
      const up = () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });

    // 监听消息区 DOM 变化，自动增量提取（即使没点开始，也能捕获新消息）；250ms 防抖
    let moTimer = null;
    const mo = new MutationObserver(() => {
      clearTimeout(moTimer);
      moTimer = setTimeout(() => { try { ingest(); } catch (e) {} }, 250);
    });
    const observe = () => {
      mo.observe(document.body, { childList: true, subtree: true });
    };
    if (document.body) observe();
    else window.addEventListener('DOMContentLoaded', observe);

    // 每 2.5s 刷新一次计数/会话名
    setInterval(updatePanel, 2500);
  }

  /* ---------------- 启动 ---------------- */
  installNetworkHooks();
  if (document.body) buildPanel();
  else window.addEventListener('DOMContentLoaded', buildPanel);
  // SPA 路由切换后面板仍在；切会话时给出提示
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      log('检测到页面切换，如换了会话请重新点「开始」');
    }
  }, 1000);
})();
