const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const h = fs.readFileSync(path.join(dir, path.basename(dir) + '.html'), 'utf8');
const i = h.indexOf('var B=');
let j = h.indexOf('\nvar list=');
if (j < 0) j = h.length;
let raw = h.slice(i + 6, j);
let B = [];
try { B = JSON.parse(raw); }
catch (e) {
  // 容错：截到最后一个 }] 再试
  const last = raw.lastIndexOf('}]');
  if (last > 0) { try { B = JSON.parse(raw.slice(0, last + 2)); } catch (e2) {} }
}
let iemo = 0;
const iemoFiles = new Set();
let brackets = 0;
B.forEach(d => {
  const bm = (d.body || '').match(/src="(media\/[^"]+)"/g) || [];
  bm.forEach(x => { const u = x.match(/src="([^"]+)"/)[1]; if (u.includes('emoji')) { iemo++; iemoFiles.add(u); } });
  if (/\[[^\[\]]{1,10}\]/.test(d.text || '') && !(d.body || '').includes('iemo')) brackets++;
});
let ok = 0, miss = 0;
iemoFiles.forEach(p => { fs.existsSync(path.join(dir, p)) ? ok++ : miss++; });
const meAv = [...new Set(B.filter(d => d.me).map(d => d.av).filter(Boolean))];
const taAv = [...new Set(B.filter(d => !d.me).map(d => d.av).filter(Boolean))];
const lines = [
  '气泡: ' + B.length,
  '内联表情: ' + iemo + ' 处, 唯一文件 ' + iemoFiles.size + ' 个',
  '本地存在: ' + ok + ' / 缺失: ' + miss,
  '未替换标记文本: ' + brackets,
  '我的头像: ' + meAv.join(','),
  '对方头像: ' + taAv.join(','),
  '头像区分: ' + (meAv[0] && taAv[0] && meAv[0] !== taAv[0] ? 'OK' : 'FAIL')
];
fs.writeFileSync(path.join(dir, '_check.txt'), lines.join('\n'));
console.log('written');
