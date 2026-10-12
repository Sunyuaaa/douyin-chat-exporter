#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""从生成的简笔画原图重建窗口图标（开发用，产品运行不需要）。

原图两个坑：
1. 「透明背景」是画上去的浅灰棋盘，不是真 alpha；
2. 右下角有「Qoder AI 生成」水印。

做法：先把底部 10% 填成背景色去掉水印，再缩小让棋盘平均成均匀浅灰，
然后按「亮度 + 饱和度」把墨线抠成 alpha，最后按主题输出两套 .ico
（深色标题栏上必须用浅色描边，否则图标几乎看不见）。

用法：python tools/make_icon.py <原图.png>
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SIZES = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
BG_FILL = (245, 245, 246)


def keyed(src: Path) -> tuple[Image.Image, tuple[int, int, int]]:
    """返回 (带 alpha 的 512 图, 墨线本色)。"""
    im = Image.open(src).convert("RGB")
    w, h = im.size
    px = im.load()
    for y in range(int(h * 0.90), h):          # 去水印
        for x in range(w):
            px[x, y] = BG_FILL
    im = im.resize((512, 512), Image.LANCZOS)  # 棋盘平均掉
    px = im.load()
    out = Image.new("RGBA", (512, 512), (0, 0, 0, 0))
    op = out.load()
    samples: list[tuple[int, int, int]] = []
    for y in range(512):
        for x in range(512):
            r, g, b = px[x, y][:3]
            mx, mn = max(r, g, b), min(r, g, b)
            if mx - mn > 40:                   # 彩色（蓝点）：原样保留
                op[x, y] = (r, g, b, 255)
                continue
            a = int(max(0.0, min(255.0, (228 - mx) * 255 / 62.0)))
            if a:
                samples.append((r, g, b))
                op[x, y] = (0, 0, 0, a)        # 先占位，下面统一上色
    samples.sort()
    ink = samples[len(samples) // 2] if samples else (67, 73, 77)
    for y in range(512):
        for x in range(512):
            r, g, b, a = op[x, y]
            if a and (r, g, b) == (0, 0, 0):
                op[x, y] = (ink[0], ink[1], ink[2], a)
    return out, ink


def trimmed(img: Image.Image, pad_ratio: float = 0.09) -> Image.Image:
    box = img.split()[-1].getbbox()
    if not box:
        raise SystemExit("没抠出内容，检查原图")
    w, h = box[2] - box[0], box[3] - box[1]
    side = max(w, h)
    pad = int(side * pad_ratio)
    cv = Image.new("RGBA", (side + 2 * pad,) * 2, (0, 0, 0, 0))
    cv.paste(img.crop(box), (pad, pad), img.crop(box).split()[-1])
    return cv.resize((256, 256), Image.LANCZOS)


def recolored(img: Image.Image, ink: tuple[int, int, int]) -> Image.Image:
    """把描边换成指定颜色；彩色部分（蓝点）保持原色。
    判据用饱和度，不能用「是不是纯黑」——keyed() 里已经把墨线染成本色了。"""
    px = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b, a = px[x, y]
            if not a or max(r, g, b) - min(r, g, b) > 40:
                continue
            px[x, y] = (ink[0], ink[1], ink[2], a)
    return img


def main() -> int:
    src = Path(sys.argv[1]) if len(sys.argv) > 1 else None
    if not src or not src.exists():
        raise SystemExit(f"找不到原图：{src}")
    keyed_img, ink = keyed(src)
    variants = (("app-icon.ico", ink), ("app-icon-dark.ico", (232, 234, 237)))
    for name, col in variants:
        t = trimmed(recolored(keyed_img.copy(), col))
        t.save(ROOT / name.replace(".ico", ".png"))
        t.save(ROOT / name, format="ICO", sizes=SIZES)
        print(f"写出 {name}（描边 #{col[0]:02x}{col[1]:02x}{col[2]:02x}）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
