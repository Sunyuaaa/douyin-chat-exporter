# -*- coding: utf-8 -*-
"""test_export.py — app.py 落盘 / 密钥 / 登录态 的离线自检（不联网、不开窗口、不碰真目录）。

用法：.\\.venv\\Scripts\\python.exe test_export.py

覆盖：
  1) clean_text 处理 JS 切断代理对产生的孤立代理项（曾经导致 0 字节文件）；
  2) write_text_atomic 原子写：不留 .part、\\r\\n 不被翻译成 \\r\\r\\n；
  3) 分块导出 begin/append/finish 的字节正确，空内容与非法 eid 必须算失败；
  4) CSV 只有一个 BOM（Python 侧 utf-8-sig 负责，JS 侧不再重复加）；
  5) API Key 走 DPAPI 加密，文件里没有明文，且任何回传给页面的结果都不含明文；
  6) 留空不修改 / clear_key 清除的语义；
  7) apply_pending_logout 按标记删除数据目录，删不掉时保留标记；
  8) download_one 已存在文件跳过。
"""
import json
import os
import sys
import subprocess
import tempfile
import shutil
from pathlib import Path

try:      # Windows 控制台默认 GBK，测试里要打印 U+FFFD / 中文，先切成 UTF-8
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

sys.path.insert(0, str(Path(__file__).resolve().parent))
import app  # noqa: E402
import media  # noqa: E402

# app.py 在导入时把 sys.excepthook 换成了「异常只写 boot.log」——产品里对，测试里会让
# 崩溃变成「静默 exit 1，什么栈都看不到」（这次就踩了一次）。测试脚本要正常打印栈。
sys.excepthook = sys.__excepthook__

FAILS = []


def chk(name, ok, detail=""):
    print(("ok   - " if ok else "FAIL - ") + name + (("  " + str(detail)) if detail else ""))
    if not ok:
        FAILS.append(name)


def fresh_api(tmp):
    """把导出目录与登录数据目录指到临时文件夹，绝不碰真实的 exports/ 与 Data/。"""
    app.EXPORTS_DIR = Path(tmp) / "exports"
    app.EXPORTS_DIR.mkdir(parents=True, exist_ok=True)
    app.DATA_DIR = Path(tmp) / "Data"
    app.LOGOUT_FLAG = Path(tmp) / ".logout_pending"
    api = app.JsApi()
    return api


# ---------- 1) 孤立代理项 ----------
lone = "前面" + "\ud83d" + "后面"          # 半个 emoji 代理对
cleaned = app.clean_text(lone)
chk("clean_text 替换孤立代理项", "\ud83d" not in cleaned and "前面" in cleaned and "后面" in cleaned,
    repr(cleaned))
pair = "好\U0001F602好"
chk("clean_text 保留完整 emoji 代理对", app.clean_text(pair) == pair)

# ---------- 2) 原子写 ----------
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    p = app.EXPORTS_DIR / "t" / "t.txt"
    p.parent.mkdir(parents=True, exist_ok=True)
    size = app.write_text_atomic(p, "a\r\nb\r\n" + lone, "utf-8")
    raw = p.read_bytes()
    chk("write_text_atomic 写出字节数与内容一致", raw.count(b"\r\n") == 2 and b"\r\r\n" not in raw,
        "size=%d" % size)
    chk("write_text_atomic 不留 .part 文件", not (p.parent / (p.name + ".part")).exists())
    chk("write_text_atomic 清洗后能落盘", raw.decode("utf-8") == "a\r\nb\r\n" + cleaned)

