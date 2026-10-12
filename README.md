# 抖音聊天记录导出器（内置 WebView2 · 接口直连）

> 读取聊天数据的核心逻辑参考 [TeamBreakerr/douyin-chat-export](https://github.com/TeamBreakerr/douyin-chat-export)（308★，未附许可证），详见文末「参考与致谢」。

一个 WebView2 桌面软件：软件内扫码登录抖音网页版，**直接调用 IM 的 protobuf 接口翻页拉全量私信**（不模拟滚动、不抓 DOM），导出 JSON / HTML / TXT / CSV，并把聊天里的图片、视频、语音、表情下载到本地自动解密。渲染内核复用系统自带的 WebView2 Runtime，程序本体约 30 MB。

<p align="center">
  <img width="32%" alt="操作界面" src="https://github.com/user-attachments/assets/69f85212-7944-4b6e-827b-6a4674c292ee" />
  <img width="32%" alt="阅读器界面" src="https://github.com/user-attachments/assets/2fee4720-1d9d-4324-8377-7c6a83aac649" />
  <img width="32%" alt="导出结果" src="https://github.com/user-attachments/assets/a1a47945-45fd-4760-acf6-ab22fd2e4a8d" />
</p>

## 核心功能

- **拉全量**：按会话翻页直到 `hasMore=0`；中途停止可以再点继续，从未取完的会话、从已有最早一条的时间戳往前翻，不丢也不重复。
- **四种格式**：JSON 字段最全（唯一完整留底）、HTML 微信式气泡离线可看、TXT 纯文本、CSV 带 BOM 不乱码。
- **媒体自动解密**：图片 AES-256-GCM、自拍/IM 视频 MPEG-CENC、HEIC 自动转 JPEG、语音 `.m4a` 直存、表情包按资源去重。
- **分享视频不下载本体**，只存封面 + 标题 / 作者 / 永久链接。
- **语音转文字**（可选）：设置里填 OpenAI 兼容的 Base URL / API Key / 模型名；四种格式都会带上结果，限流自动退避重试，转写文本落同名 `.txt` 缓存，重启后仍在。
- **软件内阅读器**：日期分组、搜索、按日期跳转、媒体懒加载，离线可读；只导了 JSON 的记录也能就地补下缺失媒体。
- **数据不出本机**：请求复用你自己在页面里的登录态，不向任何第三方地址上传内容。

## 界面设计

- 扫码登录后自动进入全屏操作界面：左侧 40px 图标竖栏（选会话 / 概览 / 聊天记录 / AI 分析 / 设置），右侧步骤卡片，按步骤走完就是导出完成。
- 会话列表显示真实头像与昵称，支持搜索、「全部 / 私聊 / 群聊」筛选、多选与全选。
- 点 🌐 回到抖音网页，左上角胶囊随时唤回面板；看完视频点胶囊能回到刚才那条记录和滚动位置。
- 进度只在毛玻璃弹窗里按整体阶段推进，失败改用 toast 提示，界面不留行内日志。
- 原生标题栏颜色跟随界面主题（Win11 DWM），深浅两套图标。
- 三类空内容（接口没给正文 / 打招呼卡片 / 只有时间的系统通知）统一不显示，JSON 里保留并打 `blank` / `greeting` 标记。

## 快速上手

1. 双击 `DouyinExporter.exe`（单文件免安装，首次解压需 10–20 秒，别连点；同目录生成 `Data/` 与 `exports/`）。没有 exe 就双击 `启动.bat`，行为完全一致。
2. 用手机抖音 App 扫码登录，登录态存在 `Data/`，整个文件夹拷走即用。
3. 左侧选会话 → 右侧勾格式、时间范围、媒体类型 → 点「▶ 获取聊天数据」→ 点绿色「⬆ 导出」，结果落在 `exports/<会话名>/`。
4. 点左竖栏「聊天记录」即可在软件内阅读。

**前置条件**：Windows 10/11；已安装 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)（Win11 自带）；程序放在有写权限的目录（别放 Program Files）。未签名 exe 首次运行可能弹 SmartScreen，点「更多信息 → 仍要运行」即可。

## 工作原理

```
DouyinExporter.exe（Python + pywebview 外壳）
  ├─ app.py       窗口 / 文件落盘 / 密钥与登录态管理
  ├─ injector.js  注入页面：枚举会话 → 直连 IM 接口翻页 → 渲染 → 导出与媒体任务
  ├─ media.py     下载与解密（图片 AES-GCM、视频 CENC、HEIC 转 JPEG）
  └─ WebView2 控件 → 系统 WebView2 Runtime（Chromium，不随程序分发）
```

