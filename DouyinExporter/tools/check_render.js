// tools/check_render.js — 离线回归 injector.js 的接口层与消息分类（不联网、不开软件）
// 覆盖四件事：
//   1) buildRequest 重构成字段表驱动后，字节输出与旧的硬编码版本必须完全一致；
//   2) im-schema.json 的键名/取值要和 injector.js 内置默认对得上（防止改错键静默失效）；
//   3) render() 对 exports/ 里真实消息的分类结果（对比改动前后，列出仍在兜底的类型）；
//   4) emojiKey() 的表情包去重判据——合成用例（换 CDN 主机 / 换尺寸变体 / 无地址）
//      加真机复核：按 emojiKey 分组的张数不得多于按文件 md5 算的实际张数（残留重复）。
// 用法：node tools/check_render.js
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'injector.js'), 'utf8');
const mark = src.indexOf('CHECK-START');
const a = src.indexOf('*/', mark) + 2;      // 从注释结束处开始抠，别把中文注释抠进去
const b = src.indexOf('/* CHECK-END');
if (mark < 0 || a <= 1 || b < 0 || b <= a) {
  console.error('抠不到 CHECK-START / CHECK-END 标记——injector.js 的分节注释被改了');
  process.exit(2);
}
// 抠出的这段只含 var / function 定义，除 window 外不依赖页面
const box = new Function('window', src.slice(a, b) +
  '\nreturn { render: render, buildRequest: buildRequest, parseResponse: parseResponse,' +
  ' SC: SC, missSeen: missSeen, concatArrays: concatArrays, es: es, evf: evf, eb: eb,' +
  ' emojiKey: emojiKey };');

let fails = 0;
function chk(name, ok, detail) {
  console.log((ok ? 'ok   - ' : 'FAIL - ') + name + (detail ? '  ' + detail : ''));
  if (!ok) fails++;
}

// ---------- 1) 字段表驱动 vs 旧硬编码 ----------
const external = JSON.parse(fs.readFileSync(path.join(ROOT, 'im-schema.json'), 'utf8'));
const W = { __DYIN_SCHEMA: external, pywebview: null, conversationStore: null, userInfoStore: null };
const api = box(W);
const apiBuiltin = box({});                       // 没有外部 schema 时用内置默认

// 旧版本 buildRequest 的逐字节等价实现（写死，作为回归基线）
function legacyRequest(concatArrays, es, evf, eb, convId, shortId, ts) {
  var inner = concatArrays([es(1, convId), evf(2, 1), evf(3, shortId), evf(4, 1), evf(5, ts), evf(6, 50)]);
  return concatArrays([
    evf(1, 301), evf(2, 10027), es(3, '0.1.6'), es(4, ''), evf(5, 3), evf(6, 0),
    es(7, 'fef1a80:p/lzg/store'), eb(8, eb(301, inner)), es(9, '0'),
    es(11, 'douyin_pc'), es(14, '360000'), evf(18, 1), es(21, 'douyin_pc')
  ]);
}
const cid = '0:1:1111111111111111:2222222222222222';   // 合成会话号，仅测格式，不含真实账号
for (const [sid, ts] of [[9001, '9999999999999999'], [12345678, '1737000000000000']]) {
  const now = Buffer.from(api.buildRequest(cid, BigInt(sid), BigInt(ts)));
  const old = Buffer.from(legacyRequest(api.concatArrays, api.es, api.evf, api.eb, cid, BigInt(sid), BigInt(ts)));
  chk('buildRequest 与旧硬编码逐字节一致 (shortId=' + sid + ')', now.equals(old),
    now.length + ' 字节' + (now.equals(old) ? '' : ' 差异@' + firstDiff(now, old)));
}
chk('外部 schema 与内置默认产出相同请求',
  Buffer.from(api.buildRequest(cid, BigInt(9001), BigInt('9999999999999999')))
      .equals(Buffer.from(apiBuiltin.buildRequest(cid, BigInt(9001), BigInt('9999999999999999')))));

// ---------- 2) im-schema.json 与内置默认一致性 ----------
const groups = ['ep', 'msg', 'resp', 'req', 'awe', 'share'];
let drift = [];
for (const g of groups) {
  for (const k of Object.keys(external[g] || {})) {
    if (!(k in (apiBuiltin.SC[g] || {}))) { drift.push(g + '.' + k + '（内置没有这个键）'); continue; }
    if (JSON.stringify(external[g][k]) !== JSON.stringify(apiBuiltin.SC[g][k])) {
      drift.push(g + '.' + k + ' 外部=' + JSON.stringify(external[g][k]) +
                 ' 内置=' + JSON.stringify(apiBuiltin.SC[g][k]));
    }
  }
}
chk('im-schema.json 与内置默认值一致（当前随包内容应等价）', drift.length === 0, drift.join(' | ') || '无漂移');