# ---------- 3) 分块导出 ----------
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    big = "".join("行%d,%s\n" % (i, "x" * 200) for i in range(2000))
    eid = api.begin_export("某人", "txt")
    api.append_export(eid, big[:1000])
    r_mid = api.append_export(eid, big[1000:])
    fin = api.finish_export(eid)
    got = (app.EXPORTS_DIR / "某人" / "某人.txt").read_text(encoding="utf-8")
    chk("分块导出内容逐字节一致", got == big and r_mid["ok"], "chars=%d" % r_mid["chars"])
    chk("finish 返回 ok/size/name", fin["ok"] and fin["size"] == len(big.encode("utf-8"))
        and fin["name"] == "某人.txt", str(fin)[:120])
    chk("会话名里的非法字符被清洗", api.begin_export("a/b:c.", "json") and
        (app.EXPORTS_DIR / "a_b_c").is_dir())
    bad = api.finish_export(999999)
    chk("非法 eid 的 finish 明确失败", bad["ok"] is False, str(bad)[:80])
    empty = api.finish_export(api.begin_export("空", "csv"))
    chk("没有分块内容的 finish 判为失败", empty["ok"] is False and "空" in str(empty["error"]),
        str(empty)[:80])
    chk("失败的 finish 不会留下 0 字节文件",
        not (app.EXPORTS_DIR / "空" / "空.csv").exists())

# ---------- 4) CSV 单 BOM ----------
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    eid = api.begin_export("c", "csv")
    api.append_export(eid, "时间,内容\r\n2026,x")     # JS 侧已不再自己加 BOM
    fin = api.finish_export(eid)
    raw = (app.EXPORTS_DIR / "c" / "c.csv").read_bytes()
    chk("CSV 只有一个 BOM", raw.startswith(b"\xef\xbb\xbf") and
        not raw[3:6] == b"\xef\xbb\xbf", raw[:12])
    chk("CSV 换行未被二次翻译", b"\r\r\n" not in raw)
    chk("CSV 落盘字节数与返回值一致", fin["size"] == len(raw), "%d vs %d" % (fin["size"], len(raw)))
    # save_export 必须返回结构化结果（JS 靠 ok/size 判成败，不能猜文案前缀）
    ok = api.save_export("txt", "内容内容", "s")
    chk("save_export 成功返回 ok/name/size", ok["ok"] is True and ok["size"] > 0 and
        ok["name"] == "s.txt", str(ok)[:110])
    bad = api.save_export("txt", "", "s2")
    chk("save_export 空内容判为失败", bad["ok"] is False and bad.get("error"), str(bad)[:90])
    chk("save_export 失败不留文件", not (app.EXPORTS_DIR / "s2" / "s2.txt").exists())
    sur = api.save_export("html", lone, "脏字符")
    chk("save_export 能清洗孤立代理项后落盘", sur["ok"] is True and
        "\ufffd" in (app.EXPORTS_DIR / "脏字符" / "脏字符.html").read_text(encoding="utf-8"))

# ---------- 5/6) DPAPI 与保存语义 ----------
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    app.DATA_DIR.mkdir(parents=True, exist_ok=True)
    secret = "sk-test-1234567890abcdef"
    r = api.save_llm_config("https://x/v1/", secret, "mimo-v2.5-asr", False)
    disk = (app.DATA_DIR / "llm_config.json").read_text(encoding="utf-8")
    chk("保存成功且带 Base URL 尾斜杠被去掉", r["ok"] and r["configured"] and
        "https://x/v1\"" in disk, disk.replace("\n", " ")[:160])
    if r["key_protected"]:
        chk("磁盘上没有明文 Key", secret not in disk)
        chk("DPAPI 密文可解回原值", api._llm_secret() == secret)
    else:
        print("     （本机 DPAPI 不可用，退回明文——两项加密断言跳过）")
        chk("明文回退时仍能读回 Key", api._llm_secret() == secret)
    view = api.get_llm_config()
    chk("回传给页面的配置不含明文 Key", secret not in json.dumps(view, ensure_ascii=False),
        json.dumps(view["config"], ensure_ascii=False)[:160])
    chk("页面看到掩码与 has_key", view["config"]["has_key"] is True and
        secret not in view["config"]["api_key_mask"] and "…" in view["config"]["api_key_mask"],
        view["config"]["api_key_mask"])
    # 留空不修改
    api.save_llm_config("https://y/v1", "", "other-model", False)
    chk("API Key 留空时沿用已保存的", api._llm_secret() == secret)
    # 重填则替换
    api.save_llm_config("https://y/v1", "sk-new-000000009999", "other-model", False)
    chk("重填 Key 会替换", api._llm_secret() == "sk-new-000000009999")
    # 清除
    api.save_llm_config("https://y/v1", "", "", True)
    chk("clear_key 会删除 Key", api._llm_secret() == "" and
        not api.get_llm_config()["config"]["has_key"])
    # 旧明文自动迁移
    (app.DATA_DIR / "llm_config.json").write_text(
        json.dumps({"base_url": "https://z/v1", "api_key": "sk-legacy-9999",
                    "model": "mimo-v2.5-asr"}), encoding="utf-8")
    got = api._llm_secret()
    disk2 = (app.DATA_DIR / "llm_config.json").read_text(encoding="utf-8")
    chk("旧明文配置能正常读回", got == "sk-legacy-9999", got)
    if api.get_llm_config()["config"]["key_protected"]:
        chk("读旧明文后自动迁移成密文", "sk-legacy-9999" not in disk2)
    badfile = app.DATA_DIR / "llm_config.json"
    badfile.write_text("{ 坏掉的 json", encoding="utf-8")
    chk("损坏的配置文件按未配置处理而不是崩", api.get_llm_config()["ok"] is True and
        api.get_llm_config()["config"]["configured"] is False)

