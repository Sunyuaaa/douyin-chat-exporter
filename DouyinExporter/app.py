# -*- coding: utf-8 -*-
"""
抖音聊天记录导出器（内置 WebView2 浏览器）
- 内嵌系统 WebView2（Edge Chromium 内核），在软件内直接打开抖音网页版并扫码登录
- 登录 Cookie 持久保存在程序目录 Data/，下次打开免扫码（便携）
- 页面加载后自动注入 injector.js：直接调用抖音 IM protobuf 接口翻页拉全量私信（不滚动、不抓 DOM）
- 导出数据通过 pywebview 桥回传，由本程序写入 exports/ 目录
依赖：pip install -r requirements.txt（Windows 需已装 WebView2 Runtime，Win11 自带）
"""
import os
import re
import sys
import base64
import json
import time
import uuid
import datetime
import threading
import traceback
import subprocess
import shutil
import webbrowser
import ctypes
import ctypes.wintypes
import urllib.request
import urllib.error
import zipfile
from pathlib import Path

import media  # 同目录媒体下载/解密模块（PyInstaller 随 import 自动打包）

# pythonw / console=False 的进程里 spawn 控制台程序（ffmpeg、powershell）会各闪出一个 cmd 黑框：
# 语音转码是每条一次，231 条就闪 231 次。CREATE_NO_WINDOW 让它彻底不出现。
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def app_dir() -> Path:
    """程序所在目录：打包后为 exe 目录，开发时为 app.py 目录（Data/exports 放这里，便于便携）"""
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent


BASE = app_dir()
DATA_DIR = BASE / "Data"
EXPORTS_DIR = BASE / "exports"
EXPORTS_DIR.mkdir(parents=True, exist_ok=True)

_BOOT_LOG = BASE / "boot.log"
APP_VERSION = "1.1"
# 设置「关于」里那行链接允许打开的地址白名单：页面只能把这个整串交给 open_repo，
# 别的 host / 协议一律拒绝，避免注入出去的桥被外部页面拿去开任意 URL。
REPO_URLS = ("https://github.com/Sunyuaaa/douyin-chat-exporter",)


def log(msg: str) -> None:
    """启动诊断日志（写文件，避免 windowed 模式下 stdout 丢失）"""
    try:
        with open(_BOOT_LOG, "a", encoding="utf-8") as f:
            f.write(f"{datetime.datetime.now().strftime('%H:%M:%S')}.{int(time.time()*1000)%1000:03d} {msg}\n")
            f.flush()
    except Exception:
        pass


log(f"===== 抖音聊天记录导出器 v{APP_VERSION} 启动 | {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')} =====")
log(f"boot start | frozen={getattr(sys, 'frozen', False)} | exe={sys.executable} | meipass={getattr(sys, '_MEIPASS', '-')}")
log("before import webview ...")
import webview  # noqa: E402
log("after import webview OK")
try:
    import clr  # noqa: F401
    import System  # noqa: E402
    log(f"CLR ready: {System.Environment.Version} / {System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription}")
except Exception as e:  # noqa: BLE001
    log(f"CLR probe failed: {e!r}")


def resource_path(name: str) -> Path:
    """只读资源路径：PyInstaller onefile 时在解压临时目录 _MEIPASS"""
    base = Path(getattr(sys, "_MEIPASS", app_dir()))
    return base / name


# ============ 原生标题栏配色 / 图标 ============
# 标题栏是 Windows 自己画的（DWM），pywebview 没有配色接口，只能走 DwmSetWindowAttribute。
# COLORREF 是 0x00BBGGRR（字节序反的），下面这些常量都是这么拼的。
# Win10 没有 35/36 两个属性，调用会返回错误码但不崩，所以统一 try 包住、失败只记日志。
DWMWA_USE_IMMERSIVE_DARK_MODE = 20
DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36

# 与 injector.js 里 --bg / --text 保持一致：标题栏要跟界面顶部同色才看不出两条杠
THEME_TITLEBAR = {
    "light": {"caption": 0x00F8F6F5, "text": 0x00211E1C, "dark": 0, "icon": "app-icon.ico"},
    "dark": {"caption": 0x001C1817, "text": 0x00EDEAEA, "dark": 1, "icon": "app-icon-dark.ico"},
}
UI_THEME_FILE = DATA_DIR / "ui_theme.txt"


def norm_theme(mode) -> str:
    return "dark" if str(mode or "").strip().lower().startswith("dark") else "light"


def saved_theme() -> str:
    """上次退出前用的主题：建窗口时就要决定图标和标题栏色，等不到页面里的 localStorage。"""
    try:
        return norm_theme(UI_THEME_FILE.read_text(encoding="utf-8").strip())
    except Exception:  # noqa: BLE001
        return "light"


def save_theme(mode: str) -> None:
    try:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        UI_THEME_FILE.write_text(norm_theme(mode), encoding="utf-8")
    except Exception as e:  # noqa: BLE001
        log(f"[标题栏] 主题记盘失败：{e}")


def _dwm_set(hwnd: int, attr: int, value: int) -> int:
    try:
        v = ctypes.c_uint32(value)
        return ctypes.windll.dwmapi.DwmSetWindowAttribute(
            ctypes.c_void_p(hwnd), ctypes.c_uint32(attr), ctypes.byref(v), ctypes.sizeof(v))
    except Exception as e:  # noqa: BLE001
        log(f"[标题栏] DwmSetWindowAttribute({attr}) 异常：{e}")
        return -1


def apply_titlebar(hwnd: int, mode: str) -> dict:
    """按主题设置标题栏底色 / 文字色 / 边框色，并强制重画非客户区。

    注意：DwmGetWindowAttribute 不支持读回 34/35/36（实测返回失败），
    所以只能靠 SetWindowAttribute 的 HRESULT 判断有没有设上，Win10 上是非 0。
    """
    t = THEME_TITLEBAR[norm_theme(mode)]
    hr = {
        str(DWMWA_USE_IMMERSIVE_DARK_MODE): _dwm_set(hwnd, DWMWA_USE_IMMERSIVE_DARK_MODE, t["dark"]),
        str(DWMWA_CAPTION_COLOR): _dwm_set(hwnd, DWMWA_CAPTION_COLOR, t["caption"]),
        str(DWMWA_TEXT_COLOR): _dwm_set(hwnd, DWMWA_TEXT_COLOR, t["text"]),
        str(DWMWA_BORDER_COLOR): _dwm_set(hwnd, DWMWA_BORDER_COLOR, t["caption"]),  # 不留一条亮边
    }
    try:  # 不设 FRAMECHANGED 时旧色会一直显示到窗口被挪动/缩放
        SWP = 0x0002 | 0x0001 | 0x0040 | 0x0010               # NOMOVE|NOSIZE|NOZORDER|NOACTIVATE
        ctypes.windll.user32.SetWindowPos(ctypes.c_void_p(hwnd), None, 0, 0, 0, 0, SWP)
    except Exception as e:  # noqa: BLE001
        log(f"[标题栏] 重画失败：{e}")
    ok = hr[str(DWMWA_CAPTION_COLOR)] == 0
    if not ok:
        # 句柄无效、或系统不支持该属性（Win10 只有 20，35/36 是 Win11 才有）都会走到这里
        log(f"[标题栏] 底色没设上（句柄无效或系统不支持该属性）：{hr}")
    return {"ok": ok, "mode": norm_theme(mode), "hr": hr}


