(function () {
  var out = {};
  var cs = window.conversationStore;
  out.hasStore = !!cs;
  if (!cs) return out;
  var mp = cs.conversationMap;
  out.mapSize = mp ? mp.size : 0;
  if (!mp || !mp.size) return out;
  var ids = Array.from(mp.keys());
  out.sampleConvId = ids[0];
  var c = mp.get(ids[0]);
  out.convKeys = Object.keys(c);
  out.bizType = c.bizType;
  out.shortId = String(c.shortId || '');
  var ci = c.coreInfo || {};
  out.coreInfoKeys = Object.keys(ci);
  // 采样 coreInfo 里可能是名称/头像/备注/sec 的字段值（截断）
  var pick = {};
  ['name', 'nickname', 'remarkName', 'remark_name', 'remark', 'displayName', 'display_name',
   'icon', 'avatar', 'avatarUrl', 'avatar_thumb', 'secOwner', 'secPeer', 'owner', 'peer',
   'secUid', 'sec_uid', 'uid', 'peerUid'].forEach(function (k) {
    if (ci[k] !== undefined) {
      try { pick[k] = JSON.stringify(ci[k]).slice(0, 120); } catch (e) { pick[k] = String(ci[k]).slice(0, 120); }
    }
  });
  out.coreInfoSample = pick;
  // 遍历前 5 个会话的 bizType / name 类字段
  out.first5 = ids.slice(0, 5).map(function (id) {
    var cc = mp.get(id), cci = cc.coreInfo || {};
    return { id: id.slice(0, 40), biz: cc.bizType,
             name: cci.name || '', secOwner: (cci.secOwner || '').slice(0, 30) };
  });
  // userInfoStore
  try {
    var us = window.userInfoStore;
    out.userStoreKeys = us ? Object.keys(us) : null;
    out.curUser = null;
    if (us && us.curLoginUserInfo) {
      var cu = us.curLoginUserInfo;
      out.curUser = { keys: Object.keys(cu).slice(0, 30),
                      uid: cu.uid || cu.user_id || '',
                      sec: (cu.sec_uid || cu.secUid || '').slice(0, 30),
                      nickname: cu.nickname || '' };
    }
    if (us && us.usersInfoMap) {
      out.usersInfoMapSize = us.usersInfoMap.size;
      var uids = Array.from(us.usersInfoMap.keys()).slice(0, 3);
      out.usersInfoSampleKeys = uids;
      if (uids.length) {
        var u0 = us.usersInfoMap.get(uids[0]);
        out.userEntryKeys = u0 ? Object.keys(u0).slice(0, 40) : null;
        if (u0) out.userEntrySample = {
          nickname: u0.nickname || '', uid: u0.uid || '',
          sec: (u0.sec_uid || u0.secUid || '').slice(0, 30),
          remark: u0.remark_name || u0.remark || u0.remarkName || '(无字段)'
        };
      }
    }
  } catch (e) { out.userStoreErr = String(e); }
  return out;
})()
