(function () {
  // 等会话列表加载完
  var rows = document.querySelectorAll('#dyce-convlist > div');
  if (!rows.length) return { err: 'list not ready', status: (document.getElementById('dyce-status')||{}).textContent };
  return { rows: rows.length, status: (document.getElementById('dyce-status')||{}).textContent };
})()