# ---------- 7) 退出登录标记 ----------
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    app.DATA_DIR.mkdir(parents=True)
    (app.DATA_DIR / "whatever.txt").write_text("x", encoding="utf-8")
    chk("未标记时不动 Data/", (app.apply_pending_logout() is None) and app.DATA_DIR.exists())
    api.request_reset_login()
    chk("点击后写入标记文件", app.LOGOUT_FLAG.exists())
    app.apply_pending_logout()
    chk("按标记删除整个 Data/", not app.DATA_DIR.exists() and not app.LOGOUT_FLAG.exists())
    # 删不掉（被占用）时保留标记
    app.DATA_DIR.mkdir(parents=True)
    keep = app.DATA_DIR
    try:
        handle = open(keep / "locked.bin", "wb")
        handle.write(b"x" * 10)
        app.LOGOUT_FLAG.write_text("again", encoding="utf-8")
        app.apply_pending_logout()
        chk("Data/ 被占用时保留标记，下次再清",
            app.LOGOUT_FLAG.exists() or not app.DATA_DIR.exists(),
            "flag=%s dir=%s" % (app.LOGOUT_FLAG.exists(), app.DATA_DIR.exists()))
        handle.close()
    except OSError:
        print("     （无法制造占用场景，跳过）")
    shutil.rmtree(keep, ignore_errors=True)

# ---------- 8) download_one 跳过已存在 ----------
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    vdir = app.EXPORTS_DIR / "某人" / "media" / "voice"
    vdir.mkdir(parents=True)
    (vdir / "123.m4a").write_bytes(b"fake-audio")
    res = api.download_one("某人", {"kind": "plain", "url": "http://x", "sub": "voice", "sid": "123"})
    chk("已存在的媒体直接跳过不重复下载", res["ok"] and res.get("skipped") and
        res["rel"] == "media/voice/123.m4a", str(res))
    # 坏缓存要能自愈：0 字节、以及「内容是 HEIC 却被存成 .mp4」的图
    idir = app.EXPORTS_DIR / "某人" / "media" / "images"
    idir.mkdir(parents=True)
    (idir / "0byte.jpg").write_bytes(b"")
    heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x02\x00" + b"fake-heic-body" * 8
    (idir / "bad.mp4").write_bytes(heic)
    called = []
    real_pt = media.process_task
    def fake_pt(task, transport=None):
        called.append(task["sid"])
        return heic, ".heic"
    media.process_task = fake_pt
    try:
        r0 = api.download_one("某人", {"kind": "plain", "url": "u", "sub": "images", "sid": "0byte"})
        r1 = api.download_one("某人", {"kind": "plain", "url": "u", "sub": "images", "sid": "bad"})
        chk("0 字节的残留文件会重下而不是当已下载",
            "0byte" in called and r0.get("skipped") is not True, str(r0)[:80])
        chk("内容其实是图的 .mp4 会被删掉重下（HEIC 误判自愈）",
            "bad" in called and r1.get("skipped") is not True, str(r1)[:80])
        chk("自愈后不再留 .mp4 的假视频", not (idir / "bad.mp4").exists())
    finally:
        media.process_task = real_pt