// ---------- 3) 响应解析未受重构影响 ----------
// 手工拼一个极小响应：payload(f6) -> body(f301) -> {f2 nextTs, f3 hasMore, f1 message{f3 server_id, f10 real_ms, f8 content_json}}
const msgBody = Buffer.concat([
  varintTag(3, 0), varint(7000000000000000001n),
  varintTag(10, 0), varint(1752000000000n),
  varintTag(11, 0), varint(1n),                       // is_recalled
  varintTag(8, 2), lenPrefixed(Buffer.from(JSON.stringify({ aweType: 700, text: '你好' }), 'utf8'))
]);
const innerBody = Buffer.concat([
  varintTag(2, 0), varint(1752000000000000n),
  varintTag(3, 0), varint(0n),
  varintTag(1, 2), lenPrefixed(msgBody)
]);
const payload = Buffer.concat([varintTag(301, 2), lenPrefixed(innerBody)]);
const data = Buffer.concat([varintTag(6, 2), lenPrefixed(payload)]);
const parsed = api.parseResponse(new Uint8Array(data));
chk('parseResponse 仍能解出消息/游标/hasMore',
  !!parsed && parsed.msgs.length === 1 && parsed.nextTs === '1752000000000000' && parsed.hasMore === 0,
  parsed ? JSON.stringify({ n: parsed.msgs.length, sid: parsed.msgs[0].server_id,
    real_ms: parsed.msgs[0].real_ms, recalled: parsed.msgs[0].is_recalled }) : 'null');
const r0 = api.render(JSON.parse(parsed.msgs[0].content_json));
chk('render 文本消息分类正确', r0.kind === 'text' && r0.text === '你好', JSON.stringify(r0));
chk('is_recalled 字段被解析出来（撤回诊断用）', parsed.msgs[0].is_recalled === 1,
  'f11=' + parsed.msgs[0].is_recalled);

// ---------- 4) 真实导出数据分类回归 ----------
const expDir = path.join(ROOT, 'exports');
if (fs.existsSync(expDir)) {
  let total = 0, changed = 0, empties = 0;
  const newlyEmpty = [];
  const stillOther = new Map();
  for (const name of fs.readdirSync(expDir)) {
    const f = path.join(expDir, name, name + '.json');
    if (!fs.existsSync(f)) continue;
    for (const m of (JSON.parse(fs.readFileSync(f, 'utf8')).messages || [])) {
      total++;
      const r = api.render(m.content || {});
      if (r.kind !== m.kind) changed++;
      // 判据要跟数据量无关：新渲染「变空」的，必须是本来就空的（快照里 text 也是空的）。
      // 以前写的是 empties <= 20，多导几个会话就会假报警。
      if (!String(r.text || '').trim()) {
        empties++;
        if (String(m.text || '').trim()) newlyEmpty.push(name + '/' + m.server_id + ' ' + r.kind);
      }
      if (r.kind === 'other') {
        const k = (m.aweType === undefined ? 'no-aweType' : m.aweType) +
          (Object.keys(m.content || {}).length ? '' : ' · 空内容');
        stillOther.set(k, (stillOther.get(k) || 0) + 1);
      }
    }
  }
  console.log('---');
  console.log('真实数据 ' + total + ' 条：与快照相比分类不同 ' + changed +
    ' 条，文本为空 ' + empties + ' 条（空的多为改动前就没正文的）');
  console.log('仍在兜底(other)的 aweType：',
    [...stillOther.entries()].sort((x, y) => y[1] - x[1]).map(e => e[0] + '×' + e[1]).join(' | ') || '（无）');
  chk('重分类不会把原本有正文的消息变空', newlyEmpty.length === 0,
    '新增空文本 ' + newlyEmpty.length + ' 条：' + newlyEmpty.slice(0, 3).join(' , '));
} else {
  console.log('（没有 exports/，跳过真实数据回归）');
}

// ---------- 5) 表情包合集去重 ----------
// 真实地址形状：同一张表情会从不同 CDN 主机下发（对象路径末两段一样）。
// 以前判据用「去掉 ? 的整条 URL」→ 换个主机就算另一张，合集里连着几张一模一样的图。
const oneSticker = [
  { emojiUrl: 'https://p3-sign.douyinpic.com/obj/tos-cn-o-0812/AAA111?x-expires=1&x-signature=a', local: 'media/emoji/1.webp' },
  { emojiUrl: 'https://p26-sign.douyinpic.com/obj/tos-cn-o-0812/AAA111?x-expires=2&x-signature=b', local: 'media/emoji/2.webp' },
  { emojiUrl: 'https://p5-ex-gddgtc-sign.douyinpic.com/obj/tos-cn-o-0812/AAA111~tplv-dy-resize.image?x-expires=3', local: 'media/emoji/3.webp' }
];
const oneKeys = oneSticker.map(api.emojiKey);
chk('同一表情换 CDN 主机也只算一张', new Set(oneKeys).size === 1, oneKeys.join(' | '));
chk('不同表情不会被并成一张', new Set([
  api.emojiKey({ emojiUrl: 'https://p3-sign.douyinpic.com/obj/ies.fe.effect/aaa', local: 'x' }),
  api.emojiKey({ emojiUrl: 'https://p3-sign.douyinpic.com/obj/ies.fe.effect/bbb', local: 'y' })
]).size === 2);
chk('拿不到地址时退回本地文件名（宁可少并也不误并）',
  api.emojiKey({ emojiUrl: '', local: 'media/emoji/7.webp' }) === 'file:media/emoji/7.webp' &&
  api.emojiKey({ emojiUrl: '', local: 'media/emoji/8.webp' }) === 'file:media/emoji/8.webp');

