# -*- coding: utf-8 -*-
"""标题栏配色 / 图标自检（开发用，会真的弹一个窗口并截屏）。

为什么需要：DWM 的 35/36 属性只在 Win11 有，设不上也不抛异常（只返回错误码），
而且 DwmGetWindowAttribute 根本不支持读回这几个属性（实测返回失败），
光看代码或读回值都无法判断「到底有没有生效」。
这里真的建窗口、真的设属性，再把屏幕对应区域截下来直接比对标题栏像素颜色。

用法：python tools/check_titlebar.py   （产物 tools/_titlebar_light.png / _dark.png 可直接看）
"""
import ctypes
import ctypes.wintypes
import json
import re
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import webview  # noqa: E402

import app as A  # noqa: E402

HERE = Path(__file__).resolve().parent
FAILS = []


def chk(name, cond, extra=""):
    print(("ok   - " if cond else "FAIL - ") + name + ("  " + extra if extra else ""))
    if not cond:
        FAILS.append(name)


def win_rect(hwnd):
    r = ctypes.wintypes.RECT()
    ctypes.windll.user32.GetWindowRect(ctypes.c_void_p(hwnd), ctypes.byref(r))
    return r.left, r.top, r.right, r.bottom


def grab(hwnd, path):
    """截窗口所在区域；返回 (图, 标题栏主色)。

    DPI 缩放会让 GetWindowRect（物理像素）和 Pillow 抓到的位图尺寸不在一个坐标系，
    直接按 rect 裁会裁到桌布上（实测就是这样）。所以用虚拟屏幕尺寸做一次线性标定。
    """
    from PIL import ImageGrab
    u = ctypes.windll.user32
    u.SetForegroundWindow(ctypes.c_void_p(hwnd))
    time.sleep(0.25)
    full = ImageGrab.grab(all_screens=True).convert("RGB")
    vx, vy = u.GetSystemMetrics(76), u.GetSystemMetrics(77)   # 虚拟屏幕原点
    sw, sh = u.GetSystemMetrics(78), u.GetSystemMetrics(79)   # 虚拟屏幕尺寸
    kx, ky = (full.width / sw if sw else 1.0), (full.height / sh if sh else 1.0)
    l, t, r, b = win_rect(hwnd)
    box = (int((l - vx) * kx), int((t - vy) * ky), int((r - vx) * kx), int((b - vy) * ky))
    im = full.crop(box)
    im.save(path)
    full.resize((full.width // 3, full.height // 3)).save(HERE / "_titlebar_full.png")
    out_dbg = {"metrics": (vx, vy, sw, sh), "rect": (l, t, r, b),
               "k": (round(kx, 3), round(ky, 3)), "box": box, "shot": im.size}
    # 标题栏在顶部约 34 物理像素内；取每行出现最多的颜色，挑最"纯"的那一行
    best, best_ratio = None, 0.0
    for y in range(4, min(30, im.height)):
        row = [im.getpixel((x, y)) for x in range(20, max(21, im.width - 200), 7)]
        if len(row) < 8:
            continue
        c = max(set(row), key=row.count)
        ratio = row.count(c) / len(row)
        if ratio > best_ratio:
            best, best_ratio = c, ratio
    return im, best, out_dbg


def close_enough(a, b, tol=8):
    return a is not None and all(abs(x - y) <= tol for x, y in zip(a, b))


def desktop_locked() -> bool:
    """屏幕锁定时截到的全是锁屏桌布，任何像素断言都没意义（实测会把「通过」蒙对）。
    输入桌面不是 Default 就说明当前不在交互桌面上。"""
    u = ctypes.windll.user32
    h = u.OpenInputDesktop(0, False, 0x0100)          # DESKTOP_SWITCHDESKTOP
    if not h:
        h = u.OpenInputDesktop(0, False, 0x0001)      # DESKTOP_READOBJECTS
    if not h:
        return True
    try:
        buf = ctypes.create_unicode_buffer(256)
        ok = ctypes.windll.user32.GetUserObjectInformationW(h, 2, buf, 512, None)  # UOI_NAME
        return bool(ok) and buf.value.strip().lower() != "default"
    finally:
        u.CloseDesktop(h)


def main():
    win = webview.create_window(
        "标题栏自检", "<html><body style='margin:0;background:#f5f6f8'></body></html>",
        width=560, height=320, on_top=True)
    out = {}

    def probe():
        time.sleep(1.6)                      # 等窗口真的显示出来
        try:
            hwnd = int(win.native.Handle.ToInt32())
            out["hwnd"] = hwnd
        except Exception as e:  # noqa: BLE001
            out["err"] = repr(e)
            win.destroy()
            return
        u = ctypes.windll.user32
        u.ShowWindow(ctypes.c_void_p(hwnd), 5)      # SW_SHOW
        u.SetWindowPos(ctypes.c_void_p(hwnd), -1, 0, 0, 0, 0, 0x0002 | 0x0001)  # TOPMOST|NOMOVE|NOSIZE
        out["visible"] = bool(u.IsWindowVisible(ctypes.c_void_p(hwnd)))
        out["iconic"] = bool(u.IsIconic(ctypes.c_void_p(hwnd)))
        out["locked"] = desktop_locked()
        for mode, want in (("light", (245, 246, 248)), ("dark", (23, 24, 28))):
            r = A.apply_titlebar(hwnd, mode)
            out[mode + "_hr"] = r.get("hr")
            time.sleep(0.45)                 # 给 DWM 重画非客户区的时间
            if out["locked"]:                # 锁屏时截到的全是桌布，像素断言会蒙对，直接跳过
                out[mode + "_px"] = None
                continue
            im, col, dbg = grab(hwnd, HERE / f"_titlebar_{mode}.png")
            out[mode + "_px"] = list(col) if col else None
            out[mode + "_want"] = list(want)
            out[mode + "_ok"] = close_enough(col, want)
            out[mode + "_dbg"] = dbg
        for name in ("app-icon.ico", "app-icon-dark.ico"):
            try:
                from System.Drawing import Icon
                ic = Icon(str(A.resource_path(name)))
                out[name] = f"{ic.Size.Width}x{ic.Size.Height}"
            except Exception as e:  # noqa: BLE001
                out[name] = "失败：" + repr(e)
        try:                   # 主题记忆写盘/读回，跑完恢复原值
            prev = A.UI_THEME_FILE.read_text(encoding="utf-8") if A.UI_THEME_FILE.exists() else None
            A.save_theme("dark")
            out["theme_roundtrip"] = A.saved_theme()
            if prev is None:
                A.UI_THEME_FILE.unlink(missing_ok=True)
            else:
                A.UI_THEME_FILE.write_text(prev, encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            out["theme_roundtrip"] = repr(e)
        win.destroy()

    t = threading.Thread(target=probe, daemon=True)
    t.start()
    webview.start(gui="edgechromium", private_mode=True)
    t.join(10)

    chk("拿到窗口句柄", bool(out.get("hwnd")), str(out.get("err", "")))
    chk("Win11 接受改标题栏底色（HRESULT=0）",
        out.get("light_hr", {}).get("35") == 0, str(out.get("light_hr")))
    # 像素比对只有在「屏幕没锁、窗口真的在桌面上」时才有意义：
    # 锁屏时截到的是桌布，深浅两套会蒙成同一个颜色（曾经就这样蒙对过一次）
    screen_ok = (not out.get("locked")) and out.get("light_px") != out.get("dark_px")
    if not screen_ok:
        print("跳过 - 标题栏像素比对：屏幕锁定或窗口没上屏（locked=%s visible=%s iconic=%s，"
              "两次取样 %s / %s）。解锁后再跑一次即可。"
              % (out.get("locked"), out.get("visible"), out.get("iconic"),
                 out.get("light_px"), out.get("dark_px")))
    else:
        chk("浅色主题：标题栏像素 = #f5f6f8", out.get("light_ok") is True,
            f"读到 {out.get('light_px')} 期望 {out.get('light_want')}")
        chk("深色主题：标题栏像素 = #17181c", out.get("dark_ok") is True,
            f"读到 {out.get('dark_px')} 期望 {out.get('dark_want')}")
    chk("两套图标都能被 GDI+ 解析",
        all(re.fullmatch(r"\d+x\d+", str(out.get(n, ""))) for n in ("app-icon.ico", "app-icon-dark.ico")),
        f"{out.get('app-icon.ico')} / {out.get('app-icon-dark.ico')}")
    chk("主题记忆能读回", out.get("theme_roundtrip") == "dark", str(out.get("theme_roundtrip")))
    print("---")
    print(json.dumps(out, ensure_ascii=False)[:700])
    print("截图：", HERE / "_titlebar_light.png", HERE / "_titlebar_dark.png")
    print("FAIL ×%d" % len(FAILS) if FAILS else "OK 全部通过")
    return 1 if FAILS else 0


if __name__ == "__main__":
    sys.exit(main())