# ---------- 8b) 右键单独保存：只许读 exports/<会话>/media/ 下的真实文件 ----------
# 只测「该拒绝的分支」——文件真存在时会弹系统另存为框，离线测试里不能弹。
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    r1 = api.save_media_as("某人", "media/../../../../Windows/win.ini")
    chk("穿越路径被拒（不弹框、不读围栏外的文件）",
        r1["ok"] is False and "不存在" in r1["error"], str(r1))
    r2 = api.save_media_as("某人", "etc/passwd")
    chk("非 media/ 前缀被拒", r2["ok"] is False, str(r2))
    r3 = api.save_media_as("某人", "media/images/nope.jpg")
    chk("文件不存在时给明确原因", r3["ok"] is False and "不存在" in r3["error"], str(r3))
    chk("_media_file 对越界返回 None", api._media_file("某人", "media/../boot.log") is None)

# ---------- 8c) 右键删除整个会话文件夹：不可恢复，围栏必须严 ----------
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    me = app.EXPORTS_DIR / "某人"
    (me / "media" / "images").mkdir(parents=True)
    (me / "某人.json").write_text('{"messages": []}', encoding="utf-8")
    (me / "media" / "images" / "a.jpg").write_bytes(b"y" * 5000)
    other = app.EXPORTS_DIR / "别人"
    other.mkdir()
    (other / "别人.json").write_text('{"messages": []}', encoding="utf-8")
    bad = api.delete_export_conv("../别人")
    chk("路径穿越的名字直接拒", bad["ok"] is False, str(bad)[:80])
    bad2 = api.delete_export_conv("某人/../别人")
    chk("带分隔符的名字直接拒", bad2["ok"] is False, str(bad2)[:80])
    nf = api.delete_export_conv("没这个会话")
    chk("没有对应文件夹时报「找不到」而不是删点别的",
        nf["ok"] is False and "找不到" in nf["error"], str(nf)[:80])
    ok = api.delete_export_conv("某人")
    chk("删掉整个会话文件夹并回报释放字节",
        ok["ok"] and ok["bytes"] >= 5000 and not me.exists(), str(ok)[:90])
    chk("只删指定的那一个，别的会话不受影响",
        other.exists() and (other / "别人.json").exists())

# ---------- 9) 子进程不能闪 cmd 黑框 ----------
# pythonw / console=False 的父进程 spawn 控制台程序会各开一个窗口（语音转码=每条一次）。
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    seen = {}

    def fake_run(cmd, *a, **kw):
        seen["cmd"] = cmd[0]
        seen["creationflags"] = kw.get("creationflags")
        seen["stdin"] = kw.get("stdin")

        class R:
            returncode = 1          # 让它走"失败"分支即可，只关心调用参数
            stdout = b""
            stderr = b"stub"
        return R()

    real_run, real_which = app.subprocess.run, app.shutil.which
    real_mrun, real_mwhich = media.subprocess.run, media.shutil.which
    try:
        app.subprocess.run = fake_run
        app.shutil.which = lambda x: "C:/fake/ffmpeg.exe"
        src = Path(tmp) / "v.m4a"
        src.write_bytes(b"fake")
        _p, _tmp, err = app.to_chat_audio(src)
        chk("语音转码调用 ffmpeg 时带 CREATE_NO_WINDOW",
            seen.get("creationflags") == getattr(subprocess, "CREATE_NO_WINDOW", 0) and
            bool(seen.get("creationflags")),
            "flags=%s ffmpeg=%s 错误=%s" % (seen.get("creationflags"), seen.get("cmd"), str(err)[:40]))
        chk("转码子进程 stdin 已重定向（不继承控制台）", seen.get("stdin") is not None)
        seen.clear()
        media.subprocess.run = fake_run
        media.shutil.which = lambda x: "C:/fake/ffmpeg.exe"
        media._faststart(b"x" * 100)
        chk("视频 faststart 调用 ffmpeg 也带 CREATE_NO_WINDOW",
            seen.get("creationflags") == getattr(subprocess, "CREATE_NO_WINDOW", 0),
            "flags=%s" % seen.get("creationflags"))
    finally:
        app.subprocess.run, app.shutil.which = real_run, real_which
        media.subprocess.run, media.shutil.which = real_mrun, real_mwhich