# ============ 落盘稳健性（遗留问题 #1）============
def clean_text(s) -> str:
    """剔除孤立代理项。

    JS 里对含 emoji 的文本做 slice() 可能把代理对切成一半，这类字符写 UTF-8 会抛
    UnicodeEncodeError；早期表现是「文件已创建但 0 字节 + 没有落盘日志」，
    而异常被桥吞掉后页面仍会显示「导出完成」。这里统一换成 U+FFFD。
    """
    if not isinstance(s, str):
        s = str(s if s is not None else "")
    try:
        s.encode("utf-8")
        return s
    except UnicodeEncodeError:
        pass
    out = []
    n, i = len(s), 0
    while i < n:
        code = ord(s[i])
        if 0xD800 <= code <= 0xDBFF and i + 1 < n and 0xDC00 <= ord(s[i + 1]) <= 0xDFFF:
            out.append(s[i]); out.append(s[i + 1]); i += 2
        elif 0xD800 <= code <= 0xDFFF:
            out.append("\ufffd"); i += 1
        else:
            out.append(s[i]); i += 1
    return "".join(out)


def write_text_atomic(path: Path, content: str, encoding: str = "utf-8") -> int:
    """先写 .part 再 os.replace：中途异常绝不会留下 0 字节的半成品文件。

    newline="" 很关键：默认 None 会把 '\\n' 翻译成 os.linesep，
    CSV 自己拼的 '\\r\\n' 会变成 '\\r\\r\\n'。
    """
    content = clean_text(content)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.parent / (path.name + ".part")
    try:
        with open(tmp, "w", encoding=encoding, newline="") as f:
            f.write(content)
        os.replace(tmp, path)
    finally:
        try:
            if tmp.exists():
                tmp.unlink()
        except OSError:
            pass
    return len(content.encode(encoding, errors="replace"))


# ============ DPAPI：本机绑定加密（遗留问题 #4）============
class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.wintypes.DWORD),
                ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(buf: bytes) -> "_DataBlob":
    cbuf = ctypes.create_string_buffer(buf, len(buf))
    return _DataBlob(len(buf), ctypes.cast(cbuf, ctypes.POINTER(ctypes.c_char))), cbuf


def dpapi_protect(text: str):
    """用当前用户域加密，返回 base64；失败返回 None（调用方退回明文并记录）。"""
    try:
        blob, keep = _blob(text.encode("utf-8"))
        out = _DataBlob()
        ok = ctypes.windll.crypt32.CryptProtectData(
            ctypes.byref(blob), None, None, None, None, 0x01, ctypes.byref(out))
        if not ok:
            return None
        try:
            raw = ctypes.string_at(out.pbData, out.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(out.pbData)
        return base64.b64encode(raw).decode("ascii")
    except Exception as e:  # noqa: BLE001
        log(f"[DPAPI] 加密失败: {e!r}")
        return None


def dpapi_unprotect(b64: str):
    """解密 dpapi 保护的 base64；失败返回 None。"""
    try:
        blob, keep = _blob(base64.b64decode(b64))
        out = _DataBlob()
        ok = ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(blob), None, None, None, None, 0x01, ctypes.byref(out))
        if not ok:
            return None
        try:
            raw = ctypes.string_at(out.pbData, out.cbData)
        finally:
            ctypes.windll.kernel32.LocalFree(out.pbData)
        return raw.decode("utf-8")
    except Exception as e:  # noqa: BLE001
        log(f"[DPAPI] 解密失败: {e!r}")
        return None


def mask_secret(text: str) -> str:
    """给界面看的掩码：绝不把完整 Key 回传给页面（页面跑的是抖音的 JS）。"""
    t = str(text or "")
    if not t:
        return ""
    if len(t) <= 8:
        return "已保存（" + "*" * len(t) + "）"
    return t[:4] + "…" + t[-4:] + f"（已保存 {len(t)} 位）"


# ============ 语音转文字：音频格式适配 ============
# 有些网关的 /chat/completions + input_audio 只接受 wav/mp3（MiMo 实测报
# "input_audio.format must be one of: wav, mp3. Got: m4a"），而抖音语音存下来是 m4a。
_CHAT_AUDIO_OK = ("wav", "mp3")


def _silent_unlink(p: Path):
    try:
        if p.exists():
            p.unlink()
    except OSError:
        pass


def ffmpeg_exe():
    """找一个能用的 ffmpeg，顺序：
    ① 系统 PATH 里的 ffmpeg；
    ② 放在程序自己目录下的 ffmpeg.exe（想换更新/更小的版本时用它覆盖内置的）；
    ③ pip 装的 imageio-ffmpeg（源码版走 venv；单文件 exe 也已把它自带的二进制打进包里，
       见 spec 里 excludes 的注释，所以 exe 版开箱就有转码能力）。
    都没有 → None（调用方给出可操作的中文提示）。"""
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    for name in ("ffmpeg.exe", "ffmpeg-win-x86_64.exe"):
        p = BASE / name
        if p.is_file():
            return str(p)
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:  # noqa: BLE001
        return None


def to_chat_audio(src: Path):
    """非 wav/mp3 的音频转成 16k 单声道 mp3（ASR 够用、base64 后也小）。
    返回 (可用路径或 None, 是否临时文件, 错误说明)。"""
    fmt = (src.suffix.lstrip(".") or "wav").lower()
    if fmt in _CHAT_AUDIO_OK:
        return src, False, None
    exe = ffmpeg_exe()
    if not exe:
        return None, False, (
            "这个网关的 input_audio 只接受 wav/mp3，而本机语音是 %s，系统里也没有可用的 ffmpeg，"
            "无法转码。三个办法：① 装系统 ffmpeg 并加入 PATH（如 winget install Gyan.FFmpeg）；"
            "② 下载单文件 ffmpeg.exe 放到本软件同目录（exe 版也优先认它）；"
            "③ 源码版在本目录 .venv 里 pip install imageio-ffmpeg（exe 版已内置这一份，"
            "走到这条提示说明内置二进制没跑起来）。"
            "或者改用带 /audio/transcriptions 端点的 OpenAI 兼容网关，那种可以直接收 m4a。" % src.suffix)
    import tempfile
    out = Path(tempfile.gettempdir()) / ("dyce_asr_%s.mp3" % uuid.uuid4().hex[:8])
    try:
        p = subprocess.run(
            [exe, "-y", "-loglevel", "error", "-i", str(src),
             "-ac", "1", "-ar", "16000", "-b:a", "48k", str(out)],
            capture_output=True, timeout=120, stdin=subprocess.DEVNULL,
            creationflags=NO_WINDOW)
        if p.returncode != 0 or not out.is_file() or out.stat().st_size < 512:
            err = (p.stderr or b"").decode("utf-8", errors="replace").strip()[-200:]
            _silent_unlink(out)
            return None, False, "ffmpeg 转码失败：" + (err or "未知错误")
        return out, True, None
    except Exception as e:  # noqa: BLE001
        _silent_unlink(out)
        return None, False, "ffmpeg 转码异常：%r" % (e,)


LOGOUT_FLAG = BASE / ".logout_pending"


def apply_pending_logout() -> None:
    """启动早期（创建窗口之前）执行：见到标记就整个删掉 Data/，实现「一键退出登录」。
    删除失败（文件被占用）时保留标记，下次启动再试一次。"""
    try:
        if not LOGOUT_FLAG.exists():
            return
        if DATA_DIR.exists():
            shutil.rmtree(DATA_DIR, ignore_errors=True)
        if DATA_DIR.exists():
            log("清除登录态：Data/ 仍有残留（可能软件没关干净），标记保留，下次启动再清")
        else:
            LOGOUT_FLAG.unlink(missing_ok=True)
            log("清除登录态：已删除 Data/，本次启动需要重新扫码")
    except Exception as e:  # noqa: BLE001
        log(f"清除登录态异常: {e!r}")


HOME_URL = "https://www.douyin.com/"
MESSAGE_URL = "https://www.douyin.com/message"

