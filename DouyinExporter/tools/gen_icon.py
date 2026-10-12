# -*- coding: utf-8 -*-
"""生成应用图标 app.ico：深色圆角底 + 抖音错位描色聊天气泡 + 「抖」字 + 绿色导出角标。
1024 超采样绘制 → LANCZOS 缩到 256，输出多尺寸 ico + 一张 256 预览 png。"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

S = 1024          # 超采样画布
OUT = Path(__file__).parent

BG_TOP, BG_BOT = (30, 34, 48), (16, 19, 26)     # 深色竖向渐变
CYAN, RED = (37, 244, 238), (254, 44, 85)       # 抖音双色调
WHITE, INK, GREEN = (255, 255, 255), (22, 24, 35), (23, 163, 74)


def rounded(draw, box, r, fill):
    draw.rounded_rectangle(box, radius=r, fill=fill)


def main():
    # 竖向渐变底
    grad = Image.new("RGB", (1, S))
    for y in range(S):
        k = y / (S - 1)
        grad.putpixel((0, y), tuple(round(a + (b - a) * k) for a, b in zip(BG_TOP, BG_BOT)))
    img = grad.resize((S, S)).convert("RGBA")
    d = ImageDraw.Draw(img)

    # 圆角方形底（四周留 40 透明边，ico 在小尺寸时更饱满）
    rounded(d, (40, 40, 984, 984), 200, "#00000000" if False else (*BG_TOP, 255))
    # 重新画渐变进圆角：用蒙版
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((40, 40, 984, 984), radius=200, fill=255)
    bg = Image.new("RGBA", (S, S))
    bg.paste(grad.resize((S, S)).convert("RGBA"), (0, 0))
    img = Image.composite(bg, Image.new("RGBA", (S, S), (0, 0, 0, 0)), mask)
    d = ImageDraw.Draw(img)

    # 气泡形状（含尾巴）：用于错位描色与本体
    def bubble(dr, dx, dy, color):
        dr.rounded_rectangle((250 + dx, 330 + dy, 770 + dx, 880 + dy), radius=85, fill=color)
        dr.polygon([(330 + dx, 860 + dy), (480 + dx, 860 + dy), (315 + dx, 1000 + dy)], fill=color)

    # 抖音错位描色：青左红右，压在白泡后面
    bubble(d, -22, 0, (*CYAN, 255))
    bubble(d, 22, 0, (*RED, 255))
    bubble(d, 0, 0, (*WHITE, 255))

    # 「抖」字
    font = None
    for fp in ("C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/simhei.ttf"):
        try:
            font = ImageFont.truetype(fp, 330)
            break
        except OSError:
            continue
    if font:
        t = "抖"
        tb = d.textbbox((0, 0), t, font=font)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        d.text((510 - tw / 2 - tb[0], 600 - th / 2 - tb[1]), t, font=font, fill=(*INK, 255))

    # 绿色导出角标：圆 + 白色向下箭头（带杆）
    cx, cy, r = 780, 790, 165
    # 描边底圈（深色，和底色拉开层次）
    d.ellipse((cx - r - 18, cy - r - 18, cx + r + 18, cy + r + 18), fill=(*BG_BOT, 255))
    d.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(*GREEN, 255))
    aw = 46          # 箭头杆宽
    d.rounded_rectangle((cx - aw / 2, cy - 95, cx + aw / 2, cy + 35), radius=20, fill=(*WHITE, 255))
    d.polygon([(cx - 105, cy + 20), (cx + 105, cy + 20), (cx, cy + 135)], fill=(*WHITE, 255))

    # 缩到 256 并输出
    base = img.resize((256, 256), Image.LANCZOS)
    base.save(OUT / "icon_preview.png")
    base.save(OUT / "app.ico",
              sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    print("✅ 已生成 app.ico + icon_preview.png")


if __name__ == "__main__":
    main()