# ---------- ffmpeg 查找顺序（PATH → 程序目录的 ffmpeg.exe → 内置 imageio-ffmpeg）----------
with tempfile.TemporaryDirectory() as tmp:
    real_base, real_which = app.BASE, app.shutil.which
    real_mod = sys.modules.get("imageio_ffmpeg")
    try:
        app.BASE = Path(tmp)
        app.shutil.which = lambda x: "C:/win/ffmpeg.exe"
        chk("ffmpeg 优先用系统 PATH", app.ffmpeg_exe() == "C:/win/ffmpeg.exe")
        app.shutil.which = lambda x: None
        (app.BASE / "ffmpeg.exe").write_bytes(b"MZ")
        chk("PATH 没有时认程序目录里的 ffmpeg.exe",
            app.ffmpeg_exe() == str(app.BASE / "ffmpeg.exe"), str(app.ffmpeg_exe()))
        (app.BASE / "ffmpeg.exe").unlink()
        sys.modules["imageio_ffmpeg"] = None          # 让 import 直接失败，模拟第三档也没有
        chk("三档都没有 → None（调用方给中文提示）", app.ffmpeg_exe() is None)
    finally:
        app.BASE, app.shutil.which = real_base, real_which
        if real_mod is None:
            sys.modules.pop("imageio_ffmpeg", None)
        else:
            sys.modules["imageio_ffmpeg"] = real_mod
    chk("app/media 的 NO_WINDOW 常量非零（Windows 上）",
        app.NO_WINDOW != 0 and media.NO_WINDOW != 0,
        "%d / %d" % (app.NO_WINDOW, media.NO_WINDOW))

