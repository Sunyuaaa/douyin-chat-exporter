(function () {
  var out = {};
  var cs = window.conversationStore;
  var mp = cs.conversationMap;
  var ids = Array.from(mp.keys());
  var c = mp.get(ids[0]);
  out.toSec = c.toParticipantSecUserId || '';
  out.toSecLen = (c.toParticipantSecUserId || '').length;
  // 测一次 IM user/info 接口，看真实响应结构
  return fetch('/aweme/v1/web/im/user/info/?aid=6383&device_platform=webapp&channel=channel_pc_web', {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'sec_user_ids=' + encodeURIComponent(JSON.stringify([c.toParticipantSecUserId]))
  }).then(function (r) { return r.json(); }).then(function (j) {
    out.apiTopKeys = Object.keys(j);
    var d = j.data;
    out.dataType = Array.isArray(d) ? 'array' : typeof d;
    if (Array.isArray(d) && d.length) {
      out.itemKeys = Object.keys(d[0]).slice(0, 40);
      var u = d[0];
      out.itemSample = {
        sec_uid: (u.sec_uid || '').slice(0, 20),
        nickname: u.nickname || '',
        remark_name: u.remark_name === undefined ? '(无)' : u.remark_name,
        uid: u.uid || '',
        avatar0: (u.avatar_thumb && u.avatar_thumb.url_list && u.avatar_thumb.url_list[0] || '').slice(0, 60)
      };
    } else {
      out.dataPreview = JSON.stringify(j).slice(0, 400);
    }
    return out;
  }).catch(function (e) { out.err = String(e); return out; });
})()