// 真机数据：按 emojiKey 去重后的合集，要和「按文件字节算的实际张数」完全相等——
// 多出来 = 还有重复（用户看到的连着几张一样的图）；少掉 = 把不同表情误并成一张。
if (fs.existsSync(expDir)) {
  const crypto = require('crypto');
  let rowTotal = 0, keyTotal = 0, dupLeft = 0, fmtMulti = 0, bad = [];
  for (const name of fs.readdirSync(expDir)) {
    const f = path.join(expDir, name, name + '.json');
    if (!fs.existsSync(f)) continue;
    const em = (JSON.parse(fs.readFileSync(f, 'utf8')).messages || [])
      .filter(m => m.kind === 'emoji' && m.local);
    if (em.length < 5) continue;
    const md5toKeys = new Map(), keySet = new Set(), keyToMd5 = new Map();
    em.forEach(m => {
      const p = path.join(path.dirname(f), String(m.local).replace(/\//g, path.sep));
      let buf; try { buf = fs.readFileSync(p); } catch (e) { return; }
      const h = crypto.createHash('md5').update(buf).digest('hex');
      const cu = (m.content || {}).url;
      const u = (cu && typeof cu === 'object' && cu.url_list && cu.url_list[0]) || '';
      const k = api.emojiKey({ emojiUrl: u, local: m.local });
      keySet.add(k);
      if (!md5toKeys.has(h)) md5toKeys.set(h, new Set());
      md5toKeys.get(h).add(k);
      if (!keyToMd5.has(k)) keyToMd5.set(k, new Set());
      keyToMd5.get(k).add(h);
    });
    rowTotal += em.length; keyTotal += keySet.size;
    // 同一张图被拆成几个 key = 合集里看得见的重复，必须为 0
    const split = [...md5toKeys.values()].filter(s => s.size > 1).length;
    dupLeft += split;
    // 一个 key 里出现多种字节：正常（同一表情有人发 HEIC、有人发 JPG，转码后字节不同），只报数
    fmtMulti += [...keyToMd5.values()].filter(s => s.size > 1).length;
    if (split) bad.push(name + ' 还有 ' + split + ' 组重复没并掉');
  }
  chk('表情包合集不再残留重复（同一张图只算一张）', !dupLeft,
    '真实表情 ' + rowTotal + ' 行 → 合集 ' + keyTotal + ' 张；残留重复 ' + dupLeft + ' 组' +
    '；一个 key 内含多种字节格式 ' + fmtMulti + ' 处（同一表情 HEIC/JPG 两版，属正常）' +
    (bad.length ? '\n   ' + bad.join('\n   ') : ''));
}

// ---------- 6) 样式表里不许出现 // 注释（CSS 没有这种注释，它会吃掉紧跟的那条规则）----------
{
  const a2 = src.indexOf('var SHELL_CSS = `');
  const b2 = src.indexOf('`;', a2);
  const css = b2 > a2 ? src.slice(a2, b2) : '';
  const bad = css.split('\n')
    .map((l, i) => [i + 1, l])
    .filter(([, l]) => /(^|\s)\/\/(?!\s*\/)/.test(l) && !/^\/\*/.test(l.trim()));
  chk('SHELL_CSS 内没有 // 注释（CSS 里它是垃圾字符，会吞掉下一条规则）',
    !!css && bad.length === 0,
    bad.length ? bad.slice(0, 3).map(x => x[0] + ': ' + x[1].trim().slice(0, 60)).join(' | ') : '（干净）');
}

// ---------- helpers ----------
function firstDiff(x, y) {
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return i;
  return -1;
}
function varint(v) {
  const out = [];
  let n = BigInt(v);
  do { let b = Number(n & 0x7Fn); n >>= 7n; if (n > 0n) b |= 0x80; out.push(b); } while (n > 0n);
  return Buffer.from(out);
}
function varintTag(field, wire) { return varint((field << 3) | wire); }
function lenPrefixed(buf) { return Buffer.concat([varint(buf.length), buf]); }

console.log('---');
console.log(fails ? 'FAIL ×' + fails : 'OK 全部通过');
process.exit(fails ? 1 : 0);