# ---------- 10) 转写：限流退避重试 + 缓存回填 ----------
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    # 重试策略判定
    cases = [(429, True), (500, True), (503, True), (408, True), (None, True),
             (400, False), (401, False), (403, False), (200, False)]
    bad = [c for c, want in cases if bool(api._asr_retry_wait("HTTP %s: x" % c, c)) != want]
    chk("退避策略只对 429/5xx/网络错重试", not bad, "判断错的码: %s" % bad)
    chk("429 读 Retry-After 头", api._asr_retry_wait("retry-after: 12", 429) == 12.0,
        str(api._asr_retry_wait("retry-after: 12", 429)))
    chk("Retry-After 上限 60s", api._asr_retry_wait("Retry-After: 999", 429) == 60.0)

    # 模拟前两次 429、第三次成功
    calls = {"n": 0}
    real_sleep = app.time.sleep
    app.time.sleep = lambda s: None
    try:
        def fake_once(url, key, model, src):
            calls["n"] += 1
            if calls["n"] < 3:
                return None, "HTTP 429: too many requests", 429
            return "转好了", None, 200
        api._asr_once = fake_once
        text, err = api._post_transcribe("https://x/v1", "k", "m", Path("x"))
        chk("429 会自动重试直到成功", text == "转好了" and calls["n"] == 3,
            "尝试 %d 次 text=%r" % (calls["n"], text))

        calls["n"] = 0
        def always_400(url, key, model, src):
            calls["n"] += 1
            return None, "HTTP 400: input_audio.format must be one of: wav, mp3", 400
        api._asr_once = always_400
        text, err = api._post_transcribe("https://x/v1", "k", "m", Path("x"))
        chk("400 参数错不浪费重试", text is None and calls["n"] == 1, "尝试 %d 次" % calls["n"])

        calls["n"] = 0
        def always_429(url, key, model, src):
            calls["n"] += 1
            return None, "HTTP 429: slow down", 429
        api._asr_once = always_429
        text, err = api._post_transcribe("https://x/v1", "k", "m", Path("x"))
        chk("持续限流最多试 4 次后带原因返回", text is None and calls["n"] == 4 and "429" in err,
            "尝试 %d 次 err=%s" % (calls["n"], str(err)[:40]))
    finally:
        app.time.sleep = real_sleep

    # 缓存回填（重启后 .txt 还在）
    vd = app.EXPORTS_DIR / "某人" / "media" / "voice"
    vd.mkdir(parents=True)
    (vd / "111.txt").write_text("第一句", encoding="utf-8")
    (vd / "222.txt").write_text("  ", encoding="utf-8")          # 空的要忽略
    (vd / "333.m4a").write_bytes(b"x")
    got = api.voice_texts("某人")
    chk("voice_texts 读回非空缓存", got["ok"] and got["count"] == 1 and
        got["texts"] == {"111": "第一句"}, str(got)[:90])
    chk("voice_texts 目录不存在也不报错", api.voice_texts("没这个会话")["ok"] and
        api.voice_texts("没这个会话")["count"] == 0)

    # 列表里的条数：阅读器侧栏要把「N 条」显示在名字后面，靠 list_export_convs 带出 meta.total
    jd = app.EXPORTS_DIR / "某人"
    (jd / "某人.json").write_text(
        '{"meta": {"conversation": "某人", "total": 4059}, "messages": [' + ("x" * 200000) + ']}',
        encoding="utf-8")
    convs = api.list_export_convs()["convs"]
    mine = [c for c in convs if c["name"] == "某人"]
    chk("list_export_convs 带出条数", len(mine) == 1 and mine[0]["total"] == 4059, str(mine)[:90])
    # 侧栏那行「已导出 X MB」= 整个会话文件夹，含媒体；只报 JSON 大小会和概览「占用空间」对不上
    want = sum(p.stat().st_size for p in (app.EXPORTS_DIR / "某人").rglob("*") if p.is_file())
    json_only = (app.EXPORTS_DIR / "某人" / "某人.json").stat().st_size
    chk("list_export_convs 的 size 含媒体（比 JSON 单独大，且等于目录总字节）",
        len(mine) == 1 and mine[0]["size"] == want and want > json_only,
        "size=%s 目录=%s 仅JSON=%s" % (mine[0]["size"], want, json_only))
    (app.EXPORTS_DIR / "无条数").mkdir()
    (app.EXPORTS_DIR / "无条数" / "无条数.json").write_text('{"messages": []}', encoding="utf-8")
    bad = [c for c in api.list_export_convs()["convs"] if c["name"] == "无条数"]
    chk("老 JSON 没 total 时返回 None 不报错", len(bad) == 1 and bad[0]["total"] is None, str(bad)[:90])

    # 概览页三个数字的本机口径（重启后内存为空，以前恒显示 0）
    # 用独立的会话目录做断言，避免被上面 voice_texts 用例留下的 333.m4a 干扰
    md = (app.EXPORTS_DIR / "概览" / "media")
    (md / "images").mkdir(parents=True, exist_ok=True)
    (md / "voice").mkdir(parents=True, exist_ok=True)
    (app.EXPORTS_DIR / "概览" / "概览.json").write_text(
        '{"meta": {"conversation": "概览", "total": 77}, "messages": []}', encoding="utf-8")
    for i in range(3):
        (md / "images" / ("i%d.jpg" % i)).write_bytes(b"x")
    (md / "voice" / "v1.m4a").write_bytes(b"x")
    (md / "voice" / "v1.txt").write_text("转写缓存", encoding="utf-8")   # 不算媒体
    (md / "表情包.zip").write_bytes(b"x")                              # 不算媒体
    st = api.overview_stats()
    chk("overview_stats 每会话明细（.txt/.zip 不计入媒体）",
        st["ok"] and st["perConv"].get("概览") == {"total": 77, "media": 4}, str(st["perConv"])[:120])
    want_bytes = sum(p.stat().st_size for p in (app.EXPORTS_DIR / "概览").rglob("*") if p.is_file())
    chk("overview_stats 的 bytes 覆盖该会话目录里所有文件（媒体 + JSON/zip 都算）",
        st["bytes"] >= want_bytes and want_bytes > 0,
        "bytes=%s ≥ 概览目录 %s 字节" % (st.get("bytes"), want_bytes))
    chk("overview_stats 汇总值覆盖各会话",
        st["messages"] >= 77 + 4059 and st["media"] >= 4 and st["convs"] >= 2,
        "msgs=%s media=%s convs=%s" % (st.get("messages"), st.get("media"), st.get("convs")))
    # 只有转写缓存、没有 JSON 也没有媒体的目录不该被算成一个会话
    (app.EXPORTS_DIR / "空壳" / "media" / "voice").mkdir(parents=True)
    (app.EXPORTS_DIR / "空壳" / "media" / "voice" / "a.txt").write_text("x", encoding="utf-8")
    chk("只有缓存文件的目录不计入概览", "空壳" not in api.overview_stats()["perConv"])
    empty = Path(tmp) / "无导出目录"
    app.EXPORTS_DIR = empty
    st2 = api.overview_stats()
    chk("没有 exports 时返回全 0 不报错",
        st2["ok"] and st2["messages"] == 0 and st2["media"] == 0 and st2["convs"] == 0
        and st2["bytes"] == 0, str(st2)[:90])