接口是 `POST /v1/message/get_by_conversation`，用会话 `shortId` 加响应里的 `nextTs` 游标翻页；显示与排序取消息的 `field 10`（真实毫秒时间），`field 4` 只当翻页游标。接口字段编号与 `aweType` 类型表集中在 `im-schema.json`（`injector.js` 内置同值兜底），抖音改版优先改这个文件——exe 也支持读同目录外部那份，不用重新打包；未识别的类型会往 `boot.log` 记 `[schema-miss]`。

## 目录结构

```
DouyinExporter/
├─ DouyinExporter.exe    单文件成品（约 29MB），双击即用
├─ app.py / media.py / injector.js    外壳 / 媒体下载解密 / 页面内核心
├─ im-schema.json        接口字段表与消息类型表
├─ emoji-map.json        内联小表情 → 图片地址
├─ test_media.py / test_export.py     离线自检（不联网，不碰真实数据）
├─ 启动.bat / requirements.txt        源码方式运行
├─ tools/                开发调试辅助，产品运行不需要（用前设 DY_DEBUG=1）
├─ Data/                 【本机私有】登录态，扫码后生成
└─ exports/              【本机私有】导出结果，按会话名分文件夹
```

**拷贝给别人或公开发布前，务必删掉 `Data/`、`exports/`、`boot.log`**——`Data/` 里是登录 Cookie，拿到就能进你的账号。别靠记忆清点，跑一次只读检查：`.\.venv\Scripts\python.exe tools\precheck_release.py`。

## 从源码运行

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe app.py            # 或直接双击 启动.bat

.\.venv\Scripts\python.exe test_media.py     # 媒体下载/解密 8 例
.\.venv\Scripts\python.exe test_export.py    # 落盘 / 密钥 / 登录态 30 例
node tools/check_render.js                   # 字段表 + buildRequest 字节回归 + 消息分类回归
```

重新打包单文件 exe 的完整命令在 `DouyinExporter/详细说明.md`。

## 故障排查

- **白屏 / 标题「(未响应)」**：结束所有 `DouyinExporter.exe` 与命令行含 DouyinExporter 的 `msedgewebview2.exe`，重开一次等 10–20 秒，确认只开一个实例。
- **一直「正在检测登录…」/ 列表为空**：页面里没登录或没进私信页，扫码后点「刷新会话列表」。
- **面板不见了**：点左上角黑色胶囊，或刷新页面自动重新注入。
- **拉下来 0 条 / 大片「未支持的消息类型」**：看 `boot.log` 的 `[schema-miss]` 行，按里面列的字段名补 `im-schema.json`。
- **语音转文字少了一部分**：通常是网关 429 限流，会自动退避重试；仍有剩余就进阅读器 →「语音转文字」，弹窗默认只勾未转写的，可直接补跑。
- **想重置登录态**：齿轮 →「清除登录态」，或直接删除 `Data/` 后重启。

## 已知限制

- 媒体下载依赖消息里的签名 CDN 链接，链接过期 / 消息已撤回 / 对方注销时无法补救，个别失败会在计数面板列出、可续下。
- iPhone 的 HEIC 会转 JPEG（依赖 pillow_heif），极端情况下转换失败保留 `.heic`。
- 分享视频用官方永久链接 `https://www.douyin.com/video/<itemId>`，未做需要 App 签名才能生成的 `v.douyin.com` 短链。
- 仅限备份本人账号数据；导出内容涉及对方隐私，请勿擅自公开传播。

## 参考与致谢

本项目**读取聊天数据的核心逻辑**——不模拟滚动、不抓 DOM，而是直接调用抖音 IM 的 protobuf 接口按会话翻页拉全量——这条取数路线参考了 [TeamBreakerr/douyin-chat-export](https://github.com/TeamBreakerr/douyin-chat-export)（308★，最后更新 2026-09）。

需要写清楚边界：**该仓库没有附带任何许可证文件**，按著作权默认「保留所有权利」。所以本项目参考的是它的**思路与接口用法**——接口路径、字段编号、翻页游标这类事实信息；字段表外置与内置兜底、protobuf 编解码与消息渲染、媒体下载解密、语音转文字、四种导出格式、离线阅读器和整套界面，都是本仓库内独立实现的。若今后要直接引入它的源码，需先向作者取得许可。

更完整的特性与修复记录见 `DouyinExporter/详细说明.md`。
