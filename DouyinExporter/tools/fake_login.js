/* 测试用：伪造 conversationStore + userInfoStore，触发外壳自动进入（tools 调试专用） */
(function () {
  if (window.__fake_login_done) return { already: true };
  window.__fake_login_done = true;
  function avDataUrl(ch, bg) {
    var c = document.createElement('canvas'); c.width = c.height = 64;
    var x = c.getContext('2d');
    x.fillStyle = bg; x.beginPath(); x.arc(32, 32, 32, 0, 7); x.fill();
    x.fillStyle = '#fff'; x.font = '600 30px "Microsoft YaHei", sans-serif';
    x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(ch, 32, 35);
    return c.toDataURL();
  }
  var palette = ['#5b8cff', '#17a34a', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#ef4444', '#6366f1'];
  var meUid = '9000000000000000000';
  var meAv = avDataUrl('我', '#2f6bff');
  var privates = ['星河', '小满', '阿哲', '陈老师', '老王', '旅游搭子'];
  var groups = ['设计师交流群', '家庭群'];
  var convMap = new Map();
  var users = new Map();
  users.set(meUid, { uid: meUid, nickname: '我', sec_uid: '' });
  privates.forEach(function (name, i) {
    var peer = '100000000000000000' + (i + 1);
    var id = 'im:1:' + meUid + ':' + peer;
    var av = avDataUrl(name[0], palette[i % palette.length]);
    users.set(peer, { uid: peer, nickname: name, sec_uid: '',
      avatar_thumb: { url_list: [av] } });
    convMap.set(id, { bizType: 1, shortId: 9000 + i, sortOrder: 1000 - i,
      coreInfo: {}, toParticipantSecUserId: '' });
  });
  groups.forEach(function (name, i) {
    var id = 'im:2:G' + (i + 1);
    convMap.set(id, { bizType: 2, shortId: 9500 + i, sortOrder: 900 - i,
      coreInfo: { name: name, icon: '' }, toParticipantSecUserId: '' });
  });
  window.conversationStore = { conversationMap: convMap, curConversationId: null };
  window.userInfoStore = {
    usersInfoMap: users,
    curLoginUserInfo: { uid: meUid, sec_uid: '', nickname: '我',
      avatarUrl: meAv, avatar300Url: meAv }
  };
  return { ok: true, convs: convMap.size };
})()