# 内联小表情（文本里的 [流泪] 等）名称 → 图片 URL 映射（随包分发）
try:
    EMOJI_MAP = json.loads(resource_path("emoji-map.json").read_text(encoding="utf-8"))
except Exception:  # noqa: BLE001
    EMOJI_MAP = {}

# IM 接口字段表 / aweType 分类表：抖音改版时优先改这个 JSON，不用重编译 exe。
# 读不到也没关系——injector.js 里有同值的内置默认。
def schema_path() -> Path:
    """字段表优先取程序目录里的那份（exe 旁边放一个就能替换），否则取包内解出来的。"""
    side = app_dir() / "im-schema.json"
    return side if side.is_file() else resource_path("im-schema.json")


try:
    SCHEMA = json.loads(schema_path().read_text(encoding="utf-8"))
    log("im-schema.json 已加载：" + str(schema_path()))
except Exception:  # noqa: BLE001
    SCHEMA = {}
    log("im-schema.json 未加载，injector.js 将使用内置默认字段表")


class JsApi:
    """暴露给页面 JS 的接口：window.pywebview.api.xxx()"""

    def __init__(self):
        # 注意：必须用下划线属性。pywebview 会递归反射 js_api 对象的公开属性来生成
        # JS 桥；若公开持有 Window 对象，会递归进其内部 .NET 控件对象图，在打包环境下
        # 造成 UI 线程与桥接线程死锁（窗口“未响应”）。
        self._window = None
        # 分块导出：大 HTML/JSON 不能作为单次桥参数（数 MB 会让 EdgeChromium 桥/CLR 崩溃），
        # 改为 begin -> append(小块) -> finish，句柄存在这里。
        self._chunks = {}
        self._chunk_seq = 0
        # 阅读器分块读（JSON/base64）句柄，与导出 _chunks 分开，避免互相误伤
        self._reads = {}
        # ASR 端点形态探测缓存：None 未探 | 'transcriptions' | 'chat'
        self._asr_form = None

    def log_event(self, msg):
        """前端事件/错误上报：写入 boot.log 供远程分析。"""
        log("[JS] " + str(msg)[:500])
        return {"ok": True}

    def save_export(self, fmt, content, conv_name=""):
        """一次性落盘（分块失败时的兜底重试也走这里）。
        返回结构化结果而不是文案：JS 靠字符串前缀判断成败会漏（'保存失败：' 并不以'失败'开头）。"""
        try:
            fmt = (fmt or "txt").lower()
            ext = {"json": "json", "html": "html", "txt": "txt", "csv": "csv"}.get(fmt, "txt")
            safe = self._safe(conv_name or "")
            path = EXPORTS_DIR / safe / f"{safe}.{ext}"
            encoding = "utf-8-sig" if ext == "csv" else "utf-8"
            content = clean_text(content or "")
            if not content:
                # 先查再写：空内容直接建个空文件出来，正是「0 字节却报成功」那个坑的形状
                log(f"[导出失败] save_export {path.name} 内容为空")
                return {"ok": False, "error": "内容为空"}
            size = write_text_atomic(path, content, encoding)
            log(f"[导出] {path.name}（{size} 字节）")
            return {"ok": True, "name": path.name, "size": size,
                    "path": str(path), "msg": f"已保存：{safe}\\{path.name}"}
        except Exception as e:  # noqa: BLE001
            log("[导出失败] save_export: " + traceback.format_exc()[-500:])
            return {"ok": False, "error": str(e)}

    # ---- 分块导出（大文件稳健落盘）----
    def begin_export(self, conv_name="", fmt="txt"):
        """打开一次分块导出，返回 eid。按会话名建文件夹，文件名不含日期。"""
        ext = {"json": "json", "html": "html", "txt": "txt", "csv": "csv"}.get((fmt or "txt").lower(), "txt")
        safe = self._safe(conv_name or "")
        path = EXPORTS_DIR / safe / f"{safe}.{ext}"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._chunk_seq += 1
        eid = self._chunk_seq
        self._chunks[eid] = {"path": path, "parts": [],
                             "encoding": "utf-8-sig" if ext == "csv" else "utf-8"}
        log(f"[分块开始] {path.name} eid={eid}")
        return eid

    def append_export(self, eid, chunk):
        try:
            key = int(eid)
        except (TypeError, ValueError):
            log(f"[导出失败] append_export 收到非法 eid={eid!r}")
            return {"ok": False, "error": f"bad eid: {eid!r}"}
        c = self._chunks.get(key)
        if not c:
            log(f"[导出失败] append_export 句柄不存在 eid={key}（begin 未成功或已被 finish）")
            return {"ok": False, "error": f"bad eid: {key}"}
        c["parts"].append(chunk or "")
        return {"ok": True, "chars": len(chunk or "")}

    def finish_export(self, eid):
        try:
            c = self._chunks.pop(int(eid), None)
        except (TypeError, ValueError) as e:
            log(f"[导出失败] finish_export 非法 eid={eid!r}: {e!r}")
            return {"ok": False, "error": f"bad eid: {eid!r}"}
        if not c:
            log(f"[导出失败] finish_export 句柄不存在 eid={eid}（begin/append 阶段可能已出错）")
            return {"ok": False, "error": f"句柄不存在 eid={eid}"}
        name = c["path"].name
        content = "".join(c["parts"])
        if not content:
            log(f"[导出失败] {name} 未收到任何内容（分块数={len(c['parts'])}）")
            return {"ok": False, "error": "内容为空", "name": name}
        try:
            size = write_text_atomic(c["path"], content, c["encoding"])
        except Exception as e:  # noqa: BLE001
            log("[导出失败] 写入 " + name + ": " + traceback.format_exc()[-500:])
            return {"ok": False, "error": f"写入失败: {e}", "name": name}
        if size <= 0:
            log(f"[导出失败] {name} 落盘后大小为 0")
            return {"ok": False, "error": "落盘为空", "name": name}
        log(f"[导出] {name}（{size} 字节 · {len(c['parts'])} 块）")
        return {"ok": True, "name": name, "size": size,
                "path": str(c["path"]), "chunks": len(c["parts"])}

    def cancel_export(self, eid):
        self._chunks.pop(int(eid), None)
        return {"ok": True}

    # ---- 阅读器：导出记录列表 / 分块读 JSON / 分块读媒体（base64）----
    def get_exports_dir(self):
        return {"ok": True, "path": str(EXPORTS_DIR)}

    def list_export_convs(self):
        """扫描 exports/ 下已导出 JSON 的会话，供阅读器列出可读记录。
        size 是**整个会话文件夹**的实际字节数（媒体 + 各种导出格式都算），
        不是 JSON 那一个文件——以前只报 JSON 大小，7.7MB 的快照其实占了 394MB，
        和「数据概览 · 占用空间」对不上。"""
        out = []
        try:
            if EXPORTS_DIR.exists():
                for d in sorted(EXPORTS_DIR.iterdir()):
                    if not d.is_dir():
                        continue
                    f = d / (d.name + ".json")
                    if f.exists():
                        st = f.stat()
                        out.append({"name": d.name, "size": self._dir_stats(d)[0],
                                    "mtime": int(st.st_mtime),
                                    "total": self._json_total(f)})
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        return {"ok": True, "convs": out}

    def _dir_stats(self, d):
        """返回 (目录内所有文件字节数, 其中算作媒体的文件数)。
        媒体只算 `media/` 子目录下的（.txt 转写缓存 / .zip / .json 不算），
        否则会话根上那份 HTML、CSV 会被当成「媒体个数」。
        用 scandir 手工递归：rglob + is_file 在几千个小文件上要 0.5 秒以上，
        而这个列表每次进阅读器都要跑一遍。"""
        total = 0
        media_n = 0
        media_root = os.path.join(str(d), "media") + os.sep
        stack = [str(d)]
        while stack:
            cur = stack.pop()
            try:
                with os.scandir(cur) as it:
                    for e in it:
                        try:
                            if e.is_dir(follow_symlinks=False):
                                stack.append(e.path)
                            elif e.is_file(follow_symlinks=False):
                                total += e.stat().st_size
                                in_media = e.path.startswith(media_root) or \
                                    os.path.dirname(e.path) == os.path.join(str(d), "media")
                                if in_media and Path(e.path).suffix.lower() not in self._NON_MEDIA:
                                    media_n += 1
                        except OSError:
                            pass
            except OSError:
                pass
        return total, media_n

    @staticmethod
    def _json_total(path):
        """只读 JSON 开头几百字节取 meta.total（列表要用条数，没必要解析整个文件）。"""
        try:
            with open(path, "rb") as fh:
                head = fh.read(4096).decode("utf-8", errors="replace")
            m = re.search(r'"total"\s*:\s*(\d+)', head)
            return int(m.group(1)) if m else None
        except Exception:  # noqa: BLE001
            return None

    # 概览页「本地媒体」不计这些：转写缓存、打包结果、分享卡片 meta 都不算媒体文件
    _NON_MEDIA = (".txt", ".zip", ".json")

    def overview_stats(self):
        """概览三个数字 + 占用空间的「本机已有」口径。

        以前只统计页面内存里的 state.msgByConv / mediaPaths，重启软件后内存是空的，
        于是本机明明躺着几千条消息、上千个媒体，界面却显示 0。
        bytes = 这些会话文件夹里所有文件的字节数（媒体 + JSON/HTML/TXT/CSV/zip 都算），
        就是「下载这些东西占了多少磁盘」。
        """
        out = {"convs": 0, "messages": 0, "media": 0, "bytes": 0, "perConv": {}}
        try:
            if EXPORTS_DIR.exists():
                for d in sorted(EXPORTS_DIR.iterdir()):
                    if not d.is_dir():
                        continue
                    f = d / (d.name + ".json")
                    total = self._json_total(f) if f.is_file() else None
                    size, media = self._dir_stats(d)   # 与列表「已导出 X MB」同一口径
                    if not total and not media:
                        continue
                    out["convs"] += 1
                    out["messages"] += total or 0
                    out["media"] += media
                    out["bytes"] += size
                    out["perConv"][d.name] = {"total": total or 0, "media": media}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}
        return {"ok": True, "convs": out["convs"], "messages": out["messages"],
                "media": out["media"], "bytes": out["bytes"], "perConv": out["perConv"]}

    @staticmethod
    def _read_chunk_chars():
        # 与导出同量级的单块大小：单块过大会让 EdgeChromium/CLR 桥崩溃
        return 120000

    def begin_read(self, conv):
        """打开 exports/<conv>/<conv>.json 准备分块读取，返回 eid。"""
        try:
            safe = self._safe(conv)
            path = EXPORTS_DIR / safe / f"{safe}.json"
            if not path.is_file():
                return {"ok": False, "error": "记录不存在（请先导出 JSON）"}
            self._chunk_seq += 1
            eid = self._chunk_seq
            self._reads[eid] = {"text": path.read_text(encoding="utf-8"), "pos": 0}
            return {"ok": True, "eid": eid,
                    "size": len(self._reads[eid]["text"])}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def read_next(self, eid):
        c = self._reads.get(int(eid))
        if not c:
            return {"ok": False, "error": "bad eid"}
        n = self._read_chunk_chars()
        part = c["text"][c["pos"]:c["pos"] + n]
        c["pos"] += len(part)
        if not part:
            self._reads.pop(int(eid), None)
            return {"ok": True, "done": True}
        return {"ok": True, "done": False, "part": part}

    def begin_media(self, conv, rel):
        """把 exports/<conv>/<rel> 读成 base64 准备分块回传（阅读器内嵌媒体用）。"""
        try:
            safe = self._safe(conv)
            base = (EXPORTS_DIR / safe).resolve()
            rel = str(rel or "")
            if not rel.startswith("media/") or ".." in rel:
                return {"ok": False, "error": "bad rel"}
            path = (base / rel).resolve()
            if not str(path).startswith(str(base)) or not path.is_file():
                return {"ok": False, "error": "file not found"}
            b64 = base64.b64encode(path.read_bytes()).decode("ascii")
            self._chunk_seq += 1
            eid = self._chunk_seq
            self._reads[eid] = {"text": b64, "pos": 0}
            return {"ok": True, "eid": eid, "size": path.stat().st_size,
                    "b64len": len(b64)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def read_media_next(self, eid):
        return self.read_next(eid)

    def open_media(self, conv, rel):
        """用系统默认播放器打开本地媒体（大视频不走桥传输时的外部播放）。"""
        try:
            safe = self._safe(conv)
            base = (EXPORTS_DIR / safe).resolve()
            rel = str(rel or "")
            if not rel.startswith("media/") or ".." in rel:
                return {"ok": False, "error": "bad rel"}
            path = (base / rel).resolve()
            if not str(path).startswith(str(base)) or not path.is_file():
                return {"ok": False, "error": "file not found"}
            os.startfile(str(path))  # noqa: S606
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def export_media_zip(self, conv, rels, label="媒体"):
        """把勾选的本地媒体（media/... 相对路径）打包为 zip 放在会话目录下。
        阅读器「图片浏览 / 语音下载」弹层的导出按钮走这里；打包后打开导出文件夹。"""
        try:
            safe = self._safe(conv)
            base = (EXPORTS_DIR / safe).resolve()
            items = [str(r or "") for r in (rels or []) if str(r or "")]
            if not items:
                return {"ok": False, "error": "未勾选任何文件"}
            files = []
            for rel in items:
                if not rel.startswith("media/") or ".." in rel:
                    return {"ok": False, "error": f"bad rel: {rel}"}
                p = (base / rel).resolve()
                if not str(p).startswith(str(base)) or not p.is_file():
                    return {"ok": False, "error": f"文件不存在：{rel}"}
                files.append((p, rel))
            stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            label_safe = re.sub(r'[\\/:*?"<>|]', "_", str(label or "媒体"))[:20] or "媒体"
            out = base / f"{label_safe}_{stamp}.zip"
            with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
                for p, rel in files:
                    zf.write(p, rel)
            log(f"[导出] {out.name}（{len(files)} 个文件）")
            return {"ok": True, "name": out.name, "count": len(files)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    # ---- 语音转文字：模型配置（存 Data/llm_config.json，随 Data/ 一起删除）----
    DEFAULT_LLM = {"base_url": "", "api_key": "", "model": "mimo-v2.5-asr"}
    _AUDIO_EXTS = (".m4a", ".mp3", ".wav", ".aac", ".ogg", ".opus")

    def _llm_path(self) -> Path:
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        return DATA_DIR / "llm_config.json"

    def _llm_raw(self):
        """磁盘上的原始配置（可能含 api_key_dpapi，也可能是旧版明文 api_key）。"""
        cfg = dict(self.DEFAULT_LLM)
        p = self._llm_path()
        if p.is_file():
            try:
                cfg.update(json.loads(p.read_text(encoding="utf-8")))
            except ValueError as e:  # noqa: BLE001
                log(f"[模型配置] llm_config.json 解析失败，按未配置处理: {e!r}")
        return cfg

    def _llm_save(self, cfg) -> None:
        self._llm_path().write_text(
            json.dumps(cfg, ensure_ascii=False, indent=2), encoding="utf-8")

    def _llm_secret(self, cfg=None):
        """取真实 API Key——只在进程内部使用，绝不回传给页面（页面里跑着抖音的 JS）。
        读到旧版明文时顺手迁移成 DPAPI；DPAPI 不可用就继续明文并记日志，不影响功能。"""
        cfg = cfg if cfg is not None else self._llm_raw()
        enc = str(cfg.get("api_key_dpapi") or "")
        if enc:
            got = dpapi_unprotect(enc)
            if got is not None:
                return got
            log("[模型配置] DPAPI 解密失败（换电脑/换 Windows 用户？），需要重填 API Key")
            return ""
        plain = str(cfg.get("api_key") or "")
        if plain:
            enc = dpapi_protect(plain)
            if enc:
                # 就地更新 cfg：调用方紧接着还要用同一个字典算 key_protected，
                # 不回填就会在第一次读取时误报「DPAPI 不可用，暂存明文」
                cfg["api_key_dpapi"] = enc
                cfg["api_key"] = ""
                self._llm_save(cfg)
                log("[模型配置] 明文 API Key 已迁移为 DPAPI 加密存储")
            else:
                log("[模型配置] DPAPI 不可用，API Key 继续以明文保存")
        return plain

    def get_llm_config(self):
        """给界面用：Base URL / 模型名照实回显，Key 只回「有没有 + 掩码」。"""
        try:
            cfg = self._llm_raw()
            key = self._llm_secret(cfg)
            return {"ok": True, "config": {
                "base_url": cfg.get("base_url") or "",
                "model": cfg.get("model") or self.DEFAULT_LLM["model"],
                "api_key": "",                       # 输入框留空 = 沿用已存的 Key
                "api_key_mask": mask_secret(key),
                "has_key": bool(key),
                "key_protected": bool(cfg.get("api_key_dpapi")),
                "configured": bool(cfg.get("base_url") and key),
            }}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def save_llm_config(self, base_url="", api_key="", model="", clear_key=False):
        try:
            cfg = self._llm_raw()
            old_key = self._llm_secret(cfg)
            cfg["base_url"] = str(base_url or "").strip().rstrip("/")
            cfg["model"] = str(model or "").strip() or self.DEFAULT_LLM["model"]
            typed = str(api_key or "").strip()
            if clear_key:
                key = ""
            else:
                key = typed or old_key               # 没重填就保留原 Key
            enc = dpapi_protect(key) if key else ""
            cfg["api_key_dpapi"] = enc
            cfg["api_key"] = "" if enc or not key else key
            if key and not enc:
                log("[模型配置] DPAPI 不可用，本次 API Key 以明文保存")
            self._llm_save(cfg)
            log(f"[模型配置] 已保存 {cfg['model']} @ "
                f"{cfg['base_url'] or '(未填 Base URL)'}"
                f"（Key {'已保存' if key else '已清除'}"
                f"{'，DPAPI 加密' if enc else ''}）")
            return {"ok": True, "configured": bool(cfg["base_url"] and key),
                    "has_key": bool(key), "key_protected": bool(enc)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def request_reset_login(self):
        """一键退出登录：只写标记，真正的删除在下次启动、创建窗口之前执行
        （WebView2 正在使用 Data/ 里的文件，运行时删不掉）。"""
        try:
            LOGOUT_FLAG.write_text(
                datetime.datetime.now().isoformat(), encoding="utf-8")
            log("已写入退出登录标记：" + str(LOGOUT_FLAG))
            return {"ok": True, "path": str(LOGOUT_FLAG)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    # ---- 原生标题栏：配色与图标跟随界面主题 ----
    def _hwnd(self):
        try:
            native = getattr(getattr(self, "_window", None), "native", None)
            return int(native.Handle.ToInt32()) if native is not None else None
        except Exception:  # noqa: BLE001
            return None

    def _form_icon(self, name):
        """换窗口与任务栏图标。WinForms 属性只能在 UI 线程改，必要时 Invoke 过去。"""
        path = resource_path(name)
        if not path.exists():
            log(f"[图标] 找不到 {path}")
            return False
        try:
            from System import Func, Type
            from System.Drawing import Icon
            form = self._window.native

            def _apply():
                form.Icon = Icon(str(path))

            if form.InvokeRequired:
                form.Invoke(Func[Type](_apply))
            else:
                _apply()
            return True
        except Exception as e:  # noqa: BLE001
            log(f"[图标] 设置失败：{e}")
            return False

    def set_titlebar(self, mode):
        """主题变了 → 标题栏底色/文字色与图标一起跟上，并记住，下次启动直接用。"""
        m = norm_theme(mode)
        save_theme(m)
        hwnd = self._hwnd()
        if not hwnd:
            return {"ok": False, "error": "窗口还没建好"}
        r = apply_titlebar(hwnd, m)
        r["icon"] = self._form_icon(THEME_TITLEBAR[m]["icon"])
        log(f"[标题栏] 主题切换 → {m}：hr={r['hr']} 图标={r['icon']}")
        return r

    def transcribe_one(self, conv, sid):
        """对 exports/<conv>/media/voice/<sid>.<音频> 调 OpenAI 兼容
        /audio/transcriptions 转文字；结果缓存为同名 .txt，已存在不重复请求。"""
        try:
            cfg = self._llm_raw()
            key = self._llm_secret(cfg)
            if not (cfg.get("base_url") and key):
                return {"ok": False, "error": "请先在设置里填写 Base URL 和 API Key"}
            safe = self._safe(conv)
            folder = EXPORTS_DIR / safe / "media" / "voice"
            sid = str(sid or "")
            if not re.fullmatch(r"[\w\-]+", sid):
                return {"ok": False, "error": "bad sid"}
            txt = folder / (sid + ".txt")
            if txt.is_file():
                return {"ok": True, "text": txt.read_text(encoding="utf-8"),
                        "cached": True}
            src = next((folder / (sid + e) for e in self._AUDIO_EXTS
                        if (folder / (sid + e)).is_file()), None)
            if src is None:
                return {"ok": False, "error": "语音文件不存在，请先下载媒体"}
            text, err = self._post_transcribe(
                cfg["base_url"], key, cfg["model"], src)
            if err:
                # 远程排障要看得到失败原因（此前只记成功，用户报「转写没用」时无从下手）
                log(f"[转文字失败] {safe}/{sid} @{cfg['model']}: " + str(err)[:220])
                return {"ok": False, "error": err}
            folder.mkdir(parents=True, exist_ok=True)
            txt.write_text(text, encoding="utf-8")
            log(f"[转文字] {safe}/{sid} → {len(text)} 字")
            return {"ok": True, "text": text}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def voice_texts(self, conv):
        """读回本机已有的转写缓存（media/voice/<sid>.txt）。
        重启后 JS 内存里的转写表是空的，不回填就会出现三件事：阅读器显示不出已转好的文字、
        再导出一次把 JSON 里的 asr 字段冲没、已经成功的条目被重复请求。"""
        try:
            safe = self._safe(conv)
            folder = EXPORTS_DIR / safe / "media" / "voice"
            out = {}
            if folder.is_dir():
                for p in folder.glob("*.txt"):
                    try:
                        t = p.read_text(encoding="utf-8").strip()
                    except OSError:
                        continue
                    if t:
                        out[p.stem] = t
            return {"ok": True, "texts": out, "count": len(out)}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def _post_transcribe(self, base_url, api_key, model, src: Path):
        """调 ASR，带退避重试。先试 OpenAI 标准 /audio/transcriptions；网关 404
        （如 MiMo）自动回落 /chat/completions + input_audio，形态探测结果缓存。
        批量转几百条必然撞上 429 限流——一次失败就放弃，用户看到的就是"有的没转出来"。"""
        url_base = str(base_url or "").strip().rstrip("/")
        err = None
        for attempt in range(1, 5):
            text, err, code = self._asr_once(url_base, api_key, model, src)
            if text is not None:
                if attempt > 1:
                    log(f"[转文字] 第 {attempt} 次尝试成功")
                return text, None
            wait = self._asr_retry_wait(err, code)
            if wait is None or attempt >= 4:
                break
            log(f"[转文字重试 {attempt}/4] {wait:.0f}s 后再试：{str(err)[:120]}")
            time.sleep(wait)
        return None, err

    def _asr_once(self, url_base, api_key, model, src):
        """一次尝试，返回 (text, err, http_code)。"""
        if self._asr_form in (None, "transcriptions"):
            text, err, code = self._post_transcriptions(url_base, api_key, model, src)
            if text is not None:
                self._asr_form = "transcriptions"
                return text, None, code
            if code == 404:
                self._asr_form = "chat"      # 该网关没有转写端点，回落 chat
            else:
                return None, err, code
        return self._post_chat_asr(url_base, api_key, model, src)

    @staticmethod
    def _asr_retry_wait(err, code):
        """该不该重试、等多久：429 / 5xx / 超时 / 网络错重试；
        400（参数、格式不对）、401/403（Key）这类重试也没用。429 优先读 Retry-After。"""
        if code in (408, 429, 500, 502, 503, 504) or code is None:
            if code == 429:
                m = re.search(r"retry[-_ ]after[:\s]+(\d+)", str(err or ""), re.I)
                if m:
                    return min(60.0, max(1.0, float(m.group(1))))
                return 4.0
            return 2.0
        return None

    @staticmethod
    def _post_transcriptions(base_url, api_key, model, src: Path):
        """OpenAI 标准转写端点。返回 (text, err, http_code)。"""
        try:
            url = base_url
            if not url.endswith("/audio/transcriptions"):
                url += "/audio/transcriptions"
            ctype = {"m4a": "audio/mp4", "mp3": "audio/mpeg", "wav": "audio/wav",
                     "aac": "audio/aac", "ogg": "audio/ogg"}.get(
                         src.suffix.lstrip(".").lower(), "application/octet-stream")
            boundary = "----dyceasr" + uuid.uuid4().hex
            parts = [
                (f'--{boundary}\r\nContent-Disposition: form-data; '
                 f'name="model"\r\n\r\n').encode(),
                str(model).encode("utf-8") + b"\r\n",
                (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; '
                 f'filename="{src.name}"\r\nContent-Type: {ctype}\r\n\r\n').encode(),
                src.read_bytes(),
                f"\r\n--{boundary}--\r\n".encode(),
            ]
            req = urllib.request.Request(
                url, data=b"".join(parts), method="POST",
                headers={
                    "Authorization": "Bearer " + str(api_key),
                    "Content-Type": f"multipart/form-data; boundary={boundary}",
                    "User-Agent": "DouyinExporter/1.1",
                })
            with urllib.request.urlopen(req, timeout=180) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            text = ""
            try:
                j = json.loads(raw)
                if isinstance(j, dict):
                    text = (j.get("text") or
                            (j.get("data") or {}).get("text") or "")
                    if not text and isinstance(j.get("output"), list):
                        text = "".join(p.get("text", "") for p in j["output"]
                                       if isinstance(p, dict))
            except ValueError:
                text = raw.strip()
            if not text:
                return None, "接口返回空文本：" + raw[:200], 200
            return text, None, 200
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            return None, f"HTTP {e.code}: {detail or e.reason}", e.code
        except Exception as e:  # noqa: BLE001
            return None, str(e), None

    @staticmethod
    def _post_chat_asr(base_url, api_key, model, src: Path):
        """chat/completions 形态的转写；网关只收 wav/mp3 时先把 m4a 转成临时 mp3。
        返回 (text, err, http_code)。"""
        audio, is_tmp, why = to_chat_audio(src)
        if why:
            return None, why, None          # 转码不了属于本地问题，重试无意义
        try:
            return JsApi._post_chat_asr_raw(base_url, api_key, model, audio)
        finally:
            if is_tmp:
                _silent_unlink(audio)

    @staticmethod
    def _post_chat_asr_raw(base_url, api_key, model, src: Path):
        """chat/completions + input_audio 的实际请求（MiMo 等网关的 ASR 形态）。
        返回 (text, err, http_code)。"""
        try:
            fmt = src.suffix.lstrip(".").lower() or "mp3"
            if fmt not in ("wav", "mp3", "m4a", "aac", "ogg", "flac", "webm"):
                fmt = "wav"
            payload = {
                "model": str(model),
                "messages": [{"role": "user", "content": [
                    {"type": "input_audio", "input_audio": {
                        "data": base64.b64encode(src.read_bytes()).decode("ascii"),
                        "format": fmt}}]}],
            }
            req = urllib.request.Request(
                base_url + "/chat/completions",
                data=json.dumps(payload).encode("utf-8"), method="POST",
                headers={
                    "Authorization": "Bearer " + str(api_key),
                    "Content-Type": "application/json",
                    "User-Agent": "DouyinExporter/1.1",
                })
            with urllib.request.urlopen(req, timeout=180) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            try:
                j = json.loads(raw)
            except ValueError:
                return None, "chat 接口返回非 JSON：" + raw[:200], 200
            if isinstance(j, dict) and j.get("error"):
                err = j["error"]
                msg = (err.get("message") if isinstance(err, dict) else str(err))
                return None, f"接口错误：{msg}", 200
            try:
                text = (j["choices"][0]["message"].get("content") or "").strip()
            except (KeyError, IndexError, TypeError):
                text = ""
            if not text:
                return None, "接口返回空文本：" + raw[:200], 200
            return text, None, 200
        except urllib.error.HTTPError as e:
            detail = ""
            try:
                detail = e.read().decode("utf-8", errors="replace")[:300]
            except Exception:  # noqa: BLE001
                pass
            return None, f"HTTP {e.code}: {detail or e.reason}", e.code
        except Exception as e:  # noqa: BLE001
            return None, str(e), None

    @staticmethod
    def _synth_nihao() -> Path:
        """Windows 自带 SAPI 合成一段「你好」WAV（优先中文音色），测试用、离线。
        走 PowerShell（System.Speech 在 GAC 里，pythonnet 按名加载不到）。"""
        import tempfile
        tmp = Path(tempfile.gettempdir()) / f"dyce_nihao_{uuid.uuid4().hex[:8]}.wav"
        ps = (
            "Add-Type -AssemblyName System.Speech;"
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            "$zh = $s.GetInstalledVoices() | Where-Object { $_.Enabled -and "
            "$_.VoiceInfo.Culture.Name -like 'zh*' } | Select-Object -First 1;"
            "if ($zh) { $s.SelectVoice($zh.VoiceInfo.Name) };"
            f"$s.SetOutputToWaveFile('{tmp}');"
            '$s.Speak("你好"); $s.Dispose()'
        )
        r = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", ps],
            capture_output=True, timeout=60, stdin=subprocess.DEVNULL,
            creationflags=NO_WINDOW)
        if not tmp.is_file() or tmp.stat().st_size < 100:
            err = (r.stderr or b"").decode("utf-8", errors="replace")[:300]
            raise RuntimeError("本机 TTS 合成失败：" + (err or f"exit={r.returncode}"))
        return tmp

    def test_transcribe(self, base_url="", api_key="", model=""):
        """测试：现场合成「你好」上传，返回接口识别结果（用输入框当前值，空则回落已存配置）。"""
        try:
            saved = self._llm_raw()
            base_url = str(base_url or "").strip() or str(saved.get("base_url") or "")
            api_key = str(api_key or "").strip() or (self._llm_secret(saved) or "")
            model = (str(model or "").strip() or
                     str(saved.get("model") or "") or self.DEFAULT_LLM["model"])
            if not (base_url and api_key):
                return {"ok": False, "error": "请先填写 Base URL 和 API Key"}
            t0 = time.time()
            wav = self._synth_nihao()
            try:
                text, err = self._post_transcribe(base_url, api_key, model, wav)
            finally:
                try:
                    wav.unlink()
                except OSError:
                    pass
            ms = int((time.time() - t0) * 1000)
            if err:
                log(f"[测试转写] 失败：{err[:120]}")
                return {"ok": False, "error": err, "ms": ms}
            log(f"[测试转写] 通过：{text[:40]}（{ms}ms）")
            return {"ok": True, "text": text, "ms": ms}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def open_repo(self, url):
        """在系统浏览器打开项目仓库地址；只认 REPO_URLS 白名单，其余一律不开。"""
        u = str(url or "").strip()
        if not any(u == base or u.startswith(base + "/") for base in REPO_URLS):
            log("[关于] open_repo 拒绝非白名单地址：" + u[:120])
            return {"ok": False, "reason": "只允许打开项目仓库地址"}
        try:
            webbrowser.open(u)
            return {"ok": True, "url": u}
        except Exception as e:  # noqa: BLE001
            log("[关于] 打开浏览器失败：%r" % (e,))
            return {"ok": False, "reason": repr(e)}

    def open_exports(self):
        try:
            os.startfile(str(EXPORTS_DIR))
            return "ok"
        except Exception as e:  # noqa: BLE001
            return f"打开失败：{e}"

    def choose_export_dir(self):
        """弹出系统文件夹选择框，切换导出目录（后续导出/媒体都写入新目录）。"""
        global EXPORTS_DIR
        try:
            import clr  # noqa: F401
            clr.AddReference("System.Windows.Forms")
            from System.Windows.Forms import FolderBrowserDialog, DialogResult
            dlg = FolderBrowserDialog()
            dlg.Description = "选择导出文件夹"
            dlg.SelectedPath = str(EXPORTS_DIR)
            if dlg.ShowDialog() == DialogResult.OK:
                EXPORTS_DIR = Path(str(dlg.SelectedPath))
                EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
                return {"ok": True, "path": str(EXPORTS_DIR)}
            return {"ok": False}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)}

    def _media_file(self, conv, rel):
        """把 (会话, media/xxx) 解析成导出的绝对路径，越界或不存在返回 None。
        与 begin_media 同一套围栏：只允许 exports/<会话>/media/ 下的真实文件。"""
        try:
            base = (EXPORTS_DIR / self._safe(conv)).resolve()
            rel = str(rel or "")
            if not rel.startswith("media/") or ".." in rel:
                return None
            path = (base / rel).resolve()
            if not str(path).startswith(str(base)) or not path.is_file():
                return None
            return path
        except Exception:  # noqa: BLE001
            return None

    def save_media_as(self, conv, rel):
        """阅读器里右键「单独保存」：弹系统另存为框，把这一个媒体文件复制到用户选的位置。
        只读不写导出内容——保存路径由用户定，软件不猜。"""
        try:
            src = self._media_file(conv, rel)
            if not src:
                return {"ok": False, "error": "文件不存在（可能还没下载）"}
            import clr  # noqa: F401
            clr.AddReference("System.Windows.Forms")
            from System.Windows.Forms import SaveFileDialog, DialogResult
            dlg = SaveFileDialog()
            dlg.Title = "保存媒体文件"
            dlg.FileName = str(src.name)
            dl = Path.home() / "Downloads"
            dlg.InitialDirectory = str(dl if dl.is_dir() else EXPORTS_DIR)
            dlg.Filter = "所有文件 (*.*)|*.*"
            if dlg.ShowDialog() != DialogResult.OK:
                return {"ok": False, "cancelled": True}
            dst = Path(str(dlg.FileName))
            shutil.copyfile(str(src), str(dst))
            log(f"[保存] {conv}/{rel} → {dst}（{dst.stat().st_size} 字节）")
            return {"ok": True, "path": str(dst), "size": dst.stat().st_size,
                    "name": dst.name}
        except Exception as e:  # noqa: BLE001
            log("[保存失败] save_media_as: " + traceback.format_exc()[-400:])
            return {"ok": False, "error": str(e)}

    def delete_export_conv(self, name):
        """阅读器左侧右键「删除本机记录」：删掉 exports/<会话> 整个文件夹。
        只允许删 EXPORTS_DIR 的直接子目录，且传进来的名字必须已经是净化过的会话名
        （`_safe(name) == name`），否则一律不删——这是不可恢复的操作，宁可拒错。"""
        try:
            raw = str(name or "")
            safe = self._safe(raw)
            if not safe or safe != raw:
                return {"ok": False, "error": "会话名不是净化后的目录名，没敢删"}
            base = EXPORTS_DIR.resolve()
            d = (EXPORTS_DIR / safe).resolve()
            if d.parent != base or not d.is_dir():
                return {"ok": False, "error": "找不到这个会话文件夹"}
            size, _ = self._dir_stats(d)
            shutil.rmtree(str(d))
            log(f"[删除] 会话文件夹 {safe} 已删除（释放 {size} 字节）")
            return {"ok": True, "name": safe, "bytes": size}
        except Exception as e:  # noqa: BLE001
            log("[删除失败] delete_export_conv: " + traceback.format_exc()[-400:])
            return {"ok": False, "error": str(e)}

    @staticmethod
    def _safe(s):
        # Windows 会把目录/文件名末尾的点与空格静默剥离（"下次一定." 实际建成 "下次一定"），
        # 若不在这里去掉，返回给 HTML 的 rel 带点而磁盘无点，媒体/头像会全部 404。
        t = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", str(s or "")).strip().rstrip(".").strip()
        return t[:40] or "未知会话"

    def download_one(self, conv_name, task):
        """下载并解密单个媒体到 exports/<会话>/media/<sub>/<sid><ext>。
        HTML 与媒体同处会话文件夹内，rel 直接是可用的相对路径（便于整文件夹打包发送）。
        task: {kind, url, skey?, ext?, sub, sid, meta?}
        返回 {ok, rel, size}（已存在则 skipped=True）或 {ok:False, error}。"""
        try:
            conv = self._safe(conv_name)
            sub = re.sub(r"[^A-Za-z0-9_]", "", str(task.get("sub") or "files")) or "files"
            sid = str(task.get("sid") or "file")
            folder = EXPORTS_DIR / conv / "media" / sub
            # 扩展名词汇的权威出处是 media.EXTENSIONS（勿在此自复制元组）
            for e in media.EXTENSIONS:
                p = folder / (sid + e)
                # 0 字节的残留不算「已下载」：否则一次失败会让这个文件永远补不回来
                if p.exists() and p.stat().st_size == 0:
                    log(f"[媒体] {conv}/{sub}/{sid}{e} 是 0 字节，删除重下")
                    _silent_unlink(p)
                elif p.exists() and e == ".mp4" and sub in ("images", "shares", "emoji"):
                    # 旧版本把 HEIC 当 ftyp 一律存成 .mp4，浏览器解不出来 → 破图标。
                    # 发现这种「扩展名是 mp4、内容其实是图」的文件就删掉重下，这次会转成 JPEG。
                    head = b""
                    try:
                        with open(p, "rb") as fh:
                            head = fh.read(16)
                    except Exception:  # noqa: BLE001
                        pass
                    if media.is_image_bytes(head):
                        log(f"[媒体] {conv}/{sub}/{sid}.mp4 内容是图片，删除重下（HEIC 误判修复）")
                        _silent_unlink(p)
                elif p.exists():
                    return {"ok": True, "skipped": True,
                            "rel": f"media/{sub}/{sid}{e}", "size": p.stat().st_size}
            data, ext = media.process_task(task)
            folder.mkdir(parents=True, exist_ok=True)
            path = folder / (sid + ext)
            path.write_bytes(data)
            if ext.lower() in (".heic", ".heif"):
                # 浏览器解不了 HEIC（Edge/Chrome 无 HEVC 扩展时），转码失败要留痕才好定位
                log(f"[媒体] {conv}/{sub}/{sid} 存成 {ext}：HEIC 转 JPEG 没成功，"
                    f"阅读器里会显示「图片无法显示（HEIC 未转码成功）」")
            return {"ok": True, "rel": f"media/{sub}/{sid}{ext}", "size": len(data)}
        except Exception as e:  # noqa: BLE001
            log(f"[媒体失败] {self._safe(conv_name)}/{task.get('sub')}/{task.get('sid')} "
                f"kind={task.get('kind')}: {e}")
            return {"ok": False, "error": str(e)}


class Injector:
    def __init__(self, window: "webview.Window", js_code: str):
        self.window = window
        self.js_code = js_code

    def inject(self, *_args):
        """页面 loaded 事件触发；在后台线程重试注入，避免与页面首屏竞争"""
        log("loaded event fired, scheduling injector job")
        def job():
            # 先注入版本号 / 内联表情映射 / 接口字段表，再注入主脚本（同线程顺序执行，时序有保证）
            try:
                self.window.evaluate_js(
                    'window.__DYIN_VERSION=' + json.dumps(APP_VERSION) + ';'
                    "window.__DYIN_EMOJI_MAP=" + json.dumps(EMOJI_MAP, ensure_ascii=False) + ';'
                    "window.__DYIN_SCHEMA=" + json.dumps(SCHEMA, ensure_ascii=False) + ";")
            except Exception as e:  # noqa: BLE001
                log(f"emoji map inject failed: {e!r}")
            for i in range(12):
                try:
                    self.window.evaluate_js(self.js_code)
                    log(f"inject OK at try {i+1} -> {self.window.get_current_url()}")
                    return
                except Exception as e:  # noqa: BLE001
                    log(f"inject retry {i+1}: {e!r}")
                    threading.Event().wait(1)
            log("inject FAILED: page not ready")

        threading.Thread(target=job, daemon=True).start()


def webview2_available() -> bool:
    """检查系统是否装有 WebView2 运行时（Win11 自带，部分 Win10 需单独安装）。
    查 Evergreen 运行时的注册表登记项（微软官方判定方式）。"""
    import winreg
    GUID = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
    for hive, path in (
        (winreg.HKEY_LOCAL_MACHINE, "SOFTWARE\\WOW6432Node\\Microsoft\\EdgeUpdate\\Clients\\" + GUID),
        (winreg.HKEY_LOCAL_MACHINE, "SOFTWARE\\Microsoft\\EdgeUpdate\\Clients\\" + GUID),
        (winreg.HKEY_CURRENT_USER, "Software\\Microsoft\\EdgeUpdate\\Clients\\" + GUID),
    ):
        try:
            with winreg.OpenKey(hive, path):
                return True
        except OSError:
            continue
    return False


def main():
    log("main() enter")
    # 上次点过「清除登录态」的话，必须在创建窗口（WebView2 锁住 Data/）之前删掉
    apply_pending_logout()
    js_path = resource_path("injector.js")
    log(f"injector.js path={js_path} exists={js_path.exists()}")
    if not js_path.exists():
        raise FileNotFoundError(f"找不到注入脚本：{js_path}")
    js_code = js_path.read_text(encoding="utf-8")
    log(f"injector.js loaded, {len(js_code)} chars")

    api = JsApi()
    log("before create_window")
    # 远程调试口默认关闭（发布安全：开放的 9222 端口允许本机任意进程控制 WebView、
    # 读取登录 Cookie）。需要用 tools/cdp*.py 排查问题时，设环境变量 DY_DEBUG=1 再启动。
    if os.environ.get("DY_DEBUG"):
        os.environ["WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS"] = "--remote-debugging-port=9222"
        log("DY_DEBUG=1: remote debugging on :9222")
    window = webview.create_window(
        f"抖音聊天记录导出器 v{APP_VERSION}",
        HOME_URL,
        js_api=api,
        width=1320,
        height=880,
        min_size=(1000, 680),
        text_select=True,
    )
    api._window = window
    injector = Injector(window, js_code)
    window.events.loaded += injector.inject

    def _titlebar_on_show(*_):
        # 登录页（抖音自己的白底）阶段也要同色，所以不等页面里的主题回调
        hwnd = api._hwnd()
        if hwnd:
            r = apply_titlebar(hwnd, saved_theme())
            log(f"[标题栏] 启动按主题 {r['mode']} 设色：hr={r['hr']}")
        else:
            log("[标题栏] 启动时没拿到窗口句柄，配色等页面主题回调")

    window.events.shown += _titlebar_on_show

    print("=" * 56)
    print(" 抖音聊天记录导出器启动中…")
    print(f" 登录数据目录(便携)：{DATA_DIR}")
    print(f" 导出文件目录    ：{EXPORTS_DIR}")
    print(" 首次使用请在页面内扫码登录抖音，登录态会自动保存")
    print("=" * 56)

    # gui=edgechromium 强制使用 WebView2；storage_path 指定便携数据目录（Cookie 持久化）
    # private_mode 必须显式 False：pywebview 默认 True，退出时会 clear_user_data() 把
    # storage_path 整个 rmtree（表现为登录态每次关闭后被清空）。
    # icon 是 start() 的参数、不是 create_window() 的（写错会直接 TypeError 起不来）：
    # 它落到 _state['icon']，winforms 后端在建窗口时读它（文档只写了 GTK/QT，实测 Windows 也生效）。
    # 深色标题栏必须换浅色描边那套图标，否则几乎看不见，所以按上次主题挑文件。
    log("before webview.start (edgechromium + storage_path + private_mode=False)")
    webview.start(
        storage_path=str(DATA_DIR),
        gui="edgechromium",
        private_mode=False,
        debug=False,
        icon=str(resource_path(THEME_TITLEBAR[saved_theme()]["icon"])),
    )
    log("webview.start returned, exiting")


def _log_exc(exc_type, exc_value, tb):
    """未捕获异常（主线程/子线程）写入日志，供远程分析。"""
    import traceback as tb_mod
    log("未捕获异常: " + "".join(tb_mod.format_exception(exc_type, exc_value, tb))[-1500:])


sys.excepthook = _log_exc
try:
    import threading as _threading
    _threading.excepthook = lambda a: _log_exc(a.exc_type, a.exc_value, a.exc_traceback)
except Exception:  # noqa: BLE001
    pass


if __name__ == "__main__":
    # 缺 WebView2 时 pywebview 会在窗口创建阶段静默失败（windowed 模式连错误都看不见），
    # 这里提前用系统弹窗给出人话指引，而不是让接收方以为软件是坏的。
    if webview2_available() is False:
        try:
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                0,
                "未检测到 Microsoft Edge WebView2 运行时，软件无法启动。\n\n"
                "请先用浏览器打开下面的微软官网，下载安装「WebView2 Runtime」\n"
                "（选 Evergreen Standalone Installer 即可，装完重新打开本软件）：\n\n"
                "https://developer.microsoft.com/microsoft-edge/webview2/\n\n"
                "Win11 一般自带；本检测仅拦截确实缺失的情况。",
                "缺少运行组件",
                0x10,  # MB_ICONERROR
            )
        except Exception:  # noqa: BLE001
            pass
        sys.exit(1)
    try:
        main()
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        try:
            input("程序异常，按回车键退出…")
        except EOFError:
            pass
