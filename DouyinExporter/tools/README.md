# tools/ — 开发调试辅助（产品运行不需要）

通过 WebView2 远程调试端口（CDP 9222）在页面执行 JS、导航、截图。

## 启动带调试端口的软件

9222 调试口默认关闭（发布安全：开放端口允许本机任意进程控制 WebView、读取登录 Cookie）。
需要调试时先设环境变量再启动：

```powershell
$env:DY_DEBUG = "1"
.\DouyinExporter.exe
```

## 用法（在项目根目录执行）

```powershell
python tools/cdp.py list                 # 列出所有标签页
python tools/cdp.py nav <url>            # 导航
python tools/cdp.py eval <js文件路径>     # 在第一个 douyin 页面执行 JS，打印返回值
python tools/cdp2.py out.png             # 截取页面视口
python tools/cdp_click.py <x> <y>        # 模拟真实鼠标点击（DOM click 无效时用）
node tools/check_html.js "exports/<人名>"  # 校验导出 HTML（气泡/内联表情/头像/资源完整性）
node tools/check_render.js                # 接口层回归：buildRequest 字节比对 + schema 漂移 + 消息分类
python tools/precheck_release.py          # 分发前检查：Data/、exports/、boot.log、明文 Key、缺 exe
python tools/precheck_release.py --json   # 同上，机器可读（safe_to_share 字段）
powershell -NoProfile -ExecutionPolicy Bypass -File DouyinExporter/tools/restart.ps1   # 关掉正在跑的导出器再重开（改完 injector.js 用）
```

`restart.ps1` 认三条判据：打包版进程名、可执行文件在本项目 `.venv` 里、以及「谁的 WebView2 子进程带着本项目
`Data\`」（最后这条是为了抓「用系统 Python 直接跑 app.py」——命令行里看不出目录）。加 `-DryRun` 只列出会关
哪些进程，什么都不杀。适合存成 Qoder 的快捷 Action。

`check_render.js` 靠 `injector.js` 里的 `CHECK-START` / `CHECK-END` 两行注释抠代码，改动那两行注释会导致它失效。

## 不联网跑外壳（界面改动用）

`ui_harness.html` 伪造 conversationStore + pywebview 桥 + IM 接口，加载真实 `injector.js`，
右下角有开发条可一键进各步骤 / 图片浏览 / 语音转文字。改动界面后用它自查，不用扫码登录：

```powershell
python -m http.server 8765   # 在 DouyinExporter 目录执行
# 浏览器打开 http://127.0.0.1:8765/tools/ui_harness.html
```

页面在后台/不可见时 `IntersectionObserver` 一次都不会回调，媒体懒加载（以及它的失败分支）
就永远跑不到。加参数 `?forceIO=1` 打开会换成「observe 即触发」的桩，用来验证
`loadMediaUrl` 的成功与失败两条路径（比如分享卡片封面读不到时是否整块删掉）。

依赖：`websocket-client`（见根目录 requirements.txt）。

## 其他脚本

- `extract_emoji_map.py`：从抖音 JS bundle 重新提取「[表情名] → 图片 URL」映射，更新
  `emoji-map.json`（抖音改版导致文本内联表情失效时重跑一次；需先 `DY_DEBUG=1` 启动并进入聊天页）
- `make_icon.py <原图.png>`：由生成的简笔画原图重出 `app-icon.ico` / `app-icon-dark.ico`。
  原图的「透明」是画上去的浅灰棋盘、右下角还带水印，所以脚本会先去掉底部水印、缩小平均掉棋盘，
  再按亮度/饱和度抠成 alpha，输出浅/深两套描边（深色标题栏必须用浅色那套）。
- `check_titlebar.py`：真的建一个窗口、真的调 `DwmSetWindowAttribute`，再截屏比对标题栏像素色。
  必须真机跑：`DwmGetWindowAttribute` 读不回 34/35/36（实测返回失败），只有 HRESULT 和像素能说明问题。
  屏幕锁定或窗口没上屏时会自动跳过像素比对（否则会拿锁屏桌布蒙出一个假「通过」），
  产物 `tools/_titlebar_light.png` / `_titlebar_dark.png` 可直接看。
- `inspect_*.js`：一次性探查脚本（会话结构 / 用户接口 / 排序字段），按需保留或删除
- `fake_login.js` / `fake_state.js`：在真软件里伪造登录态与假会话数据（免扫码进外壳），
  前者造 `conversationStore`，后者往 `__dyce.state` 里灌假消息，配合 `cdp.py eval` 使用
- `gen_promo.py` / `promo_shot.js`：合成宣传图 `promo.png`（深色渐变底 + 真实截图），非产品依赖
- `gen_icon.py`：**旧图标生成器**（深色底 + 抖音色气泡 + 「抖」字），产出 `app.ico`。
  图标已换成 `make_icon.py` 那套简笔画，`app.ico` 也随旧设计一起删除，此脚本仅作留档
