(function () {
  var s = window.__dyce.state;
  // 生成彩色首字母圆头像（canvas → dataURL）
  function avDataUrl(ch, bg) {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var x = c.getContext('2d');
    x.fillStyle = bg; x.beginPath(); x.arc(32, 32, 32, 0, 7); x.fill();
    x.fillStyle = '#fff'; x.font = '600 30px "Microsoft YaHei", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, 32, 35);
    return c.toDataURL();
  }
  var palette = ['#5b8cff', '#17a34a', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];
  function mk(id, biz, name, i) {
    return { id: id, shortId: String(9000 + i), bizType: biz, name: name,
             avatar: avDataUrl(name[0], palette[i % palette.length]),
             peerSec: '', sortOrder: 1000 - i };
  }
  var fake = [
    mk('f1', 1, '星河', 0),   mk('f2', 1, '小满', 1),  mk('f3', 1, '阿哲', 2),
    mk('f4', 2, '设计师交流群', 3), mk('f5', 1, '陈老师', 4), mk('f6', 2, '家庭群', 5),
    mk('f7', 1, '老王', 6),  mk('f8', 1, '旅游搭子', 7),
  ];
  s.conversations = fake;
  s.selectedIds = []; s.msgByConv = new Map(); s.loaded = false;
  window.__dyce.renderConvList();
  // 状态行不含账号 uid
  document.getElementById('dyce-status').textContent = '私聊 6 · 群聊 2';
  window.__dyce.updateSelText();
  return { faked: true, rows: document.querySelectorAll('#dyce-convlist > div').length };
})()
