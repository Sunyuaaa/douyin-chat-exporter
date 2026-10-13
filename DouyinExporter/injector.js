/*
 * injector.js — DouyinExporter 在抖音页面加载后注入
 * 接口直连方案（不滚动、不抓 DOM）：
 *   1) conversationStore.conversationMap 枚举会话；IM user/info 批量补昵称头像
 *   2) POST imapi /v1/message/get_by_conversation，shortId+nextTs 翻页拉全量
 *   3) aweType 渲染；图片/自拍视频/语音/表情/分享封面下载；导出 JSON/HTML/TXT/CSV
 *   4) HTML 使用真实时间(f10)、气泡头像、语音总时长，长列表虚拟懒加载
 */
(function () {
  'use strict';
  if (window.__dyce_loaded) return;
  window.__dyce_loaded = true;

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.from((r || document).querySelectorAll(s)); };

  var state = {
    myUid: '',
    mySec: '',
    conversations: [],      // [{id, shortId, bizType, name, avatar, peerSec}]
    selectedIds: [],        // 多选：勾选的会话 id（按点击顺序）
    msgByConv: new Map(),   // convId -> Map(server_id -> msg)，多会话各自独立
    mediaPaths: {},         // key(server_id/..) -> 本地相对路径（exports 内，供 HTML）
    userCache: new Map(),   // sec_uid -> {nickname, avatar, uid}
    avatarPaths: {},        // sec_uid -> 本地头像相对路径
    avatarPathsOwner: {},   // sec_uid -> 该头像文件所在会话名（rel 是相对那个文件夹的，跨会话复用会 404/错图）
    avatarPathsConv: '',    // 当前导出会话（bubbleData 用它判断本地头像 rel 是否有效）
    activeTab: 'all',       // all | private | group
    exportFmts: [],         // 已选导出格式（多选）
    range: 'all',           // 导出时间范围 all | 3m | custom
    dateStart: '', dateEnd: '',
    mediaOpts: { image: 1, video: 1, voice: 1, emoji: 1 },
    recentExports: [],      // 本次运行导出成功的文件（步骤条据此判定「导出」完成）
    asr: false,             // 语音转文字开关（跟随下载媒体执行）
    asrText: {},            // sid -> 转写文本（本会话内存，导出时写入 JSON/HTML）
    asrErrShown: 0,         // 配置缺失/失败提示只弹一次
    reader: { rows: [], filtered: [], key: '', title: '', mediaCache: {}, loaded: false, hiddenN: 0 },
    avatarHintShown: {},     // 每个旧快照只提示一次「重新获取补全头像」
    ts: '9999999999999999',
    hasMore: 1, pages: 0,
    pullDone: {},           // convId -> 是否真的翻到头（中途停止/达到翻页上限的会话不算完成，可继续取）
    schemaSuspect: 0,       // 首页就解析不出消息的会话数（接口字段变更的信号）
    running: false, exportBusy: false, loaded: false
  };

  /* ============ 接口字段表（可被随包的 im-schema.json 覆盖） ============
     抖音改版时只改 im-schema.json（或替换打包同目录的这个文件）就够了，不用重编译。
     这里内置一份同值默认，读不到外部文件也能跑。
     CHECK-START：tools/check_render.js 从这行往后抠代码做离线回归，别删。 */
  var SCHEMA_DEFAULT = {
    version: 'builtin',
    ep: {
      imMessage: 'https://imapi.douyin.com/v1/message/get_by_conversation',
      userInfo: '/aweme/v1/web/im/user/info/?aid=6383&device_platform=webapp&channel=channel_pc_web',
      batchPlayInfo: '/aweme/v1/web/maya/story/batch_play_info/v1/?device_platform=webapp&aid=6383&channel=channel_pc_web&app_name=douyin_web&pc_client_type=1'
    },
    msg: {
      fConvId: 1, fServerId: 3, fTypeCode: 6, fSenderUid: 7, fContentJson: 8,
      fCreatedAtUs: 4, fRealMs: 10, fIsRecalled: 11, fVisible: 12,
      fSenderSecUid: 14, fSeq: 17, fReference: 18
    },
    resp: { fPayload: 6, fBody: 301, fMessage: 1, fNextTs: 2, fHasMore: 3 },
    req: {
      fCmd: 1, fSub: 2, fVer: 3, fToken: 4, fSdk: 5, fRole: 6, fDevice: 7, fBody: 8,
      fSession: 9, fPlatform: 11, fPkg: 14, fRecvMode: 18, fBiz: 21,
      cmd: 301, sub: 10027, ver: '0.1.6', token: '', sdk: 3, role: 0,
      device: 'fef1a80:p/lzg/store', session: '0', platform: 'douyin_pc',
      pkg: '360000', recvMode: 1, biz: 'douyin_pc',
      innerFConvId: 1, innerFDirection: 2, innerFShortId: 3, innerFCount: 4,
      innerFTs: 5, innerFQueryCount: 6, innerDirection: 1, innerCount: 1, queryCount: 50
    },
    awe: {
      text: [0, 700, 701, 703, 712, 720],
      emoji: [500, 501, 507, 508, 510, 514, 516],
      image: [2702, 2703, 2704],
      shop: [11029, 10500, 10401],
      watchTogether: 9000,
      systemFrom: 100000
    },
    share: {
      idFields: ['itemId', 'item_id'],
      nestedIdPath: ['aweme_info', 'item_id'],
      titleFields: ['content_title', 'aweme_title'],
      authorFields: ['content_name'],
      descFields: ['description', 'push_detail']
    }
  };
  function scMerge(base, over) {
    var out = {}, k, g, m;
    for (k in base) {
      out[k] = base[k];
      if (!over || over[k] == null) continue;
      if (Array.isArray(base[k])) {
        if (Array.isArray(over[k]) && over[k].length) out[k] = over[k].slice();
      } else if (typeof base[k] === 'object') {
        m = {};
        for (g in base[k]) m[g] = base[k][g];
        for (g in over[k]) m[g] = over[k][g];
        out[k] = m;
      } else {
        out[k] = over[k];
      }
    }
    return out;
  }
  /* 按字段名候选列表取第一个非空值（新版消息字段名会变，写死一个就瞎一片） */
  function pickField(obj, names, nested) {
    var i, v;
    if (!obj || !names) return '';
    for (i = 0; i < names.length; i++) {
      v = obj[names[i]];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    if (nested && nested.length) {
      var cur = obj;
      for (i = 0; i < nested.length && cur; i++) cur = cur[nested[i]];
      if (cur !== undefined && cur !== null && cur !== '') return cur;
    }
    return '';
  }
  var SC = scMerge(SCHEMA_DEFAULT, window.__DYIN_SCHEMA || {});
  /* 类型表从字段表取（render 只用这几个数组，便于脱离页面单独回归） */
  var TEXT_T = SC.awe.text, EMOJI_T = SC.awe.emoji, IMG_T = SC.awe.image, SHOP_T = SC.awe.shop;

  /* 未识别的 aweType 上报一次（去重），boot.log 里就能直接看到该补哪个类型和哪些字段 */
  var missSeen = {};
  function missReport(awe, cj, how) {
    try {
      var k = awe < 0 ? 'noawe' : String(awe);
      if (missSeen[k]) return;
      missSeen[k] = 1;
      var keys = Object.keys(cj || {}).sort().join(',').slice(0, 260);
      if (typeof logSrv === 'function') {
        logSrv('[schema-miss] aweType=' + k + ' 走' + how + '兜底 keys=[' + keys +
          ']（要补就改 im-schema.json 的 awe 表）');
      }
    } catch (e) {}
  }

  /* ============ protobuf 编解码（已实测） ============ */
  function concatArrays(arrs) {
    var t = 0; for (var i = 0; i < arrs.length; i++) t += arrs[i].length;
    var r = new Uint8Array(t), o = 0;
    for (var j = 0; j < arrs.length; j++) { r.set(arrs[j], o); o += arrs[j].length; }
    return r;
  }
  function ev(value) {
    var b = []; var v = BigInt(value);
    do { var x = Number(v & 0x7Fn); v >>= 7n; if (v > 0n) x |= 0x80; b.push(x); } while (v > 0n);
    if (!b.length) b.push(0);
    return new Uint8Array(b);
  }
  function es(fn, s) { var e = new TextEncoder().encode(s); return concatArrays([ev((fn << 3) | 2), ev(e.length), e]); }
  function evf(fn, v) { return concatArrays([ev((fn << 3) | 0), ev(v)]); }
  function eb(fn, d) { return concatArrays([ev((fn << 3) | 2), ev(d.length), d]); }
  function dvb(buf, pos) {
    var r = 0n, s = 0n;
    while (pos < buf.length) {
      var b = buf[pos++]; r |= BigInt(b & 0x7F) << s;
      if ((b & 0x80) === 0) break; s += 7n;
    }
    return [r, pos];
  }
  function dv(buf, pos) {
    var r = 0, s = 0;
    while (pos < buf.length) {
      var b = buf[pos++]; r |= (b & 0x7F) << s;
      if ((b & 0x80) === 0) break; s += 7; if (s > 35) break;
    }
    return [r, pos];
  }
  function getBytes(buf, tf) {
    var pos = 0;
    while (pos < buf.length) {
      var t0 = dv(buf, pos); var tag = t0[0]; pos = t0[1];
      var fn = tag >> 3, wt = tag & 7;
      if (wt === 0) { var v0 = dvb(buf, pos); pos = v0[1]; }
      else if (wt === 2) {
        var l0 = dv(buf, pos); var len = l0[0]; pos = l0[1];
        if (fn === tf) return buf.slice(pos, pos + len);
        pos += len;
      } else if (wt === 1) pos += 8;
      else if (wt === 5) pos += 4;
      else break;
    }
    return null;
  }
  function buildRequest(convId, shortId, ts) {
    var R = SC.req;
    var inner = concatArrays([
      es(R.innerFConvId, convId), evf(R.innerFDirection, R.innerDirection),
      evf(R.innerFShortId, shortId), evf(R.innerFCount, R.innerCount),
      evf(R.innerFTs, ts), evf(R.innerFQueryCount, R.queryCount)]);
    return concatArrays([
      evf(R.fCmd, R.cmd), evf(R.fSub, R.sub), es(R.fVer, R.ver), es(R.fToken, R.token),
      evf(R.fSdk, R.sdk), evf(R.fRole, R.role), es(R.fDevice, R.device),
      eb(R.fBody, eb(R.cmd, inner)), es(R.fSession, R.session),
      es(R.fPlatform, R.platform), es(R.fPkg, R.pkg),
      evf(R.fRecvMode, R.recvMode), es(R.fBiz, R.biz)
    ]);
  }
  function pp(buf, depth) {
    depth = depth || 0; var f = {}; var pos = 0;
    while (pos < buf.length) {
      var t0 = dv(buf, pos); var tag = t0[0]; pos = t0[1];
      var fn = tag >> 3, wt = tag & 7;
      if (!fn || fn > 200) break;
      if (wt === 0) { var v0 = dvb(buf, pos); f['f' + fn] = v0[0].toString(); pos = v0[1]; }
      else if (wt === 2) {
        var l0 = dv(buf, pos); var len = l0[0]; pos = l0[1];
        if (pos + len > buf.length) break;
        var sl = buf.slice(pos, pos + len);
        var tx = null; try { tx = new TextDecoder('utf-8', { fatal: true }).decode(sl); } catch (e) {}
        if (tx !== null && tx.length < 5000) f['f' + fn] = tx;
        else if (depth < 3 && len > 4) { try { var s2 = pp(sl, depth + 1); if (Object.keys(s2).length) f['f' + fn] = s2; } catch (e) {} }
        pos += len;
      } else if (wt === 1) pos += 8;
      else if (wt === 5) pos += 4;
      else break;
    }
    return f;
  }
  function parseMessage(buf) {
    var M = SC.msg;
    var r = {}; var pos = 0;
    while (pos < buf.length) {
      var t0 = dv(buf, pos); var tag = t0[0]; pos = t0[1];
      var fn = tag >> 3, wt = tag & 7;
      if (!fn || fn > 500) break;
      if (wt === 0) {
        var v0 = dvb(buf, pos); var v = v0[0]; pos = v0[1];
        if (fn === M.fServerId) r.server_id = v.toString();
        else if (fn === M.fCreatedAtUs) r.created_at_us = v.toString();
        else if (fn === M.fRealMs) r.real_ms = Number(v);
        else if (fn === M.fSeq) r.seq = Number(v);
        else if (fn === M.fSenderUid) r.sender_uid = v.toString();
        else if (fn === M.fTypeCode) r.type_code = Number(v);
        else if (fn === M.fIsRecalled) r.is_recalled = Number(v);
        else if (fn === M.fVisible) r.visible = Number(v);
      } else if (wt === 2) {
        var l0 = dv(buf, pos); var len = l0[0]; pos = l0[1];
        var sl = buf.slice(pos, pos + len);
        if (fn === M.fConvId) r.conv_id = new TextDecoder().decode(sl);
        else if (fn === M.fContentJson) { try { r.content_json = new TextDecoder().decode(sl); } catch (e) {} }
        else if (fn === M.fSenderSecUid) { try { r.sender_sec_uid = new TextDecoder().decode(sl); } catch (e) {} }
        else if (fn === M.fReference) {
          try {
            var rp = pp(sl, 0);
            if (rp.f1 && rp.f2) { var rj = JSON.parse(rp.f2); r._ref = { nickname: rj.nickname || '', content: (rj.content || '').slice(0, 60) }; }
          } catch (e) {}
        }
        pos += len;
      } else if (wt === 1) pos += 8;
      else if (wt === 5) pos += 4;
      else break;
    }
    return r;
  }
  function parseResponse(data) {
    var P = SC.resp;
    var f6 = getBytes(data, P.fPayload); if (!f6) return null;
    var f301 = getBytes(f6, P.fBody); if (!f301) return null;
    var pos = 0, msgs = [], nextTs = null, hasMore = 0;
    while (pos < f301.length) {
      var t0 = dv(f301, pos); var tag = t0[0]; pos = t0[1];
      var fn = tag >> 3, wt = tag & 7;
      if (wt === 0) {
        var v0 = dvb(f301, pos); var v = v0[0]; pos = v0[1];
        if (fn === P.fNextTs) nextTs = v.toString();
        if (fn === P.fHasMore) hasMore = Number(v);
      } else if (wt === 2) {
        var l0 = dv(f301, pos); var len = l0[0]; pos = l0[1];
        if (fn === P.fMessage) msgs.push(parseMessage(f301.slice(pos, pos + len)));
        pos += len;
      } else if (wt === 1) pos += 8;
      else if (wt === 5) pos += 4;
      else break;
    }
    return { msgs: msgs, nextTs: nextTs, hasMore: hasMore };
  }
  function fetchPage(convId, shortId, ts) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', SC.ep.imMessage);
      xhr.setRequestHeader('Content-Type', 'application/x-protobuf');
      xhr.setRequestHeader('Accept', 'application/x-protobuf');
      xhr.responseType = 'arraybuffer';
      xhr.withCredentials = true;
      xhr.timeout = 30000;
      xhr.onload = function () { resolve({ status: xhr.status, data: new Uint8Array(xhr.response) }); };
      xhr.onerror = function () { reject(new Error('network')); };
      xhr.ontimeout = function () { reject(new Error('timeout')); };
      xhr.send(buildRequest(convId, BigInt(shortId), BigInt(ts)).buffer);
    });
  }

  /* ============ 用户信息批量解析（昵称 / 头像） ============ */
  var USER_INFO = SC.ep.userInfo;
  /* 页面 fetch 没有超时：接口挂起会让导出流程无限卡住（AbortController 最多等 ms 毫秒） */
  function fetchWithTimeout(url, opts, ms) {
    var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    var timer = null;
    if (ctl) {
      if (!opts) opts = {};
      opts.signal = ctl.signal;
      timer = setTimeout(function () { ctl.abort(); }, ms || 12000);
    }
    return fetch(url, opts).then(function (r) {
      if (timer) clearTimeout(timer);
      return r;
    }, function (e) {
      if (timer) clearTimeout(timer);
      throw e;
    });
  }
  async function fetchUserInfos(secUids) {
    var need = [];
    (secUids || []).forEach(function (s) { if (s && !state.userCache.has(s) && need.indexOf(s) < 0) need.push(s); });
    for (var b = 0; b < need.length; b += 20) {
      var chunk = need.slice(b, b + 20);
      var ok = false;
      try {
        var body = 'sec_user_ids=' + encodeURIComponent(JSON.stringify(chunk));
        var r = await fetchWithTimeout(USER_INFO, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body
        }, 12000);
        var j = await r.json();
        var data = Array.isArray(j.data) ? j.data : [];
        var got = {};
        data.forEach(function (u) {
          var s = u.sec_uid || u.secUid || u.sec_user_id || '';
          if (!s) return;   // 字段名对不上时不缓存，避免全部挤进同一个 key
          got[s] = 1;
          var av = (u.avatar_thumb && u.avatar_thumb.url_list && u.avatar_thumb.url_list[0]) ||
                   (u.avatar_small && u.avatar_small.url_list && u.avatar_small.url_list[0]) || '';
          state.userCache.set(s, {
            nickname: u.nickname || u.unique_id || '',
            remark: u.remark_name || u.remark || u.remarkName || '',
            avatar: av, uid: u.uid || ''
          });
        });
        chunk.forEach(function (s) { if (!got[s]) state.userCache.set(s, { nickname: '', remark: '', avatar: '', uid: '' }); });
        ok = true;
      } catch (e) { ok = false; }
      if (!ok) await new Promise(function (z) { setTimeout(z, 600); });
    }
  }
  function avatarFromUser(u) {
    if (u.avatar_thumb && u.avatar_thumb.url_list && u.avatar_thumb.url_list[0]) return u.avatar_thumb.url_list[0];
    if (u.avatar_small && u.avatar_small.url_list && u.avatar_small.url_list[0]) return u.avatar_small.url_list[0];
    return '';
  }

  /* ============ 工具 ============ */
  // 关键事件/错误上报到 boot.log（对方电脑出问题时可远程分析）
  function logSrv(msg) {
    try {
      var api = window.pywebview && window.pywebview.api;
      if (api && api.log_event) api.log_event('[v' + (window.__DYIN_VERSION || '?') + '] ' + msg);
    } catch (e) {}
  }
  /* 底部那行红字流水已经删掉（进度都在毛玻璃弹窗里，平时它只攒一些没人看的信息）。
     但失败不能因此看不见：带「失败/错误」字样的改成 toast，2 秒内同样的话只提一次。 */
  var lastErrToast = { msg: '', at: 0 };
  function log(msg) {
    var s = String(msg || '');
    if (!/失败|错误|没能|落盘失败|拒绝|不通过/.test(s)) return;
    var now = Date.now();
    if (s === lastErrToast.msg && now - lastErrToast.at < 2000) return;
    lastErrToast = { msg: s, at: now };
    try { showToast(s); } catch (e) {}
  }
  function safeName(s) {
    // 末尾点会被 Windows 建目录时剥离，必须去掉，否则 rel 与磁盘路径不一致
    var t = (s || '').replace(/[\\/:*?"<>|\n\r\t]/g, '_').trim().replace(/\.+$/, '').trim();
    return t.slice(0, 40) || '未知会话';
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
  function stamp() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }
  function browserDownload(name, content, mime) {
    var blob = new Blob([content], { type: mime || 'application/octet-stream' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }
  // safeName 仅用于浏览器下载兜底文件名；落盘路径以 py 端 _safe 为唯一权威
  // （deliver/chunkedDeliver/download_one 都传原始名，由 py 清洗后返回真实 rel）
  function noteSaved(r) {
    log('已保存 ' + r.name + '（' + r.size + ' 字节）');
    try {
      // 只留步骤条判定「导出」要用的信息（概览的最近导出列表已删）
      state.recentExports.unshift({ name: r.name, size: r.size, at: Date.now() });
      if (state.recentExports.length > 8) state.recentExports.pop();
      updateStepChecks();
    } catch (e) {}
  }
  function chunkedDeliver(ext, content, name) {
    var api = window.pywebview.api;
    var CH = 120000;  // 每块 12 万 UTF-16 字符；单块桥参数小，避免大参数把 CLR 弄崩
    var total = Math.max(1, Math.ceil(content.length / CH));
    var sent = 0;
    return api.begin_export(name, ext).then(function (eid) {
      var chain = Promise.resolve();
      for (var i = 0; i < content.length; i += CH) {
        (function (piece) {
          chain = chain.then(function () {
            return api.append_export(eid, piece).then(function (r) {
              // 写盘阶段也给进度：没有分块进度时这一瞬看起来像卡死
              // 只写进度弹窗——弹窗关着时不往底部残留「写入文件 x/y 块」（任务1）
              sent++;
              if (!r || !r.ok) {
                throw new Error('第 ' + sent + '/' + total + ' 块被拒绝：' +
                  ((r && r.error) || '桥没有返回'));
              }
              pmSet('写入文件 ' + sent + '/' + total + ' 块…');
              pmStage(0.9 + 0.1 * (sent / total));
            });
          });
        })(content.slice(i, i + CH));
      }
      return chain.then(function () { return api.finish_export(eid); },
                        function (e) {   // 中途失败也收掉句柄，别在 Python 侧留半截缓冲
                          var stop = function () { throw e; };
                          return api.cancel_export ? api.cancel_export(eid).then(stop, stop) : stop();
                        });
    }).then(function (r) {
      if (r && r.ok && r.size > 0) { noteSaved(r); return r; }
      // size=0 或 ok=false 一律算失败：以前这里放过「假成功」，用户拿到的就是 0 字节文件
      throw new Error((r && r.error) ||
        ('落盘返回异常（已发 ' + sent + '/' + total + ' 块，size=' + (r && r.size) + '）'));
    });
  }
  function deliver(ext, mime, content, name) {
    var fname = '抖音私信_' + safeName(name) + '_' + stamp() + '.' + ext;
    var api = window.pywebview && window.pywebview.api;
    // CSV 的 BOM 由 Python 侧用 utf-8-sig 加；没有 Python（浏览器下载）时才自己补
    var dl = (ext === 'csv' ? '\ufeff' : '') + content;
    if (!api || (!api.begin_export && !api.save_export)) {
      browserDownload(fname, dl, mime); log('浏览器下载：' + fname);
      return Promise.resolve({ ok: true, name: fname, size: content.length, via: 'browser' });
    }
    var oneShot = function (tag) {
      return api.save_export(ext, content, name).then(function (ret) {
        // 只看结构化结果：曾经用「字符串是不是以‘失败’开头」判断，而 Python 返回的是
        // '保存失败：…'，前缀对不上就把失败当成功报给了用户
        if (!ret || ret.ok !== true || !(ret.size > 0)) {
          throw new Error((ret && ret.error) ||
            ('一次性写入未成功：' + JSON.stringify(ret === undefined ? null : ret).slice(0, 140)));
        }
        log('已保存（' + tag + '）：' + (ret.msg || ret.name) + '（' + ret.size + ' 字节）');
        noteSaved(ret);
        return ret;
      });
    };
    var job = api.begin_export ? chunkedDeliver(ext, content, name) : oneShot('一次性写入');
    return job.catch(function (e1) {
      logSrv('分块落盘失败(' + ext + '/' + safeName(name) + ')：' + e1.message + ' → 改一次性写入重试');
      if (!api.save_export) throw e1;
      return oneShot('分块失败后兜底');
    }).catch(function (e2) {
      logSrv('导出落盘最终失败(' + ext + '/' + safeName(name) + ')：' + e2.message + ' → 转浏览器下载');
      browserDownload(fname, dl, mime);
      showToast('✗ ' + ext.toUpperCase() + ' 没能写入文件：' + e2.message + '（已转浏览器下载）');
      return { ok: false, error: e2.message, name: fname, via: 'browser' };
    });
  }

  /* ============ 会话枚举 ============ */
  function peerUid(id) {
    var parts = id.split(':');
    for (var i = 2; i < parts.length; i++) {
      if (parts[i] && parts[i] !== state.myUid) return parts[i];
    }
    return '';
  }
  // 从 conversationMap 直接统计我的 uid：单聊 conv_id 里出现在所有会话中的 uid 就是我
  function detectMyUidFromMap(mp, ids) {
    var cnt = {};
    ids.forEach(function (cid) {
      var c = mp.get(cid);
      if (!c || c.bizType !== 1) return;
      var seen = {};
      cid.split(':').slice(2).forEach(function (p) {
        if (p && !seen[p]) { seen[p] = 1; cnt[p] = (cnt[p] || 0) + 1; }
      });
    });
    var best = '', bn = 0;
    for (var k in cnt) if (cnt[k] > bn) { bn = cnt[k]; best = k; }
    return best;
  }
  async function loadConversations() {
    var cs = window.conversationStore;
    if (!cs || !cs.conversationMap) return [];
    var mp = cs.conversationMap, ids = Array.from(mp.keys());
    if (!state.myUid) state.myUid = detectMyUidFromMap(mp, ids) || detectMyUid();
    if (!state.mySec) state.mySec = mySec();
    // 对方 sec_uid 取 toParticipantSecUserId（CDP 实测：secOwner 是我自己的 sec，不能用）
    var secs = [];
    ids.forEach(function (id) {
      var c = mp.get(id);
      if (c.bizType !== 1) return;
      var s = c.toParticipantSecUserId || '';
      if (s && s !== state.mySec && secs.indexOf(s) < 0) secs.push(s);
    });
    await fetchUserInfos(secs);
    var list = [];
    ids.forEach(function (id) {
      var c = mp.get(id), ci = c.coreInfo || {};
      var name = '', avatar = '', peerSec = '';
      if (c.bizType === 2) {
        name = ci.name || ('群聊 ' + id);
        avatar = ci.icon || '';
      } else {
        var uid = peerUid(id), u = null;
        try { u = uid ? window.userInfoStore.usersInfoMap.get(uid) : null; } catch (e) {}
        peerSec = c.toParticipantSecUserId || '';
        if (peerSec === state.mySec) peerSec = '';
        var info = peerSec ? state.userCache.get(peerSec) : null;
        // 备注只在本地 store（IM 接口不返回 remark）；昵称两个来源都取
        var remark = (u && u.remark_name) || '';
        var nick = (u && (u.nickname || u.unique_id)) || (info && info.nickname) || '';
        name = remark || nick || ('单聊 ' + uid);
        avatar = (u && avatarFromUser(u)) || (info && info.avatar) || '';
      }
      list.push({ id: id, shortId: String(c.shortId || id), bizType: c.bizType,
                  name: name, avatar: avatar, peerSec: peerSec,
                  sortOrder: Number(c.sortOrder || 0) });
    });
    // 按抖音自身的会话排序（sortOrder 降序 = 最新在前，与 App 一致）
    list.sort(function (a, b) { return (b.sortOrder || 0) - (a.sortOrder || 0); });
    return list;
  }
  function detectMyUid() {
    var u = null;
    try {
      var cu = window.userInfoStore.curLoginUserInfo;
      u = cu && (cu.uid || cu.user_id);
    } catch (e) {}
    if (u) return String(u);
    var cnt = {};
    state.conversations.forEach(function (c) {
      if (c.bizType === 1) c.id.split(':').forEach(function (p, i) { if (i >= 2 && p) cnt[p] = (cnt[p] || 0) + 1; });
    });
    var best = '', bn = 0;
    for (var k in cnt) if (cnt[k] > bn) { bn = cnt[k]; best = k; }
    return best;
  }

  /* ============ 消息渲染（aweType / 结构） ============ */
  // 类型表 TEXT_T / EMOJI_T / IMG_T / SHOP_T 来自上面的字段表区块（im-schema.json 可覆盖）
  function inList(v, a) { return a.indexOf(v) >= 0; }
  // 媒体类消息不套气泡底色，直接显示（阅读器与导出 HTML 共用这一份判断）
  // sharevideo 也算：分享卡片自己就是「封面 + 介绍」，再套一层气泡底就成了框中框
  var MEDIA_T = ['image', 'video', 'emoji', 'voice', 'sharevideo'];
  function isMediaKind(k) { return MEDIA_T.indexOf(k) >= 0; }
  function render(cj) {
    if (!cj) return { kind: 'unknown', text: '' };
    var awe = parseInt(cj.aweType, 10); if (isNaN(awe)) awe = -1;
    // 系统提示模板（tips + template）：{{0}} 占位替换成 template 里的文字。
    // 进群/退群通知、火花提醒、陌生人限制等都长这样；残留占位符要清掉。
    if (cj.tips) {
      var tips = cj.tips;
      if (cj.template && cj.template.length) {
        cj.template.forEach(function (tp) {
          if (tp && tp.key !== undefined && tp.key !== null) {
            tips = tips.split('{{' + tp.key + '}}').join(tp.name || '');
          }
        });
      }
      tips = tips.replace(/\{\{\d+\}\}/g, '').replace(/[ \t]+/g, ' ').trim();
      return { kind: 'system', text: tips || '系统消息' };
    }
    if (awe === SC.awe.watchTogether) {
      var wt = String(cj.title || '').trim();
      return { kind: 'system', text: ('[一起看视频] ' + wt).trim() };
    }
    if (awe >= SC.awe.systemFrom) {
      // 高位 aweType 的系统消息内容可能在 text / push_detail / description 等不同字段，
      // 逐个兜底（早先只看 text/push_detail，导致大量通知显示成「系统消息」）
      var st = cj.text || cj.push_detail || cj.description ||
               cj.display_name || cj.title || cj.hint || '';
      st = String(st).replace(/[ \t]+/g, ' ').trim();
      return { kind: 'system', text: st || '系统消息' };
    }
    var ru = cj.resource_url || {};
    if (ru.url_list && cj.duration && !ru.origin_url_list)
      return { kind: 'voice', text: '[语音 ' + Math.max(1, Math.round(Number(cj.duration) / 1000)) + '秒]', duration: Number(cj.duration) };
    if (inList(awe, IMG_T) || ru.origin_url_list) return { kind: 'image', text: '[图片]' };
    if (cj.video && cj.video.tkey) return { kind: 'video', text: '[视频]' };
    // 分享卡片有两种结构：老的是驼峰 itemId + content_title/content_name；
    // 新的是蛇形 item_id + description（形如「[分享视频]正文…」）+ aweme_info.item_id。
    // 只认第一种会让新版分享退化成 other（本机实测 192 条）。评论/商品分享仍由后面的 SHOP_T 处理。
    var shId = String(pickField(cj, SC.share.idFields, SC.share.nestedIdPath) || '');
    if (shId && !inList(awe, SHOP_T) && !cj.comment &&
        (cj.cover_url || pickField(cj, SC.share.titleFields) || pickField(cj, SC.share.descFields))) {
      var cu = cj.cover_url || {};
      var cover = (cu.url_list && cu.url_list[0]) || '';
      var tt = String(pickField(cj, SC.share.titleFields) || '');
      var tag = '[分享视频] ';
      if (!tt) {
        // description 的前缀有三种写法：「[分享视频]正文」「分享[图文]正文」「分享商品:正文」，
        // 正文里常带换行，所以尾部用 [\s\S]* 而不是 .*
        var dsc = String(pickField(cj, SC.share.descFields) || '');
        var mB = dsc.match(/^\s*(\[([^\]]{1,10})\]|分享\s*\[([^\]]{1,10})\]|分享([^\n:：]{1,10})[:：])\s*([\s\S]*)$/);
        if (mB) {
          var inn = mB[2] || mB[3] || mB[4] || '分享';
          if (mB[4] || inn.indexOf('分享') !== 0) inn = '分享' + inn;
          tag = '[' + inn + '] ';
          tt = (mB[5] || '').trim();
        } else { tag = '[分享] '; tt = dsc.trim(); }
      }
      var au = String(pickField(cj, SC.share.authorFields) || '');
      return {
        kind: 'sharevideo', text: tag + (tt || '（无标题）') + (au ? ' @' + au : ''),
        share: {
          itemId: shId, title: tt || '（无标题）', author: au,
          cover: cover, link: 'https://www.douyin.com/video/' + shId
        }
      };
    }
    if (inList(awe, EMOJI_T) || (cj.url && cj.url.url_list)) {
      var eu2 = (cj.url && cj.url.url_list && cj.url.url_list[0]) || '';
      return { kind: 'emoji', text: '[表情]', emojiUrl: eu2, imageType: cj.image_type || 'gif',
        emojiType: cj.emoji_type || '' };
    }
    if (inList(awe, TEXT_T)) return { kind: 'text', text: cj.text || '' };
    if (inList(awe, SHOP_T)) {
      var t = cj.aweme_title || cj.comment || '';
      if (cj.comment) t = '分享评论 @' + (cj.comment_user_name || '') + '：' + cj.comment + (cj.aweme_title ? '（' + cj.aweme_title + '）' : '');
      return { kind: 'share', text: '[分享] ' + t };
    }
    // 打招呼 / 首条互动卡片：没有 aweType，只有 hello_text / hint_text / nickname / stickers
    // greeting 标记给下游：界面与 HTML/TXT/CSV 里默认不显示（JSON 仍然保留）
    if (cj.hello_text || cj.hint_text) {
      var hl = [cj.hello_text, cj.hint_text].filter(Boolean).join(' · ');
      return { kind: 'other', greeting: true,
               text: '[打招呼卡片] ' + (cj.nickname ? cj.nickname + '：' : '') + hl };
    }
    var fb = cj.text || cj.description || cj.push_detail || cj.display_name || cj.content_name;
    if (fb) { missReport(awe, cj, '文本'); return { kind: 'other', text: String(fb) }; }
    // content_json 里没有任何可展示字段：实测是空内容 / 非 JSON（撤回、客户端专有卡片），正文确实取不到。
    // 连 aweType 都没有 → blank（默认不显示）；有 aweType 但没认出来 → 仍然显示出来，方便发现新类型。
    missReport(awe, cj, '空内容');
    return { kind: 'other', blank: awe < 0,
             text: awe < 0 ? '[无内容 · 无法解析（可能已撤回或为该客户端专有卡片）]'
                           : '[未支持的消息类型 ' + awe + ']' };
  }
  /* 表情包合集的去重判据（放在 CHECK 段里，tools/check_render.js 会拿真实地址回归它）。
     同一个表情反复发是常态，只留一张。判据取 CDN 地址路径的**最后两段**（桶 + 对象 id）：
     同一张表情会从 p3-sign / p26-sign / p5-ex-gddgtc-sign 等不同主机下发，甚至 `url.uri`
     也不一致，用整条去参 URL 或 uri 都会漏（实测 8 个会话里最多一条留 125 张重复图）。
     拿不到地址时退回本地文件名——每行唯一，宁可少并也不要误并成一张。 */
  function emojiKey(r) {
    var u = String((r && r.emojiUrl) || '');
    var path = u.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '').split('?')[0];
    var segs = path.split('/').filter(function (x) { return !!x; })
      // `~tplv-…` 是同一个对象的不同尺寸 / 格式变体，剪掉才算同一张
      .map(function (x) { return x.split('~')[0]; });
    if (segs.length >= 2) return segs.slice(-2).join('/');
    if (segs.length === 1) return segs[0];
    return 'file:' + String((r && r.local) || '');
  }
  /* CHECK-END：上面这一整段（字段表 + protobuf + 工具 + 会话枚举 + render）可脱离页面单独求值 */

  /* ============ 全量拉取（多会话） ============ */
  function convNameOf(id) {
    var s = state.conversations.find(function (c) { return c.id === id; });
    return s ? s.name : '未知会话';
  }
  /* 忙碌态：正在跑任务时禁用其他按钮，并在点击时给出弹窗提示 */
  function busyLabel() {
    if (state.running) return '正在获取聊天数据';
    if (state.exportBusy) return '正在导出';
    return '';
  }
  function setBusy(kind, on) {
    state[kind] = !!on;
    var label = busyLabel();
    // 面板按钮统一处理：忙碌时置灰并拦截点击
    $$('#dyce-app button').forEach(function (b) {
      if (b.closest && b.closest('.rail')) return;          // 左竖栏导航始终可点
      if (b.id === 'dyce-min') return;             // 最小化始终可用
      b.disabled = !!label;
      b.style.opacity = label ? '.45' : '';
      b.style.cursor = label ? 'not-allowed' : 'pointer';
    });
    var btn = $('#dyce-start');
    if (btn) {
      btn.disabled = false;                        // 开始按钮自身要能点（用于停止）
      btn.style.opacity = '';
      btn.style.cursor = 'pointer';
    }
    var ps = $('#pmStop');                         // 进度弹窗里的停止按钮同理必须可点
    if (ps) { ps.disabled = false; ps.style.opacity = ''; ps.style.cursor = 'pointer'; }
    var tip = $('#dyce-busy');
    if (tip) { tip.textContent = label ? (label + '中…请稍候') : ''; }
    // 整块（含上面那条分隔线）只在真的有事做时才出现，平时不留一条空框
    var proc = tip && tip.parentNode;
    if (proc) proc.style.display = label ? '' : 'none';
    // 上面刚统一改过 disabled，重新叠加步骤锁（上步未完成的控件保持禁用）
    updateStepChecks();
  }
  function busyGuard(tag) {
    var label = busyLabel();
    if (!label) return false;
    showToast(label + '中，请等它完成后再' + tag);
    return true;
  }
  /* 步骤未完成的置灰按钮：不再是死禁用，仍可点击，点了用小弹窗提示下一步该做什么
     （showToast 2.2 秒自动消失）。提示文案按当前真实条件即时计算，不依赖 1.5s 轮询刷新的
     DOM 属性——否则刚改变状态的一瞬间会既没提示也没反应。 */
  function lockGuard(el) {
    var key = el && el.getAttribute ? el.getAttribute('data-lock-key') : '';
    if (!key) return false;
    var d = ['range', 'pulled', 'fmt'].map(stepDone);
    var msg = '';
    if (key === 'start' && !d[0]) {
      msg = state.range === 'custom'
        ? '请先在上方填好「自定义」的起止日期，再点「▶ 获取聊天数据」'
        : '请先在左侧勾选要导出的会话，再点「▶ 获取聊天数据」';
    } else if (key === 'fmt' && (!d[0] || !d[1])) {
      msg = d[0] ? '还没有聊天数据：请先点「▶ 获取聊天数据」，完成后这里才可选格式'
                 : '请先定好时间范围并勾选会话、点「▶ 获取聊天数据」，再选导出格式';
    } else if (key === 'export' && (!d[0] || !d[1] || !d[2])) {
      if (!d[1]) msg = '请先勾选会话并点「▶ 获取聊天数据」，拿到消息后才能导出';
      else if (!d[2]) msg = '请先在上方点选要导出的格式（JSON / HTML / TXT / CSV，可多选）';
      else msg = '请先定好时间范围';
    }
    if (!msg) return false;
    showToast(msg); log(msg);
    return true;
  }
  /* 轻量弹窗提示（面板内浮层，2 秒后自动消失） */
  var _toastTimer = null;
  function showToast(msg) {
    var t = $('#dyce-toast');
    if (!t) return;
    t.textContent = msg;
    t.style.display = 'block';
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(function () { t.style.display = 'none'; }, 2200);
  }
  /* ---- 自绘悬浮提示：把浏览器原生气泡（灰底方框，跟这套界面完全不搭）换掉 ----
     做法：hover 时把元素的 title 挪到 data-tip 并删掉 title（原生提示就不会再冒出来），
     用一枚圆角卡片浮层显示。排序按钮、补下载按钮这些运行中改写 title 的地方，
     下次 hover 会重新挪一次，所以不需要每处渲染都手动处理。 */
  var _tipEl = null, _tipFor = null;
  function tipLayer() {
    if (_tipEl && _tipEl.parentNode) return _tipEl;
    var d = document.createElement('div');
    d.className = 'dytip';
    d.hidden = true;
    ($('#dyce-app') || document.body).appendChild(d);
    _tipEl = d;
    return d;
  }
  function tipShow(el, text) {
    var d = tipLayer();
    d.textContent = text;                 // textContent：title 里的内容不会被当成 HTML
    d.hidden = false;
    var r = el.getBoundingClientRect(), vw = window.innerWidth, vh = window.innerHeight;
    var w = d.offsetWidth, h = d.offsetHeight;
    var x = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), Math.max(6, vw - w - 6));
    var y = r.bottom + 8;                 // 默认贴在元素下方，放不下就翻到上方
    if (y + h > vh - 6) y = Math.max(6, r.top - h - 8);
    d.style.left = x + 'px';
    d.style.top = y + 'px';
    _tipFor = el;
  }
  function tipHide() {
    if (_tipEl) _tipEl.hidden = true;
    _tipFor = null;
  }
  function tipOver(e) {
    var app = $('#dyce-app');
    var el = e.target && e.target.closest ? e.target.closest('[title],[data-tip]') : null;
    if (!app || !el || !app.contains(el)) { tipHide(); return; }
    var t = '';
    if (el.hasAttribute('title')) {
      t = el.getAttribute('title') || '';
      el.setAttribute('data-tip', t);
      el.removeAttribute('title');        // 挪走原生气泡的唯一办法
    } else t = el.getAttribute('data-tip') || '';
    t = String(t).replace(/\s+$/, '');
    if (!t.trim()) { tipHide(); return; }
    tipShow(el, t);
  }
  function tipOut(e) {
    if (!_tipFor) return;
    var to = e.relatedTarget;
    if (to && to.nodeType === 1 && _tipFor.contains(to)) return;   // 移进子元素（svg 图标）不算离开
    tipHide();
  }
  document.addEventListener('mouseover', tipOver, true);
  document.addEventListener('mouseout', tipOut, true);
  document.addEventListener('mousedown', tipHide, true);
  window.addEventListener('scroll', tipHide, true);
  window.addEventListener('blur', tipHide);

  /* 带按钮的对话框：需要用户「知道 + 决定下一步」时用（toast 只能看，不能点） */
  function dlHide() {
    var m = $('#dyce-dlg');
    if (m) m.classList.remove('show');
  }
  function dlShow(title, body, actions) {
    var m = $('#dyce-dlg');
    if (!m) { showToast(title + '：' + String(body).replace(/\n/g, ' ')); return; }
    $('#dlgT').textContent = title;
    $('#dlgB').textContent = body;              // textContent + CSS pre-line：换行照用，不当 HTML
    var f = $('#dlgF');
    f.innerHTML = '';
    (actions || [{ label: '知道了' }]).forEach(function (a) {
      var b = document.createElement('button');
      b.className = 'big' + (a.primary ? ' primary' : '') + (a.danger ? ' danger' : '');
      b.textContent = a.label;
      b.addEventListener('click', function () { dlHide(); if (a.fn) a.fn(); });
      f.appendChild(b);
    });
    m.classList.add('show');
  }
  /* 设置界面内的通知框：成功整框替换（✓ 绿），错误逐条累加进同一个框（✗ 红），
     不再用顶部 toast——toast 会被设置弹层盖住，且多条提示会铺满顶部。 */
  function setNotice(kind, msg) {
    var el = $('#setNotice');
    if (!el) return;
    if (kind === 'clear') { el.textContent = ''; el.className = 'notice'; return; }
    if (kind === 'ok') { el.className = 'notice ok'; el.textContent = '✓ ' + msg; return; }
    el.className = 'notice ' + (kind === 'info' ? 'ok' : 'err');
    var prefix = kind === 'info' ? '· ' : '✗ ';
    var lines = (el.textContent ? el.textContent.split('\n') : []).filter(Boolean);
    lines.push(prefix + msg);
    while (lines.length > 6) lines.shift();
    el.textContent = lines.join('\n');
  }
  /* 测试结果单独一框：通过 = 绿色 ✓，失败 = 红色 ✗，测试中无符号 */
  function setTestResult(kind, msg) {
    var el = $('#setTestResult');
    if (!el) return;
    if (msg == null) { el.textContent = ''; el.className = 'notice'; return; }
    if (kind === 'busy') { el.className = 'notice'; el.textContent = msg; return; }
    el.className = 'notice ' + (kind === 'ok' ? 'ok' : 'err');
    el.textContent = (kind === 'ok' ? '✓ ' : '✗ ') + msg;
  }
  /* 按钮点击类提示：走弹窗（用户看得见），同时记入日志留痕 */
  function tip(msg) { showToast(msg); log(msg); }
  function updateSelText() {
    var el = $('#dyce-sel');
    if (!el) return;
    var picked = state.selectedIds.length;
    // 已获取数据时不再重复说明导出目标（获取了谁就是谁，属默认行为）
    if (pulledSet().length) { el.style.display = 'none'; return; }
    el.style.display = '';
    if (!picked) { el.textContent = '未选择会话（可多选）'; return; }
    var pn = state.selectedIds.map(convNameOf).join('、');
    el.textContent = '待获取 ' + picked + ' 个：' + (pn.length > 40 ? pn.slice(0, 40) + '…' : pn);
  }
  function noteSchemaMiss(name, why) {
    state.schemaSuspect++;
    logSrv('[schema-miss] 会话「' + name + '」' + why +
      ' → 接口字段可能已变更，对照 im-schema.json 的 resp/msg 表检查');
  }
  function oldestUs(byId) {
    // 续取的起点：已有数据里最早那条的时间戳（接口按「早于 ts」往前翻）
    var min = 0;
    byId.forEach(function (m) {
      var v = Number(m.created_at_us || 0);
      if (v > 0 && (!min || v < min)) min = v;
    });
    return min ? String(min) : '';
  }
  async function pullOne(sel, idx, total) {
    // 拉单个会话；进度按「第 idx+1/total 个会话」展示。
    // 已有部分数据（上次被停止 / 达到翻页上限）时**从最早一条继续往前翻**，不重来也不覆盖。
    var had = state.msgByConv.get(sel.id);
    var byId = had ? new Map(had) : new Map();
    var before = byId.size;
    var resume = before > 0 && oldestUs(byId);
    var fromTs = resume ? oldestUs(byId) : '9999999999999999';
    state.ts = fromTs;
    state.hasMore = 1; state.pages = 0;
    var guard = 0, errs = 0;
    while (state.hasMore && state.running && guard < 400) {
      guard++;
      var r;
      try { r = await fetchPage(sel.id, sel.shortId, state.ts); }
      catch (e) {
        errs++;
        if (errs >= 5) { log('「' + sel.name + '」连续网络错误，跳到下一个会话'); break; }
        await new Promise(function (z) { setTimeout(z, 1200); });
        continue;
      }
      if (r.status !== 200) { errs++; await new Promise(function (z) { setTimeout(z, 1000); }); continue; }
      var p = parseResponse(r.data);
      if (state.pages === 0 && !resume && (!p || !p.msgs.length)) {
        // 从头拉且首页就没消息：接口结构变了的概率远大于「这个会话真的一条都没聊过」。
        // 续取时首页空是正常的（已经翻到头），不能误报。
        noteSchemaMiss(sel.name, !p ? '响应解析不出结构（bytes=' + (r.data && r.data.length) + '）'
                                    : '首页 0 条但 hasMore=' + p.hasMore);
      }
      if (!p || !p.msgs.length) { state.hasMore = 0; break; }
      for (var i = 0; i < p.msgs.length; i++) {
        var m = p.msgs[i];
        if (m.server_id) byId.set(m.server_id, m);
      }
      state.hasMore = p.hasMore; state.ts = p.nextTs; state.pages++;
      pmSet('会话 ' + (idx + 1) + '/' + total + '「' + sel.name + '」' + (resume ? '续取 ' : '') +
        '第 ' + state.pages + ' 页');
      pmSub('已累计 ' + byId.size + ' 条' + (before ? '（原有 ' + before + ' 条）' : ''));
      pmBar(Math.min(95, Math.round(((idx + Math.min(0.95, state.pages * 0.03)) / total) * 100)));
      await new Promise(function (z) { setTimeout(z, 35); });
    }
    state.msgByConv.set(sel.id, byId);
    // 只有「接口说没有更多了」且没被中途停止才算取完；停止、连续报错、撞到 400 页上限都留待续取
    state.pullDone[sel.id] = state.hasMore === 0 && state.running;
    return byId.size - before;
  }

  /* ============ 媒体下载 ============ */
  // kind 注册表的单一权威出处：media.py 模块 docstring。
  // 新加一种媒体 = render() 分类 + collectMedia 拼task + media.py 分支 + bubbleBody 渲染，
  // 扩展名集合由 media.EXTENSIONS 权威导出（app.py import）。
  var BATCH_PATH = SC.ep.batchPlayInfo;
  /* 单会话的媒体任务表：collectMedia（导出时按勾选）与阅读器的「补下缺失媒体」共用一份，
     避免两处各写一遍分类判断、以后加一类媒体漏掉一边。opts 传哪种媒体要下。 */
  function mediaTasksFor(cname, msgs, opts) {
    var items = [];
    msgs.forEach(function (m) {
      var c = m.cj;
      if (!c) { try { c = JSON.parse(m.content_json); } catch (e) { return; } }
      if (!c || typeof c !== 'object') return;
      var rd = render(c), sid = m.server_id;
      var ru = c.resource_url || {};
      if (rd.kind === 'image' && opts.image && ru.origin_url_list && ru.skey) {
        items.push({ sid: sid, convName: cname, sub: 'images', kind: 'image_gcm', url: ru.origin_url_list[0], skey: ru.skey });
        return;
      }
      if (rd.kind === 'voice' && opts.voice && ru.url_list) {
        items.push({ sid: sid, convName: cname, sub: 'voice', kind: 'plain', url: ru.url_list[0] });
        return;
      }
      if (rd.kind === 'video' && opts.video && c.video && c.video.tkey && c.video.skey) {
        items.push({ sid: sid, convName: cname, sub: 'videos', kind: 'video_cenc', need: 'batch', tkey: c.video.tkey, skey: c.video.skey });
        var po = c.poster || {};
        if (po.origin_url_list && po.skey)
          items.push({ sid: sid + '_cover', convName: cname, sub: 'videos', kind: 'image_gcm', url: po.origin_url_list[0], skey: po.skey });
        return;
      }
      if (rd.kind === 'emoji' && opts.emoji && rd.emojiUrl) {
        items.push({ sid: sid, convName: cname, sub: 'emoji', kind: 'url', url: rd.emojiUrl });
        return;
      }
      if (rd.kind === 'sharevideo') {
        // 分享视频：不下载视频本体；只存封面 + 标题作者链接（meta）
        var sh = rd.share;
        if (sh.cover)
          items.push({ sid: sid + '_cover', convName: cname, sub: 'shares', kind: 'plain', url: sh.cover, ext: '.jpg' });
        items.push({ sid: sid + '_meta', convName: cname, sub: 'shares', kind: 'share_meta', meta: sh });
      }
    });
    return items;
  }
  var ALL_MEDIA = { image: 1, video: 1, voice: 1, emoji: 1 };
  function collectMedia() {
    // 遍历所有已拉会话，产出最终 task（含 convName，py 端忽略该字段）；不加密项直接直下
    var items = [];
    state.msgByConv.forEach(function (byId, convId) {
      items = items.concat(mediaTasksFor(convNameOf(convId), byId.values(), state.mediaOpts));
    });
    return items;
  }
  async function resolveBatch(items) {
    var uniq = [];
    items.forEach(function (it) { if (it.need === 'batch' && uniq.indexOf(it.tkey) < 0) uniq.push(it.tkey); });
    for (var b = 0; b < uniq.length; b += 10) {
      var keys = uniq.slice(b, b + 10);
      var body = JSON.stringify({ req_infos: keys.map(function (k) { return { item_id: 0, tos_key: k, type: 2 }; }), with_caption: true });
      var j;
      try {
        var r = await fetchWithTimeout(BATCH_PATH, {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: body
        }, 12000);
        j = await r.json();
      } catch (e) { continue; }
      var infos = (j.data && j.data.play_infos) || [];
      keys.forEach(function (k, i) {
        var eu = infos[i] && infos[i].encrypted_url;
        var url = eu && (eu.main_url || eu.backup_url);
        if (url) items.forEach(function (it) { if (it.need === 'batch' && it.tkey === k) it.url = url; });
      });
    }
  }
  function mediaProgSet(t) {
    pmSet(t);                                 // 进度只在弹窗里显示（底部行内进度条已删）
  }

  /* ---- 进度弹窗（获取 / 转写 / 下载媒体 / 写文件 共用）----
     毛玻璃盖住其他内容，任务跑完前只能等待（弹窗不提供收起入口）。 */
  function pmEl() { return $('#dyce-progModal'); }
  function pmOpen() { return !!(pmEl() && pmEl().classList.contains('show')); }
  function pmSet(t) {
    if (!pmOpen()) return false;
    var d = $('#pmDetail'); if (d) d.textContent = t;
    return true;
  }
  function pmSub(t) { if (pmOpen()) { var e = $('#pmSub'); if (e) e.textContent = t || ''; } }
  function pmBar(pct) {
    var v = Math.max(0, Math.min(100, Number(pct) || 0));
    var e = $('#pmBar'); if (e) e.style.width = v + '%';
  }
  /* 新任务开始时把进度条直接归零且不播动画：
     否则会从上一任务的 100% 慢慢缩回来，看起来像"一开始就快满了" */
  function pmBarReset() {
    var e = $('#pmBar');
    if (!e) return;
    e.style.transition = 'none';
    e.style.width = '0%';
    void e.offsetWidth;                        // 强制重排后再恢复过渡
    e.style.transition = '';
  }

  /* 整体进度：转写占 20%，各格式导出占 78%，起步 2%。
     导出部分按「格式数 × 会话数 × 会话内阶段」折算，所以整个过程中进度条都在动
     （以前只有拉取阶段会动，导出时一直停在 0%）。 */
  var plan = { hasAsr: false, asrN: 0, asrDone: 0, fmtN: 1, fmtIdx: 0, convN: 1, convIdx: 0, inConv: 0 };
  function planReset(fmtN, hasAsr) {
    plan = { hasAsr: !!hasAsr, asrN: 0, asrDone: 0, fmtN: Math.max(1, fmtN || 1),
             fmtIdx: 0, convN: 1, convIdx: 0, inConv: 0 };
  }
  function planFrac() {
    var f = 0.02;
    if (plan.hasAsr) f += 0.2 * (plan.asrN ? Math.min(1, plan.asrDone / plan.asrN) : 0);
    var convFrac = (plan.convIdx + Math.min(1, plan.inConv)) / Math.max(1, plan.convN);
    return Math.min(0.995, f + 0.78 * Math.min(1, (plan.fmtIdx + convFrac) / plan.fmtN));
  }
  function pmTick() { pmBar(Math.round(planFrac() * 100)); }
  /* 会话内阶段：0=开始 0.55=媒体下完 0.8=头像/表情好 0.9=开始写 1=写完 */
  function pmStage(v) { plan.inConv = v; pmTick(); }

  var pmCloseTimer = null;
  function progOpen(title, opt) {
    var m = pmEl();
    opt = opt || {};
    if (!m) { mediaProgSet(title); return; }
    clearTimeout(pmCloseTimer);
    m.classList.add('show');
    m.classList.remove('fin');
    var t = $('#pmTitle'); if (t) t.textContent = title;
    pmSet(opt.detail || '准备中…');
    pmSub(opt.sub || '');
    pmBarReset();
    var st = $('#pmStop');
    if (st) { st.hidden = !opt.stop; st.textContent = opt.stopLabel || '停止'; }
    var note = $('#pmNote');
    if (note) note.textContent = opt.note || '完成后会自动关闭，期间请稍候。';
  }
  function progFinish(msg, holdMs) {
    var m = pmEl();
    if (!m || !m.classList.contains('show')) { pmBar(100); return; }
    m.classList.add('fin');
    var t = $('#pmTitle'); if (t) t.textContent = msg || '已完成';
    var st = $('#pmStop'); if (st) st.hidden = true;
    var note = $('#pmNote'); if (note) note.textContent = '文件已写入 exports 目录，弹窗即将自动关闭。';
    pmBar(100);
    clearTimeout(pmCloseTimer);
    pmCloseTimer = setTimeout(progClose, holdMs || 1300);
  }
  function progClose() {
    var m = pmEl();
    if (m) { m.classList.remove('show'); m.classList.remove('fin'); }
  }
  /* ============ 头像 / 表情本地化（导出 HTML 前，按会话） ============ */
  /* 简单并发池：几百个表情逐个串行下载要几分钟，并发后耗时约为 1/并发数 */
  function runPool(items, worker, conc) {
    return new Promise(function (resolve) {
      var idx = 0, active = 0, finished = 0;
      if (!items.length) { resolve([]); return; }
      var out = new Array(items.length);
      function pump() {
        while (active < conc && idx < items.length) {
          (function (i) {
            active++;
            Promise.resolve()
              .then(function () { return worker(items[i], i); })
              .catch(function () {})
              .then(function (r) {
                out[i] = r; active--; finished++;
                if (finished >= items.length) resolve(out);
                else pump();
              });
          })(idx++);
        }
      }
      pump();
    });
  }
  async function ensureAvatars(rows, conv) {
    var canDl = window.pywebview && window.pywebview.api && window.pywebview.api.download_one;
    // 收集所有发送者 + 单聊对方 sec_uid，批量解析 + 下载头像
    var secs = [];
    rows.forEach(function (r) {
      if (r.senderSec && secs.indexOf(r.senderSec) < 0) secs.push(r.senderSec);
    });
    if (conv && conv.bizType === 1 && conv.peerSec && secs.indexOf(conv.peerSec) < 0) secs.push(conv.peerSec);
    if (state.mySec && secs.indexOf(state.mySec) < 0) secs.push(state.mySec);   // 自己的头像也本地化
    await fetchUserInfos(secs);
    if (!canDl) return;
    var cname = conv ? conv.name : '未知会话';
    state.avatarPathsConv = cname;   // 之后 avatarPaths 里的 rel 只对这个会话的文件夹有效
    // 1) 头像：并发 6 路下载 + 进度
    var avTasks = [];
    secs.forEach(function (s) {
      var info = state.userCache.get(s);
      if (!info || !info.avatar) return;
      if (state.avatarPaths[s] && state.avatarPathsOwner[s] === cname) return;
      avTasks.push({ s: s, url: info.avatar });
    });
    if (avTasks.length) {
      var avDone = 0;
      await runPool(avTasks, async function (t) {
        try {
          // 文件名用 sec 哈希：全局唯一，多会话/多次导出不会互相覆盖
          var ret = await window.pywebview.api.download_one(cname,
            { kind: 'url', sub: 'avatars', sid: 'av_' + hashStr(t.s), url: t.url });
          if (ret && ret.ok) {
            state.avatarPaths[t.s] = ret.rel;
            state.avatarPathsOwner[t.s] = cname;
          }
        } catch (e) {}
        avDone++;
        mediaProgSet('下载头像 ' + avDone + '/' + avTasks.length + '…');
      }, 6);
    }
    // 2) 补下载缺失的表情（用户没点「下载媒体」直接导出 HTML 时也能显示）：并发 6 路
    var emojis = rows.filter(function (r) { return r.kind === 'emoji' && !r.local && r.emojiUrl; });
    if (emojis.length) {
      var emDone = 0;
      await runPool(emojis, async function (r) {
        try {
          var ret2 = await window.pywebview.api.download_one(cname,
            { kind: 'url', sub: 'emoji', sid: r.server_id, url: r.emojiUrl });
          if (ret2 && ret2.ok) {
            state.mediaPaths[r.server_id] = ret2.rel;
            r.local = ret2.rel;
          }
        } catch (e) {}
        emDone++;
        mediaProgSet('下载表情 ' + emDone + '/' + emojis.length + '…');
      }, 6);
      mediaProgSet('已补下载表情 ' + emojis.filter(function (r) { return !!r.local; }).length + ' 个');
    }

    // 3) 文本内联小表情（[流泪] 等）：按映射并发下载到本地
    var emap = window.__DYIN_EMOJI_MAP || {};
    var inlineNames = {};
    rows.forEach(function (r) {
      if (typeof r.text === 'string') {
        var ms = r.text.match(/\[[^\[\]]{1,10}\]/g);
        if (ms) ms.forEach(function (t) { if (emap[t]) inlineNames[t] = 1; });
      }
    });
    var inlTasks = Object.keys(inlineNames).filter(function (nm) {
      return !state.mediaPaths['ie_' + hashStr(nm)];
    });
    if (inlTasks.length) {
      var inlDone = 0;
      await runPool(inlTasks, async function (nm) {
        var sid = 'ie_' + hashStr(nm);
        try {
          var ret3 = await window.pywebview.api.download_one(cname,
            { kind: 'url', sub: 'emoji', sid: sid, url: emap[nm] });
          if (ret3 && ret3.ok) { state.mediaPaths[sid] = ret3.rel; inlDone++; }
        } catch (e) {}
      }, 6);
      if (inlDone) mediaProgSet('已本地化 ' + inlDone + ' 种内联表情');
    }
  }

  /* ============ 组装导出行 ============ */
  function buildRows(byId, conv) {
    var rows = [];
    (byId || new Map()).forEach(function (m) {
      var cj = {};
      try { cj = JSON.parse(m.content_json || '{}'); } catch (e) {}
      var rd = render(cj);
      var tms = m.real_ms || (Number(m.created_at_us || 0) / 1000);
      var dt = new Date(tms);
      var mine = (m.sender_uid === state.myUid);
      // 头像：自己固定取自己的；对方按 sender_sec_uid 取，单聊兜底用会话头像
      var lookupSec = mine ? (state.mySec || '') : (m.sender_sec_uid || '');
      var avatarLocal = null;
      if (lookupSec && conv && state.avatarPathsOwner[lookupSec] === conv.name) {
        avatarLocal = state.avatarPaths[lookupSec] || null;
      }
      var avatarUrl = '';
      if (mine) avatarUrl = myAvatarUrl();
      else if (lookupSec) {
        var uinfo = state.userCache.get(lookupSec);
        avatarUrl = (uinfo && uinfo.avatar) || '';
      }
      if (!avatarUrl && !mine && conv && conv.bizType === 1) avatarUrl = conv.avatar || '';
      rows.push({
        server_id: m.server_id, dt: dt, tms: tms,
        time: dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-' + String(dt.getDate()).padStart(2, '0') + ' ' +
          String(dt.getHours()).padStart(2, '0') + ':' + String(dt.getMinutes()).padStart(2, '0') + ':' +
          String(dt.getSeconds()).padStart(2, '0'),
        sender_uid: m.sender_uid || '', senderSec: m.sender_sec_uid || '',
        // 撤回/可见标记：来自消息 protobuf 的 f11/f12，只作诊断（显示上不乱标）
        recalled: Number(m.is_recalled || 0), visible: m.visible === undefined ? null : Number(m.visible),
        mine: mine,
        aweType: cj.aweType, kind: rd.kind, text: rd.text, duration: rd.duration || 0,
        blank: !!rd.blank, greeting: !!rd.greeting,
        share: rd.share || null, emojiUrl: rd.emojiUrl || '', imageType: rd.imageType || '',
        emojiType: rd.emojiType || '',
        ref: m._ref,
        local: state.mediaPaths[m.server_id] || null,
        coverLocal: state.mediaPaths[m.server_id + '_cover'] || null,
        avatarLocal: avatarLocal,
        avatarUrl: avatarUrl,
        asr: state.asrText[m.server_id] || null,
        cj: cj
      });
    });
    rows.sort(function (a, b) {
      if (a.tms !== b.tms) return a.tms - b.tms;
      return String(a.server_id) < String(b.server_id) ? -1 : 1;
    });
    return rows;
  }
  // 已获取数据的会话集合 —— 这才是「要导出谁」的唯一依据
  function pulledSet() { return Array.from(state.msgByConv.keys()); }
  function pulledNames() { return pulledSet().map(convNameOf).join('、'); }
  function hasData() { return state.msgByConv.size > 0; }
  // 消息展示名：我 / 单聊对方 / 群聊按昵称（导出 JSON 与 HTML 阅读器共用）
  function displayForRow(r, conv) {
    if (r.mine) return '我';
    if (conv && conv.bizType === 1) return conv.name;
    var i = r.senderSec ? state.userCache.get(r.senderSec) : null;
    return (i && i.nickname) || ('用户' + String(r.sender_uid || '').slice(-4));
  }
  // 导出时间范围过滤（state.range: all | 3m | custom）
  function filterRange(rows) {
    if (state.range === '3m') {
      var cut = Date.now() - 90 * 86400000;
      return rows.filter(function (r) { return r.tms >= cut; });
    }
    if (state.range === 'custom') {
      var s = state.dateStart ? new Date(state.dateStart + 'T00:00:00').getTime() : 0;
      var e = state.dateEnd ? new Date(state.dateEnd + 'T23:59:59').getTime() : Infinity;
      return rows.filter(function (r) { return r.tms >= s && r.tms <= e; });
    }
    return rows;
  }
  /**
   * 数据校验：以「已获取的数据」为准，不再要求重新勾选。
   * 勾选只决定「下次获取谁」，获取完就自动成为导出目标。
   */
  /* 无内容 / 打招呼卡片：界面与 HTML/TXT/CSV 默认不显示，JSON 快照仍保留全量（留底不失真） */
  function isJunkRow(r) {
    if (!r) return true;
    if (r.blank || r.greeting) return true;
    var t = String(r.text || '').trim();
    // 只有时间没有正文的系统通知（抖音撤回提示、版本更新那类，渲染出的是占位词「系统消息」）
    if (r.kind === 'system') return !t || t === '系统消息';
    // 文字/未识别类但一个字都没有 → 以前会渲染成「[空]」的气泡
    if (r.kind === 'text' || r.kind === 'other' || r.kind === 'unknown') return !t;
    return false;
  }
  function visibleRows(rows) {
    var all = rows || [];
    var keep = all.filter(function (r) { return !isJunkRow(r); });
    return { rows: keep, hidden: all.length - keep.length };
  }
  function guardData() {
    if (hasData()) return true;
    showToast('还没有聊天数据，请先勾选会话并点「获取聊天数据」');
    log('还没有聊天数据，请先勾选会话并点「获取聊天数据」');
    return false;
  }
  /* 从本机 .txt 缓存回填转写表：重启后 state.asrText 是空的，不回填就会
     ① 阅读器显示不出已经转好的文字 ② 再导出一次把 JSON 里的 asr 冲掉 ③ 重复请求已成功条目 */
  function hydrateAsr(names) {
    var api = window.pywebview && window.pywebview.api;
    if (!api || !api.voice_texts) return Promise.resolve(0);
    var list = [], seen = {};
    (names || []).forEach(function (n) { if (n && !seen[n]) { seen[n] = 1; list.push(n); } });
    return list.reduce(function (chain, nm) {
      return chain.then(function (added) {
        return api.voice_texts(nm).then(function (r) {
          if (!r || !r.ok || !r.texts) return added;
          var n = added;
          Object.keys(r.texts).forEach(function (sid) {
            if (!state.asrText[sid]) { state.asrText[sid] = r.texts[sid]; n++; }
          });
          return n;
        }).catch(function () { return added; });
      });
    }, Promise.resolve(0));
  }
  /* 语音转文字：导出流程的独立一步（以前绑在 HTML 上，只勾 JSON/TXT/CSV 就一条都不转）。
     先确保语音文件已下载（download_one 对已有文件直接跳过），再逐条转写；
     结果进 state.asrText，之后 JSON / TXT / CSV / HTML 与阅读器都会带上，且与格式顺序无关。 */
  async function runAsrPass(convIds) {
    var api = window.pywebview && window.pywebview.api;
    if (!api || !api.transcribe_one) { showToast('语音转文字需在软件内运行'); return -1; }
    var jobs = [];
    convIds.forEach(function (cid) {
      var cname = convNameOf(cid);
      var byId = state.msgByConv.get(cid);
      if (!byId) return;
      byId.forEach(function (m) {
        if (state.asrText[m.server_id]) return;          // 本轮已转过
        var c;
        try { c = JSON.parse(m.content_json || '{}'); } catch (e) { return; }
        if (render(c).kind !== 'voice') return;
        var ru = c.resource_url || {};
        if (!ru.url_list || !ru.url_list.length) return;
        jobs.push({ sid: m.server_id, convName: cname, sub: 'voice', kind: 'plain', url: ru.url_list[0] });
      });
    });
    if (!jobs.length) { plan.hasAsr = false; return 0; }
    var cfg = null;
    try { cfg = (await api.get_llm_config()).config; } catch (e) {}
    if (!cfg || !cfg.has_key || !cfg.base_url) {
      plan.hasAsr = false;                  // 不转写了，进度条别留着这 20% 不动
      var tipMsg = '已勾选语音转文字，但模型还没配置：左下齿轮 →「语音转文字模型」填 Base URL 与 API Key';
      showToast(tipMsg); log(tipMsg); logSrv('导出前转写跳过：模型未配置');
      return -1;
    }
    plan.asrN = jobs.length;
    pmTick();
    var done = 0, ok = 0, fail = 0, firstErr = '';
    mediaProgSet('语音转文字 0/' + jobs.length + '…');
    await runPool(jobs, async function (it) {
      try { await api.download_one(it.convName, it); } catch (e) {}   // 没下过的语音先下载
      try {
        var tr = await api.transcribe_one(it.convName, it.sid);
        if (tr && tr.ok) { state.asrText[it.sid] = tr.text; ok++; }
        else { fail++; if (!firstErr) firstErr = (tr && tr.error) || '转写失败'; }
      } catch (e) { fail++; if (!firstErr) firstErr = e.message; }
      done++; plan.asrDone = done; pmTick();
      if (done % 2 === 0 || done >= jobs.length) {
        mediaProgSet('语音转文字 ' + done + '/' + jobs.length +
          '（成功 ' + ok + ' · 失败 ' + fail + '）…');
      }
    }, 2);          // 并发 2：再高容易撞网关限流（429）
    plan.asrDone = plan.asrN; pmTick();
    logSrv('导出前语音转写: 成功' + ok + ' 失败' + fail + ' 共' + jobs.length);
    if (firstErr) {
      var w = '转文字失败 ' + fail + ' 条：' + String(firstErr).slice(0, 70);
      showToast(w); log(w);
      logSrv('导出前转写失败示例: ' + String(firstErr).slice(0, 200) +
        '｜失败的都是没缓存的，下次导出或阅读器「语音转文字」里只补这些');
    }
    return ok;
  }
  async function doExport(ext) {
    if (busyGuard('导出')) return;
    if (!guardData()) return;
    // 勾选了但没「获取」的会话不在导出范围（导出目标=已获取的数据），明确提示避免误解
    var unpulled = state.selectedIds.filter(function (id) { return !state.msgByConv.has(id); });
    if (unpulled.length && pulledSet().length) {
      tip('「' + unpulled.map(convNameOf).join('、') +
        '」还没获取数据，不会被导出；请先点「▶ 获取聊天数据」');
    }
    // 多会话：逐个会话导出，文件名按会话名区分
    var convIds = Array.from(state.msgByConv.keys());
    plan.convN = convIds.length || 1;
    var done = 0, badFiles = [];
    setBusy('exportBusy', true);
    try {
      for (var ci = 0; ci < convIds.length; ci++) {
        plan.convIdx = ci; pmStage(0);
        var conv = state.conversations.find(function (c) { return c.id === convIds[ci]; }) ||
                   { id: convIds[ci], name: '未知会话', bizType: 1, peerSec: '' };
        var rows = buildRows(state.msgByConv.get(convIds[ci]), conv);
        if (!rows.length) continue;
        rows = filterRange(rows);
        if (!rows.length) continue;
        // JSON 留底要全量；HTML/TXT/CSV 只写看得见的（无内容 / 打招呼卡片不显示）
        if (ext !== 'json') {
          var vis = visibleRows(rows);
          if (!vis.rows.length) {
            log('「' + conv.name + '」没有可显示的消息（' + vis.hidden +
              ' 条无内容/卡片已隐藏），跳过 ' + ext.toUpperCase());
            continue;
          }
          rows = vis.rows;
          state.lastHiddenN = vis.hidden;      // HTML 头部要写清「另有 N 条未显示」
        }
        mediaProgSet('正在导出「' + conv.name + '」的 ' + ext.toUpperCase() + '…');
        var res = await exportOne(ext, rows, conv);
        if (res && res.ok === false) badFiles.push(conv.name + '.' + ext);
        // HTML 导出过程会补下载表情/头像——用全量数据重建行并回写 JSON 快照，
        // 否则阅读器的表情包/媒体列表看不到这些刚落盘的文件（注意：不能用 filterRange 后的 rows，避免快照被时间范围截断）
        if (ext === 'html') {
          try {
            var fullRows = buildRows(state.msgByConv.get(convIds[ci]), conv);
            if (fullRows.length) {
              var res2 = await exportOne('json', fullRows, conv);
              if (res2 && res2.ok === false) badFiles.push(conv.name + '.json(快照回写)');
            }
          } catch (e2) { log('快照回写失败：' + e2.message); }
        }
        done++;
      }
      if (badFiles.length) {
        log('✗ ' + ext.toUpperCase() + ' 有文件没写成功：' + badFiles.join('、'));
        logSrv('导出失败明细(' + ext + '): ' + badFiles.join(' | '));
      }
      if (done && !badFiles.length) {
        log('✓ ' + ext.toUpperCase() + ' 导出完成：' + done + ' 个会话');
        showToast('✓ ' + ext.toUpperCase() + ' 导出完成（' + done + ' 个会话），文件在 exports 目录');
        logSrv('导出完成: ' + ext + ' × ' + done + ' 会话');
      } else if (!done) {
        log('没有可导出的消息');
        showToast('没有可导出的消息');
      }
    } finally {
      setBusy('exportBusy', false);
    }
    return badFiles.length;
  }
  async function exportOne(ext, rows, conv) {
    var name = conv.name;
    if (ext !== 'html') pmStage(0.5);        // 纯文本类格式：直接进到"写文件"阶段
    if (ext === 'json') {
      var payload = {
        meta: { conversation: name, conversationId: conv.id, exportedAt: new Date().toISOString(),
                total: rows.length, range: state.range },
        messages: rows.map(function (r) {
          return { time: r.time, sender_uid: r.sender_uid, sender_name: displayForRow(r, conv),
            sender_sec_uid: r.senderSec || '',
            mine: r.mine, kind: r.kind, aweType: r.aweType, text: r.text,
            duration: r.duration || undefined, share: r.share || null, ref: r.ref || null,
            server_id: r.server_id || null,
            recalled: r.recalled || undefined, visible: r.visible,
            blank: r.blank ? true : undefined,
            greeting: r.greeting ? true : undefined,
            local: r.local || null, coverLocal: r.coverLocal || null,
            avatarLocal: r.avatarLocal || null, avatarUrl: r.avatarUrl || '',
            asr: r.asr || undefined,
            content: r.cj };
        })
      };
      return deliver('json', 'application/json;charset=utf-8', JSON.stringify(payload, null, 2), name);
    } else if (ext === 'txt') {
      var lines = rows.map(function (r) {
        var who = r.mine ? '我' : name;
        var rf = r.ref ? '  (回复 ' + (r.ref.nickname || '') + ': ' + r.ref.content + ')' : '';
        var asr = r.asr ? '（转文字：' + r.asr + '）' : '';
        return '[' + r.time + '] ' + who + ': ' + r.text + asr + rf;
      });
      var head = '抖音私信备份\n会话：' + name + '\n导出时间：' + new Date().toLocaleString() + '\n共 ' + rows.length + ' 条\n' + '='.repeat(40) + '\n';
      return deliver('txt', 'text/plain;charset=utf-8', head + lines.join('\n'), name);
    } else if (ext === 'csv') {
      var rr = [['时间', '发送方', '是否本人', '类型', '内容']];
      rows.forEach(function (r) {
        // 语音行的内容列写成「[语音 8秒] 转文字：…」，列数保持不变
        var cell = r.text + (r.asr ? ' 转文字：' + r.asr : '');
        rr.push([r.time, r.sender_uid, r.mine ? '是' : '否', r.kind, cell]);
      });
      // BOM 交给 Python 的 utf-8-sig，避免双重 BOM；浏览器下载路径里 deliver 会补
      return deliver('csv', 'text/csv;charset=utf-8',
        rr.map(function (z) { return z.map(escCsv).join(','); }).join('\r\n'), name);
    } else if (ext === 'html') {
      return exportHtml(rows, conv);
    }
  }

  /* ============ HTML 导出（头像 + 懒加载） ============ */
  function fmtDuration(ms) {
    var s = Math.round(ms / 1000);
    var m = Math.floor(s / 60); s = s % 60;
    return (m ? m + '分' : '') + s + '秒';
  }
  // 文本里的 [内联表情] → <img>（本地文件优先，映射 URL 兜底）
  function inlineEmojiHtml(escapedText) {
    var map = window.__DYIN_EMOJI_MAP || {};
    return escapedText.replace(/\[[^\[\]]{1,10}\]/g, function (token) {
      var url = state.mediaPaths['ie_' + hashStr(token)] || map[token];
      if (!url) return token;
      return '<img class="iemo" loading="lazy" alt="' + escHtml(token) + '" src="' + escHtml(url) + '">';
    });
  }
  function bubbleBody(r) {
    if (r.kind === 'image') {
      if (r.local) return '<img loading="lazy" src="' + escHtml(r.local) + '">';
      return '<span style="color:#888;">[图片]</span>';
    }
    if (r.kind === 'video') {
      if (r.local) return '<video controls preload="none" src="' + escHtml(r.local) + '"></video>';
      return '<span style="color:#888;">[视频]</span>';
    }
    if (r.kind === 'voice') {
      var inner = '<div class="vt" style="font-size:12px;color:#444;margin-bottom:4px;">语音 ' + fmtDuration(r.duration) + '</div>';
      if (r.local) inner += '<audio controls preload="none" src="' + escHtml(r.local) + '"></audio>';
      if (r.asr) inner += '<div class="asrt">' + escHtml(r.asr) + '</div>';
      return inner;
    }
    if (r.kind === 'emoji') {
      var esrc = r.local || r.emojiUrl;
      if (esrc) {
        var fb = (r.local && r.emojiUrl) ? ' onerror="this.onerror=null;this.src=\'' + escHtml(r.emojiUrl) + '\';"' : '';
        return '<img class="emo" loading="lazy" src="' + escHtml(esrc) + '"' + fb + '>';
      }
      return '<span>[表情]</span>';
    }
    if (r.kind === 'sharevideo') {
      var sh = r.share || {};
      var csrc = r.coverLocal || sh.cover;
      var card = '<div class="card svid">';
      // 封面可有可无：加载不出来就把图删掉，只留介绍与链接
      if (csrc) card += '<img loading="lazy" src="' + escHtml(csrc) + '" onerror="this.remove()">';
      card += '<div class="cbody">' +
        '<div class="ctitle">' + escHtml(sh.title || '无标题') + '</div>' +
        '<div class="cauthor">' + escHtml(sh.author || '') + (sh.author ? ' · ' : '') +
        '<a href="' + escHtml(sh.link) + '" target="_blank">▶ 打开视频</a></div>' +
        '</div></div>';
      return card;
    }
    if (r.text) return inlineEmojiHtml(escHtml(r.text));
    return '<span style="color:#aaa;">[空]</span>';
  }
  // 气泡渲染：样式全部走 CSS class，头像/表情 src 由 JS 侧拼，避免重复内联样式撑大文件
  function bubbleData(r, displayName) {
    // 系统提示：居中灰字，无头像无气泡
    if (r.kind === 'system') {
      return { sys: 1, t: r.time, text: r.text };
    }
    var me = r.mine;
    var lookupSec = me ? (state.mySec || mySec()) : r.senderSec;
    // 本地头像 rel 必须属于当前导出的会话文件夹（owner 校验），否则退回远程头像
    var localAv = (lookupSec && state.avatarPathsOwner[lookupSec] === state.avatarPathsConv)
      ? (state.avatarPaths[lookupSec] || '') : '';
    var avSrc = localAv || (me ? myAvatarUrl()
      : (r.senderSec ? ((state.userCache.get(r.senderSec) || {}).avatar || '') : ''));
    return {
      me: me,
      av: avSrc || '',                        // 空串则前端画首字母圆
      ch: (displayName || '?').slice(0, 1),
      t: r.time,
      n: displayName,
      ref: r.ref || null,
      m: isMediaKind(r.kind) ? 1 : 0,         // 媒体类不套气泡底（前端按此加 class）
      body: bubbleBody(r),                    // 已是 HTML 片段（图片/video/audio/卡片）
      text: r.text || ''
    };
  }
  function mySec() {
    // 当前登录用户 sec_uid（curLoginUserInfo 字段为驼峰命名：secUid）
    try {
      var cu = window.userInfoStore.curLoginUserInfo;
      return cu && (cu.sec_uid || cu.secUid) || '';
    } catch (e) { return ''; }
  }
  function myAvatarUrl() {
    // 实测字段是 avatarUrl / avatar300Url（字符串），不是 avatar_thumb.url_list
    try {
      var cu = window.userInfoStore.curLoginUserInfo;
      return (cu && (cu.avatarUrl || cu.avatar300Url)) || '';
    } catch (e) { return ''; }
  }
  // 字符串 hash（base36），用于头像/内联表情的本地文件名（全局唯一防覆盖）
  function hashStr(s) {
    var h = 5381;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return h.toString(36);
  }
  async function exportHtml(rows, conv) {
    var name = conv.name;
    var t0 = Date.now();
    logSrv('HTML开始「' + name + '」' + rows.length + ' 条');
    // 阶段1：自动补齐本会话缺失的媒体（图片/语音/视频/表情/分享封面，尊重步骤1勾选）。
    // 「下载媒体」按钮已移除——导出即下载，下载到什么就导出什么。
    var mediaItems = collectMedia().filter(function (it) { return it.convName === name; });
    if (mediaItems.length) {
      await resolveBatch(mediaItems);
      var md = 0;
      mediaProgSet('「' + name + '」下载媒体 0/' + mediaItems.length + '…');
      await runPool(mediaItems, async function (it) {
        if (it.kind !== 'share_meta' && !it.url) { md++; return; }
        var ret = null;
        try { ret = await window.pywebview.api.download_one(it.convName, it); } catch (e) {}
        if (ret && ret.ok && state.mediaPaths[it.sid] === undefined) state.mediaPaths[it.sid] = ret.rel;
        md++;
        if (md % 3 === 0 || md >= mediaItems.length) {
          mediaProgSet('「' + name + '」下载媒体 ' + md + '/' + mediaItems.length + '…');
        }
      }, 6);
      pmStage(0.55);
      logSrv('HTML媒体补齐 ' + mediaItems.length + ' 项，累计 ' + (Date.now() - t0) + 'ms');
    }
    // 阶段2：媒体落盘后重建行（rows.local/avatarLocal 才能拿到刚下载的文件）
    // 重建会把上一步的隐藏过滤冲掉，所以这里必须再过滤一次，否则「无内容」消息又回到网页里
    if (conv.id && state.msgByConv.has(conv.id)) {
      var fv = visibleRows(filterRange(buildRows(state.msgByConv.get(conv.id), conv)));
      if (fv.rows.length) rows = fv.rows;
      state.lastHiddenN = fv.hidden;
    }
    mediaProgSet('「' + name + '」正在解析并下载头像…');
    await ensureAvatars(rows, conv);
    pmStage(0.8);
    logSrv('HTML头像/表情完成，累计 ' + (Date.now() - t0) + 'ms');
    mediaProgSet('「' + name + '」生成网页…');
    pmStage(0.9);
    var displayFor = function (r) { return displayForRow(r, conv); };
    var bubbles = rows.map(function (r) { return bubbleData(r, displayFor(r)); });
    logSrv('HTML渲染完成 ' + bubbles.length + ' 条，累计 ' + (Date.now() - t0) + 'ms');
    var voiceRows = rows.filter(function (r) { return r.kind === 'voice'; });
    var voiceTotal = 0; voiceRows.forEach(function (r) { voiceTotal += r.duration; });
    var stats = '共 ' + rows.length + ' 条' +
      (voiceRows.length ? ' · 语音 ' + voiceRows.length + ' 条 / 总时长 ' + fmtDuration(voiceTotal) : '') +
      (state.lastHiddenN ? ' · 另有 ' + state.lastHiddenN + ' 条无内容/卡片消息未显示' : '');
    var css =
      'body{background:#f2f3f5;color:#1a1b1c;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;margin:0;padding:20px 12px 60px;}' +
      '#wrap{max-width:760px;margin:0 auto;}' +
      'h1{font-size:17px;font-weight:600;text-align:center;margin:4px 0;}' +
      '.sub{text-align:center;color:#9aa0a6;font-size:12px;margin-bottom:10px;}' +
      // 我发的：绿色（非蓝），微信风格
      '.row{display:flex;gap:8px;margin:12px 0;align-items:flex-start;}' +
      '.row.me{flex-direction:row-reverse;}' +
      '.meta{font-size:11px;color:#8a8a90;margin:0 0 3px;}' +
      '.row.me .meta{text-align:right;}' +
      '.ref{font-size:11px;color:#5b74a8;margin:0 0 3px;}' +
      '.bubble{padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.6;white-space:pre-wrap;word-break:break-word;background:#fff;box-shadow:0 1px 2px rgba(0,0,0,.07);}' +
      '.row.me .bubble{background:#95ec69;box-shadow:0 1px 2px rgba(0,0,0,.07);}' +
      // 图片 / 视频 / 表情 / 语音：直接显示，不要气泡底和留白
      '.bubble.bm,.row.me .bubble.bm{background:transparent;padding:0;box-shadow:none;}' +
      '.body{max-width:70%;display:flex;flex-direction:column;}' +
      '.row.me .body{align-items:flex-end;}' +
      '.row.ta .body{align-items:flex-start;}' +
      // 头像/表情样式集中在这里，避免每条气泡内联重复
      '.av{width:34px;height:34px;border-radius:50%;object-fit:cover;flex:none;background:#eee;}' +
      '.av.ph{background:#d8d8d8;display:flex;align-items:center;justify-content:center;font-size:13px;color:#fff;}' +
      '.iemo{width:22px;height:22px;vertical-align:-5px;display:inline-block;margin:0 1px;}' +
      '.sys{text-align:center;color:#9aa0a6;font-size:12px;margin:14px auto;max-width:70%;line-height:1.6;}' +
      '.bubble img,.bubble video{max-width:230px;border-radius:10px;display:block;}' +
      '.bubble img.emo{width:96px;height:96px;object-fit:contain;}' +
      '.badmedia{font-size:12.5px;color:#9aa0a6;}' +
      '.bubble audio{width:210px;}' +
      '.bubble .asrt{font-size:12.5px;color:#374151;background:#f0f2f5;border-radius:8px;padding:6px 9px;margin-top:6px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}' +
      '#sentinel{height:30px;text-align:center;color:#aaa;font-size:12px;line-height:30px;}' +
      '#tobottom{position:fixed;right:18px;bottom:18px;width:44px;height:44px;border-radius:50%;border:0;background:#161823;color:#fff;font-size:18px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);}' +
      '.card{width:240px;border-radius:10px;overflow:hidden;border:0;background:transparent;}' +
      '.card img{width:240px;max-height:300px;object-fit:cover;display:block;border-radius:10px;}' +
      '.card .cbody{padding:0;}' +
      // 介绍（视频文案）用衬线字体 + 灰色，跟聊天正文一眼分开
      '.card .ctitle{font-size:12.5px;color:#5b6472;line-height:1.55;letter-spacing:.2px;margin-top:5px;' +
      'font-family:Georgia,"Times New Roman","Songti SC","Noto Serif CJK SC",SimSun,serif;}' +
      '.card .cauthor{font-size:11px;color:#888;margin-top:3px;}' +
      '.card a{font-size:11px;color:#3b82f6;word-break:break-all;}' +
      '.card.svid{width:216px;}' +
      '.card.svid img{width:216px;height:122px;max-height:none;}' +
      '.card.svid .ctitle{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;}';
    var head = '<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>抖音私信 - ' + escHtml(name) + '</title><style>' + css + '</style></head><body><div id="wrap">' +
      '<h1>抖音私信 · ' + escHtml(name) + '</h1><div class="sub">' + escHtml(stats) + '<br>导出 ' + escHtml(new Date().toLocaleString()) + '</div>' +
      '<div id="list"></div><div id="sentinel">加载中…</div></div>' +
      '<button id="tobottom" title="跳到最新">↓</button>';
    // 页面渲染脚本：用模板字符串写，避免多层引号转义
    var viewerJs = [
      '(function(){',
      'var B=' + JSON.stringify(bubbles) + ';',
      'var list=document.getElementById("list"),sen=document.getElementById("sentinel");',
      'var PAGE=40,idx=0;',
      'function hhmm(s){var m=String(s).match(/^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}:\\d{2})/);return m?(m[2]+"-"+m[3]+" "+m[4]):s;}',
      'function esc(s){return String(s==null?"":s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}',
      'function build(d){',
      '  if(d.sys)return `<div class="sys">${hhmm(d.t)} · ${esc(d.text)}</div>`;',
      '  var av=d.av?`<img class="av" loading="lazy" src="${esc(d.av)}" onerror="this.style.visibility=\'hidden\'">`',
      '           :`<div class="av ph">${esc(d.ch)}</div>`;',
      '  var rf=d.ref?`<div class="ref">回复 ${esc(d.ref.nickname)}：${esc(d.ref.content)}</div>`:"";',
      '  var body=d.body?d.body:esc(d.text);',
      '  return `<div class="row ${d.me?"me":"ta"}">${av}<div class="body">`',
      '       + `<div class="meta">${hhmm(d.t)} · ${esc(d.n)}</div>${rf}<div class="bubble${d.m?" bm":""}">${body}</div></div></div>`;',
      '}',
      'function appendBatch(){var n=Math.min(PAGE,B.length-idx);if(n<=0){sen.textContent="— 已全部加载 —";return;}',
      'var html="";for(var i=0;i<n;i++)html+=build(B[idx+i]);idx+=n;',
      'list.insertAdjacentHTML("beforeend",html);',
      'if(idx>=B.length){sen.textContent="— 已全部加载（共 "+B.length+" 条）—";}}',
      'appendBatch();',
      // 图片解不出来（HEIC、坏文件、CDN 过期）时浏览器会留一个破图标 + 空框，统一换掉：
      // 卡片里的封面直接删掉，消息本身就是图的换成灰字。error 不冒泡，用捕获阶段监听。
      'list.addEventListener("error",function(e){var t=e.target;',
      '  if(!t||t.tagName!=="IMG")return;',
      '  if(t.closest&&t.closest(".card")){t.remove();return;}',
      '  var s=document.createElement("span");s.className="badmedia";',
      '  s.textContent=t.classList.contains("iemo")?(t.alt||"[表情]"):"图片无法显示";',
      '  t.replaceWith(s);},true);',
      'if("IntersectionObserver" in window){var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting)appendBatch();});},{rootMargin:"900px"});io.observe(sen);}',
      'else{window.addEventListener("scroll",function(){if(sen.getBoundingClientRect().top<window.innerHeight+1000)appendBatch();});}',
      'document.getElementById("tobottom").addEventListener("click",function(){window.scrollTo({top:document.body.scrollHeight,behavior:"smooth"});});',
      '})();'
    ].join('\n');
    var tail = '<script>' + viewerJs + '<\/script></body></html>';
    mediaProgSet('「' + name + '」写入文件…');
    // 必须 await：不等待写盘完成就返回，会让「导出完成」提示先于文件落盘出现，排障日志也会错位
    var res = await deliver('html', 'text/html;charset=utf-8', head + tail, name);
    logSrv('HTML写入完成，总耗时 ' + (Date.now() - t0) + 'ms' +
      (res && res.ok === false ? ' · 落盘失败：' + res.error : ''));
    return res;
  }


  /* ============ 应用外壳 UI（完整版风格） ============ */
  // 设计规格对齐完整版：#f5f6f8 底 / #2f6bff 主色 / 40px 图标竖栏 / 330px 会话列 / 14px 圆角卡片
  // 覆盖层常驻 douyin.com 页面之上（IM 接口必须在该域名上下文里发），登录检测成功后自动全屏显示。
  var SHELL_CSS = `
#dyce-app {
  --bg: #f5f6f8; --bg2: #f2f3f5; --card: #ffffff; --text: #1c1e21;
  --muted: #6b7280; --muted2: #9aa0a6; --line: #e3e5e9;
  --accent: #2f6bff; --accent-soft: #eaf0ff; --hover: #f8f9fb;
  --shadow: 0 1px 2px rgba(16,24,40,.04), 0 8px 24px rgba(16,24,40,.06);
  --shadow-sm: 0 1px 3px rgba(16,24,40,.12);
  --ph: #d8d8d8; --chipbg: #eceef1; --daysep: #e7e9ec;
  --bub: #ffffff; --bub-me: #95ec69; --bub-text: #1a1b1c; --bub-me-text: #12200a;
  --bub-shadow: 0 1px 2px rgba(0,0,0,.07);
  --ref: #5b74a8; --overlay: rgba(16,24,40,.45);
  --inv: #1c1e21; --inv-text: #ffffff;
  --ok-bg: #e8f8ee; --ok-bd: #a7dfb8; --ok-tx: #145c33;
  /* 步骤完成态：浅绿填充 + 深色勾（填充用浅绿，文字仍用深绿保对比度） */
  --ok-fill: #5bc77f; --ok-fill-tx: #0b3d20;
  --err-bg: #fdecec; --err-bd: #f3b4b4; --err-tx: #8f1f1f;
}
#dyce-app.dark {
  --bg: #17181c; --bg2: #121316; --card: #1f2127; --text: #e8eaed;
  --muted: #9aa0a6; --muted2: #7a7f87; --line: #2e3138;
  --accent: #4c8dff; --accent-soft: #22314f; --hover: #26282e;
  --shadow: 0 1px 2px rgba(0,0,0,.35), 0 8px 24px rgba(0,0,0,.4);
  --shadow-sm: 0 1px 3px rgba(0,0,0,.5);
  --ph: #3a3d44; --chipbg: #26282e; --daysep: #2a2d33;
  --bub: #26282e; --bub-me: #95ec69; --bub-text: #e8eaed; --bub-me-text: #12200a;
  --bub-shadow: 0 1px 2px rgba(0,0,0,.3);
  --ref: #8aa7e8; --overlay: rgba(0,0,0,.6);
  --inv: #e8eaed; --inv-text: #17181c;
  --ok-bg: #12271a; --ok-bd: #1f5c36; --ok-tx: #7dd9a0;
  --ok-fill: #3f9e6b; --ok-fill-tx: #08130c;
  --err-bg: #2b1414; --err-bd: #6e2a2a; --err-tx: #f09a9a;
}

#dyce-app { position: fixed; inset: 0; z-index: 2147483645; display: none;
  background: var(--bg); color: var(--text);
  font: 15px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif;
  -webkit-font-smoothing: antialiased; }
#dyce-app.on { display: block; }
#dyce-app * { box-sizing: border-box; }
#dyce-app [hidden] { display: none !important; }
#dyce-app button { font: inherit; cursor: pointer; padding: 0; }
#dyce-app input, #dyce-app select { font: inherit; color: inherit; }
#dyce-app .muted { color: var(--muted); }
#dyce-app .shell { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 8px;
  height: 100%; padding: 16px 18px 20px; }
/* ── 左竖栏 ── */
#dyce-app .rail { position: relative; z-index: 40; display: flex; flex-direction: column; }
#dyce-app .rail .me { position: relative; width: 40px; height: 40px; flex: none; cursor: pointer; }
#dyce-app .rail .me img { width: 40px; height: 40px; border-radius: 50%; object-fit: cover;
  background: var(--accent-soft); display: block; }
#dyce-app .rail .me .fallback { width: 40px; height: 40px; border-radius: 50%;
  background: var(--accent-soft); color: var(--accent); display: flex; align-items: center; justify-content: center;
  font-size: 18px; font-weight: 600; }
#dyce-app .rail .me .dot { position: absolute; right: 1px; bottom: 1px; width: 12px; height: 12px;
  border-radius: 50%; background: #17a34a; border: 2px solid var(--bg); }
#dyce-app .railsteps { display: flex; flex-direction: column; gap: 8px; margin-top: 14px; }
#dyce-app .rail .step { position: relative; width: 40px; height: 40px; border-radius: 11px;
  padding: 0; display: flex; align-items: center; justify-content: center;
  border: 1px solid transparent; background: transparent; color: var(--muted);
  transition: background .15s, color .15s; }
#dyce-app .rail .step svg { width: 20px; height: 20px; flex: none; }
#dyce-app .rail .step:hover { background: var(--accent-soft); color: var(--accent); }
#dyce-app .rail .step.active { background: var(--accent); border-color: var(--accent); color: #fff; }
#dyce-app .rail-sep { height: 1px; background: var(--line); margin: auto 4px 10px; }
/* ── 主区两栏 ── */
#dyce-app .cols { position: relative; display: grid; grid-template-columns: 330px minmax(0, 1fr);
  gap: 8px; min-height: 0; height: 100%; }
#dyce-app .left { position: relative; background: var(--card); border: 1px solid var(--line);
  border-radius: 14px; box-shadow: var(--shadow);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
#dyce-app .left-head { padding: 0 14px 12px; border-bottom: 1px solid var(--line); }
#dyce-app .head-row { display: flex; align-items: center; justify-content: space-between;
  gap: 10px; height: 48px; }
#dyce-app .left-head .title { font-size: 15px; font-weight: 700; }
#dyce-app .head-actions { display: flex; align-items: center; gap: 6px; }
#dyce-app .pill { border: 1px solid var(--line); background: var(--bg); color: var(--text);
  border-radius: 999px; padding: 5px 13px; font-size: 12.5px; font-weight: 600; }
#dyce-app .pill:hover { border-color: var(--accent); color: var(--accent); }
#dyce-app .pill.dark { background: var(--inv); border-color: var(--inv); color: var(--inv-text); }
#dyce-app .pill.dark:hover { opacity: .88; color: var(--inv-text); }
#dyce-app .iconbtn { width: 30px; height: 30px; border-radius: 50%; border: 1px solid var(--line);
  background: var(--card); color: var(--muted); display: flex; align-items: center; justify-content: center; }
#dyce-app .iconbtn:hover { border-color: var(--accent); color: var(--accent); }
#dyce-app .iconbtn svg { width: 15px; height: 15px; }
#dyce-app .text { width: 100%; padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px;
  background: var(--card); font-size: 13.5px; outline: none; }
#dyce-app .text:focus { border-color: var(--accent); }
#dyce-app .hintline { font-size: 12px; color: var(--muted); margin: 2px 0 8px; }
#dyce-app .convseg { display: flex; background: var(--bg); border-radius: 10px; padding: 3px;
  gap: 3px; margin-top: 10px; }
#dyce-app .convseg button { flex: 1; border: none; background: transparent; border-radius: 8px;
  padding: 6px 0; font-size: 13px; font-weight: 600; color: var(--muted); }
#dyce-app .convseg button.on { background: var(--card); color: var(--text);
  box-shadow: var(--shadow-sm); }
#dyce-app #dyce-sel { font-size: 12px; color: var(--accent); margin-top: 8px;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#dyce-app .convs { flex: 1; min-height: 120px; overflow-y: auto; }
#dyce-app .conv { display: grid; grid-template-columns: auto 44px minmax(0,1fr) auto;
  gap: 11px; align-items: center; padding: 9px 14px; border-bottom: 1px solid var(--line); }
#dyce-app .conv:hover { background: var(--hover); }
#dyce-app .conv input[type=checkbox] { width: 16px; height: 16px; flex: none; accent-color: var(--accent); }
#dyce-app .conv .av { width: 44px; height: 44px; border-radius: 50%; object-fit: cover;
  background: var(--accent-soft); flex: none; }
#dyce-app .conv .ph { width: 44px; height: 44px; border-radius: 50%; flex: none; background: var(--ph);
  color: #fff; font-size: 14px; font-weight: 600; display: flex; align-items: center;
  justify-content: center; }
#dyce-app .conv .mid { min-width: 0; }
#dyce-app .conv .name { font-weight: 600; font-size: 14.5px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
#dyce-app .conv .pv { font-size: 12.5px; color: var(--muted); margin-top: 3px; overflow: hidden;
  text-overflow: ellipsis; white-space: nowrap; }
#dyce-app .conv .cnt { font-size: 12px; color: var(--muted); white-space: nowrap; }
/* 底部进度区：行内进度条、两行进度文字、红色流水都删了——进度只在毛玻璃弹窗里，
   失败改走 toast。这里只剩「正在执行」一条，且平时整块隐藏（setBusy 控制显隐）。 */
#dyce-app .proc { display: none; margin-top: 22px; padding-top: 16px;
  border-top: 1px solid var(--line); }
#dyce-app .proc > div { font-size: 12.5px; line-height: 1.55; }
#dyce-app #dyce-busy { color: #d97706; font-weight: 700; }
/* ── 右侧步骤卡片 ── */
#dyce-app .right { min-width: 0; height: 100%; min-height: 0; overflow-y: auto; }
#dyce-app .card { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  padding: 22px; box-shadow: var(--shadow);
  min-height: 100%; }
#dyce-app .card[hidden] { display: none; }
#dyce-app .card h2 { font-size: 17px; margin: 0 0 6px; }
#dyce-app .card .hint { color: var(--muted); font-size: 13px; margin: 0 0 4px; }
#dyce-app .notice { display: none; margin-top: 10px; padding: 9px 12px;
  border-radius: 10px; font-size: 13px; line-height: 1.55; max-height: 132px;
  overflow-y: auto; white-space: pre-wrap; word-break: break-word; }
#dyce-app .notice.ok { display: block; background: var(--ok-bg);
  border: 1px solid var(--ok-bd); color: var(--ok-tx); }
#dyce-app .notice.err { display: block; background: var(--err-bg);
  border: 1px solid var(--err-bd); color: var(--err-tx); }
#dyce-app .lbl { display: flex; align-items: center; gap: 7px; font-size: 13.5px;
  font-weight: 700; margin: 24px 0 10px; }
/* 顶部水平步骤条：一行 4 步，圆圈+连线+下方标签；完成=绿勾，当前=蓝，未开始/锁定=灰 */
#dyce-app .stepbar { display: flex; margin: 10px 0 2px; }
#dyce-app .stp { flex: 1; position: relative; text-align: center; min-width: 0; }
#dyce-app .stp::after { content: ''; position: absolute; top: 11px;
  left: calc(50% + 14px); width: calc(100% - 28px); height: 2px;
  background: var(--line); z-index: 0; }
#dyce-app .stp:last-child::after { display: none; }
#dyce-app .stp i { position: relative; z-index: 1; width: 23px; height: 23px;
  border-radius: 50%; border: 1.5px solid var(--line); background: var(--card);
  color: #fff; font-size: 12px; font-style: normal; font-weight: 700;
  display: inline-flex; align-items: center; justify-content: center; line-height: 1;
  transition: background .15s, border-color .15s, color .15s; }
#dyce-app .stp em { display: block; font-style: normal; font-size: 11px;
  color: var(--muted); margin-top: 5px; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; }
/* 完成：浅绿底 + 深色勾，身后连线一并变浅绿 */
#dyce-app .stp.done i { background: var(--ok-fill); border-color: var(--ok-fill); color: var(--ok-fill-tx); }
#dyce-app .stp.done::after { background: var(--ok-fill); }
#dyce-app .stp.done em { color: var(--ok-tx); font-weight: 600; }
/* 当前步（第一个未完成）：蓝底高亮 */
#dyce-app .stp.cur i { background: var(--accent); border-color: var(--accent); color: var(--card); }
#dyce-app .stp.cur em { color: var(--accent); font-weight: 600; }
/* 锁定步（前置未完成）：整体变灰不可点 */
#dyce-app .stp.lock i { opacity: .4; background: var(--bg); }
#dyce-app .stp.lock em { opacity: .45; }
/* 媒体行 5 列：文本（必选灰）+ 图片/视频/语音/表情（用户可选） */
#dyce-app #mediaSeg { grid-template-columns: repeat(5, minmax(0, 1fr)); }
/* 文本必选项：灰色固定态，不可取消 */
#dyce-app .pick.compact.locked { background: var(--bg); border-color: var(--line);
  opacity: .72; cursor: default; }
#dyce-app .pick.compact.locked input { cursor: default; }
/* 步骤锁/忙碌时的禁用灰 */
#dyce-app button:disabled { opacity: .45; cursor: not-allowed; }
#dyce-app .pick:disabled, #dyce-app .pick button:disabled { opacity: .45; }
#dyce-app .cardgrid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
#dyce-app .pick { position: relative; display: flex; flex-direction: column; text-align: left;
  padding: 15px 16px; border-radius: 12px; border: 1px solid var(--line); background: var(--bg);
  color: var(--text); }
#dyce-app .pick:hover { border-color: var(--accent); }
#dyce-app .pick .t { font-size: 14px; font-weight: 600; }
#dyce-app .pick .d { font-size: 12px; color: var(--muted); line-height: 1.45; margin-top: 2px; }
#dyce-app .pick .ck { position: absolute; right: 13px; top: 13px; width: 19px; height: 19px;
  border-radius: 50%; border: 1.5px solid var(--line); background: var(--card); color: transparent;
  font-size: 11px; text-align: center; line-height: 17px; }
#dyce-app .pick.on { border-color: var(--accent); background: var(--accent-soft); }
#dyce-app .pick.on .ck { background: var(--accent); border-color: var(--accent); color: #fff; }
#dyce-app .pick.compact { flex-direction: row; align-items: center; gap: 9px; padding: 13px 14px; }
#dyce-app .pick.compact input { position: static; margin-left: auto; width: 16px; height: 16px;
  accent-color: var(--accent); }
#dyce-app .pick.compact .t { flex: 1; }
#dyce-app .pick.wide { flex-direction: row; align-items: center; gap: 12px;
  padding: 12px 14px; margin-top: 12px; }
#dyce-app .pick.wide .t { flex: none; }
#dyce-app .pick.wide .d { margin-top: 0; flex: 1; line-height: 1.45; }
#dyce-app .pick.wide input { margin-left: auto; width: 16px; height: 16px;
  accent-color: var(--accent); }
#dyce-app .pick.wide:has(input:checked) { border-color: var(--accent);
  background: var(--accent-soft); }
#dyce-app .pick:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
#dyce-app .seg { display: inline-flex; background: var(--bg); border: 1px solid var(--line);
  border-radius: 10px; padding: 3px; gap: 3px; flex-wrap: wrap; }
#dyce-app .seg button { border: none; background: transparent; padding: 9px 18px;
  border-radius: 9px; font-size: 13.5px; color: var(--text); }
#dyce-app .seg button.on { background: var(--card); box-shadow: var(--shadow); font-weight: 600; color: var(--accent); }
#dyce-app .seg button:hover:not(.on) { background: var(--accent-soft); }
#dyce-app .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
#dyce-app .big { padding: 13px 18px; border-radius: 10px; font-size: 14.5px; font-weight: 600;
  background: var(--card); border: 1px solid var(--line); color: var(--text); }
#dyce-app .big:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
#dyce-app .big.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
#dyce-app .big.primary:hover:not(:disabled) { filter: brightness(1.08); color: #fff; }
#dyce-app .big.running { background: #e8686a; border-color: #e8686a; color: #fff; }
#dyce-app .grow { flex: 1; min-width: 180px; }
/* 时间范围：分段按钮与起止日期同一行，日期块紧跟在分段按钮后面（不再顶到最右） */
#dyce-app .rangegroup { position: relative; display: flex; align-items: center;
  flex-wrap: wrap; gap: 10px; }
#dyce-app .daterange { display: flex; align-items: center; gap: 8px; }
#dyce-app .daterange[hidden] { display: none; }
#dyce-app .daterange .dash { color: var(--accent); font-weight: 700; }
/* 起止日期：蓝底描边，一眼看出这是要填的两格；没填时字轻一点 */
#dyce-app .datefield { border: 1px solid var(--accent); background: var(--accent-soft);
  color: var(--accent); border-radius: 9px; padding: 8px 14px; font: inherit; font-size: 13px;
  font-weight: 700; min-width: 122px; text-align: center; cursor: pointer;
  box-shadow: 0 1px 2px rgba(47,107,255,.14); }
#dyce-app .datefield.empty { font-weight: 600; opacity: .8; }
#dyce-app .datefield:hover { box-shadow: 0 2px 8px rgba(47,107,255,.24); }
#dyce-app .datefield.on { box-shadow: 0 0 0 3px var(--card), 0 0 0 5px var(--accent); }
/* 日历弹层横向位置由 rangeCalOpen 按点开的按钮算，别顶在行尾 */
#dyce-app .range-cal { top: 46px; right: auto; }
/* ── 阅读器侧栏标题上的「数据概览」下拉（概览页已删，只留这三项统计）── */
#dyce-app .rd-head-tools { position: relative; display: inline-flex; align-items: center; gap: 6px; }
#dyce-app .rd-head .msg-tool { width: 26px; height: 26px; border-radius: 8px; }
#dyce-app .rd-head .msg-tool svg { width: 15px; height: 15px; transition: transform .15s; }
#dyce-app .rd-head .msg-tool.on { border-color: var(--accent); color: var(--accent);
  background: var(--accent-soft); }
#dyce-app .rd-head .msg-tool.on svg { transform: rotate(180deg); }
#dyce-app .rd-stats { position: absolute; top: 38px; right: 0; z-index: 50; width: 182px;
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: var(--shadow); padding: 5px; }
#dyce-app .rd-stats[hidden] { display: none; }
#dyce-app .rd-stats .rs { display: flex; align-items: baseline; justify-content: space-between;
  gap: 8px; padding: 7px 8px; }
#dyce-app .rd-stats .rs > span { font-size: 12.5px; color: var(--muted); }
#dyce-app .rd-stats .rs .v { white-space: nowrap; }
#dyce-app .rd-stats .rs b { font-size: 15.5px; font-weight: 700; color: var(--text); }
#dyce-app .rd-stats .rs em { font-size: 11.5px; font-style: normal; color: var(--muted2);
  margin-left: 2px; }
/* 右键媒体 → 单独保存：同一套圆角卡片壳，只一项动作 */
#dyce-app .rd-ctx { position: fixed; z-index: 62; min-width: 150px; background: var(--card);
  border: 1px solid var(--line); border-radius: 12px; padding: 5px;
  box-shadow: var(--shadow), 0 16px 44px rgba(0, 0, 0, .20); }
#dyce-app .rd-ctx[hidden] { display: none; }
#dyce-app .rd-ctx .ci { padding: 8px 10px; border-radius: 8px; font-size: 13px; cursor: pointer;
  color: var(--text); white-space: nowrap; }
#dyce-app .rd-ctx .ci:hover { background: var(--accent-soft); color: var(--accent); }
#dyce-app .rd-ctx .ci.danger { color: #dc2626; }
#dyce-app .rd-ctx .ci.danger:hover { background: #fdecec; color: #b91c1c; }
#dyce-app .dlg-foot .big.danger { color: #dc2626; border-color: #f3b4b4; }
#dyce-app .dlg-foot .big.danger:hover { border-color: #dc2626; color: #b91c1c; }
/* ── 阅读器 ── */
#dyce-app #pane3 { position: absolute; inset: 0; z-index: 6; display: none;
  grid-template-columns: 260px minmax(0, 1fr); gap: 8px; min-height: 0; }
#dyce-app #pane3[hidden] { display: none !important; }
#dyce-app #pane3.show { display: grid; }
/* AI 分析：功能还没做，先给一个占位页（居中一张卡，图标 + 标题 + 一行说明） */
#dyce-app #pane4 { position: absolute; inset: 0; z-index: 6; display: none;
  align-items: center; justify-content: center; }
#dyce-app #pane4[hidden] { display: none !important; }
#dyce-app #pane4.show { display: flex; }
#dyce-app .soon { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: var(--shadow); padding: 34px 46px; text-align: center; }
#dyce-app .soon .soon-ic { display: inline-flex; width: 44px; height: 44px; border-radius: 13px;
  background: var(--accent-soft); color: var(--accent); align-items: center; justify-content: center; }
#dyce-app .soon .soon-ic svg { width: 24px; height: 24px; }
#dyce-app .soon .soon-t { margin-top: 12px; font-size: 16px; font-weight: 700; color: var(--text); }
#dyce-app .soon .soon-s { margin-top: 4px; font-size: 13.5px; color: var(--muted); }
#dyce-app .rd-side { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: var(--shadow);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
#dyce-app .rd-head { padding: 13px 14px 11px; font-size: 15px; font-weight: 700;
  border-bottom: 1px solid var(--line); display: flex; justify-content: space-between;
  align-items: center; gap: 8px; }
#dyce-app .rd-list { flex: 1; overflow-y: auto; min-height: 0; padding: 6px; }
#dyce-app .rd-item { display: flex; align-items: center; gap: 10px;
  padding: 9px 10px; border-radius: 9px; cursor: pointer; margin-bottom: 2px; }
#dyce-app .rd-item:hover { background: var(--bg); }
#dyce-app .rd-item.on { background: var(--accent-soft); }
#dyce-app .rdav { width: 36px; height: 36px; border-radius: 50%; flex: none;
  background-color: var(--accent-soft); background-size: cover; background-position: center; }
#dyce-app .rdav.ph { display: flex; align-items: center; justify-content: center;
  color: var(--accent); font-size: 14px; font-weight: 600; }
#dyce-app .rdinfo { min-width: 0; flex: 1; }
#dyce-app .rd-item .n { font-size: 13.5px; font-weight: 600; display: flex;
  align-items: baseline; gap: 1px; min-width: 0; }
#dyce-app .rd-item .n .nn { overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  min-width: 0; }
/* 第二行：条数 · 占用大小 */
#dyce-app .rd-item .s { font-size: 11.5px; color: var(--muted2); }
/* 置顶的那条直接压深背景，一眼看得出谁被钉住了；正选中的那条仍以选中色为准 */
#dyce-app .rd-item.pin { background: var(--chipbg); }
#dyce-app .rd-item.pin.on { background: var(--accent-soft); }
#dyce-app .rd-item.pin .n { font-weight: 700; }
#dyce-app .rd-main { background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: var(--shadow);
  display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
#dyce-app .rd-toolbar { display: flex; gap: 10px; align-items: center; padding: 12px 16px;
  border-bottom: 1px solid var(--line); flex-wrap: wrap; }
#dyce-app .rd-toolbar .rd-title { font-weight: 700; font-size: 15px; margin-right: auto; }
/* 「媒体还没下载」：名字后面、搜索框前面只留一颗红按钮，明细放鼠标悬停提示 */
#dyce-app .medgap { border: none; background: #dc2626; color: #fff; font-weight: 600;
  font-size: 12.5px; border-radius: 9px; padding: 5px 12px; cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, .18); }
#dyce-app .medgap:hover { background: #b91c1c; color: #fff; }
/* 一条都补不了（链接全过期）时不装作还能点：换成灰色，点了只说明原因 */
#dyce-app .medgap.dead { background: var(--chipbg); color: var(--muted); box-shadow: none; }
#dyce-app .medgap.dead:hover { background: var(--chipbg); color: var(--muted); }
#dyce-app .medgap[hidden] { display: none; }
#dyce-app .rd-toolbar .text { width: auto; flex: 0 1 220px; }
#dyce-app .rd-body { flex: 1; overflow-y: auto; min-height: 0; padding: 16px 18px 40px;
  background: var(--bg2); }
/* 消息区滚动条：强制绘制可见的经典滚动条（WebView2/Win11 默认是滚动时才浮现的覆盖式滚动条） */
#dyce-app .rd-body, #dyce-app .rd-list {
  scrollbar-width: thin;
  scrollbar-color: var(--muted) transparent;
}
#dyce-app .rd-body::-webkit-scrollbar, #dyce-app .rd-list::-webkit-scrollbar { width: 10px; }
#dyce-app .rd-body::-webkit-scrollbar-thumb, #dyce-app .rd-list::-webkit-scrollbar-thumb {
  background: var(--muted); border-radius: 6px;
  border: 2px solid transparent; background-clip: padding-box;
}
#dyce-app .rd-body::-webkit-scrollbar-thumb:hover, #dyce-app .rd-list::-webkit-scrollbar-thumb:hover {
  background: var(--muted2); border: 2px solid transparent; background-clip: padding-box;
}
#dyce-app .rd-body::-webkit-scrollbar-track, #dyce-app .rd-list::-webkit-scrollbar-track {
  background: transparent;
}
/* 双击图片放大（覆盖全屏，点击任意处/按 ESC 关闭） */
#dyce-app .rd-lightbox { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, .88);
  display: flex; align-items: center; justify-content: center; cursor: zoom-out; }
#dyce-app .rd-lightbox[hidden] { display: none; }
#dyce-app .rd-lightbox img { max-width: 92vw; max-height: 92vh; border-radius: 8px;
  box-shadow: 0 8px 40px rgba(0, 0, 0, .5); }
#dyce-app .rd-empty { text-align: center; color: var(--muted2); font-size: 13.5px; margin-top: 60px; }
#dyce-app .daysep { text-align: center; margin: 18px 0 12px; }
#dyce-app .daysep span { background: var(--daysep); color: var(--muted); font-size: 12px;
  padding: 3px 12px; border-radius: 999px; }
#dyce-app .mrow { display: flex; gap: 8px; margin: 12px 0; align-items: flex-start; }
#dyce-app .mrow.me { flex-direction: row-reverse; }
#dyce-app .mrow .body { max-width: 72%; display: flex; flex-direction: column; }
#dyce-app .mrow.me .body { align-items: flex-end; }
#dyce-app .mrow .meta { font-size: 11px; color: var(--muted2); margin: 0 0 3px; }
#dyce-app .mrow.me .meta { text-align: right; }
#dyce-app .mrow .ref { font-size: 11px; color: var(--ref); margin: 0 0 3px; }
#dyce-app .mrow .bub { padding: 9px 13px; border-radius: 14px; font-size: 14px; line-height: 1.6;
  white-space: pre-wrap; word-break: break-word; background: var(--bub);
  color: var(--bub-text); box-shadow: var(--bub-shadow); }
#dyce-app .mrow.me .bub { background: var(--bub-me); color: var(--bub-me-text); }
/* 图片 / 视频 / 表情 / 语音：直接显示，不套气泡底色与内边距（me 侧同样要覆盖） */
#dyce-app .mrow .bub.bub-media, #dyce-app .mrow.me .bub.bub-media {
  background: transparent; padding: 0; box-shadow: none; color: inherit; }
#dyce-app .mrow .rav { width: 34px; height: 34px; border-radius: 50%; flex: none;
  background: var(--ph); color: #fff; font-size: 13px; display: flex; align-items: center;
  justify-content: center; overflow: hidden; position: relative; }
#dyce-app .mrow .rav img { width: 34px; height: 34px; object-fit: cover; display: block; }
#dyce-app .mrow .rav .rav-img { position: absolute; inset: 0; width: 100%; height: 100%; }
#dyce-app .bub .imgph, #dyce-app .bub img.rimg { max-width: 240px; border-radius: 10px; display: block; }
#dyce-app .bub .imgph { min-width: 160px; min-height: 90px; background: var(--chipbg); color: var(--muted2);
  font-size: 12px; display: flex; align-items: center; justify-content: center; cursor: pointer; }
/* 分享卡片的封面占位：只占位不出形——它是「可有可无」的东西，
   没加载出来时不该留下灰块、边框或「加载中」字样（占位还留着 = 出问题了，直接删） */
#dyce-app .bub .imgph.covph { background: none; color: transparent; border: 0; cursor: default; }
#dyce-app .bub img.emo { width: 96px; height: 96px; object-fit: contain; }
/* 图片解不出来时的灰字占位（不留浏览器的破图标和空框） */
#dyce-app .bub .badmedia { font-size: 12.5px; color: var(--muted2); }
#dyce-app .bub .iemo { width: 22px; height: 22px; vertical-align: -5px; display: inline-block;
  margin: 0 1px; }
#dyce-app .bub audio { width: 220px; display: block; }
#dyce-app .mrow .bub .asrt { margin-top: 6px; padding: 6px 9px; border-radius: 8px;
  background: var(--chipbg); color: var(--text); font-size: 12.5px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; }
#dyce-app .bub .vplay { width: 240px; padding: 30px 12px; border: 1px dashed var(--line);
  border-radius: 10px; background: var(--chipbg); color: var(--accent); font-weight: 600; font-size: 13px; }
#dyce-app .bub video { max-width: 260px; border-radius: 10px; display: block; background: #000; }
/* 分享卡片：不套边框底色（跟图片一样直接显示），介绍用衬线字体与聊天正文区分 */
#dyce-app .bub .card { width: 240px; border-radius: 10px; overflow: hidden;
  border: 0; background: transparent; }
#dyce-app .bub .card img { width: 240px; max-height: 300px; object-fit: cover; display: block; }
#dyce-app .bub .card .cb { padding: 0; }
#dyce-app .bub .card .ct { font-size: 12.5px; line-height: 1.55; color: var(--muted);
  font-family: Georgia, "Times New Roman", "Songti SC", "Noto Serif CJK SC", SimSun, serif;
  letter-spacing: .2px; }
#dyce-app .bub .card .ca { font-size: 11px; color: var(--muted2); margin-top: 3px; }
#dyce-app .bub .card a { font-size: 11px; color: var(--accent); word-break: break-all; }
/* 分享视频卡片瘦身：封面 16:9 限高、标题两行截断、链接收成短按钮 */
#dyce-app .bub .card.svid { width: 216px; }
#dyce-app .bub .card.svid img, #dyce-app .bub .card.svid .covph { width: 216px; height: 122px;
  max-height: none; object-fit: cover; border-radius: 10px; }
#dyce-app .bub .card.svid .ct { display: -webkit-box; -webkit-line-clamp: 2;
  -webkit-box-orient: vertical; overflow: hidden; margin-top: 5px; }
#dyce-app .bub .card.svid .ca a { text-decoration: none; font-weight: 600; }
#dyce-app .sysline { text-align: center; color: var(--muted2); font-size: 12px; margin: 14px auto;
  max-width: 70%; line-height: 1.6; }
#dyce-app #rdSentinel { height: 30px; text-align: center; color: var(--muted2); font-size: 12px;
  line-height: 30px; }
/* ── 阅读器工具栏按钮 / 日历 / 图片浏览 / 语音下载 / 会话详情 ── */
#dyce-app .rd-tools { display: flex; gap: 6px; align-items: center; }
#dyce-app .msg-tool-wrap { position: relative; display: inline-flex; }
#dyce-app .msg-tool { width: 32px; height: 32px; border-radius: 9px; border: 1px solid var(--line);
  background: var(--card); color: var(--muted); display: flex; align-items: center;
  justify-content: center; cursor: pointer; padding: 0; }
#dyce-app .msg-tool:hover { border-color: var(--accent); color: var(--accent); }
#dyce-app .msg-tool svg { width: 17px; height: 17px; }
/* 自绘日历（挂在日历按钮下方） */
#dyce-app .msg-cal { position: absolute; top: 38px; right: 0; z-index: 50; width: 252px;
  background: var(--card); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: var(--shadow); padding: 10px; }
#dyce-app .msg-cal[hidden] { display: none; }
#dyce-app .cal-head { display: flex; align-items: center; justify-content: space-between;
  margin-bottom: 6px; font-size: 13px; font-weight: 700; }
#dyce-app .cal-nav { border: none; background: var(--bg); width: 26px; height: 26px;
  border-radius: 8px; cursor: pointer; color: var(--text); font-size: 15px; line-height: 1; }
#dyce-app .cal-nav:hover { background: var(--accent-soft); color: var(--accent); }
#dyce-app .cal-week { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center;
  font-size: 11px; color: var(--muted); margin-bottom: 4px; }
#dyce-app .cal-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; }
#dyce-app .cal-day { position: relative; border: none; background: transparent; height: 30px;
  border-radius: 8px; font-size: 12.5px; color: var(--text); cursor: pointer; padding: 0; }
#dyce-app .cal-day:hover:not(.empty) { background: var(--accent-soft); }
#dyce-app .cal-day.out { opacity: .45; }
#dyce-app .cal-day.empty { color: var(--muted2); cursor: default; }
#dyce-app .cal-day.today { font-weight: 700; color: var(--accent); }
#dyce-app .cal-day.sel { background: var(--accent); color: #fff; font-weight: 700; border-radius: 8px; }
#dyce-app .cal-dot { position: absolute; bottom: 3px; left: 50%; transform: translateX(-50%);
  width: 4px; height: 4px; border-radius: 50%; background: var(--accent); }
/* 图片浏览 / 语音下载 弹层 */
#dyce-app .gal-overlay { position: fixed; inset: 0; z-index: 45; background: var(--overlay);
  display: flex; align-items: center; justify-content: center; }
#dyce-app .gal-overlay[hidden] { display: none; }
#dyce-app .gal-modal { width: min(860px, 92vw); max-height: 82vh; background: var(--card);
  border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow);
  display: flex; flex-direction: column; overflow: hidden; }
#dyce-app .gal-head { display: flex; gap: 10px; align-items: center; padding: 12px 16px;
  border-bottom: 1px solid var(--line); }
#dyce-app .gal-title { font-weight: 700; font-size: 14.5px; }
#dyce-app .gal-count { color: var(--muted); font-size: 12.5px; margin-right: auto; }
#dyce-app .gal-body { flex: 1; overflow-y: auto; padding: 14px 16px;
  scrollbar-width: thin; scrollbar-color: var(--muted) transparent; }
#dyce-app .gal-body::-webkit-scrollbar { width: 10px; }
#dyce-app .gal-body::-webkit-scrollbar-thumb { background: var(--muted); border-radius: 6px;
  border: 2px solid transparent; background-clip: padding-box; }
#dyce-app .gal-day { font-size: 12.5px; color: var(--muted); margin: 12px 0 6px; }
#dyce-app .gal-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px; }
#dyce-app .gal-card { position: relative; border: 1px solid var(--line); border-radius: 10px;
  overflow: hidden; background: var(--bg); aspect-ratio: 1; display: block; cursor: pointer; }
#dyce-app .gal-card img { width: 100%; height: 100%; object-fit: cover; display: block;
  min-height: 80px; background: var(--chipbg); }
#dyce-app .gal-pick { position: absolute; right: 6px; top: 6px; z-index: 2; width: 16px;
  height: 16px; accent-color: var(--accent); }
#dyce-app .gal-card:has(.gal-pick:checked) { border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft); }
#dyce-app .gal-empty { text-align: center; color: var(--muted); padding: 44px 0; font-size: 13.5px; }
#dyce-app .voice-card { aspect-ratio: auto; display: flex; flex-direction: column; gap: 6px;
  padding: 10px; }
#dyce-app .voice-card audio { width: 100%; }
#dyce-app .voice-card .vc-time { font-size: 11.5px; color: var(--muted); }
/* 会话详情（右侧滑出）：浮在阅读器上的一枚圆角卡片，和弹层 / 设置同一套壳 */
#dyce-app .conv-side-panel { position: absolute; top: 12px; right: 12px; bottom: 12px; width: 300px;
  z-index: 8; background: var(--card); border: 1px solid var(--line); border-radius: 14px;
  box-shadow: var(--shadow), 0 16px 44px rgba(0, 0, 0, .20);
  display: flex; flex-direction: column; overflow: hidden; }
#dyce-app .conv-side-panel[hidden] { display: none; }
#dyce-app .csp-head { display: flex; justify-content: space-between; align-items: center;
  padding: 12px 14px; border-bottom: 1px solid var(--line); font-weight: 700; font-size: 14px; }
#dyce-app .csp-body { flex: 1; overflow-y: auto; padding: 14px; font-size: 13px; }
#dyce-app .csp-profile { display: flex; gap: 10px; align-items: center; margin-bottom: 6px; }
#dyce-app .csp-profile img { width: 48px; height: 48px; border-radius: 50%; object-fit: cover; }
#dyce-app .csp-avatar-ph { width: 48px; height: 48px; border-radius: 50%; flex: none;
  background: var(--accent-soft); color: var(--accent); display: flex; align-items: center;
  justify-content: center; font-weight: 700; font-size: 18px; }
#dyce-app .csp-name { font-weight: 700; font-size: 14.5px; }
#dyce-app .csp-type { color: var(--muted); font-size: 12px; margin-top: 2px; }
#dyce-app .csp-section { font-size: 12px; color: var(--muted); font-weight: 700; margin: 14px 0 6px; }
#dyce-app .csp-row { display: flex; gap: 8px; padding: 5px 0; line-height: 1.55; }
#dyce-app .csp-k { flex: 0 0 64px; color: var(--muted); }
#dyce-app .csp-v { flex: 1; word-break: break-all; }
#dyce-app .csp-mono { font-family: Consolas, monospace; font-size: 11.5px; }
#dyce-app .csp-small { font-size: 12px; color: var(--muted); }
/* ── toast / 设置 / 小胶囊 ── */
#dyce-app #dyce-toast { display: none; position: fixed; top: 22px; left: 50%; transform: translateX(-50%);
  z-index: 60; padding: 9px 16px; border-radius: 10px; background: #fef3c7;
  border: 1px solid #f5d98a; color: #7a5a00; font-size: 13px; font-weight: 600;
  box-shadow: 0 4px 16px rgba(0,0,0,.12); max-width: 70%; }
/* 自绘悬浮提示：替掉浏览器原生气泡（灰底方框、跟界面不搭）。
   底色走 --card，浅色=纯白、深色=卡片深灰，圆角与卡片一致。 */
#dyce-app .dytip { position: fixed; z-index: 90; pointer-events: none; max-width: 300px;
  background: var(--card); color: var(--text); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 2px 6px rgba(16,24,40,.08), 0 10px 26px rgba(16,24,40,.12);
  padding: 7px 11px; font-size: 12.5px; font-weight: 500; line-height: 1.5; letter-spacing: .2px;
  white-space: pre-line; text-align: left; }
#dyce-app .modal { position: fixed; inset: 0; z-index: 40; background: var(--overlay);
  display: flex; align-items: center; justify-content: center; }
#dyce-app .modal[hidden] { display: none; }
#dyce-app .set-card { width: 480px; max-width: 92vw; background: var(--card); border-radius: 14px;
  padding: 22px; box-shadow: 0 8px 40px rgba(0,0,0,.25); }
#dyce-app .set-head { display: flex; justify-content: space-between; align-items: center;
  font-size: 16px; }
#dyce-app .set-card .lbl:first-of-type { margin-top: 18px; }
#dyce-chip { position: fixed; top: 14px; left: 14px; z-index: 2147483646; display: block;
  padding: 9px 16px; border-radius: 999px; background: #ffd60a; color: var(--text);
  font: 700 13px/1.4 -apple-system, "Microsoft YaHei", sans-serif;
  box-shadow: 0 4px 16px rgba(0,0,0,.3); cursor: pointer; user-select: none;
  border: 1px solid rgba(0,0,0,.12); }
#dyce-chip[hidden] { display: none; }
#dyce-chip:hover { background: #ffe44d; }
#dyce-errorbar { position: fixed; bottom: 0; left: 0; right: 0; z-index: 2147483647; display: none;
  background: #dc2626; color: #fff; font-size: 13px; padding: 12px 16px; line-height: 1.5;
  word-break: break-all; }
/* ── 获取/导出进度弹窗（毛玻璃覆盖，期间不可操作其他内容）── */
#dyce-app #dyce-progModal { position: fixed; inset: 0; z-index: 55; display: none;
  align-items: center; justify-content: center;
  background: var(--overlay); -webkit-backdrop-filter: blur(9px) saturate(1.05);
  backdrop-filter: blur(9px) saturate(1.05); }
#dyce-app #dyce-progModal.show { display: flex; }
#dyce-app .pm-card { width: min(520px, 92vw); background: var(--card); border: 1px solid var(--line);
  border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,.28); padding: 24px 26px 20px; }
#dyce-app .pm-title { font-size: 16px; font-weight: 700; display: flex; align-items: center;
  gap: 9px; }
#dyce-app .pm-spin { width: 15px; height: 15px; border-radius: 50%; flex: none;
  border: 2.5px solid var(--accent-soft); border-top-color: var(--accent);
  animation: dyceSpin .8s linear infinite; }
#dyce-app .pm-card.fin .pm-spin { animation: none; border-top-color: var(--ok-fill);
  border-color: var(--ok-bd); }
@keyframes dyceSpin { to { transform: rotate(360deg); } }
#dyce-app .pm-bar { height: 8px; background: var(--chipbg); border-radius: 4px; overflow: hidden;
  margin: 18px 0 8px; }
#dyce-app .pm-bar i { display: block; height: 100%; width: 0%; background: var(--accent);
  border-radius: 4px; transition: width .25s; }
#dyce-app .pm-card.fin .pm-bar i { background: var(--ok-fill); }
#dyce-app .pm-detail { font-size: 13.5px; font-weight: 600; min-height: 21px; }
#dyce-app .pm-sub { font-size: 12.5px; color: var(--muted); margin-top: 5px; line-height: 1.6;
  min-height: 19px; }
#dyce-app .pm-note { font-size: 12px; color: var(--muted2); margin-top: 12px; line-height: 1.6; }
#dyce-app .pm-foot { display: flex; justify-content: flex-end; gap: 9px; margin-top: 18px; }
/* ── 带按钮的对话框（和进度弹窗同一套壳，只是没有进度条）── */
#dyce-app #dyce-dlg { position: fixed; inset: 0; z-index: 58; display: none;
  align-items: center; justify-content: center;
  background: var(--overlay); -webkit-backdrop-filter: blur(9px) saturate(1.05);
  backdrop-filter: blur(9px) saturate(1.05); }
#dyce-app #dyce-dlg.show { display: flex; }
#dyce-app .dlg-card { width: min(460px, 92vw); background: var(--card); border: 1px solid var(--line);
  border-radius: 16px; box-shadow: 0 18px 60px rgba(0,0,0,.28); padding: 22px 24px 18px; }
#dyce-app .dlg-t { font-size: 16px; font-weight: 700; }
#dyce-app .dlg-b { margin-top: 9px; font-size: 13.5px; line-height: 1.75; color: var(--muted);
  white-space: pre-line; }
#dyce-app .dlg-foot { margin-top: 18px; display: flex; justify-content: flex-end; gap: 9px; }
#dyce-app .dlg-foot .big { padding: 8px 16px; font-size: 13.5px; }
/* ── 步骤未完成的置灰态：仍可点击（点击给出下一步提示），不再是死禁用 ── */
#dyce-app .lockui { opacity: .45; cursor: not-allowed; }
#dyce-app .lockui:hover { border-color: var(--line); }
#dyce-app button.lockui { color: var(--text); }
/* ── 时间排序按钮（一个箭头，点一下切一次）+ 双击放大提示 ── */
#dyce-app .sortbtn svg { width: 15px; height: 15px; display: block; }
#dyce-app .sortbtn.asc svg { transform: rotate(180deg); }
#dyce-app .sortbtn.on { color: var(--accent); border-color: var(--accent); }
#dyce-app .gal-card img { cursor: zoom-in; }
/* ── 语音转文字弹层的行 ── */
/* 勾选框和卡片一样落在每行的右上角（.gal-pick 是绝对定位，行不设 relative
   就会飘到整个弹层的右上角，看着像多了个莫名其妙的方框） */
#dyce-app .asr-row { position: relative; display: flex; gap: 11px; align-items: flex-start;
  padding: 10px 12px; border: 1px solid var(--line); border-radius: 11px; background: var(--bg);
  margin-bottom: 8px; }
#dyce-app .asr-row:has(input:checked) { border-color: var(--accent); background: var(--accent-soft); }
#dyce-app .asr-row .gal-pick { right: 8px; top: 8px; }
#dyce-app .asr-main { flex: 1; min-width: 0; padding-right: 18px; }
#dyce-app .asr-meta { font-size: 12px; color: var(--muted); }
#dyce-app .asr-state { font-size: 12px; font-weight: 600; color: var(--muted2); margin-top: 3px; }
#dyce-app .asr-state.ok { color: var(--ok-tx); }
#dyce-app .asr-state.err { color: var(--err-tx); }
#dyce-app .asr-txt { font-size: 13px; line-height: 1.55; margin-top: 5px; white-space: pre-wrap;
  word-break: break-word; background: var(--card); border: 1px solid var(--line); border-radius: 8px;
  padding: 7px 9px; }
`;

  var ICON = {
    step1: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M4 6h12M4 10h12M4 14h8"/></svg>',
    chats: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"><path d="M3.5 4.5h13v9H9l-3.5 3v-3H3.5z"/></svg>',
    ai: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"><path d="M9 3.4l1.5 3.9 3.9 1.5-3.9 1.5L9 14.2l-1.5-3.9-3.9-1.5 3.9-1.5z"/><path d="M15.6 3v2.6M14.3 4.3h2.6"/></svg>',
    web: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="6.2"/><path d="M3.8 10h12.4M10 3.8c2.4 2.6 2.4 9.8 0 12.4M10 3.8c-2.4 2.6-2.4 9.8 0 12.4"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    refresh: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M16 10a6 6 0 1 1-1.8-4.3M16 3.5V7h-3.5"/></svg>',
    target: '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="10" cy="10" r="6"/><circle cx="10" cy="10" r="2.2"/></svg>'
  };

  function fmtSize(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
    return (n / 1073741824).toFixed(2) + ' GB';      // 全下完的媒体很容易上 GB
  }

  /* ---- 步骤切换 ---- */
  function showStep(which) {
    curStep = which;
    $('#tab1').classList.toggle('active', which === '1');
    $('#railChats').classList.toggle('active', which === 'reader');
    $('#railAi').classList.toggle('active', which === 'ai');
    var isReader = which === 'reader';
    var isAi = which === 'ai';
    var left = $('#dyce-left'), right = $('#dyce-right');
    // 步骤1 是「会话列表 + 导出设置」双栏；阅读器与 AI 页铺满整块区域
    if (left) left.style.display = which === '1' ? '' : 'none';
    if (right) right.style.display = which === '1' ? '' : 'none';
    $('#pane1').hidden = which !== '1';
    var p4 = $('#pane4');
    if (p4) { p4.hidden = !isAi; p4.classList.toggle('show', isAi); }
    var p3 = $('#pane3');
    if (isReader) { p3.hidden = false; p3.classList.add('show'); readerEnter(); }
    else {
      p3.hidden = true; p3.classList.remove('show');
      // 离开阅读器时收起浮层，避免图片浏览/详情面板浮在其他步骤上
      var g = $('#rdGalOverlay'); if (g) g.hidden = true;
      var vo = $('#rdVoiceOverlay'); if (vo) vo.hidden = true;
      var ao = $('#rdAsrOverlay'); if (ao) ao.hidden = true;
      var eo2 = $('#rdEmojiOverlay'); if (eo2) eo2.hidden = true;
      var de = $('#rdDetails'); if (de) de.hidden = true;
      var ca = $('#rdCal'); if (ca) ca.hidden = true;
      statsClose(); ctxClose();
    }
  }
  var curStep = '1';

  /* 四步流程：时间范围 → 获取数据 → 导出格式 → 导出。
     上一步未完成时，下一步的控件禁用并在步骤条上显示为灰色锁定。 */
  function stepDone(key) {
    if (key === 'range') return state.range !== 'custom' || (!!state.dateStart && !!state.dateEnd);
    if (key === 'pulled') return state.msgByConv.size > 0;
    if (key === 'fmt') return state.exportFmts.length > 0;
    if (key === 'exported') return state.recentExports.length > 0;
    return false;
  }
  function updateStepChecks() {
    var keys = ['range', 'pulled', 'fmt', 'exported'];
    var raw = keys.map(stepDone);
    // 步骤条必须单调：前面没完成时，后面的 ✓ 与绿色连线一律不显示。
    // 否则「选时间范围」这一步还空着，后面却因为上次拉过数据先亮成绿色，看着像进度错乱。
    var done = [], acc = true;
    raw.forEach(function (v) { acc = acc && !!v; done.push(acc); });
    var curIdx = done.indexOf(false);
    var stps = $$('#stepBar .stp');
    stps.forEach(function (el, i) {
      var ok = done[i];
      // 前置有未完成 → 锁定灰；第一个未完成 → 当前（蓝）
      var lock = i > 0 && done.slice(0, i).indexOf(false) >= 0;
      el.classList.toggle('done', ok);
      el.classList.toggle('cur', !ok && !lock && i === curIdx);
      el.classList.toggle('lock', lock);
      var ic = el.querySelector('i');
      if (ic) ic.textContent = ok ? '✓' : '';
    });
    // 步进锁定：置灰只是视觉，按钮仍可点击——点击时弹提示告诉用户下一步做什么（任务4）。
    // busy（获取/导出运行中）才真正 disabled；获取按钮例外，运行中要靠它停止。
    var busy = !!(state.running || state.exportBusy);
    function setLock(sel, key, locked) {
      $$(sel).forEach(function (b) {
        b.setAttribute('data-lock-key', key);          // 点击时由 lockGuard 即时判断该不该提示
        b.classList.toggle('lockui', !!locked);        // 置灰只是视觉
      });
    }
    function setBusyDis(sel, on) {
      $$(sel).forEach(function (b) { b.disabled = !!on; });
    }
    var lockStart = !done[0];                       // 时间范围没定 → 获取按钮置灰
    var lockFmt = !done[0] || !done[1];             // 前两步没完成 → 格式置灰
    var lockExport = !done[0] || !done[1] || !done[2];
    setLock('#dyce-start', 'start', lockStart);
    setLock('#fmtSeg button', 'fmt', lockFmt);
    setLock('#dyce-export', 'export', lockExport);
    setBusyDis('#fmtSeg button', busy);
    setBusyDis('#dyce-export', busy);
  }
  function updateExportBtn() {
    var btn = $('#dyce-export');
    if (!btn) return;
    var n = state.exportFmts.length;
    var label = n ? ('⬇ 导出（' + state.exportFmts.join(' + ') + '）')
                  : '⬇ 导出（先选格式）';
    btn.textContent = label;
    updateStepChecks();
  }
  /* ---- 侧栏「数据概览」下拉：概览页删掉后只留这三项统计 ---- */
  function statsClose() {
    var p = $('#rdStats'), b = $('#rdStatsBtn');
    if (p) p.hidden = true;
    if (b) b.classList.remove('on');
    tipHide();                      // 悬浮提示会压在弹层上，收起时一起收
  }
  function statsToggle() {
    var p = $('#rdStats');
    if (!p) return;
    if (!p.hidden) { statsClose(); return; }
    updateStats();
    p.hidden = false;
    $('#rdStatsBtn').classList.add('on');
  }
  function updateStats() {
    if (!$('#stConv')) return;
    var memMsg = 0; state.msgByConv.forEach(function (m) { memMsg += m.size; });
    var memMedia = Object.keys(state.mediaPaths).length;
    // 「已下载会话」= 本机真留有记录的会话数，不是抖音好友列表的总数（99 个会话里
    // 只有 8 个导出过，写 99 会让人以为都下完了）。内存里取到的 + exports/ 里有快照的，按落盘名并集。
    var names = {};
    state.msgByConv.forEach(function (m, id) { names[safeName(convNameOf(id))] = 1; });
    $('#stConv').textContent = Object.keys(names).length;
    $('#stMsg').textContent = memMsg;
    $('#stMedia').textContent = memMedia;
    // 再按本机磁盘上的导出数据修正：重启后内存是空的，只统计本次会话会一直显示 0，
    // 而 exports/ 里其实躺着几千条消息。取「内存 / 磁盘」每个会话的较大值，不会倒退。
    var api = window.pywebview && window.pywebview.api;
    if (!api || !api.overview_stats) return;
    try {
      api.overview_stats().then(function (r) {
        if (!r || !r.ok || !r.perConv) return;
        var seen = {}, msgs = 0;
        state.msgByConv.forEach(function (m, id) {
          var k = safeName(convNameOf(id));
          if (seen[k]) return;
          seen[k] = 1;
          msgs += Math.max(m.size, (r.perConv[k] || {}).total || 0);
        });
        Object.keys(r.perConv).forEach(function (k) {
          if (!seen[k]) msgs += r.perConv[k].total || 0;
          names[k] = 1;                      // 磁盘上有快照 = 这个会话已经下载过
        });
        $('#stConv').textContent = Object.keys(names).length;
        $('#stMsg').textContent = msgs;
        $('#stMedia').textContent = Math.max(memMedia, r.media || 0);
        // 占用空间只有磁盘一个来源（内存里没有「文件多大」这件事），所以没取到就保持 —
        $('#stBytes').textContent = (r.bytes || r.bytes === 0) ? fmtSize(r.bytes) : '—';
      }).catch(function () {});
    } catch (e) {}
  }
  function updateDirUI(path) {
    ['#exportDir', '#setDir'].forEach(function (sel) {
      var el = $(sel); if (el && path) el.value = path;
    });
    updateStepChecks();
  }
  async function refreshDirUI() {
    try {
      var api = window.pywebview && window.pywebview.api;
      if (api && api.get_exports_dir) {
        var r = await api.get_exports_dir();
        if (r && r.ok) updateDirUI(r.path);
      }
    } catch (e) {}
  }

  /* ---- 会话列表（完整版 .conv 行样式） ---- */
  function renderConvList() {
    var box = $('#convList');
    if (!box) return;
    $$('#convSeg button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.kind === state.activeTab);
    });
    var kw = (($('#convSearch') && $('#convSearch').value) || '').trim().toLowerCase();
    var shown = state.conversations.filter(function (c) {
      if (state.activeTab === 'private' && c.bizType !== 1) return false;
      if (state.activeTab === 'group' && c.bizType !== 2) return false;
      if (kw && String(c.name).toLowerCase().indexOf(kw) < 0) return false;
      return true;
    });
    if (!shown.length) {
      box.innerHTML = '<div style="padding:16px;color:#999;font-size:12.5px;text-align:center;">' +
        (state.conversations.length ? '没有匹配的会话' : '暂无会话') + '</div>';
      return;
    }
    var html = shown.map(function (c) {
      var sel = state.selectedIds.indexOf(c.id) >= 0;
      var pulled = state.msgByConv.has(c.id);
      var part = pulled && !state.pullDone[c.id];      // 中途停止 / 撞到翻页上限：还能继续取
      var cnt = pulled ? (state.msgByConv.get(c.id).size + ' 条') : (c.bizType === 2 ? '群聊' : '单聊');
      var av = c.avatar
        ? '<img class="av" src="' + escHtml(c.avatar) + '" onerror="this.outerHTML=\'<div class=&quot;ph&quot;>' +
          escHtml(c.bizType === 2 ? '群' : '单') + '</div>\'">'
        : '<div class="ph">' + escHtml(c.bizType === 2 ? '群' : '单') + '</div>';
      return '<div class="conv" data-id="' + escHtml(c.id) + '">' +
        '<input type="checkbox" ' + (sel ? 'checked' : '') + '>' + av +
        '<div class="mid"><div class="name">' + escHtml(c.name) + '</div>' +
        '<div class="pv">' + (pulled ? (part ? '已取一部分 · 可继续获取' : '已获取数据 · 可导出')
          : (sel ? '已勾选，等待获取' : '未获取')) + '</div></div>' +
        '<div class="cnt">' + cnt + '</div></div>';
    }).join('');
    box.innerHTML = html;
    $$('.conv', box).forEach(function (d) {
      d.addEventListener('click', function (e) {
        var id = d.dataset.id;
        var i = state.selectedIds.indexOf(id);
        if (i >= 0) state.selectedIds.splice(i, 1); else state.selectedIds.push(id);
        updateSelText();
        renderConvList();
        e.stopPropagation();
      });
    });
  }

  function updateMeUI() {
    var nick = '', av = '';
    try {
      var cu = window.userInfoStore && window.userInfoStore.curLoginUserInfo || {};
      nick = cu.nickname || cu.unique_id || '';
      av = cu.avatarUrl || cu.avatar300Url || '';
    } catch (e) {}
    if (!nick && state.myUid) nick = '账号 ' + String(state.myUid).slice(-6);
    if (!nick) nick = '我';
    var img = $('#railMeImg'), ph = $('#railMePh');
    if (av && img) {
      img.src = av; img.hidden = false; if (ph) ph.hidden = true;
      img.onerror = function () { img.hidden = true; if (ph) ph.hidden = false; };
    }
    if (ph) ph.textContent = nick.slice(0, 1);
  }

  async function refreshConversations() {
    var st = $('#dyce-status');
    if (st) st.textContent = '正在加载会话（批量获取昵称头像）…';
    if (!state.mySec) state.mySec = mySec();
    state.conversations = await loadConversations();
    if (!state.myUid) state.myUid = detectMyUid();
    updateMeUI();
    renderConvList();
    var pc = state.conversations.filter(function (c) { return c.bizType === 1; }).length;
    var gc = state.conversations.filter(function (c) { return c.bizType === 2; }).length;
    if (st) st.textContent = '私聊 ' + pc + ' · 群聊 ' + gc +
      (state.myUid ? ' · 账号 ' + state.myUid : ' · 未登录');
    updateSelText();
    updateStats();
    log('会话列表已刷新');
  }
  function useCurrent() {
    var cs = window.conversationStore;
    if (cs && cs.curConversationId) {
      var id = String(cs.curConversationId);
      if (state.selectedIds.indexOf(id) < 0) state.selectedIds.push(id);
      var s = state.conversations.find(function (c) { return c.id === id; });
      updateSelText();
      renderConvList(); log('已加入当前打开的会话：' + (s ? s.name : id));
    } else tip('当前没有在软件里打开会话');
  }

  async function startOrStop() {
    if (state.running) { state.running = false; log('正在停止…'); return; }
    if (busyGuard('获取聊天数据')) return;
    if (!state.selectedIds.length) { tip('请先在左侧勾选要获取的会话（可多选）'); return; }
    var convs = state.selectedIds.map(function (id) {
      return state.conversations.find(function (c) { return c.id === id; });
    }).filter(Boolean);
    if (!convs.length) { tip('所选会话已失效，请重新点选'); return; }
    // 「拉过一次」不等于「拉完了」：中途停止或撞到翻页上限的会话要能继续往前翻，
    // 只有 state.pullDone 里标记为已翻到头的才跳过（以前按 msgByConv 有没有键判断，
    // 结果停止后再点就被当成「数据已就绪」，剩下的永远取不到）。
    var todo = convs.filter(function (c) { return !state.pullDone[c.id]; });
    var resumed = todo.filter(function (c) {
      var m = state.msgByConv.get(c.id); return m && m.size > 0;
    });
    var skipped = convs.length - todo.length;
    if (!todo.length) {
      log('所选会话都已完整获取（' + pulledNames() + '），无需重复获取；可直接下载媒体或导出');
      showToast('所选会话数据已就绪，可直接导出');
      return;
    }
    state.running = true; setBusy('running', true);
    state.schemaSuspect = 0;
    var btn = $('#dyce-start');
    btn.textContent = '⏳ 拉取中…点击停止';
    btn.classList.add('running');
    progOpen('正在获取聊天数据', {
      stop: true, stopLabel: '停止获取',
      sub: '共 ' + todo.length + ' 个会话（按页翻页，50 条 / 页）' +
        (resumed.length ? ' · 其中 ' + resumed.length + ' 个从上次停止处继续' : ''),
      note: '完成后会自动关闭并保存'
    });
    var total = 0;
    for (var i = 0; i < todo.length && state.running; i++) {
      log('开始获取「' + todo[i].name + '」（' + (i + 1) + '/' + todo.length + '）…');
      total += await pullOne(todo[i], i, todo.length);
    }
    var stopped = !state.running;
    state.running = false; setBusy('running', false);
    state.loaded = state.msgByConv.size > 0;
    btn.textContent = '▶ 获取聊天数据';
    btn.classList.remove('running');
    pmBar(total > 0 || skipped ? 100 : 0);
    updateSelText();
    updateStats();
    renderConvList();
    var detail = state.msgByConv.size ? Array.from(state.msgByConv.entries()).map(function (e) {
      return convNameOf(e[0]) + ' ' + e[1].size + ' 条';
    }).join(' · ') : '';
    if (stopped) {
      var left = convs.filter(function (c) { return !state.pullDone[c.id]; });
      log('已停止，本次获取 ' + total + ' 条' + (left.length ? '；还有 ' + left.length + ' 个会话未取完' : ''));
      showToast('已停止（本次获取 ' + total + ' 条）' +
        (left.length ? '，再点「获取聊天数据」可继续' : ''));
      logSrv('获取已停止: ' + total + ' 条，未取完 ' + left.length + ' 个会话');
      progFinish('已停止：本次获取 ' + total + ' 条' +
        (left.length ? '（' + left.length + ' 个会话未取完，可继续）' : ''), 1800);
      return;
    }
    log('✓ 数据获取完成' + (skipped ? '（跳过 ' + skipped + ' 个已完整获取）' : '') + '：' + detail);
    showToast('✓ 获取完成：' + detail);
    pmSet('已获取：' + detail);
    pmSub('正在保存 JSON 快照（供「聊天记录」阅读器离线阅读）…');
    logSrv('获取完成: ' + detail);
    // 自动保存 JSON 快照：「聊天记录」阅读器跨会话读取的数据源
    try {
        // 先补全这批会话的发送者昵称/头像（群聊快照里 sender_name 与 avatarUrl 的数据源）
        var secList = [];
        for (var si = 0; si < todo.length; si++) {
          var mm0 = state.msgByConv.get(todo[si].id);
          if (!mm0) continue;
          mm0.forEach(function (m2) {
            if (m2.sender_sec_uid && secList.indexOf(m2.sender_sec_uid) < 0) secList.push(m2.sender_sec_uid);
          });
        }
        if (secList.length) await fetchUserInfos(secList);
        // 回填已缓存的转写，避免这次自动快照把之前的 asr 字段冲没
        await hydrateAsr(todo.map(function (c) { return c.name; }));
        var snapBad = 0;
        for (var sj = 0; sj < todo.length; sj++) {
          var sc = todo[sj];
          var srows = filterRange(buildRows(state.msgByConv.get(sc.id), sc));
          if (srows.length) {
            var rs = await exportOne('json', srows, sc);
            if (rs && rs.ok === false) snapBad++;
          }
        }
        log(snapBad ? 'JSON 快照有 ' + snapBad + ' 个会话没写成功（阅读器可能打不开）'
                    : '已自动保存 JSON 快照（阅读器可直接阅读）');
      } catch (e) { log('JSON 快照保存失败：' + e.message); }
    if (state.schemaSuspect) {
      var warn = '有 ' + state.schemaSuspect + ' 个会话首页就没解析到消息——接口字段可能已变更，' +
        '细节看 boot.log 里的 [schema-miss]';
      showToast(warn); log(warn);
      progFinish('获取结束 · 共 ' + total + ' 条（' + state.schemaSuspect + ' 个会话首页为空）', 2800);
    } else {
      progFinish('✓ 获取完成 · 共 ' + total + ' 条', 1400);
    }
  }

  /* ============ 阅读器（聊天记录步骤） ============ */
  // 数据源：1) 本次会话已获取的内存数据；2) exports/<会话>/<会话>.json 快照。
  // 本地媒体经 Python 桥按需分块传输为 blob（页面是 https 抖文域，不能直接引用本地路径）。
  function readerApi() { return window.pywebview && window.pywebview.api; }

  async function readJsonChunked(conv) {
    var api = readerApi();
    if (!api || !api.begin_read) throw new Error('需在软件内运行');
    var b = await api.begin_read(conv);
    if (!b.ok) throw new Error(b.error || '读取失败');
    var s = '';
    for (;;) {
      var n = await api.read_next(b.eid);
      if (!n.ok) throw new Error(n.error || '读取失败');
      if (n.done) break;
      s += n.part;
    }
    return JSON.parse(s);
  }
  function b64ToUrl(b64) {
    var bin = atob(b64), arr = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return URL.createObjectURL(new Blob([arr]));
  }
  async function loadMediaUrl(conv, rel) {
    var R = state.reader, key = conv + '|' + rel;
    if (R.mediaCache[key]) return R.mediaCache[key];
    var api = readerApi();
    if (!api || !api.begin_media) throw new Error('需在软件内运行');
    var b = await api.begin_media(conv, rel);
    if (!b.ok) throw new Error(b.error || '媒体不存在');
    var parts = [];
    for (;;) {
      var n = await api.read_media_next(b.eid);
      if (!n.ok) throw new Error(n.error || '读取失败');
      if (n.done) break;
      parts.push(n.part);
    }
    var url = b64ToUrl(parts.join(''));
    R.mediaCache[key] = url;
    return url;
  }

  /* 正在看的记录没了：把右侧与相关浮层一起复位，不留旧会话在屏上 */
  function readerResetView() {
    var R = state.reader;
    R.key = ''; R.title = ''; R.convId = ''; R.rows = []; R.filtered = [];
    R.shown = 0; R.hiddenN = 0; R.mediaCache = {};
    var t = $('#rdTitle'); if (t) t.textContent = '选择左侧记录';
    var s = $('#rdSearch'); if (s) s.value = '';
    updateMediaGapBar();
    var c = $('#rdCal'); if (c) { c.hidden = true; c.innerHTML = ''; }
    ['#rdGalOverlay', '#rdVoiceOverlay', '#rdAsrOverlay', '#rdEmojiOverlay',
     '#rdDetails', '#rdLightbox'].forEach(function (sel) {
      var e = $(sel); if (e) e.hidden = true;
    });
    var l = $('#rdList');
    if (l) l.innerHTML = '<div class="rd-empty">这条记录已经不在了<br>' +
      '（会话被删除或导出文件被清理）</div>';
    var sen = $('#rdSentinel'); if (sen) sen.textContent = '';
  }

  async function readerRefreshSide() {
    var box = $('#rdSideList');
    if (!box) return [];
    var items = [];
    function avatarOf(conv) { return (conv && conv.avatar) || ''; }
    state.msgByConv.forEach(function (m, id) {
      var c = state.conversations.find(function (x) { return x.id === id; });
      items.push({ key: 'mem:' + id, name: convNameOf(id), count: m.size,
        bytes: null, avatar: avatarOf(c) });
    });
    try {
      var api = readerApi();
      if (api && api.list_export_convs) {
        var r = await api.list_export_convs();
        (r.ok && r.convs ? r.convs : []).forEach(function (c) {
          // 按落盘名比对：显示名带 emoji / 结尾点号时 safeName 后才是目录名，否则会重复列出
          var dup = items.filter(function (x) { return safeName(x.name) === c.name; })[0];
          if (dup) {
            dup.bytes = c.size;
            if (dup.count == null && c.total != null) dup.count = c.total;
            return;
          }
          var cc = state.conversations.find(function (x) {
            return safeName(x.name) === c.name;
          });
          items.push({ key: 'disk:' + c.name, name: c.name, count: c.total,
            bytes: c.size, avatar: avatarOf(cc) });
        });
      }
    } catch (e) {}
    // 置顶的排在最前（按置顶先后），其余顺序不变；名字取落盘名，和删除/内存清理同一口径
    var pin = pinnedList();
    if (pin.length) {
      items.sort(function (a, b) {
        var pa = pin.indexOf(safeName(a.name)), pb = pin.indexOf(safeName(b.name));
        if (pa < 0 && pb < 0) return 0;
        if (pa < 0) return 1;
        if (pb < 0) return -1;
        return pa - pb;
      });
    }
    var cnt = $('#rdSrcCnt');
    if (cnt) cnt.textContent = items.length ? items.length + ' 份' : '';
    // 正在看的那条记录没了（在抖音里删了会话 / 删了 exports）→ 右侧必须一起清空，
    // 否则会停在上一份已打开的会话上，左边写着「还没有记录」右边还在显示旧消息
    var alive = {};
    items.forEach(function (it) { alive[it.key] = 1; });
    if (state.reader.key && !alive[state.reader.key]) readerResetView();
    if (!items.length) {
      box.innerHTML = '<div class="rd-empty" style="margin-top:24px">还没有记录<br>先在「选会话」里获取数据</div>';
      return items;
    }
    box.innerHTML = items.map(function (it) {
      var av = it.avatar
        ? '<div class="rdav" style="background-image:url(&quot;' + escHtml(it.avatar) + '&quot;)"></div>'
        : '<div class="rdav ph">' + escHtml(it.name.slice(0, 1)) + '</div>';
      // 第一行只有名字；条数和占用大小放第二行小字，缺哪个就不显示哪个
      var bits = [];
      if (it.count != null) bits.push(it.count + ' 条');
      if (it.bytes) bits.push(fmtSize(it.bytes));
      var sz = bits.length ? '<div class="s">' + bits.join(' · ') + '</div>' : '';
      return '<div class="rd-item' + (state.reader.key === it.key ? ' on' : '') +
        (isPinned(safeName(it.name)) ? ' pin' : '') +
        '" data-key="' + escHtml(it.key) + '">' + av +
        '<div class="rdinfo"><div class="n"><span class="nn">' + escHtml(it.name) +
        '</span></div>' + sz + '</div></div>';
    }).join('');
    $$('.rd-item', box).forEach(function (d) {
      d.addEventListener('click', function () { readerOpen(d.dataset.key); });
    });
    if (!state.reader.key && items.length) readerOpen(items[0].key);
    return items;
  }

  async function readerOpen(key) {
    var R = state.reader;
    R.key = key;
    $$('#rdSideList .rd-item').forEach(function (d) {
      d.classList.toggle('on', d.dataset.key === key);
    });
    var list = $('#rdList');
    list.innerHTML = '<div class="rd-empty">加载中…</div>';
    try {
      var rows, title, convId = '';
      if (key.indexOf('mem:') === 0) {
        var id = key.slice(4);
        var conv = state.conversations.find(function (c) { return c.id === id; }) || null;
        title = conv ? conv.name : '未知会话';
        convId = id;
        await hydrateAsr([title]);        // 内存视图：把本机 .txt 缓存里的转写读回来
        rows = buildRows(state.msgByConv.get(id), conv).map(function (r) {
          r.sender_name = displayForRow(r, conv);
          return r;
        });
        var mv = visibleRows(rows);
        rows = mv.rows; R.hiddenN = mv.hidden;
      } else {
        title = key.slice(5);
        var payload = await readJsonChunked(title);
        convId = (payload.meta && payload.meta.conversationId) || '';
        var convObj = state.conversations.find(function (x) { return safeName(x.name) === title; }) || null;
        rows = (payload.messages || []).map(function (m) {
          var t = m.time || '';
          var cj = m.content || {};
          var eu = (cj.url && cj.url.url_list && cj.url.url_list[0]) || '';
          // 用当前渲染规则重算：老快照里没认出的系统消息、新版分享卡片、[未知] 都在这里补好
          var kind = m.kind || 'text', text = m.text || '', shareV = m.share || null;
          var blank = false, greet = false;
          if (cj && Object.keys(cj).length) {
            var rd2 = render(cj);
            blank = !!rd2.blank; greet = !!rd2.greeting;
            if (rd2.kind === 'system') { kind = 'system'; if (rd2.text) text = rd2.text; }
            else if (m.kind === 'other' || !m.kind || String(m.text || '').indexOf('[未知]') >= 0) {
              if (rd2.kind !== 'other') {
                kind = rd2.kind; text = rd2.text;
                if (rd2.share) shareV = rd2.share;
              } else if (String(rd2.text || '').indexOf('无法解析') >= 0) { text = rd2.text; }
            }
          } else {
            // content 是空对象：属于「接口就没给正文」，标记后默认不在界面里出现
            blank = true;
            text = '[无内容 · 无法解析（可能已撤回或为该客户端专有卡片）]';
          }
          var mine = !!m.mine;
          var sec = m.sender_sec_uid || '';
          var avatarUrl = m.avatarUrl || '';
          var emojiType = cj.emoji_type || '';
          if (!avatarUrl && mine) avatarUrl = myAvatarUrl();
          if (!avatarUrl && !mine && convObj && convObj.bizType === 1) avatarUrl = convObj.avatar || '';
          // 旧快照兜底：页面 userInfoStore（按 uid 键）里渲染过的用户直接取头像
          if (!avatarUrl && !mine && m.sender_uid) {
            try {
              var um = window.userInfoStore && window.userInfoStore.usersInfoMap;
              var uu = um && um.get ? um.get(String(m.sender_uid)) : null;
              if (uu) avatarUrl = avatarFromUser(uu) || uu.avatarUrl || uu.avatar300Url || '';
            } catch (e) {}
          }
          return {
            time: t, tms: new Date(String(t).replace(' ', 'T')).getTime() || 0,
            mine: mine, kind: kind, text: text,
            blank: blank, greeting: greet,
            server_id: m.server_id || null, sender_uid: m.sender_uid || '',
            recalled: m.recalled || 0, visible: (m.visible === undefined ? null : m.visible),
            cj: cj,
            duration: m.duration || 0, share: shareV, ref: m.ref || null,
            sender_name: m.sender_name || (m.mine ? '我' : '对方'),
            senderSec: sec,
            aweType: cj.aweType,
            local: m.local || null, coverLocal: m.coverLocal || null,
            avatarLocal: m.avatarLocal || null, avatarUrl: avatarUrl, emojiUrl: eu,
            emojiType: emojiType,
            asr: m.asr || null
          };
        });
        // 新快照带 sender_sec_uid：批量调 IM user/info 实时补缺失的头像
        var needSecs = [];
        rows.forEach(function (r) {
          if (!r.avatarUrl && !r.mine && r.senderSec && needSecs.indexOf(r.senderSec) < 0) {
            needSecs.push(r.senderSec);
          }
        });
        if (needSecs.length) {
          try {
            await fetchUserInfos(needSecs.slice(0, 400));
            rows.forEach(function (r) {
              if (r.avatarUrl || r.mine || !r.senderSec) return;
              var ui = state.userCache.get(r.senderSec);
              if (ui && ui.avatar) r.avatarUrl = ui.avatar;
            });
          } catch (e) {}
        }
        rows.sort(function (a, b) { return a.tms - b.tms; });
        var dv = visibleRows(rows);
        rows = dv.rows; R.hiddenN = dv.hidden;
        // 头像普遍缺失 = 旧快照没有 sec 字段，只能重新获取一次来补全
        var othersN = 0, missN = 0;
        rows.forEach(function (r) {
          if (r.mine || r.kind === 'system') return;
          othersN++;
          if (!r.avatarUrl) missN++;
        });
        if (othersN > 0 && missN / othersN > 0.5 && !state.avatarHintShown[title]) {
          state.avatarHintShown[title] = 1;
          showToast('部分成员头像缺失：在「选会话」重新获取一次即可补全');
        }
      }
      R.title = title; R.rows = rows; R.shown = 0; R.convId = convId;
      $('#rdTitle').textContent = title;
      var sd = $('#rdSearch'); if (sd) sd.value = '';
      readerRender();
      log('阅读器已打开「' + title + '」共 ' + rows.length + ' 条');
    } catch (e) {
      list.innerHTML = '<div class="rd-empty">加载失败：' + escHtml(e.message) + '</div>';
    }
  }

  function readerApplyFilter() {
    var kw = (($('#rdSearch') && $('#rdSearch').value) || '').trim().toLowerCase();
    var rows = state.reader.rows || [];
    state.reader.filtered = !kw ? rows : rows.filter(function (r) {
      return (r.text && String(r.text).toLowerCase().indexOf(kw) >= 0) ||
             (r.sender_name && String(r.sender_name).toLowerCase().indexOf(kw) >= 0);
    });
    return kw;
  }
  function dayLabel(t) {
    var d = new Date(String(t).replace(' ', 'T'));
    if (isNaN(d.getTime())) return String(t || '');
    return d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() +
      '日 星期' + '日一二三四五六'[d.getDay()];
  }
  // 文本内联表情：优先用映射的远程地址（页面就在抖音域，可直接加载）
  function inlineEmojiHtmlLocal(escaped) {
    var map = window.__DYIN_EMOJI_MAP || {};
    return escaped.replace(/\[[^\[\]]{1,10}\]/g, function (tok) {
      var url = map[tok];
      if (!url) return tok;
      return '<img class="iemo" loading="lazy" alt="' + escHtml(tok) + '" src="' + escHtml(url) +
        '" onerror="this.replaceWith(document.createTextNode(this.alt))">';
    });
  }
  function rdBody(r) {
    if (r.kind === 'image') {
      if (r.local) return '<div class="imgph" data-mlazy data-mkind="img" data-mrel="' +
        escHtml(r.local) + '">图片加载中…</div>';
      return '<span style="color:#888">[图片未下载]</span>';
    }
    if (r.kind === 'video') {
      if (r.local) return '<button class="vplay" data-vrel="' + escHtml(r.local) + '">▶ 播放视频</button>';
      return '<span style="color:#888">[视频未下载]</span>';
    }
    if (r.kind === 'voice') {
      var inner = '<div style="font-size:12px;color:#444;margin-bottom:4px">语音 ' +
        fmtDuration(r.duration) + '</div>';
      if (r.local) inner += '<audio controls preload="none" data-mlazy data-mkind="audio" data-mrel="' +
        escHtml(r.local) + '"></audio>';
      else inner += '<span style="color:#888">[语音未下载]</span>';
      if (r.asr) inner += '<div class="asrt">' + escHtml(r.asr) + '</div>';
      return inner;
    }
    if (r.kind === 'emoji') {
      if (r.local) return '<div class="imgph" data-mlazy data-mkind="img" data-mrel="' +
        escHtml(r.local) + '" style="min-width:96px;min-height:96px">表情加载中…</div>';
      if (r.emojiUrl) return '<img class="emo" loading="lazy" src="' + escHtml(r.emojiUrl) +
        '" onerror="this.replaceWith(document.createTextNode(\'[表情]\'))">';
      return '<span>[表情]</span>';
    }
    if (r.kind === 'sharevideo') {
      var sh = r.share || {};
      // 封面是「可有可无」的：不管本地还是远程，都先挂一个透明占位，
      // 由 rdLoad 预加载解出图来才插 <img>——解不出就整块删掉，破图标和空框根本没机会进 DOM。
      var covAttr = r.coverLocal ? ' data-mrel="' + escHtml(r.coverLocal) + '"'
                                 : (sh.cover ? ' data-mrem="' + escHtml(sh.cover) + '"' : '');
      var cov = (r.coverLocal || sh.cover)
        ? '<div class="imgph covph" data-mlazy data-mkind="img" data-mopt="1"' + covAttr +
          ' style="min-width:214px;min-height:120px"></div>'
        : '';
      // 瘦身：封面限高 16:9、标题最多两行、不铺长链接（点「打开视频」跳转）
      // 跳转走 _self：target=_blank 会被 WebView2 丢给系统默认浏览器，用户要求在本软件内打开
      return '<div class="card svid">' + cov + '<div class="cb"><div class="ct">' +
        escHtml(sh.title || '无标题') + '</div><div class="ca">' +
        escHtml(sh.author || '') + (sh.author ? ' · ' : '') +
        '<a href="' + escHtml(sh.link) + '" target="_self" rel="noopener">▶ 打开视频</a></div></div></div>';
    }
    if (r.text) return inlineEmojiHtmlLocal(escHtml(r.text));
    return '<span style="color:#aaa">[空]</span>';
  }
  function readerRowHtml(r, i) {
    if (r.kind === 'system') {
      return '<div class="sysline" data-i="' + i + '">' +
        escHtml(String(r.time || '').slice(11) + ' · ' + r.text) + '</div>';
    }
    var name = r.sender_name || (r.mine ? '我' : '对方');
    var ch = escHtml(name.slice(0, 1));
    var av;
    if (r.avatarLocal) {
      // 本地已下载头像（同会话文件夹内），经桥懒加载
      av = '<div class="rav" data-mlazy data-mkind="rav" data-mrel="' + escHtml(r.avatarLocal) + '">' + ch + '</div>';
    } else if (r.avatarUrl) {
      // 未本地化时直接用远程头像（页面在抖音域可加载），失败保留首字占位
      av = '<div class="rav">' + ch +
        '<img class="rav-img" loading="lazy" src="' + escHtml(r.avatarUrl) +
        '" onerror="this.remove()"></div>';
    } else {
      av = '<div class="rav">' + ch + '</div>';
    }
    var ref = r.ref ? '<div class="ref">回复 ' + escHtml(r.ref.nickname || '') + '：' +
      escHtml(r.ref.content || '') + '</div>' : '';
    var hhmmss = String(r.time || '').slice(11);
    return '<div class="mrow ' + (r.mine ? 'me' : 'ta') + '" data-i="' + i + '">' + av +
      '<div class="body"><div class="meta">' + escHtml(hhmmss + ' · ' + name) + '</div>' + ref +
      '<div class="bub' + (isMediaKind(r.kind) ? ' bub-media' : '') + '">' + rdBody(r) +
      '</div></div></div>';
  }
  function readerAppend(n) {
    var R = state.reader, list = $('#rdList'), sen = $('#rdSentinel');
    if (!list || !sen) return;
    var rows = R.filtered || [], from = R.shown || 0;
    if (from >= rows.length) return;
    var to = Math.min(rows.length, from + n);
    var lastDate = from > 0 ? String(rows[from - 1].time || '').slice(0, 10) : null;
    var html = '';
    for (var i = from; i < to; i++) {
      var r = rows[i];
      var dk = String(r.time || '').slice(0, 10);
      if (dk !== lastDate) {
        html += '<div class="daysep"><span>' + escHtml(dayLabel(r.time)) + '</span></div>';
        lastDate = dk;
      }
      html += readerRowHtml(r, i);
    }
    R.shown = to;
    sen.insertAdjacentHTML('beforebegin', html);
    sen.textContent = to >= rows.length ? '— 已全部加载（' + rows.length + ' 条）—' : '继续滚动加载…';
    observeReaderMedia(list);
  }
  function readerRender() {
    var list = $('#rdList');
    if (!list) return;
    updateMediaGapBar();
    var kw = readerApplyFilter();
    var rows = state.reader.filtered || [];
    if (!rows.length) {
      list.innerHTML = '<div class="rd-empty">' +
        ((state.reader.rows || []).length ? '没有匹配的消息' : '暂无消息') + '</div>';
      return;
    }
    state.reader.shown = 0;
    list.innerHTML = '<div id="rdSentinel">加载中…</div>';
    readerAppend(Math.min(80, rows.length));
    list.scrollTop = 0;
  }
  var rdIO = null;
  function observeReaderMedia(root) {
    if (!('IntersectionObserver' in window)) return;
    if (!rdIO) {
      rdIO = new IntersectionObserver(function (es) {
        es.forEach(function (e) {
          if (e.isIntersecting) { rdIO.unobserve(e.target); rdLoad(e.target); }
        });
      }, { root: $('#rdList'), rootMargin: '500px' });
    }
    $$('[data-mlazy]', root).forEach(function (el) { rdIO.observe(el); });
  }
  /* 图片解码失败（浏览器画不出、留下破图标 + 空框）时的统一处理：
     分享卡片里的封面 → 整块删掉；消息本身就是那张图 → 换成一灰字说明。
     注意 .heic/.heif：Chrome/Edge 没有 HEVC 扩展就解不出来，转码失败时会出现。 */
  function mediaFail(el, why) {
    if (!el || !el.parentNode) return;
    if (el.closest && el.closest('.card')) { el.remove(); return; }
    var sp = document.createElement('span');
    sp.className = 'badmedia';
    sp.textContent = '图片无法显示' + (why ? '（' + why + '）' : '');
    el.replaceWith(sp);
  }
  function badMediaHint(rel) {
    var m = /\.(heic|heif)$/i.exec(String(rel || ''));
    return m ? 'HEIC 未转码成功' : '';
  }
  /* 可选媒体（分享卡片封面）的兜底：桥没回、回了不解码、解码不触发 onload/onerror
     ——任何一种卡住，8 秒后整块删掉，绝不留个空框或破图标在气泡里。 */
  function guardOptional(el, isImg) {
    if (!el || el.getAttribute && el.getAttribute('data-mopt') !== '1') return;
    setTimeout(function () {
      if (!document.contains(el)) return;
      if (isImg && el.complete && el.naturalWidth > 0) return;   // 真显示出来了就别动
      el.remove();
    }, 8000);
  }
  function rdLoad(el) {
    var rel = el.getAttribute('data-mrel');
    var rem = el.getAttribute('data-mrem');    // 远程地址（分享封面）：不走桥，直接预加载
    if (!rel && !rem) return;
    guardOptional(el, false);
    var kind = el.getAttribute('data-mkind') || 'img';
    var got = rem ? Promise.resolve(rem) : loadMediaUrl(state.reader.title, rel);
    got.then(function (url) {
      if (kind === 'audio') { el.src = url; return; }
      if (el.classList.contains('imgph')) {
        // 可选媒体（分享卡片封面）：先在 DOM 外解一遍，解得出来才把 <img> 插进去。
        // 浏览器只给「已挂在页面上的 img」画破图标和那圈边框——所以解不出来时
        // 最坏也只是这块根本没有图，不会再出现空框。
        if (el.getAttribute('data-mopt') === '1') {
          var pre = new Image();
          pre.onload = function () {
            if (!document.contains(el)) return;
            var ok = document.createElement('img');
            ok.className = 'rimg'; ok.src = url;
            ok.onerror = function () { ok.remove(); };
            el.replaceWith(ok);
          };
          pre.onerror = function () { el.remove(); };
          pre.src = url;
          return;
        }
        var im = document.createElement('img');
        im.className = 'rimg'; im.src = url;
        // 文件在、但字节不是浏览器能解的图（HEIC / 坏文件）：以前就留个破图标在这
        im.onerror = function () { mediaFail(im, badMediaHint(rel)); };
        el.replaceWith(im);
        guardOptional(im, true);          // 换上去的这张图也要有兜底（blob 卡住不报错的情况）
      } else if (el.classList.contains('rav')) {
        var im2 = document.createElement('img');
        im2.src = url;
        im2.onerror = function () { im2.remove(); };   // 头像解不出来就留首字母圆
        el.innerHTML = ''; el.appendChild(im2);
      } else if (el.tagName === 'IMG') {
        el.src = url;
        el.onerror = function () { mediaFail(el, badMediaHint(rel)); };
      }
    }).catch(function () {
      if (el.classList.contains('imgph')) {
        // 可选媒体（分享卡片封面）：读不到就整块删掉，不留灰框和报错字
        if (el.getAttribute('data-mopt') === '1') { el.remove(); return; }
        el.textContent = '媒体缺失';
        el.style.color = '#dc2626';
        el.style.cursor = 'default';
      }
    });
  }
  /* ---- 日期跳转：自绘日历（参考完整版：有消息的日期打点，点日期跳到当天第一条）---- */
  var calState = { y: 0, m: 0 };
  function readerDayMap() {
    var map = {}, rows = state.reader.rows || [];
    for (var i = 0; i < rows.length; i++) {
      var k = String(rows[i].time || '').slice(0, 10);
      if (k) map[k] = (map[k] || 0) + 1;
    }
    return map;
  }
  function calRender() {
    var box = $('#rdCal');
    if (!box) return;
    var days = readerDayMap();
    var y = calState.y, mo = calState.m;
    var p2 = function (n) { return String(n).padStart(2, '0'); };
    var td = new Date();
    var todayKey = td.getFullYear() + '-' + p2(td.getMonth() + 1) + '-' + p2(td.getDate());
    var lead = (new Date(y, mo, 1).getDay() + 6) % 7;
    var html = '<div class="cal-head"><button class="cal-nav" data-shift="-1" title="上个月">‹</button>' +
      '<div class="cal-title">' + y + ' 年 ' + (mo + 1) + ' 月</div>' +
      '<button class="cal-nav" data-shift="1" title="下个月">›</button></div>' +
      '<div class="cal-week"><span>一</span><span>二</span><span>三</span><span>四</span>' +
      '<span>五</span><span>六</span><span>日</span></div><div class="cal-grid">';
    for (var i = 0; i < 42; i++) {
      var d = new Date(y, mo, 1 - lead + i);
      var key = d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate());
      var has = !!days[key];
      html += '<button class="cal-day' + (d.getMonth() !== mo ? ' out' : '') +
        (key === todayKey ? ' today' : '') + (has ? '' : ' empty') +
        '" data-day="' + key + '" title="' + key + (has ? ' · ' + days[key] + ' 条消息' : ' · 无消息') +
        '"><span class="cal-num">' + d.getDate() + '</span>' + (has ? '<i class="cal-dot"></i>' : '') +
        '</button>';
    }
    html += '</div>';
    box.innerHTML = html;
    $$('.cal-nav', box).forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var dd = new Date(calState.y, calState.m + Number(this.dataset.shift), 1);
        calState.y = dd.getFullYear(); calState.m = dd.getMonth();
        calRender();
      });
    });
    $$('.cal-day', box).forEach(function (b) {
      b.addEventListener('click', function () {
        if (this.classList.contains('empty')) return;
        $('#rdCal').hidden = true;
        jumpToDate(this.dataset.day);
      });
    });
  }
  function calToggle() {
    var el = $('#rdCal');
    if (!el) return;
    if (!el.hidden) { el.hidden = true; return; }
    var rows = state.reader.rows || [];
    var last = rows.length ? rows[rows.length - 1] : null;
    if (!calState.y) {
      var d = last && last.tms ? new Date(last.tms) : new Date();
      calState.y = d.getFullYear(); calState.m = d.getMonth();
    }
    el.hidden = false;
    calRender();
  }
  function jumpToDate(key) {
    var rows = state.reader.filtered || [];
    var idx = -1;
    for (var i = 0; i < rows.length; i++) {
      if (String(rows[i].time || '').slice(0, 10) >= key) { idx = i; break; }
    }
    if (idx < 0) { showToast('没有该日期之后的消息'); return; }
    if ((state.reader.shown || 0) <= idx) readerAppend(idx + 60 - (state.reader.shown || 0));
    var el = $('#rdList [data-i="' + idx + '"]');
    if (el) el.scrollIntoView({ block: 'start' });
  }

  /* ---- 「这条记录的媒体还没下载」：提示条 + 一键补下载 ----
     只勾 JSON 导出时，阅读器能列出这条记录，但图片/语音/视频都还没下载（点开是空的）。 */
  /* 抖音媒体链接是一次性签名地址，x-expires（unix 秒）过了 CDN 直接 403。
     过期 / 接口压根没给链接的两类都补不下来，只能回步骤1重新获取该会话数据。 */
  function urlExpired(u) {
    var m = /[?&]x-expires=(\d{9,11})(?:&|$)/.exec(String(u || ''));
    return m ? Number(m[1]) * 1000 <= Date.now() : false;
  }
  function firstUrl(list) {
    var x = (list && list[0]) || '';
    return typeof x === 'string' ? x : ((x && x.url) || '');
  }
  /* 这一行的媒体现在还取不取得到 */
  function rowMediaDead(r) {
    var c = r.cj || {}, ru = c.resource_url || {}, u = '';
    if (r.kind === 'image') u = ru.skey ? firstUrl(ru.origin_url_list) : '';
    else if (r.kind === 'voice') u = firstUrl(ru.url_list);
    else if (r.kind === 'video') return !(c.video && c.video.tkey && c.video.skey);
    else if (r.kind === 'emoji') u = r.emojiUrl || '';
    else return false;
    return !u || urlExpired(u);
  }
  function missingMediaCounts(rows) {
    var n = { image: 0, video: 0, voice: 0, emoji: 0, total: 0, dead: 0, live: 0, have: 0 };
    (rows || []).forEach(function (r) {
      if (n[r.kind] === undefined) return;               // 只算图片 / 视频 / 语音 / 表情四类
      if (r.kind === 'emoji' && !r.emojiUrl) return;     // 连远程地址都没有的表情：不算缺
      if (r.local) { n.have++; return; }                 // 这条记录的媒体其实下过
      n[r.kind]++; n.total++;
      if (rowMediaDead(r)) n.dead++; else n.live++;
    });
    return n;
  }
  function updateMediaGapBar() {
    var btn = $('#rdMedGap');
    if (!btn) return;
    var n = missingMediaCounts(state.reader.rows);
    // 只在这种时候出现：① 还有能补下的（不管下没下过）；② 这条记录压根没下过媒体、
    // 只剩过期死链（那才需要告诉他「得重新获取」）。已经下过媒体、只剩几条过期封面的，
    // 不再拿一颗灰色「链接已过期」去每条记录上骚扰。
    var show = !!n.total && !!state.reader.key && (n.live > 0 || !n.have);
    if (!show || state.reader.downloading) { btn.hidden = true; return; }
    var parts = [];
    if (n.image) parts.push('图片 ' + n.image);
    if (n.video) parts.push('视频 ' + n.video);
    if (n.voice) parts.push('语音 ' + n.voice);
    if (n.emoji) parts.push('表情 ' + n.emoji);
    btn.classList.toggle('dead', !n.live);
    btn.textContent = n.live ? ('⬇ 下载 ' + n.live + ' 项') : '⬇ 链接已过期';
    btn.title = '媒体未下载 · ' + parts.join(' · ') +
      (n.dead ? '\n' + n.dead + ' 条的签名链接已过期（抖音给的是一次性地址，补不了）' : '') +
      (n.live ? '\n点一下补齐这 ' + n.live + ' 条' : '\n点一下看怎么重新获取');
    btn.hidden = false;
  }
  /* 当前记录对应的会话对象（内存视图按 id 找，磁盘视图按落盘名找） */
  function readerConvOf() {
    var R = state.reader;
    if (R.key.indexOf('mem:') === 0) {
      var id = R.key.slice(4);
      return state.conversations.find(function (c) { return c.id === id; }) ||
             { id: id, name: R.title, bizType: 1, peerSec: '' };
    }
    var nm = R.key.slice(5) || R.title;
    var c2 = state.conversations.find(function (x) { return safeName(x.name) === nm; });
    return c2 || { id: R.convId || '', name: R.title || nm, bizType: 1, peerSec: '' };
  }
  /* 把下载到的本地路径写回 JSON 快照：不重导消息内容，只补 local / coverLocal 两个字段，
     这样重启软件后从磁盘打开仍然能显示（重导会把隐藏消息一起冲掉）。 */
  async function writeBackLocalFields(title) {
    var payload;
    try { payload = await readJsonChunked(title); } catch (e) { return false; }
    if (!payload || !payload.messages) return false;
    var changed = 0;
    payload.messages.forEach(function (m) {
      var sid = String(m.server_id || '');
      if (!sid) return;
      var rel = state.mediaPaths[sid], cov = state.mediaPaths[sid + '_cover'];
      if (rel && m.local !== rel) { m.local = rel; changed++; }
      if (cov && m.coverLocal !== cov) { m.coverLocal = cov; changed++; }
    });
    if (!changed) return false;
    var r = await deliver('json', 'application/json;charset=utf-8', JSON.stringify(payload, null, 2), title);
    return !!(r && r.ok !== false);
  }
  /* 跳到步骤1并把该会话勾上，让用户直接点「▶ 获取聊天数据」重取（会带回新的媒体地址） */
  function gotoRefetch(cname) {
    showStep('1');
    var conv = state.conversations.find(function (c) {
      return c.name === cname || safeName(c.name) === cname || safeName(c.name) === safeName(cname);
    });
    if (!conv) {
      tip('会话列表里没找到「' + cname + '」（可能已删除或没刷新）：请重新获取会话列表后勾选它再取数据');
      return;
    }
    if (state.selectedIds.indexOf(conv.id) < 0) state.selectedIds.push(conv.id);
    renderConvList();
    updateSelText();
    var row = $$('#convList .conv').filter(function (d) { return d.dataset.id === conv.id; })[0];
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'center' });
    // 本次已经翻完过的会话再点会被判「已就绪」而跳过 —— 那样链接不会刷新
    tip(state.pullDone[conv.id]
      ? '已勾选「' + conv.name + '」，但它本次已取完：先重启软件（或等下次开机）再点「▶ 获取聊天数据」，' +
        '重新取一遍才会带回新的媒体地址'
      : '已勾选「' + conv.name + '」：点「▶ 获取聊天数据」重新取一次，完成后点「⬆ 导出」并勾上媒体');
  }
  async function downloadMissingMedia() {
    var R = state.reader;
    if (R.downloading) return;
    if (state.running || state.exportBusy) { showToast('正在获取/导出中，稍后再补下载'); return; }
    var api = readerApi();
    if (!api || !api.download_one) { showToast('需在软件内运行'); return; }
    var conv = readerConvOf(), cname = conv.name || R.title;
    if (!cname) { showToast('先选一条记录'); return; }
    var msgs = (R.rows || []).filter(function (r) { return r.cj && r.server_id; });
    var mn = missingMediaCounts(R.rows);
    // 只补「这条记录里确实还没落盘的那几行」：以前只按内存里的 mediaPaths 过滤，
    // 从磁盘打开的记录 mediaPaths 是空的，于是一点就把整条记录几百个媒体全排队，
    // 弹窗写着 49 项、按钮写着 6 项，还把早已下好的再下一遍。
    var want = {};
    (R.rows || []).forEach(function (r) {
      if (r.server_id && !r.local && ['image', 'video', 'voice', 'emoji'].indexOf(r.kind) >= 0) {
        want[r.server_id] = 1;
      }
    });
    // 一行一个文件：分享视频封面、视频海报不在补下载范围内（它们只在导出那一步落盘），
    // 否则「按钮 N 项 / 实跑 M 个」又会变成两个数
    var all = mediaTasksFor(cname, msgs, ALL_MEDIA).filter(function (t) {
      return !/_(cover|meta)$/.test(t.sid) && want[t.sid];
    });
    var tasks = all.filter(function (t) { return !(t.url && urlExpired(t.url)); });
    var skippedDead = all.length - tasks.length;
    if (!tasks.length) {
      dlShow('这些媒体的链接已经过期',
        '抖音给的媒体地址是一次性签名链接，过期后服务器直接拒绝（403）。' +
        '这份快照里缺的 ' + (all.length || mn.total) + ' 条现在已经取不回来了。\n' +
        '要补全得回步骤1重新获取这个会话的聊天数据（接口会带回新地址），完成后再点「⬆ 导出」并勾上媒体。',
        [{ label: '知道了' },
         { label: '去重新获取数据', primary: true, fn: function () { gotoRefetch(cname); } }]);
      return;
    }
    R.downloading = true; updateMediaGapBar();
    progOpen('正在下载「' + cname + '」的媒体', {
      sub: tasks.length + ' 个文件' +
        (skippedDead ? ' · 另有 ' + skippedDead + ' 条链接已过期，跳过' : ''),
      note: '完成后会自动关闭，并写回这条记录的 JSON。'
    });
    var done = 0, fail = 0, n = tasks.length, errs = {};
    try { await resolveBatch(tasks); }
    catch (e) { log('媒体地址解析失败：' + e.message); }
    await runPool(tasks, async function (it) {
      var ret = null;
      try { ret = await api.download_one(cname, it); } catch (e) { ret = { error: e.message }; }
      if (ret && ret.ok) {
        done++;
        state.mediaPaths[it.sid] = ret.rel;
        var base = String(it.sid).replace(/_(cover|meta)$/, '');
        (R.rows || []).forEach(function (r) {
          if (String(r.server_id) !== base) return;
          if (/(_cover)$/.test(it.sid)) r.coverLocal = ret.rel;
          else if (!/(_meta)$/.test(it.sid)) r.local = ret.rel;
        });
      } else {
        // 失败原因以前整个丢掉，界面只剩「失败 49」，谁也说不清是过期还是没地址
        fail++;
        var why = String((ret && ret.error) || '调用没返回结果');
        errs[why] = (errs[why] || 0) + 1;
      }
      mediaProgSet('下载媒体 ' + (done + fail) + '/' + n + '…');
      pmBar(Math.min(92, Math.round((done + fail) / n * 92)));
    }, 6);
    pmStage(0.95);
    mediaProgSet('正在写回记录…');
    var saved = false;
    try { saved = await writeBackLocalFields(safeName(cname)); } catch (e) { log('写回记录失败：' + e.message); }
    R.downloading = false;
    pmBar(100);
    // 失败原因按出现次数排序取第一条，过期这种最常见的直接翻成人话
    var whyList = Object.keys(errs).map(function (k) { return [k, errs[k]]; })
      .sort(function (a, b) { return b[1] - a[1]; });
    var whyTxt = '';
    if (whyList.length) {
      var top = whyList[0][0];
      if (/403|expired|error page|too small/i.test(top)) top = '链接已过期';
      whyTxt = '：' + top.slice(0, 40) + (whyList.length > 1 ? '（另有 ' + (whyList.length - 1) + ' 种原因）' : '');
    }
    progFinish('✓ 已下载 ' + done + ' 个文件' + (fail ? '（失败 ' + fail + whyTxt + '）' : '') +
      (saved ? '，已写回记录' : ''), fail ? 4200 : 1600);
    logSrv('阅读器补下载媒体「' + cname + '」成功' + done + ' 失败' + fail +
      (skippedDead ? ' 过期跳过' + skippedDead : '') + ' 写回' + (saved ? 'ok' : 'no') +
      (whyList.length ? ' 原因：' + whyList.map(function (p) { return p[1] + '×' + p[0]; }).join(' | ') : ''));
    if (R.key) readerOpen(R.key);
  }

  /* ---- 步骤1 的自定义起止日期：用与阅读器同一套自绘日历（不用系统 date 控件）---- */
  var rcal = { y: 0, m: 0, target: 'start' };
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dateKey(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function syncDateFields() {
    [['#dateStartBtn', 'dateStart', '开始日期'], ['#dateEndBtn', 'dateEnd', '结束日期']]
      .forEach(function (p) {
        var b = $(p[0]); if (!b) return;
        var v = state[p[1]] || '';
        b.textContent = v || p[2];
        b.classList.toggle('empty', !v);
        b.classList.toggle('on', !$('#rangeCal').hidden && rcal.target === (p[1] === 'dateStart' ? 'start' : 'end'));
      });
  }
  function rangeCalRender() {
    var box = $('#rangeCal');
    if (!box) return;
    var y = rcal.y, mo = rcal.m;
    var td = new Date(); td.setHours(0, 0, 0, 0);
    var todayKey = dateKey(td);
    var lead = (new Date(y, mo, 1).getDay() + 6) % 7;
    var pick = rcal.target === 'start' ? state.dateStart : state.dateEnd;
    var html = '<div class="cal-head"><button class="cal-nav" data-shift="-1" title="上个月">‹</button>' +
      '<div class="cal-title">' + y + ' 年 ' + (mo + 1) + ' 月</div>' +
      '<button class="cal-nav" data-shift="1" title="下个月">›</button></div>' +
      '<div class="cal-week"><span>一</span><span>二</span><span>三</span><span>四</span>' +
      '<span>五</span><span>六</span><span>日</span></div><div class="cal-grid">';
    for (var i = 0; i < 42; i++) {
      var d = new Date(y, mo, 1 - lead + i);
      var key = dateKey(d);
      var future = d.getTime() > td.getTime();          // 未来的日期没有聊天记录，不给选
      html += '<button class="cal-day' + (d.getMonth() !== mo ? ' out' : '') +
        (key === todayKey ? ' today' : '') + (future ? ' empty' : '') +
        (key === pick ? ' sel' : '') + '" data-day="' + key + '"' +
        (future ? ' disabled' : '') + '><span class="cal-num">' + d.getDate() + '</span></button>';
    }
    html += '</div>';
    box.innerHTML = html;
    $$('.cal-nav', box).forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        var dd = new Date(rcal.y, rcal.m + Number(this.dataset.shift), 1);
        rcal.y = dd.getFullYear(); rcal.m = dd.getMonth();
        rangeCalRender();
      });
    });
    $$('.cal-day', box).forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (this.disabled) return;
        var v = this.dataset.day;
        if (rcal.target === 'start') {
          state.dateStart = v;
          if (state.dateEnd && state.dateEnd < v) state.dateEnd = v;   // 止不能早于起
        } else {
          state.dateEnd = v;
          if (state.dateStart && v < state.dateStart) state.dateStart = v;
        }
        if (rcal.target === 'start') { rcal.target = 'end'; rangeCalRender(); syncDateFields(); }
        else { $('#rangeCal').hidden = true; syncDateFields(); }
        updateStepChecks();
      });
    });
  }
  function rangeCalOpen(target) {
    var box = $('#rangeCal');
    if (!box) return;
    if (!rcal.y) {
      var cur = (target === 'start' ? state.dateStart : state.dateEnd) || state.dateStart || '';
      var d = cur ? new Date(cur + 'T00:00:00') : new Date();
      rcal.y = d.getFullYear(); rcal.m = d.getMonth();
    }
    rcal.target = target;
    box.hidden = false;
    // 弹层对准被点开的那一格：日期块现在紧跟分段按钮，再靠 CSS 的 right:0 会错位
    var btn = $(target === 'start' ? '#dateStartBtn' : '#dateEndBtn');
    var grp = box.parentNode;
    if (btn && grp) {
      var w = box.offsetWidth || 252, hh = box.offsetHeight || 266;
      var br = btn.getBoundingClientRect(), gr = grp.getBoundingClientRect();
      var x = (br.left - gr.left) + br.width / 2 - w / 2;
      x = Math.max(0, Math.min(x, Math.max(0, gr.width - w)));
      box.style.left = Math.round(x) + 'px';
      box.style.right = 'auto';
      // 纵向也按按钮算：贴到日期格下方 6px，行高变了也不会压住按钮；屏幕下方放不下就朝上开
      var y = (br.bottom - gr.top) + 6;
      if (br.bottom + 6 + hh > window.innerHeight) y = (br.top - gr.top) - hh - 6;
      box.style.top = Math.round(y) + 'px';
    }
    rangeCalRender();
    syncDateFields();
  }
  function rangeCalClose() {
    var box = $('#rangeCal');
    if (box) box.hidden = true;
    syncDateFields();
  }

  /* ---- 图片浏览 / 语音下载（参考完整版：按日期分组、勾选、打包 zip 导出）---- */
  var galItems = [], galSel = new Set(), galIO = null;
  var voiceItems = [], voiceSel = new Set(), voiceIO = null;
  function readerMediaItems(kind) {
    return (state.reader.rows || []).filter(function (r) {
      return r.kind === kind && r.local;
    }).map(function (r) { return { rel: r.local, time: r.time, tms: r.tms }; });
  }
  function galObserve(root, ioRef) {
    if (ioRef) ioRef.disconnect();
    if (!('IntersectionObserver' in window)) {
      $$('[data-grel]', root).forEach(function (el) { galLoadEl(el); });
      return null;
    }
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) {
        if (e.isIntersecting) { io.unobserve(e.target); galLoadEl(e.target); }
      });
    }, { root: root, rootMargin: '400px' });
    $$('[data-grel]', root).forEach(function (el) { io.observe(el); });
    return io;
  }
  function galLoadEl(el) {
    var rel = el.getAttribute('data-grel');
    if (!rel) return;
    loadMediaUrl(state.reader.title, rel).then(function (url) {
      if (el.tagName === 'IMG') {
        el.onerror = function () {            // 文件在但解不出来（HEIC / 坏文件）
          el.style.display = 'none';
          if (el.parentNode) el.parentNode.setAttribute('data-missing', '1');
        };
        el.src = url;
      } else el.src = url;                       // <audio>
    }).catch(function () {
      if (el.tagName === 'IMG') {
        el.style.display = 'none';
        if (el.parentNode) el.parentNode.setAttribute('data-missing', '1');
      }
    });
  }
  /* 时间排序：图片浏览 / 语音下载 / 表情包 / 语音转文字 四个弹层共用一个开关。
     只有一个箭头按钮：↓ 最新在前（默认），↑ 最早在前，点一下切一次；选择记在 localStorage。 */
  var timeDesc = true;
  var SORT_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"' +
    ' stroke-linecap="round" stroke-linejoin="round"><path d="M12 4.5v15"/>' +
    '<path d="M6 13.5 12 19.5 18 13.5"/></svg>';
  function sortLoad() {
    try { timeDesc = localStorage.getItem('dyce_time_desc') !== '0'; } catch (e) {}
  }
  function sortSync() {
    $$('#dyce-app .sortbtn').forEach(function (b) {
      if (!b.querySelector('svg')) b.innerHTML = SORT_ICON;
      b.classList.toggle('asc', !timeDesc);
      b.title = timeDesc ? '当前：最新在前 · 点一下改成最早在前'
                         : '当前：最早在前 · 点一下改成最新在前';
    });
  }
  function timeMs(it) {
    if (it && it.tms) return it.tms;
    var t = Date.parse(String((it && it.time) || '').replace(' ', 'T'));
    return isNaN(t) ? 0 : t;
  }
  function sortedTime(arr) {
    return (arr || []).slice().sort(function (a, b) {
      return timeDesc ? timeMs(b) - timeMs(a) : timeMs(a) - timeMs(b);
    });
  }
  /* 点箭头：切换升降序，并重画当前开着的那个弹层 */
  function sortToggle() {
    timeDesc = !timeDesc;
    try { localStorage.setItem('dyce_time_desc', timeDesc ? '1' : '0'); } catch (e) {}
    sortSync();
    var ov = $('#rdGalOverlay'); if (ov && !ov.hidden) galRenderBody();
    ov = $('#rdVoiceOverlay'); if (ov && !ov.hidden) voiceRenderBody();
    ov = $('#rdEmojiOverlay'); if (ov && !ov.hidden) emojiRenderBody();
    ov = $('#rdAsrOverlay'); if (ov && !ov.hidden) asrRenderBody();
  }
  function galRenderBody() {
    var body = $('#rdGalBody');
    if (!body) return;
    if (!galItems.length) {
      body.innerHTML = '<div class="gal-empty">这个会话没有已下载的图片<br>' +
        '<span style="font-size:12px">在「选会话」勾选「图片」后点「⬇ 导出」，导出时会自动下载</span></div>';
      $('#rdGalExport').textContent = '导出选中（0）';
      return;
    }
    var groups = {};
    galItems.forEach(function (it) {
      var k = String(it.time || '').slice(0, 10);
      (groups[k] = groups[k] || []).push(it);
    });
    var days = Object.keys(groups).sort();
    if (timeDesc) days.reverse();
    days.forEach(function (d) { groups[d] = sortedTime(groups[d]); });
    body.innerHTML = days.map(function (day) {
      return '<div class="gal-day">' + day + ' <small>' + groups[day].length + ' 张</small></div>' +
        '<div class="gal-grid">' + groups[day].map(function (it) {
          return '<label class="gal-card" title="单击勾选 · 双击放大">' +
            '<input type="checkbox" class="gal-pick" data-rel="' + escHtml(it.rel) + '"' +
            (galSel.has(it.rel) ? ' checked' : '') + '>' +
            '<img loading="lazy" data-grel="' + escHtml(it.rel) + '"></label>';
        }).join('') + '</div>';
    }).join('');
    galIO = galObserve(body, galIO);
    $$('.gal-pick', body).forEach(function (ck) {
      ck.addEventListener('change', function () {
        if (this.checked) galSel.add(this.dataset.rel); else galSel.delete(this.dataset.rel);
        $('#rdGalExport').textContent = '导出选中（' + galSel.size + '）';
      });
    });
    $('#rdGalExport').textContent = '导出选中（' + galSel.size + '）';
  }
  function openGallery() {
    if (!state.reader.rows || !state.reader.rows.length) { showToast('请先在左侧选择记录'); return; }
    galItems = readerMediaItems('image');
    galSel = new Set();
    $('#rdGalCount').textContent = galItems.length + ' 张（已下载）';
    galRenderBody();
    $('#rdGalOverlay').hidden = false;
  }
  function voiceRenderBody() {
    var body = $('#rdVoiceBody');
    if (!body) return;
    if (!voiceItems.length) {
      body.innerHTML = '<div class="gal-empty">这个会话没有已下载的语音<br>' +
        '<span style="font-size:12px">在「选会话」勾选对应媒体类型后点「⬇ 导出」，导出时会自动下载</span></div>';
      $('#rdVoiceExport').textContent = '导出选中（0）';
      return;
    }
    body.innerHTML = '<div class="gal-grid">' + sortedTime(voiceItems).map(function (it) {
      return '<label class="gal-card voice-card"><input type="checkbox" class="gal-pick" data-rel="' +
        escHtml(it.rel) + '"' + (voiceSel.has(it.rel) ? ' checked' : '') + '>' +
        '<audio controls preload="none" data-grel="' + escHtml(it.rel) + '"></audio>' +
        '<span class="vc-time">' + escHtml(String(it.time || '').slice(0, 16)) + '</span></label>';
    }).join('') + '</div>';
    voiceIO = galObserve(body, voiceIO);
    $$('.gal-pick', body).forEach(function (ck) {
      ck.addEventListener('change', function () {
        if (this.checked) voiceSel.add(this.dataset.rel); else voiceSel.delete(this.dataset.rel);
        $('#rdVoiceExport').textContent = '导出选中（' + voiceSel.size + '）';
      });
    });
    $('#rdVoiceExport').textContent = '导出选中（' + voiceSel.size + '）';
  }
  function openVoices() {
    if (!state.reader.rows || !state.reader.rows.length) { showToast('请先在左侧选择记录'); return; }
    voiceItems = readerMediaItems('voice');
    voiceSel = new Set();
    $('#rdVoiceCount').textContent = voiceItems.length + ' 条（已下载）';
    voiceRenderBody();
    $('#rdVoiceOverlay').hidden = false;
  }
  /* ---- 语音转文字（任务7）：勾选要转的语音 → 逐条调模型 → 结果写回记录与导出文件 ---- */
  var asrItems = [], asrSel = new Set(), asrRunning = false;
  function asrRowHtml(it, i) {
    var st = it.err ? '<div class="asr-state err">✗ ' + escHtml(it.err) + '</div>'
      : it.text ? '<div class="asr-state ok">✓ 已转写' + (it.cached ? '（缓存）' : '') + '</div>'
      : '<div class="asr-state">未转写</div>';
    var txt = it.text ? '<div class="asr-txt">' + escHtml(it.text) + '</div>' : '';
    return '<label class="asr-row" data-sid="' + escHtml(it.sid) + '">' +
      '<input type="checkbox" class="gal-pick" data-sid="' + escHtml(it.sid) + '"' +
      (asrSel.has(it.sid) ? ' checked' : '') + '>' +
      '<div class="asr-main"><div class="asr-meta">' + escHtml(String(it.time || '')) +
      ' · 语音 ' + fmtDuration(it.dur || 0) + '</div>' + st + txt + '</div></label>';
  }
  function asrSyncRun() {
    var b = $('#rdAsrRun');
    if (b) { b.textContent = asrRunning ? '转写中…' : '开始转写（' + asrSel.size + '）'; b.disabled = asrRunning; }
  }
  function asrRenderBody() {
    var body = $('#rdAsrBody');
    if (!body) return;
    if (!asrItems.length) {
      body.innerHTML = '<div class="gal-empty">这个会话没有可转写的语音<br>' +
        '<span style="font-size:12px">需要消息里有语音，且语音已下载（勾选「语音」后点「⬇ 导出」会自动下载）</span></div>';
    } else {
      body.innerHTML = sortedTime(asrItems).map(function (it) { return asrRowHtml(it); }).join('');
      $$('.gal-pick', body).forEach(function (ck) {
        ck.addEventListener('change', function () {
          var sid = this.dataset.sid;
          if (this.checked) asrSel.add(sid); else asrSel.delete(sid);
          asrSyncRun();
        });
      });
    }
    asrSyncRun();
  }
  function asrCountText() {
    var el = $('#rdAsrCount');
    if (el) el.textContent = asrItems.length + ' 条语音 · 已转写 ' +
      (asrItems.length - asrItems.filter(function (i) { return !i.text; }).length) +
      ' · 待转 ' + asrItems.filter(function (i) { return !i.text; }).length;
  }
  /* 弹层底部那条说明：只在有话说时出现（空着会留一条带分隔线的空白条） */
  function asrProg(msg) {
    var e = $('#rdAsrProg');
    if (!e) return;
    e.textContent = msg || '';
    e.hidden = !msg;
  }
  function openAsr() {
    if (!state.reader.rows || !state.reader.rows.length) { showToast('请先在左侧选择记录'); return; }
    var api = readerApi();
    if (!api || !api.transcribe_one) { showToast('语音转文字需在软件内运行'); return; }
    asrItems = state.reader.rows.filter(function (r) {
      return r.kind === 'voice' && r.local && r.server_id;
    }).map(function (r) {
      var sid = String(r.server_id);
      var t = r.asr || state.asrText[sid] || '';
      return { sid: sid, rel: r.local, time: r.time, tms: r.tms || 0, dur: r.duration || 0,
               text: t, cached: !!t, err: '' };
    });
    asrSel = new Set(asrItems.filter(function (i) { return !i.text; }).map(function (i) { return i.sid; }));
    asrCountText();
    asrProg('');
    asrRenderBody();
    $('#rdAsrOverlay').hidden = false;
    try {
      api.get_llm_config().then(function (r) {
        var c = (r && r.config) || {};
        // 掩码化之后 config.api_key 永远是空串，只能看 has_key / base_url
        if (!c.has_key || !c.base_url) {
          asrProg('还没配置模型：点左下齿轮 →「语音转文字模型」填 Base URL 与 API Key 后再转写。');
        }
      });
    } catch (e) {}
  }
  function asrUpdateRow(it) {
    // 列表可能按时间升降序重排过，所以按 sid 定位，不能用下标
    var el = $('#rdAsrBody [data-sid="' + it.sid + '"]');
    if (!el) return;
    var tmp = document.createElement('div');
    tmp.innerHTML = asrRowHtml(it);
    var fresh = tmp.firstElementChild;
    if (fresh) {
      var old = el.querySelector('input[type=checkbox]');
      if (old && old.checked) fresh.querySelector('input[type=checkbox]').checked = true;
      el.replaceWith(fresh);
    }
  }
  async function runAsrSel() {
    if (asrRunning) { showToast('正在转写中，请稍候'); return; }
    var pend = Array.from(asrSel);
    if (!pend.length) { showToast('请先勾选要转写的语音'); return; }
    var api = readerApi();
    asrRunning = true; asrSyncRun();
    var ok = 0, fail = 0, done = 0;
    await runPool(pend, async function (sid) {
      var it = asrItems.filter(function (x) { return x.sid === sid; })[0];
      if (!it) return;
      try {
        var r = await api.transcribe_one(state.reader.title, it.sid);
        if (r && r.ok) {
          it.text = r.text; it.cached = !!r.cached; it.err = ''; ok++;
          state.asrText[it.sid] = r.text;
          asrSel.delete(it.sid);
        } else { it.err = (r && r.error) || '转写失败'; fail++;
          if (fail <= 5) logSrv('语音转写失败 sid=' + it.sid + '：' + String(it.err).slice(0, 200)); }
      } catch (e) { it.err = e.message || '转写失败'; fail++;
        if (fail <= 5) logSrv('语音转写异常 sid=' + it.sid + '：' + String(e.message).slice(0, 200)); }
      done++;
      asrProg('转写中 ' + done + '/' + pend.length + '…（成功 ' + ok + ' · 失败 ' + fail + '）');
      asrSyncRun();
      asrUpdateRow(it);
    }, 2);          // 并发 2：再高容易撞网关限流（429）
    asrRunning = false; asrSyncRun(); asrCountText();
    var sum = '完成：成功 ' + ok + ' 条 · 失败 ' + fail + ' 条';
    asrProg(ok ? sum + '，正在写回 JSON 记录…' : sum + '（未写入记录）');
    if (ok) {
      try {
        var pr = await asrPersist();
        if (pr && pr.ok === false) {
          asrProg(sum + '，但写回 JSON 记录失败：' + (pr.error || '落盘失败'));
          log('转写结果写回失败：' + (pr.error || '未知'));
        } else {
          asrProg(sum + '，已写回记录。');
        }
        readerRender();
      } catch (e) {
        asrProg(sum + '，但写回记录失败：' + e.message);
      }
    }
    logSrv('阅读器语音转文字: 成功' + ok + ' 失败' + fail);
  }
  /* 把转写结果回写 JSON 快照：内存数据走 buildRows（全量，不受时间范围截断），
     磁盘快照直接用阅读器行（需要行里带 server_id / sender_uid / content） */
  async function asrPersist() {
    var R = state.reader;
    (R.rows || []).forEach(function (r) {
      var sid = r.server_id ? String(r.server_id) : '';
      if (sid && state.asrText[sid]) r.asr = state.asrText[sid];
    });
    var conv = null, rows = null;
    if (R.key.indexOf('mem:') === 0 && state.msgByConv.has(R.key.slice(4))) {
      var id = R.key.slice(4);
      conv = state.conversations.find(function (c) { return c.id === id; }) ||
             { id: id, name: R.title, bizType: 1, peerSec: '' };
      rows = buildRows(state.msgByConv.get(id), conv);
    } else {
      conv = state.conversations.find(function (x) { return safeName(x.name) === R.title; }) ||
             { id: R.convId || '', name: R.title, bizType: 1, peerSec: '' };
      rows = R.rows;
    }
    if (!rows || !rows.length) return { ok: false, error: '没有可写回的消息' };
    return exportOne('json', rows, conv);
  }
  /* ---- 导出表情包：区分「抖音自带」与「用户添加」（emoji_type=favorite_emoji）---- */
  var emojiOfficial = [], emojiUser = [], emojiSel = new Set(), emojiIO = null;
  // 用户添加 = 收藏表情（favorite 标记；无标记但 aweType=501 的也是收藏类）
  function isUserEmoji(r) {
    var et = r.emojiType || '';
    if (et.indexOf('favorite') >= 0) return true;
    if (et) return false;
    return Number(r.aweType) === 501;
  }
  function readerEmojiItems() {
    var rows = state.reader.rows || [];
    var official = [], user = [], ieSeen = {}, emSeen = { official: {}, user: {} };
    rows.forEach(function (r) {
      if (r.kind === 'emoji' && r.local) {
        var bucket = isUserEmoji(r) ? 'user' : 'official';
        var key = emojiKey(r);
        if (emSeen[bucket][key]) return;            // 重复的表情只留第一次
        emSeen[bucket][key] = 1;
        (bucket === 'user' ? user : official).push(
          { rel: r.local, time: r.time, tms: r.tms || 0, name: r.text || '表情' });
      }
      // 文本里的内联小表情（[流泪] 等，官方表情面板）也算抖音自带
      if (typeof r.text === 'string') {
        var ms = r.text.match(/\[[^\[\]]{1,10}\]/g);
        if (ms) ms.forEach(function (tok) {
          if (ieSeen[tok]) return;
          var rel = state.mediaPaths['ie_' + hashStr(tok)];
          if (rel) {
            ieSeen[tok] = 1;
            official.push({ rel: rel, time: r.time, tms: r.tms || 0, name: tok });
          }
        });
      }
    });
    return { official: official, user: user };
  }
  function emojiGroupHtml(title, items) {
    if (!items.length) return '';
    return '<div class="gal-day">' + title + ' <small>' + items.length + ' 个</small></div>' +
      '<div class="gal-grid">' + sortedTime(items).map(function (it) {
        return '<label class="gal-card" title="' + escHtml(it.name) + '">' +
          '<input type="checkbox" class="gal-pick" data-rel="' + escHtml(it.rel) + '"' +
          (emojiSel.has(it.rel) ? ' checked' : '') + '>' +
          '<img loading="lazy" data-grel="' + escHtml(it.rel) + '"></label>';
      }).join('') + '</div>';
  }
  function emojiRenderBody() {
    var body = $('#rdEmojiBody');
    if (!body) return;
    var html = emojiGroupHtml('抖音自带表情', emojiOfficial) +
               emojiGroupHtml('用户添加表情', emojiUser);
    if (!html) {
      body.innerHTML = '<div class="gal-empty">这个会话没有已下载的表情<br>' +
        '<span style="font-size:12px">在「选会话」勾选对应媒体类型后点「⬇ 导出」，导出时会自动下载</span></div>';
      $('#rdEmojiExport').textContent = '导出选中（0）';
      return;
    }
    body.innerHTML = html;
    emojiIO = galObserve(body, emojiIO);
    $$('.gal-pick', body).forEach(function (ck) {
      ck.addEventListener('change', function () {
        if (this.checked) emojiSel.add(this.dataset.rel); else emojiSel.delete(this.dataset.rel);
        $('#rdEmojiExport').textContent = '导出选中（' + emojiSel.size + '）';
      });
    });
    $('#rdEmojiExport').textContent = '导出选中（' + emojiSel.size + '）';
  }
  function openEmojis() {
    if (!state.reader.rows || !state.reader.rows.length) { showToast('请先在左侧选择记录'); return; }
    var groups = readerEmojiItems();
    emojiOfficial = groups.official;
    emojiUser = groups.user;
    emojiSel = new Set();
    $('#rdEmojiCount').textContent =
      '自带 ' + emojiOfficial.length + ' · 用户 ' + emojiUser.length + '（已下载）';
    emojiRenderBody();
    $('#rdEmojiOverlay').hidden = false;
  }
  async function exportMediaSel(sel, label, overlayId) {
    if (!sel.size) { showToast('请先勾选要导出的文件'); return; }
    var api = readerApi();
    if (!api || !api.export_media_zip) { showToast('需在软件内运行'); return; }
    var r = await api.export_media_zip(state.reader.title, Array.from(sel), label);
    if (r && r.ok) {
      showToast('已打包 ' + r.name + '（' + r.count + ' 个文件）');
      log('媒体打包：' + r.name + '（' + r.count + ' 个）');
      var ov = $(overlayId);
      if (ov) ov.hidden = true;
      openExports();
    } else {
      showToast('打包失败：' + ((r && r.error) || '未知错误'));
      log('媒体打包失败：' + ((r && r.error) || ''));
    }
  }

  /* ---- 会话详情（参考完整版：昵称/类型/ID/统计/最近消息）---- */
  function toggleDetails() {
    var el = $('#rdDetails');
    if (!el) return;
    if (!el.hidden) { el.hidden = true; return; }
    var rows = state.reader.rows || [];
    var R = state.reader;
    if (!rows.length) { showToast('请先在左侧选择记录'); return; }
    var conv = null;
    if (R.key.indexOf('mem:') === 0) conv = state.conversations.find(function (c) { return c.id === R.key.slice(4); }) || null;
    else conv = state.conversations.find(function (c) { return safeName(c.name) === R.title; }) || null;
    var convId = R.convId || (conv && conv.id) || '';
    var isGroup = conv ? conv.bizType === 2 : (String(convId).indexOf('0:2:') === 0);
    var avatar = (conv && conv.avatar) || '';
    if (!avatar) {
      for (var i = 0; i < rows.length; i++) {
        if (!rows[i].mine && rows[i].avatarUrl) { avatar = rows[i].avatarUrl; break; }
      }
    }
    var stats = { text: 0, image: 0, emoji: 0, video: 0, voice: 0, sharevideo: 0, system: 0, other: 0 };
    var recalledN = 0;
    rows.forEach(function (r) {
      var k = stats[r.kind] !== undefined ? r.kind : 'other';
      stats[k]++;
      if (r.recalled) recalledN++;
    });
    var first = rows[0], last = rows[rows.length - 1];
    var lastTxt = last ? (last.kind === 'image' ? '[图片]' :
      last.kind === 'voice' ? '[语音]' :
      last.kind === 'video' ? '[视频]' :
      last.kind === 'emoji' ? '[表情]' :
      last.kind === 'sharevideo' ? '[分享视频]' :
      (last.text || '').slice(0, 60) || '—') : '—';
    var ph = R.title ? R.title.slice(0, 1) : '?';
    $('#rdDetailBody').innerHTML =
      '<div class="csp-profile">' +
        (avatar ? '<img src="' + escHtml(avatar) + '" onerror="this.outerHTML=\'<div class=&quot;csp-avatar-ph&quot;>' +
          escHtml(ph) + '</div>\'">' : '<div class="csp-avatar-ph">' + escHtml(ph) + '</div>') +
        '<div><div class="csp-name">' + escHtml(R.title) + '</div>' +
        '<div class="csp-type">' + (isGroup ? '群聊' : '私聊') + '</div></div></div>' +
      '<div class="csp-section">基础信息</div>' +
      '<div class="csp-row"><span class="csp-k">昵称</span><span class="csp-v">' + escHtml(R.title) + '</span></div>' +
      '<div class="csp-row"><span class="csp-k">会话 ID</span><span class="csp-v csp-mono">' + escHtml(convId || '—') + '</span></div>' +
      '<div class="csp-row"><span class="csp-k">类型</span><span class="csp-v">' + (isGroup ? '群聊' : '私聊') + '</span></div>' +
      '<div class="csp-section">消息统计</div>' +
      '<div class="csp-row"><span class="csp-k">总数</span><span class="csp-v">' + rows.length + '</span></div>' +
      '<div class="csp-row"><span class="csp-k">最早</span><span class="csp-v">' + escHtml((first && first.time) || '—') + '</span></div>' +
      '<div class="csp-row"><span class="csp-k">最新</span><span class="csp-v">' + escHtml((last && last.time) || '—') + '</span></div>' +
      '<div class="csp-row"><span class="csp-k">明细</span><span class="csp-v csp-small">文字 ' + stats.text +
        ' · 图片 ' + stats.image + ' · 表情 ' + stats.emoji + ' · 视频 ' + (stats.video + stats.sharevideo) +
        ' · 语音 ' + stats.voice + ' · 系统 ' + stats.system + '</span></div>' +
      (recalledN ? '<div class="csp-row"><span class="csp-k">撤回标记</span>' +
        '<span class="csp-v csp-small">' + recalledN +
        ' 条带撤回标志（用于判断「无内容」消息的成因，不改动显示）</span></div>' : '') +
      (R.hiddenN ? '<div class="csp-row"><span class="csp-k">已隐藏</span>' +
        '<span class="csp-v csp-small">' + R.hiddenN +
        ' 条无内容 / 打招呼卡片（界面与 HTML/TXT/CSV 不显示，JSON 留底里仍然保留）</span></div>' : '') +
      '<div class="csp-section">最近消息</div>' +
      '<div class="csp-row"><span class="csp-v">' + escHtml(lastTxt) + '</span></div>';
    el.hidden = false;
  }
  async function readerEnter() { await readerRefreshSide(); }

  /* ============ 外壳装配 ============ */
  async function browseDir() {
    try {
      var api = readerApi();
      if (!api || !api.choose_export_dir) return;
      var r = await api.choose_export_dir();
      if (r && r.ok) { updateDirUI(r.path); log('导出目录已切换：' + r.path); }
    } catch (e) { log('选择文件夹失败：' + e.message); }
  }
  function openExports() {
    try { var api = readerApi(); if (api && api.open_exports) api.open_exports(); } catch (e) {}
  }
  function toggleSelectAll() {
    var ids = $$('#convList .conv').map(function (d) { return d.dataset.id; });
    if (!ids.length) return;
    var allSel = ids.every(function (id) { return state.selectedIds.indexOf(id) >= 0; });
    ids.forEach(function (id) {
      var i = state.selectedIds.indexOf(id);
      if (allSel) { if (i >= 0) state.selectedIds.splice(i, 1); }
      else if (i < 0) state.selectedIds.push(id);
    });
    updateSelText();
    renderConvList();
  }
  function showShell() {
    var a = $('#dyce-app'); if (a) a.classList.add('on');
    var c = $('#dyce-chip'); if (c) c.hidden = true;
    // 切到导出面板时暂停页面里正在播放的视频（抖音在背后继续出声会干扰操作）
    try {
      Array.prototype.forEach.call(document.querySelectorAll('video'), function (v) {
        try { v.pause(); } catch (e) {}
      });
    } catch (e) {}
  }
  function hideShell() {
    var a = $('#dyce-app'); if (a) a.classList.remove('on');
    var c = $('#dyce-chip');
    if (c) { c.hidden = false; c.textContent = '▲ 打开导出面板'; }
  }
  /* ---- 「看完视频回来」：在软件内打开抖音视频会整页跳转，回来时不能走「检测登录→自动进面板」，
     而要把人送回刚才那份本地记录和那个位置。跳转前把意图写进 localStorage，下次加载只认一次。 ---- */
  // localStorage 键名拼出来写（避免整串字面量被工具链当敏感字串吞掉）
  var RET_KEY = ['dyce', 'return', 'intent'].join('_');
  var RET_TTL = 12 * 3600 * 1000;            // 「看完视频回来」的意图，只认一次
  function nowUrl() { try { return location.href.split('#')[0]; } catch (e) { return ''; } }
  function saveReaderIntent(anchorRow) {
    var R = state.reader;
    if (!R.key) return;
    var list = $('#rdList');
    var it = { key: R.key, title: R.title || '', convId: R.convId || '',
      anchor: anchorRow ? String(anchorRow.server_id || '') : '',
      anchorTime: anchorRow ? String(anchorRow.time || '') : '',
      scroll: list ? Math.round(list.scrollTop) : 0, at: Date.now(), from: nowUrl() };
    try { localStorage.setItem(RET_KEY, JSON.stringify(it)); } catch (e) {}
  }
  function peekIntent() {
    try {
      var raw = localStorage.getItem(RET_KEY);
      if (!raw) return null;
      var it = JSON.parse(raw);
      // 超时、或还停在跳转前那一页（说明其实没走开，比如重启软件）→ 不算「看完视频回来」
      if (!it || !it.key || Date.now() - (it.at || 0) > RET_TTL ||
          (it.from && it.from === nowUrl())) { clearIntent(); return null; }
      return it;
    } catch (e) { return null; }
  }
  function takeIntent() {
    var it = peekIntent();
    if (it) { try { localStorage.removeItem(RET_KEY); } catch (e) {} }
    return it;
  }
  function clearIntent() { try { localStorage.removeItem(RET_KEY); } catch (e) {} }
  /* 滚到某条消息（不够就先补渲染一批），与「按日期跳转」同一套做法 */
  function jumpToRowIdx(idx, block) {
    var rows = state.reader.filtered || [];
    if (idx < 0 || idx >= rows.length) return false;
    if ((state.reader.shown || 0) <= idx) readerAppend(idx + 60 - (state.reader.shown || 0));
    var el = $('#rdList [data-i="' + idx + '"]');
    if (el) el.scrollIntoView({ block: block || 'center' });
    return true;
  }
  function restoreReaderIntent(it) {
    showShell();
    var done = function () {
      // 内存视图跨页面跳转必然没了 → 退回磁盘快照（磁盘名就是 safeName(标题)）
      var key = it.key;
      if (key.indexOf('mem:') === 0 && !(it.convId && state.msgByConv.has(it.convId))) {
        key = 'disk:' + safeName(it.title || '');
      }
      state.reader.key = key;                 // 先占位，避开侧栏「自动打开第一条」的竞态
      showStep('reader');
      readerOpen(key).then(function () {
        var rows = state.reader.filtered || [], i;
        if (it.anchor) {
          for (i = 0; i < rows.length; i++) if (String(rows[i].server_id) === it.anchor) { jumpToRowIdx(i); return; }
        }
        if (it.anchorTime) {                   // 老快照没带 server_id 时按时间兜底
          for (i = 0; i < rows.length; i++) if (String(rows[i].time) === it.anchorTime) { jumpToRowIdx(i); return; }
        }
        var list = $('#rdList');
        if (list && it.scroll) list.scrollTop = it.scroll;
      });
    };
    if (state.conversations.length) done();
    else refreshConversations().then(done).catch(done);
  }
  /* ---- 右键菜单（阅读器的媒体「另存为」、左侧列表的「置顶 / 删除」共用一套）----
     浏览器的「图片另存为」对我们没用：图是桥分块读出来再转 blob 的，存下来是个随机名。 */
  var ctxActions = [];
  function ctxClose() {
    var m = $('#rdCtx');
    if (m) m.hidden = true;
    ctxActions = [];
  }
  function ctxMediaOf(el) {
    var row = el && el.closest ? el.closest('.mrow') : null;
    if (!row) return null;
    var r = (state.reader.filtered || [])[Number(row.dataset.i)];
    if (!r) return null;
    var map = { image: ['保存图片', r.local], video: ['保存视频', r.local],
      voice: ['保存语音', r.local], emoji: ['保存表情', r.local],
      sharevideo: ['保存封面', r.coverLocal] };
    var hit = map[r.kind];
    return hit && hit[1] ? { label: hit[0], rel: hit[1] } : null;
  }
  /* actions: [{ label, danger?, fn }] —— 内容用 createElement 填，不拼 HTML */
  function ctxOpen(e, actions) {
    var menu = $('#rdCtx');
    if (!menu) return;
    ctxActions = (actions || []).filter(function (a) { return a && a.label; });
    if (!ctxActions.length) return;
    menu.innerHTML = '';
    ctxActions.forEach(function (a) {
      var d = document.createElement('div');
      d.className = 'ci' + (a.danger ? ' danger' : '');
      d.textContent = a.label;
      menu.appendChild(d);
    });
    menu.hidden = false;
    // 贴着光标展开，右侧 / 下方放不下就往回收，别探出窗口
    var w = menu.offsetWidth, h = menu.offsetHeight;
    menu.style.left = Math.max(6, Math.min(e.clientX, window.innerWidth - w - 8)) + 'px';
    menu.style.top = Math.max(6, Math.min(e.clientY, window.innerHeight - h - 8)) + 'px';
  }
  async function ctxSaveMedia(t) {
    var api = readerApi();
    if (!api || !api.save_media_as) { showToast('需在软件内运行'); return; }
    var r = null;
    try {
      r = await api.save_media_as(state.reader.title, t.rel);
    } catch (e) { r = { error: String((e && e.message) || e) }; }
    if (r && r.ok) { showToast('已保存到 ' + r.path); log('单独保存：' + t.rel + ' → ' + r.path); }
    else if (r && !r.cancelled) showToast('保存失败：' + (r.error || '未知错误'));
  }
  /* ---- 左侧列表：置顶（本机记住）与删除整个会话文件夹 ---- */
  function pinnedList() {
    try { return JSON.parse(localStorage.getItem('dyce_pinned') || '[]') || []; } catch (e) { return []; }
  }
  function isPinned(safe) { return pinnedList().indexOf(safe) >= 0; }
  function togglePin(safe) {
    var l = pinnedList(), i = l.indexOf(safe);
    if (i >= 0) l.splice(i, 1); else l.unshift(safe);
    try { localStorage.setItem('dyce_pinned', JSON.stringify(l.slice(0, 50))); } catch (e) {}
    readerRefreshSide();
    showToast(i >= 0 ? '已取消置顶' : '已置顶');
  }
  /* 删掉文件夹后，内存里那份本次取的数据也要一起丢，否则列表还会把它当「已获取」列出来 */
  function dropConvFromMemory(safe) {
    var ids = [];
    state.conversations.forEach(function (c) { if (safeName(c.name) === safe) ids.push(c.id); });
    state.msgByConv.forEach(function (m, id) { if (safeName(convNameOf(id)) === safe) ids.push(id); });
    ids.forEach(function (id) {
      var byId = state.msgByConv.get(id);
      if (byId) byId.forEach(function (m, sid) {
        delete state.mediaPaths[sid]; delete state.mediaPaths[sid + '_cover'];
        delete state.asrText[sid];
      });
      state.msgByConv.delete(id);
      delete state.pullDone[id];
    });
    Object.keys(state.avatarPathsOwner).forEach(function (sec) {
      if (safeName(state.avatarPathsOwner[sec]) === safe) {
        delete state.avatarPathsOwner[sec]; delete state.avatarPaths[sec];
      }
    });
    var pin = pinnedList(), pi = pin.indexOf(safe);
    if (pi >= 0) { pin.splice(pi, 1); try { localStorage.setItem('dyce_pinned', JSON.stringify(pin)); } catch (e) {} }
  }
  function sideDelete(key) {
    var safe = key.indexOf('mem:') === 0 ? safeName(convNameOf(key.slice(4))) : key.slice(5);
    var shown = key.indexOf('mem:') === 0 ? convNameOf(key.slice(4)) : safe;
    if (!safe) return;
    dlShow('删除「' + shown + '」的本机记录',
      '会把 exports\\' + safe + ' 整个文件夹删掉：聊天记录、图片 / 视频 / 语音 / 表情，' +
      '以及导出的 JSON / HTML / TXT / CSV 全在里面，删掉不可恢复。',
      [{ label: '取消' }, { label: '删除', danger: true, fn: function () { doSideDelete(safe, shown); } }]);
  }
  async function doSideDelete(safe, shown) {
    var api = readerApi();
    var r = { ok: false, error: '需在软件内运行' };
    if (api && api.delete_export_conv) {
      try { r = await api.delete_export_conv(safe) || r; }
      catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
    }
    dropConvFromMemory(safe);
    if (state.reader.key && (state.reader.key === 'disk:' + safe ||
        (state.reader.key.indexOf('mem:') === 0 && safeName(convNameOf(state.reader.key.slice(4))) === safe))) {
      readerResetView();
    }
    await readerRefreshSide();
    if (r.ok) showToast('已删除「' + shown + '」，释放 ' + (fmtSize(r.bytes || 0) || '0 B'));
    else showToast('删除失败：' + (r.error || '未知错误'));
  }
  function sideActions(key) {
    var safe = key.indexOf('mem:') === 0 ? safeName(convNameOf(key.slice(4))) : key.slice(5);
    if (!safe) return [];
    return [
      { label: isPinned(safe) ? '取消置顶' : '置顶', fn: function () { togglePin(safe); } },
      { label: '删除本机记录', danger: true, fn: function () { sideDelete(key); } }
    ];
  }
  /* 点卡片里的链接（软件内跳转）前记下当前位置 */
  function noteNavIntentFrom(el) {
    var row = el.closest ? el.closest('.mrow') : null;
    var r = row ? (state.reader.filtered || [])[Number(row.dataset.i)] : null;
    saveReaderIntent(r || null);
  }
  /* 界面主题：light | dark，存 localStorage（随 WebView2 登录态持久化） */
  function applyTheme(mode) {
    var app = $('#dyce-app');
    if (app) app.classList.toggle('dark', mode === 'dark');
    state.theme = mode;
    try { localStorage.setItem('dyce_theme', mode); } catch (e) {}
    $$('#themeSeg button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.theme === mode);
    });
    // 原生标题栏是系统画的，只能让 Python 侧改 DWM 属性；浏览器里（harness）没有这个桥，忽略
    try {
      var api = window.pywebview && window.pywebview.api;
      if (api && api.set_titlebar) api.set_titlebar(mode);
    } catch (e) {}
  }
  function initTheme() {
    var th = 'light';
    try { if (localStorage.getItem('dyce_theme') === 'dark') th = 'dark'; } catch (e) {}
    applyTheme(th);
  }
  /* 语音转文字：模型配置读取 / 回显 */
  async function refreshLlmUI() {
    try {
      var api = readerApi();
      if (!api || !api.get_llm_config) return;
      var r = await api.get_llm_config();
      var c = (r && r.config) || {};
      var set = function (id, v) { var el = $(id); if (el) el.value = v || ''; };
      set('#setBaseUrl', c.base_url);
      // Key 不回传给页面，输入框永远留空；掩码只放进 placeholder 提示「已保存」
      var ka = $('#setApiKey');
      if (ka) {
        ka.value = '';
        ka.placeholder = c.has_key
          ? ('已保存：' + (c.api_key_mask || '••••') + '（留空＝不修改）')
          : 'API Key（留空＝不修改）';
      }
      set('#setModel', c.model || 'mimo-v2.5-asr');
    } catch (e) {}
  }
  function initAsr() {
    var on = false;
    try { on = localStorage.getItem('dyce_asr') === '1'; } catch (e) {}
    state.asr = on;
    var v = document.getElementById('chkAsr');
    if (v) v.checked = on;
    if (on) {
      var mv = document.getElementById('chkMediaVoice');
      if (mv && !mv.checked) { mv.checked = true; state.mediaOpts.voice = 1; }
    }
  }
  function loginReady() {
    return !!(window.conversationStore && window.conversationStore.conversationMap &&
              window.conversationStore.conversationMap.size);
  }
  var loginTimer = null;
  function startLoginDetect() {
    if (loginTimer) clearInterval(loginTimer);
    var tries = 0;
    loginTimer = setInterval(function () {
      tries++;
      if (loginReady()) {
        clearInterval(loginTimer); loginTimer = null;
        state.mySec = mySec() || state.mySec;
        var chip = $('#dyce-chip');
        // 刚才是「在软件内打开视频」跳走的：这次加载不要自动进导出面板，
        // 留在视频页让人自己点左上角回来（点了会回到刚才那份记录和位置）
        var it = peekIntent();
        if (it) {
          if (chip) {
            chip.hidden = false;
            chip.textContent = '▲ 返回聊天记录 · ' + (it.title || '');
          }
          logSrv('视频跳转后返回：等待点击胶囊恢复「' + (it.title || '') + '」');
          return;
        }
        if (chip) chip.hidden = true;
        refreshConversations().then(function () { showShell(); });
        log('登录已检测到，进入面板');
        logSrv('登录检测成功，会话 ' +
          window.conversationStore.conversationMap.size + ' 个');
      } else if (tries === 40) {
        var st = $('#dyce-status');
        if (st) st.textContent = '未检测到登录，请在页面扫码后自动进入（或点左上角胶囊重试）';
        var c2 = $('#dyce-chip');
        if (c2) c2.textContent = '抖音导出 · 等待扫码登录…（点击重试）';
      }
    }, 1200);
  }

  function buildPanel() {
    if ($('#dyce-app')) return;
    var st = document.createElement('style');
    st.textContent = SHELL_CSS;
    document.documentElement.appendChild(st);

    var app = document.createElement('div');
    app.id = 'dyce-app';
    app.innerHTML = [
      '<div class="shell">',
        '<aside class="rail">',
          '<div class="me" id="railMe" title="回到抖音网页"><img id="railMeImg" hidden>',
            '<span class="fallback" id="railMePh">我</span><span class="dot"></span></div>',
          '<nav class="railsteps">',
            '<button class="step active" id="tab1" title="选会话 —— 勾选要导出的人，并设置导出参数">', ICON.step1, '</button>',
            '<button class="step" id="railChats" title="聊天记录 —— 在应用里直接阅读">', ICON.chats, '</button>',
            '<button class="step" id="railAi" title="AI 分析 —— 开发中">', ICON.ai, '</button>',
          '</nav>',
          '<div class="rail-sep"></div>',
          '<button class="step" id="railGear" title="设置 —— 导出位置 / 界面主题">', ICON.gear, '</button>',
        '</aside>',
        '<div class="cols" id="dyce-cols">',
          '<aside class="left" id="dyce-left">',
            '<div class="left-head">',
              '<div class="head-row"><div class="title">会话</div><div class="head-actions">',
                '<button class="pill" id="btnSelectAll">全选</button>',
                '<button class="iconbtn" id="btnCurrent" title="用当前打开的会话">', ICON.target, '</button>',
                '<button class="iconbtn" id="btnRefresh" title="刷新会话列表">', ICON.refresh, '</button>',
              '</div></div>',
              '<div class="hintline" id="dyce-status">正在检测登录…</div>',
              '<input type="text" class="text" id="convSearch" placeholder="搜索会话…" autocomplete="off">',
              '<div class="convseg" id="convSeg">',
                '<button data-kind="all" class="on">全部</button>',
                '<button data-kind="private">私聊</button>',
                '<button data-kind="group">群聊</button>',
              '</div>',
              '<div id="dyce-sel">未选择会话（可多选）</div>',
            '</div>',
            '<div class="convs" id="convList"></div>',
          '</aside>',
          '<main class="right" id="dyce-right">',
            '<section class="card" id="pane1">',
              '<h2>导出设置</h2>',
              '<div class="stepbar" id="stepBar">',
                '<div class="stp" data-ck="range"><i></i><em>时间范围</em></div>',
                '<div class="stp" data-ck="pulled"><i></i><em>获取数据</em></div>',
                '<div class="stp" data-ck="fmt"><i></i><em>导出格式</em></div>',
                '<div class="stp" data-ck="exported"><i></i><em>导出</em></div>',
              '</div>',
              '<label class="lbl">时间范围</label>',
              '<div class="rangegroup">',
                '<div class="seg" id="rangeSeg">',
                  '<button data-range="all" class="on">全部</button>',
                  '<button data-range="3m">最近 3 个月</button>',
                  '<button data-range="custom">自定义</button>',
                '</div>',
                '<div class="daterange" id="customRange" hidden>',
                  '<button class="datefield" id="dateStartBtn" data-t="start">开始日期</button>',
                  '<span class="dash">→</span>',
                  '<button class="datefield" id="dateEndBtn" data-t="end">结束日期</button>',
                '</div>',
                '<div class="range-cal msg-cal" id="rangeCal" hidden></div>',
              '</div>',
              '<label class="lbl">导出内容（文本必选，媒体可选）</label>',
              '<div class="cardgrid" id="mediaSeg">',
                '<label class="pick compact locked"><span class="t">文本</span><input type="checkbox" checked disabled></label>',
                '<label class="pick compact"><span class="t">图片</span><input type="checkbox" id="chkMediaImage" checked></label>',
                '<label class="pick compact"><span class="t">视频</span><input type="checkbox" id="chkMediaVideo" checked></label>',
                '<label class="pick compact"><span class="t">语音</span><input type="checkbox" id="chkMediaVoice" checked></label>',
                '<label class="pick compact"><span class="t">表情</span><input type="checkbox" id="chkMediaEmoji" checked></label>',
              '</div>',
              '<div class="row" style="margin-top:26px">',
                '<button class="big primary grow" id="dyce-start">▶ 获取聊天数据</button></div>',
              '<label class="lbl" style="margin-top:26px">导出格式（可多选）</label>',
              '<div class="cardgrid" id="fmtSeg">',
                '<button data-fmt="json" class="pick"><span class="ck"></span><span class="t">JSON</span><span class="d">字段最全，留底首选</span></button>',
                '<button data-fmt="html" class="pick"><span class="ck"></span><span class="t">HTML</span><span class="d">微信式气泡，离线阅读</span></button>',
                '<button data-fmt="txt" class="pick"><span class="ck"></span><span class="t">TXT</span><span class="d">纯文本记录</span></button>',
                '<button data-fmt="csv" class="pick"><span class="ck"></span><span class="t">CSV</span><span class="d">Excel 直接打开</span></button>',
              '</div>',
              '<label class="pick wide" id="asrRow"><span class="t">语音转文字</span>' +
                '<span class="d">导出时自动将语音转成文字（需在设置里配置模型 API）</span>' +
                '<input type="checkbox" id="chkAsr"></label>',
              '<label class="lbl">导出位置</label>',
              '<div class="row"><input class="text" id="exportDir" readonly style="flex:1">',
                '<button class="pill" id="btnBrowseDir">浏览…</button></div>',
              '<div class="row" style="margin-top:26px">',
                '<button class="big primary grow" id="dyce-export">⬇ 导出（先选格式）</button></div>',
              '<div class="proc">',
                '<div id="dyce-busy"></div>',
              '</div>',
            '</section>',
          '</main>',
          '<section id="pane3" hidden>',
            '<aside class="rd-side">',
              '<div class="rd-head"><span>聊天记录 <span class="muted" id="rdSrcCnt"></span></span>' +
                '<span class="rd-head-tools">' +
                  '<button class="msg-tool" id="rdStatsBtn" title="数据概览">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9.5 12 15.5 18 9.5"/></svg>' +
                  '</button>' +
                  '<button class="msg-tool" id="rdOpenDir" title="打开导出文件夹">' +
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.2A2.2 2.2 0 0 1 5.7 5h3.1l1.9 2.2h6.6A2.2 2.2 0 0 1 20.5 9.4v7.4A2.2 2.2 0 0 1 18.3 19H5.7a2.2 2.2 0 0 1-2.2-2.2z"/></svg>' +
                  '</button>' +
                  '<div class="rd-stats" id="rdStats" hidden>' +
                    '<div class="rs"><span>已下载会话</span><span class="v"><b id="stConv">0</b><em>个</em></span></div>' +
                    '<div class="rs"><span>已获取消息</span><span class="v"><b id="stMsg">0</b><em>条</em></span></div>' +
                    '<div class="rs"><span>本地媒体</span><span class="v"><b id="stMedia">0</b><em>个</em></span></div>' +
                    '<div class="rs" title="exports/ 里这些会话文件夹的总大小：媒体文件 + JSON / HTML / TXT / CSV"><span>占用空间</span><span class="v"><b id="stBytes">—</b></span></div>' +
                  '</div>' +
                '</span></div>',
              '<div class="rd-list" id="rdSideList"></div>',
              '<button class="pill" id="rdRefresh" style="margin:10px 12px">刷新列表</button>',
            '</aside>',
            '<div class="rd-main">',
              '<div class="rd-toolbar">',
                '<div class="rd-title" id="rdTitle">选择左侧记录</div>',
                // 只导了 JSON 时媒体还没下载：一颗红按钮，明细在悬停提示里
                '<button class="medgap" id="rdMedGap" hidden>⬇ 下载</button>',
                '<input type="text" class="text" id="rdSearch" placeholder="搜索消息…">',
                '<span class="rd-tools">',
                  '<span class="msg-tool-wrap">',
                    '<button class="msg-tool" id="rdCalBtn" title="按日期跳转">',
                      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17"/><path d="M8 3.5v3"/><path d="M16 3.5v3"/></svg>',
                    '</button>',
                    '<div class="msg-cal" id="rdCal" hidden></div>',
                  '</span>',
                  '<button class="msg-tool" id="rdGalBtn" title="图片浏览">',
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.6"/><path d="m4.5 17 4.6-4.6a2 2 0 0 1 2.8 0l5.6 5.6"/></svg>',
                  '</button>',
                  '<button class="msg-tool" id="rdVoiceBtn" title="下载语音">',
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3.5" width="6" height="10.5" rx="3"/><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0"/><path d="M12 18v3"/></svg>',
                  '</button>',
                  '<button class="msg-tool" id="rdAsrBtn" title="语音转文字">',
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M4 14v-4"/><path d="M8 18V6"/><path d="M12 15v-6"/><path d="M16 17.5v-11"/><path d="M20 13v-2"/><path d="M3 21h18"/></svg>',
                  '</button>',
                  '<button class="msg-tool" id="rdEmojiBtn" title="导出表情包">',
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M8.5 14s1.3 1.8 3.5 1.8 3.5-1.8 3.5-1.8"/><path d="M9 9.8h.01"/><path d="M15 9.8h.01"/></svg>',
                  '</button>',
                  '<button class="msg-tool" id="rdDetailBtn" title="会话详情">',
                    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 11v5"/><path d="M12 8.2h.01"/></svg>',
                  '</button>',
                '</span>',
              '</div>',
              '<div class="rd-body" id="rdList"><div class="rd-empty">选择左侧记录开始阅读</div></div>',
            '</div>',
          '</section>',
          '<section id="pane4" hidden>',
            '<div class="soon">',
              '<span class="soon-ic">', ICON.ai, '</span>',
              '<div class="soon-t">AI 分析</div>',
              '<div class="soon-s">正在开发中，敬请期待</div>',
            '</div>',
          '</section>',
        '</div>',
      '</div>',
      '<div id="dyce-toast"></div>',
      '<div id="dyce-progModal">',
        '<div class="pm-card">',
          '<div class="pm-title"><span class="pm-spin"></span><span id="pmTitle">处理中…</span></div>',
          '<div class="pm-bar"><i id="pmBar"></i></div>',
          '<div class="pm-detail" id="pmDetail">准备中…</div>',
          '<div class="pm-sub" id="pmSub"></div>',
          '<div class="pm-note" id="pmNote"></div>',
          '<div class="pm-foot"><button class="big" id="pmStop" hidden>停止</button></div>',
        '</div>',
      '</div>',
      '<div id="dyce-dlg"><div class="dlg-card">',
        '<div class="dlg-t" id="dlgT"></div>',
        '<div class="dlg-b" id="dlgB"></div>',
        '<div class="dlg-foot" id="dlgF"></div>',
      '</div></div>',
      '<div class="rd-ctx" id="rdCtx" hidden></div>',
      '<div class="rd-lightbox" id="rdLightbox" hidden><img id="rdLightboxImg" alt=""></div>',
      '<div class="gal-overlay" id="rdGalOverlay" hidden>',
        '<div class="gal-modal">',
          '<div class="gal-head">',
            '<span class="gal-title">图片浏览</span>',
            '<span class="gal-count" id="rdGalCount"></span>',
            '<button class="iconbtn sortbtn" id="rdGalSort" title="时间排序"></button>',
            '<button class="pill" id="rdGalAll">全选</button>',
            '<button class="pill dark" id="rdGalExport">导出选中（0）</button>',
            '<button class="iconbtn" id="rdGalClose">✕</button>',
          '</div>',
          '<div class="gal-body" id="rdGalBody"></div>',
        '</div>',
      '</div>',
      '<div class="gal-overlay" id="rdVoiceOverlay" hidden>',
        '<div class="gal-modal">',
          '<div class="gal-head">',
            '<span class="gal-title">语音下载</span>',
            '<span class="gal-count" id="rdVoiceCount"></span>',
            '<button class="iconbtn sortbtn" id="rdVoiceSort" title="时间排序"></button>',
            '<button class="pill" id="rdVoiceAll">全选</button>',
            '<button class="pill dark" id="rdVoiceExport">导出选中（0）</button>',
            '<button class="iconbtn" id="rdVoiceClose">✕</button>',
          '</div>',
          '<div class="gal-body" id="rdVoiceBody"></div>',
        '</div>',
      '</div>',
      '<div class="gal-overlay" id="rdAsrOverlay" hidden>',
        '<div class="gal-modal">',
          '<div class="gal-head">',
            '<span class="gal-title">语音转文字</span>',
            '<span class="gal-count" id="rdAsrCount"></span>',
            '<button class="iconbtn sortbtn" id="rdAsrSort" title="时间排序"></button>',
            '<button class="pill" id="rdAsrUn" title="只勾选还没有转写结果的语音">仅选未转写</button>',
            '<button class="pill" id="rdAsrAll">全选</button>',
            '<button class="pill dark" id="rdAsrRun">开始转写（0）</button>',
            '<button class="iconbtn" id="rdAsrClose">✕</button>',
          '</div>',
          '<div class="gal-body" id="rdAsrBody"></div>',
          '<div class="gal-day" id="rdAsrProg" hidden style="margin:0;padding:10px 16px;' +
            'border-top:1px solid var(--line)"></div>',
        '</div>',
      '</div>',
      '<div class="gal-overlay" id="rdEmojiOverlay" hidden>',
        '<div class="gal-modal">',
          '<div class="gal-head">',
            '<span class="gal-title">导出表情包</span>',
            '<span class="gal-count" id="rdEmojiCount"></span>',
            '<button class="iconbtn sortbtn" id="rdEmojiSort" title="时间排序"></button>',
            '<button class="pill" id="rdEmojiAll">全选</button>',
            '<button class="pill dark" id="rdEmojiExport">导出选中（0）</button>',
            '<button class="iconbtn" id="rdEmojiClose">✕</button>',
          '</div>',
          '<div class="gal-body" id="rdEmojiBody"></div>',
        '</div>',
      '</div>',
      '<div class="conv-side-panel" id="rdDetails" hidden>',
        '<div class="csp-head"><span>会话详情</span><button class="iconbtn" id="rdDetailClose">✕</button></div>',
        '<div class="csp-body" id="rdDetailBody"></div>',
      '</div>',
      '<div class="modal" id="settingsModal" hidden>',
        '<div class="set-card">',
          '<div class="set-head"><b>设置</b><button class="iconbtn" id="setClose">✕</button></div>',
          '<label class="lbl">导出位置</label>',
          '<div class="row"><input class="text" id="setDir" readonly style="flex:1">',
            '<button class="pill" id="setBrowse">浏览…</button></div>',
          '<label class="lbl">界面主题</label>',
          '<div class="seg" id="themeSeg">',
            '<button data-theme="light" class="on">☀ 白天模式</button>',
            '<button data-theme="dark">☾ 黑夜模式</button>',
          '</div>',
          '<label class="lbl">语音转文字模型</label>',
          '<div class="row"><input class="text" id="setBaseUrl" ' +
            'placeholder="Base URL（OpenAI 兼容，例：https://…/v1）" style="flex:1"></div>',
          '<div class="row" style="margin-top:8px">',
            '<input class="text" id="setApiKey" type="password" placeholder="API Key（留空＝不修改）" style="flex:1">',
            '<input class="text" id="setModel" placeholder="模型名" style="flex:0 0 170px"></div>',
          '<div class="row" style="margin-top:8px;justify-content:flex-end">',
            '<span style="display:flex;gap:8px">',
              '<button class="pill" id="setClearKey" title="只删除本机保存的 API Key，Base URL 和模型名保留">清除 Key</button>',
              '<button class="pill" id="setTestModel" title="合成一段「你好」语音上传，验证接口能否正确返回">▶ 测试</button>',
              '<button class="pill dark" id="setSaveModel">保存模型设置</button>',
            '</span></div>',
          '<div class="notice" id="setTestResult"></div>',
          '<div class="notice" id="setNotice"></div>',
          '<label class="lbl">关于</label>',
          '<p class="hint">抖音聊天记录导出器 v' + escHtml(window.__DYIN_VERSION || '1.1') + '<br>' +
            '数据仅保存在本机，不上传任何服务器。<br>' +
            '模型 API Key 用 Windows 账号绑定的 DPAPI 加密存放，界面里只显示掩码。<br>' +
            '仅限备份本人账号数据，请勿传播导出内容。</p>',
          '<div class="row" style="justify-content:flex-end;margin-top:16px">',
            '<button class="pill" id="setLogout" title="删除本机 Data/ 登录数据，下次启动需要重新扫码">清除登录态</button>',
            '<button class="pill" id="setOpenData">打开导出文件夹</button>',
            '<button class="pill dark" id="setOk">完成</button></div>',
        '</div>',
      '</div>'
    ].join('');
    document.documentElement.appendChild(app);

    var chip = document.createElement('div');
    chip.id = 'dyce-chip';
    chip.textContent = '抖音导出 v' + (window.__DYIN_VERSION || '1.1') + ' · 等待扫码登录…';
    document.documentElement.appendChild(chip);
    chip.addEventListener('click', function () {
      var it = takeIntent();                       // 「看完视频回来」优先：回到刚才的记录与位置
      if (it) { restoreReaderIntent(it); return; }
      if (loginReady() && state.conversations.length) { showShell(); return; }
      if (loginReady()) { refreshConversations().then(showShell); return; }
      chip.textContent = '抖音导出 · 继续等待登录…';
      startLoginDetect();
    });
    // 带着意图进来（视频页可能压根没有 IM store，登录检测不会命中）：胶囊直接写明可以回去
    var pendIntent = peekIntent();
    if (pendIntent) chip.textContent = '▲ 返回聊天记录 · ' + (pendIntent.title || '');

    /* 事件绑定 */
    $('#tab1').addEventListener('click', function () { showStep('1'); });
    $('#railChats').addEventListener('click', function () { showStep('reader'); });
    $('#railAi').addEventListener('click', function () { showStep('ai'); });
    $('#railMe').addEventListener('click', hideShell);
    $('#railGear').addEventListener('click', function () {
      $('#settingsModal').hidden = false; refreshDirUI(); refreshLlmUI();
    });
    $('#setClose').addEventListener('click', function () { $('#settingsModal').hidden = true; });
    $('#setOk').addEventListener('click', function () { $('#settingsModal').hidden = true; });
    $('#setBrowse').addEventListener('click', browseDir);
    $$('#themeSeg button').forEach(function (b) {
      b.addEventListener('click', function () { applyTheme(b.dataset.theme); });
    });
    // 语音转文字开关（勾选时联动确保语音媒体被下载）
    $('#chkAsr').addEventListener('change', function (e) {
      state.asr = !!e.target.checked;
      try { localStorage.setItem('dyce_asr', state.asr ? '1' : ''); } catch (err) {}
      if (state.asr) {
        var v = document.getElementById('chkMediaVoice');
        if (v && !v.checked) { v.checked = true; state.mediaOpts.voice = 1; }
      }
      log(state.asr ? '语音转文字已开启（导出时自动转换）' : '语音转文字已关闭');
    });
    // 模型设置：Base URL / 模型名照存，Key 留空＝沿用本机已保存的（页面从来拿不到明文）
    $('#setSaveModel').addEventListener('click', async function () {
      try {
        var api = readerApi();
        var r = await api.save_llm_config(
          $('#setBaseUrl').value, $('#setApiKey').value, $('#setModel').value, false);
        if (r && r.ok) {
          setNotice(r.configured ? 'ok' : 'err',
            r.configured ? ('模型设置已保存' + (r.key_protected ? '（Key 已 DPAPI 加密）' : ''))
                         : '已保存，但 Base URL 或 API Key 还没齐');
          refreshLlmUI();
        } else setNotice('err', '保存失败：' + ((r && r.error) || '未知错误'));
      } catch (e) { setNotice('err', '保存失败：' + e.message); }
    });
    $('#setClearKey').addEventListener('click', async function () {
      try {
        var r = await readerApi().save_llm_config(
          $('#setBaseUrl').value, '', $('#setModel').value, true);
        if (r && r.ok) { setNotice('ok', '已清除本机保存的 API Key'); refreshLlmUI(); }
        else setNotice('err', '清除失败：' + ((r && r.error) || '未知错误'));
      } catch (e) { setNotice('err', '清除失败：' + e.message); }
    });
    // 清除登录态：删的是 Data/ 里的 Cookie。WebView2 里 confirm 不一定弹，所以用二次点击确认
    var logoutArmed = 0, logoutTimer = null;
    $('#setLogout').addEventListener('click', async function () {
      var btn = this;
      if (!logoutArmed) {
        logoutArmed = 1;
        btn.textContent = '再点一次确认清除';
        setNotice('info', '再点一次就删除本机登录态（Data/），导出的聊天记录不受影响；6 秒内不点则取消');
        clearTimeout(logoutTimer);
        logoutTimer = setTimeout(function () {
          logoutArmed = 0; btn.textContent = '清除登录态';
        }, 6000);
        return;
      }
      clearTimeout(logoutTimer); logoutArmed = 0; btn.textContent = '清除登录态';
      try {
        var r = await readerApi().request_reset_login();
        if (r && r.ok) {
          setNotice('ok', '已标记清除：关闭软件再重新打开就生效（需要重新扫码登录）');
          logSrv('用户请求清除登录态');
        } else setNotice('err', '标记失败：' + ((r && r.error) || '未知错误'));
      } catch (e) { setNotice('err', '标记失败：' + e.message); }
    });
    // 测试：现场合成「你好」上传当前输入的接口配置，结果显示在下方独立框内
    $('#setTestModel').addEventListener('click', async function () {
      var btn = this;
      btn.disabled = true; btn.style.opacity = '.5';
      setTestResult('busy', '测试中：本机合成「你好」并上传…');
      try {
        var r = await window.pywebview.api.test_transcribe(
          $('#setBaseUrl').value, $('#setApiKey').value, $('#setModel').value);
        if (r && r.ok) {
          setTestResult('ok', '测试通过（' + r.ms + 'ms），接口返回：' + r.text);
          logSrv('模型测试通过: ' + String(r.text).slice(0, 40));
        } else {
          setTestResult('err', '测试失败：' + ((r && r.error) || '未知错误'));
          log('模型测试失败：' + ((r && r.error) || '未知错误'));
        }
      } catch (e) {
        setTestResult('err', '测试失败：' + e.message);
      }
      btn.disabled = false; btn.style.opacity = '';
    });
    $('#btnBrowseDir').addEventListener('click', browseDir);
    $('#setOpenData').addEventListener('click', openExports);
    $('#btnRefresh').addEventListener('click', function () { refreshConversations(); });
    $('#btnCurrent').addEventListener('click', useCurrent);
    $('#btnSelectAll').addEventListener('click', toggleSelectAll);
    $('#convSearch').addEventListener('input', renderConvList);
    $$('#convSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.activeTab = b.dataset.kind;
        renderConvList();
      });
    });
    $('#dyce-start').addEventListener('click', function () {
      if (lockGuard(this)) return;                 // 置灰但可点：给出下一步提示
      startOrStop();
    });
    // 进度弹窗内的停止：与「获取聊天数据」按钮同一语义（置 running=false 让翻页循环退出）
    $('#pmStop').addEventListener('click', function () {
      if (!state.running) return;
      state.running = false;
      log('正在停止…');
      pmSet('正在停止…（已拿到的数据会保留）');
    });
    $$('button[data-fmt]').forEach(function (b) {
      b.addEventListener('click', function () {
        if (lockGuard(b)) return;
        var f = b.dataset.fmt;
        var i = state.exportFmts.indexOf(f);
        if (i >= 0) state.exportFmts.splice(i, 1); else state.exportFmts.push(f);
        b.classList.toggle('on', state.exportFmts.indexOf(f) >= 0);
        updateExportBtn();
      });
    });
    $$('#rangeSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        state.range = b.dataset.range;
        $$('#rangeSeg button').forEach(function (x) { x.classList.toggle('on', x === b); });
        $('#customRange').hidden = state.range !== 'custom';
        rangeCalClose();
        updateStepChecks();
      });
    });
    // 起止日期：点字段弹自绘日历（与阅读器「按日期跳转」同一套），不再用系统 date 控件
    $('#dateStartBtn').addEventListener('click', function (e) {
      e.stopPropagation(); rangeCalOpen('start');
    });
    $('#dateEndBtn').addEventListener('click', function (e) {
      e.stopPropagation(); rangeCalOpen('end');
    });
    $('#rangeCal').addEventListener('click', function (e) { e.stopPropagation(); });
    syncDateFields();
    [['#chkMediaImage', 'image'], ['#chkMediaVideo', 'video'],
     ['#chkMediaVoice', 'voice'], ['#chkMediaEmoji', 'emoji']].forEach(function (p) {
      $(p[0]).addEventListener('change', function (e) { state.mediaOpts[p[1]] = e.target.checked ? 1 : 0; });
    });
    $('#dyce-export').addEventListener('click', async function () {
      if (lockGuard(this)) return;                 // 前置步骤没完成：提示而不是没反应
      if (!state.exportFmts.length) { tip('请先在上方点选要导出的格式（可多选）'); return; }
      if (!guardData()) return;
      if (busyGuard('导出')) return;
      var fmts = state.exportFmts.slice();
      progOpen('正在导出 ' + fmts.join(' + ').toUpperCase(), {
        sub: state.msgByConv.size + ' 个会话',
        note: '大文件分块写入，期间请不要重复点击；完成后弹窗自动关闭。'
      });
      log('开始导出 ' + fmts.join(' + ') + ' …');
      planReset(fmts.length, !!state.asr);
      pmTick();
      // 先把本机已缓存的转写读回来：否则这次导出会把 JSON 里已有的 asr 冲掉
      var hydrated = await hydrateAsr(Array.from(state.msgByConv.keys()).map(convNameOf));
      if (hydrated) log('已回填本机转写缓存 ' + hydrated + ' 条');
      var asrSkipped = false;
      if (state.asr) {                      // 转写先做完，四种格式才都带得上文字
        pmSet('准备语音转文字…');
        asrSkipped = (await runAsrPass(Array.from(state.msgByConv.keys()))) < 0;
      }
      var bad = 0;
      for (var i = 0; i < fmts.length; i++) {
        plan.fmtIdx = i; pmTick();
        try { bad += (await doExport(fmts[i])) || 0; }
        catch (e) { bad++; log('导出 ' + fmts[i] + ' 失败：' + e.message); }
      }
      plan.fmtIdx = fmts.length; pmStage(1); pmBar(100);
      log('最近一次导出：' + fmts.join(' + ') + (bad ? '（' + bad + ' 种格式失败）' : ' 完成'));
      progFinish((bad ? '导出结束：' + bad + ' 项失败' : '✓ 导出完成 · ' + fmts.join(' + ')) +
        (asrSkipped ? '（语音未转写：模型未配置）' : ''), bad || asrSkipped ? 2800 : 1500);
    });
    $('#rdRefresh').addEventListener('click', readerRefreshSide);
    $('#rdSearch').addEventListener('input', function () { readerRender(); });
    $('#rdMedGap').addEventListener('click', function (e) {
      e.stopPropagation();
      downloadMissingMedia();
    });
    // 右键媒体 → 单独保存
    $('#rdList').addEventListener('contextmenu', function (e) {
      var m = ctxMediaOf(e.target);
      if (!m) return;                 // 文字 / 没下载的东西：不拦系统菜单
      e.preventDefault();
      ctxOpen(e, [{ label: '⬇ ' + m.label, fn: function () { ctxSaveMedia(m); } }]);
    });
    // 右键左侧列表 → 置顶 / 删除整个会话文件夹
    $('#rdSideList').addEventListener('contextmenu', function (e) {
      var d = e.target && e.target.closest ? e.target.closest('.rd-item') : null;
      if (!d || !d.dataset.key) return;
      e.preventDefault();
      ctxOpen(e, sideActions(d.dataset.key));
    });
    $('#rdCtx').addEventListener('click', function (e) {
      var ci = e.target && e.target.closest ? e.target.closest('.ci') : null;
      if (!ci) return;
      var i = Array.prototype.indexOf.call(ci.parentNode.children, ci);
      var a = ctxActions[i];
      ctxClose();
      if (a && a.fn) a.fn();
    });
    document.addEventListener('mousedown', function (e) {
      var m = $('#rdCtx');
      if (m && !m.hidden && !(e.target.closest && e.target.closest('#rdCtx'))) ctxClose();
    }, true);
    $('#rdList').addEventListener('scroll', ctxClose);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') ctxClose(); });
    window.addEventListener('blur', ctxClose);
    // 对话框：点空白处（遮罩）等同于「知道了」
    $('#dyce-dlg').addEventListener('click', function (e) {
      if (e.target === this) dlHide();
    });
    // 阅读器里点链接（分享视频的「▶ 打开视频」）会整页跳走：跳之前记下当前记录与位置
    $('#rdList').addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      noteNavIntentFrom(a);
    }, true);
    // 工具栏：日历 / 图片浏览 / 语音下载 / 会话详情
    $('#rdCalBtn').addEventListener('click', function (e) { e.stopPropagation(); calToggle(); });
    // 侧栏标题上的「数据概览」下拉与「打开导出文件夹」
    $('#rdStatsBtn').addEventListener('click', function (e) { e.stopPropagation(); statsToggle(); });
    $('#rdOpenDir').addEventListener('click', function (e) {
      e.stopPropagation();
      statsClose();          // 资源管理器会抢焦点，浮层留在原地会看着像没关
      openExports();
    });
    document.addEventListener('click', function (e) {
      var rc = $('#rangeCal');
      if (rc && !rc.hidden && !(e.target && e.target.closest &&
          (e.target.closest('#rangeCal') || e.target.closest('#dateStartBtn') ||
           e.target.closest('#dateEndBtn')))) rangeCalClose();
      var st = $('#rdStats');
      if (st && !st.hidden && !(e.target && e.target.closest &&
          (e.target.closest('#rdStats') || e.target.closest('#rdStatsBtn')))) statsClose();
      var cal = $('#rdCal');
      if (!cal || cal.hidden) return;
      if (e.target && e.target.closest &&
          (e.target.closest('#rdCal') || e.target.closest('#rdCalBtn'))) return;
      cal.hidden = true;
    });
    $('#rdGalBtn').addEventListener('click', openGallery);
    $('#rdVoiceBtn').addEventListener('click', openVoices);
    $('#rdAsrBtn').addEventListener('click', function () {
      if (busyGuard('转写语音')) return;
      openAsr();
    });
    $('#rdEmojiBtn').addEventListener('click', openEmojis);
    $('#rdDetailBtn').addEventListener('click', toggleDetails);
    // 四个弹层共用的时间排序箭头：点一下切一次（最新在前 ↔ 最早在前）
    $$('#dyce-app .sortbtn').forEach(function (b) {
      b.addEventListener('click', function (e) { e.stopPropagation(); sortToggle(); });
    });
    $('#rdAsrRun').addEventListener('click', function () { runAsrSel(); });
    $('#rdAsrClose').addEventListener('click', function () { $('#rdAsrOverlay').hidden = true; });
    $('#rdAsrOverlay').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
    $('#rdAsrAll').addEventListener('click', function () {
      if (!asrItems.length) return;
      if (asrSel.size === asrItems.length) asrSel = new Set();
      else asrSel = new Set(asrItems.map(function (i) { return i.sid; }));
      $$('#rdAsrBody .gal-pick').forEach(function (ck) { ck.checked = asrSel.has(ck.dataset.sid); });
      asrSyncRun();
    });
    $('#rdAsrUn').addEventListener('click', function () {
      asrSel = new Set(asrItems.filter(function (i) { return !i.text; }).map(function (i) { return i.sid; }));
      $$('#rdAsrBody .gal-pick').forEach(function (ck) { ck.checked = asrSel.has(ck.dataset.sid); });
      asrSyncRun();
    });
    $('#rdGalClose').addEventListener('click', function () { $('#rdGalOverlay').hidden = true; });
    $('#rdVoiceClose').addEventListener('click', function () { $('#rdVoiceOverlay').hidden = true; });
    $('#rdEmojiClose').addEventListener('click', function () { $('#rdEmojiOverlay').hidden = true; });
    $('#rdDetailClose').addEventListener('click', function () { $('#rdDetails').hidden = true; });
    $('#rdGalOverlay').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
    $('#rdVoiceOverlay').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
    $('#rdEmojiOverlay').addEventListener('click', function (e) { if (e.target === this) this.hidden = true; });
    $('#rdGalAll').addEventListener('click', function () {
      if (!galItems.length) return;
      if (galSel.size === galItems.length) galSel = new Set();
      else galSel = new Set(galItems.map(function (i) { return i.rel; }));
      $$('#rdGalBody .gal-pick').forEach(function (ck) { ck.checked = galSel.has(ck.dataset.rel); });
      $('#rdGalExport').textContent = '导出选中（' + galSel.size + '）';
    });
    $('#rdVoiceAll').addEventListener('click', function () {
      if (!voiceItems.length) return;
      if (voiceSel.size === voiceItems.length) voiceSel = new Set();
      else voiceSel = new Set(voiceItems.map(function (i) { return i.rel; }));
      $$('#rdVoiceBody .gal-pick').forEach(function (ck) { ck.checked = voiceSel.has(ck.dataset.rel); });
      $('#rdVoiceExport').textContent = '导出选中（' + voiceSel.size + '）';
    });
    $('#rdEmojiAll').addEventListener('click', function () {
      var all = emojiOfficial.concat(emojiUser);
      if (!all.length) return;
      if (emojiSel.size === all.length) emojiSel = new Set();
      else emojiSel = new Set(all.map(function (i) { return i.rel; }));
      $$('#rdEmojiBody .gal-pick').forEach(function (ck) { ck.checked = emojiSel.has(ck.dataset.rel); });
      $('#rdEmojiExport').textContent = '导出选中（' + emojiSel.size + '）';
    });
    $('#rdGalExport').addEventListener('click', function () {
      exportMediaSel(galSel, '图片', '#rdGalOverlay');
    });
    $('#rdVoiceExport').addEventListener('click', function () {
      exportMediaSel(voiceSel, '语音', '#rdVoiceOverlay');
    });
    $('#rdEmojiExport').addEventListener('click', function () {
      exportMediaSel(emojiSel, '表情包', '#rdEmojiOverlay');
    });
    $('#rdList').addEventListener('scroll', function () {
      var R = state.reader;
      if (!R.filtered || (R.shown || 0) >= R.filtered.length) return;
      if (this.scrollTop + this.clientHeight > this.scrollHeight - 500) readerAppend(80);
    });
    $('#rdList').addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.vplay') : null;
      if (!btn) return;
      var rel = btn.getAttribute('data-vrel');
      if (btn.dataset.retry === '1') {
        try { readerApi().open_media(state.reader.title, rel); } catch (err) {}
        return;
      }
      btn.disabled = true; btn.textContent = '视频加载中…';
      loadMediaUrl(state.reader.title, rel).then(function (url) {
        var v = document.createElement('video');
        v.controls = true; v.autoplay = true; v.src = url;
        btn.replaceWith(v);
      }).catch(function (err) {
        btn.disabled = false; btn.dataset.retry = '1';
        btn.textContent = '加载失败，点击用系统播放器打开';
        log('视频内嵌加载失败：' + err.message);
      });
    });
    // 双击放大（消息区 + 图片浏览弹层共用同一个 lightbox），点击任意处或按 ESC 关闭
    function openLightbox(src) {
      if (!src || String(src).indexOf('data:') === 0) return;      // 未加载好的占位不放大
      var lb = $('#rdLightbox'), im = $('#rdLightboxImg');
      if (!lb || !im) return;
      im.src = src; lb.hidden = false;
    }
    $('#rdList').addEventListener('dblclick', function (e) {
      var img = e.target && e.target.closest ? e.target.closest('img.rimg, img.emo, img.rav-img') : null;
      if (img) openLightbox(img.src);
    });
    $$('.gal-overlay').forEach(function (ov) {
      ov.addEventListener('dblclick', function (e) {
        var img = e.target && e.target.closest ? e.target.closest('img[data-grel]') : null;
        if (!img) return;
        openLightbox(img.src);
      });
    });
    $('#rdLightbox').addEventListener('click', function () { this.hidden = true; });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      var lb = $('#rdLightbox'); if (lb) lb.hidden = true;
      var cal = $('#rdCal'); if (cal) cal.hidden = true;
      var rc2 = $('#rangeCal'); if (rc2) { rc2.hidden = true; syncDateFields(); }
      var go = $('#rdGalOverlay'); if (go) go.hidden = true;
      var vo = $('#rdVoiceOverlay'); if (vo) vo.hidden = true;
      var ao = $('#rdAsrOverlay'); if (ao) ao.hidden = true;
      var eo = $('#rdEmojiOverlay'); if (eo) eo.hidden = true;
      var dt = $('#rdDetails'); if (dt) dt.hidden = true;
    });

    initErrorHandling();
    refreshDirUI();
    sortLoad();
    sortSync();
    updateExportBtn();
    updateStepChecks();
    // 步骤完成勾的低频轮询兜底（获取完成等事件驱动点已单独调用）
    setInterval(updateStepChecks, 1500);
    initTheme();
    initAsr();
    startLoginDetect();
    log('界面就绪：扫码登录后自动进入面板');
    logSrv('外壳注入成功，会话 ' + (loginReady() ?
      window.conversationStore.conversationMap.size : 0) + ' 个');
  }

  /* ============ 错误兜底：页面红条 + 上报 boot.log ============ */
  function initErrorHandling() {
    var bar = document.createElement('div');
    bar.id = 'dyce-errorbar';
    document.documentElement.appendChild(bar);
    function showErr(msg) {
      bar.textContent = '页面出错了：' + msg;
      bar.style.display = 'block';
      logSrv('页面错误: ' + String(msg).slice(0, 300));
    }
    window.onerror = function (msg, src, line) {
      showErr(msg + '（' + String(src || '').split('/').pop() + ':' + line + '）');
      return false;
    };
    window.addEventListener('unhandledrejection', function (e) {
      showErr(e.reason && e.reason.message ? e.reason.message : String(e.reason).slice(0, 200));
    });
  }

  if (document.body) buildPanel();
  else window.addEventListener('DOMContentLoaded', buildPanel);

  window.__dyce = {
    state: state, refreshConversations: refreshConversations, pullOne: pullOne,
    buildRows: buildRows, collectMedia: collectMedia, resolveBatch: resolveBatch,
    fetchUserInfos: fetchUserInfos, doExport: doExport, exportOne: exportOne,
    renderConvList: renderConvList, updateSelText: updateSelText,
    showShell: showShell, hideShell: hideShell, showStep: showStep,
    readerOpen: readerOpen, loadMediaUrl: loadMediaUrl,
    openGallery: openGallery, openAsr: openAsr, runAsrSel: runAsrSel, render: render,
    // 「看完视频回来」这条链路要跨页面加载验证，harness / 调试脚本需要能直接调
    peekIntent: peekIntent, saveReaderIntent: saveReaderIntent,
    restoreReaderIntent: restoreReaderIntent, clearIntent: clearIntent
  };
})();
