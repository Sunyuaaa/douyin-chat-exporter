(function () {
  var cs = window.conversationStore;
  if (!cs || !cs.conversationMap) return { err: 'no store' };
  var mp = cs.conversationMap;
  var ids = Array.from(mp.keys()).slice(0, 8);
  return ids.map(function (id) {
    var c = mp.get(id);
    return {
      name: (c.coreInfo && c.coreInfo.name || '').slice(0, 10) || (id.slice(-6)),
      sortOrder: c.sortOrder,
      sortType: typeof c.sortOrder
    };
  });
})()