# ---------- 12) 标题栏配色 / 主题记忆 / 图标文件 ----------
with tempfile.TemporaryDirectory() as tmp:
    api = fresh_api(tmp)
    app.UI_THEME_FILE = Path(tmp) / "Data" / "ui_theme.txt"
    chk("主题名归一（只认 dark，其余按 light）",
        app.norm_theme("DARK") == "dark" and app.norm_theme("light") == "light"
        and app.norm_theme("") == "light" and app.norm_theme(None) == "light")
    chk("没存过主题时默认浅色", app.saved_theme() == "light")
    app.save_theme("dark")
    chk("主题写盘可读回", app.saved_theme() == "dark" and app.UI_THEME_FILE.exists())
    # 句柄无效（0）：DWM 只会返回错误码，不能抛异常——启动路径上它是在 GUI 线程里跑的
    r = app.apply_titlebar(0, "dark")
    chk("无效句柄下 apply_titlebar 不抛异常且结构完整",
        isinstance(r, dict) and r.get("mode") == "dark" and set(r.get("hr", {})) == {"20", "34", "35", "36"},
        str(r)[:110])
    chk("两套标题栏图标都在且不是空壳",
        all(app.resource_path(n).exists() and app.resource_path(n).stat().st_size > 1000
            for n in ("app-icon.ico", "app-icon-dark.ico")),
        str([(n, app.resource_path(n).stat().st_size if app.resource_path(n).exists() else None)
             for n in ("app-icon.ico", "app-icon-dark.ico")]))
    # 配色常量必须和 injector.js 里的 --bg / --text 对得上（COLORREF 是 0x00BBGGRR）
    chk("浅色标题栏底色 = #f5f6f8", app.THEME_TITLEBAR["light"]["caption"] == 0x00F8F6F5)
    chk("深色标题栏底色 = #17181c", app.THEME_TITLEBAR["dark"]["caption"] == 0x001C1817)

print("---")
print("FAIL ×%d" % len(FAILS) if FAILS else "OK 全部通过")
sys.exit(1 if FAILS else 0)
