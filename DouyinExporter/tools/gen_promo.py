# -*- coding: utf-8 -*-
"""合成宣传图 promo.png：深色渐变底 + 青红柔光 + 左文案右真实截图。"""
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from pathlib import Path

BASE = Path(__file__).parent.parent
W, H = 1600, 1000
CYAN, RED = (37, 244, 238), (254, 44, 85)
GREEN = (23, 163, 74)


def font(size, bold=False):
    for fp in (("C:/Windows/Fonts/msyhbd.ttc", "C:/Windows/Fonts/msyh.ttc") if bold
               else ("C:/Windows/Fonts/msyh.ttc", "C:/Windows/Fonts/msyhbd.ttc")):
        try:
            return ImageFont.truetype(fp, size)
        except OSError:
            continue
    raise SystemExit("no font")


def rounded_shot(img, radius=28):
    """截图加圆角 + 白色细描边。"""
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius=radius, fill=255)
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    border = Image.new("RGBA", img.size, (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle((0, 0, img.width - 1, img.height - 1), radius=radius,
                                             outline=(255, 255, 255, 90), width=3)
    out = Image.alpha_composite(out, border)
    return out


def main():
    # ── 背景：竖向渐变 + 青红柔光 ──
    grad = Image.new("RGB", (1, H))
    for y in range(H):
        k = y / (H - 1)
        c0, c1 = (26, 30, 44), (13, 15, 22)
        grad.putpixel((0, y), tuple(round(a + (b - a) * k) for a, b in zip(c0, c1)))
    img = grad.resize((W, H)).convert("RGBA")

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.ellipse((-300, -350, 500, 350), fill=(*CYAN, 36))
    gd.ellipse((W - 550, H - 420, W + 250, H + 180), fill=(*RED, 32))
    glow = glow.filter(ImageFilter.GaussianBlur(120))
    img = Image.alpha_composite(img, glow)

    d = ImageDraw.Draw(img)

    # ── 左栏文案 ──
    lx = 90
    # 图标
    icon = Image.open(BASE / "icon_preview.png").convert("RGBA")
    icon = icon.resize((180, 180), Image.LANCZOS)
    img.alpha_composite(icon, (lx, 90))
    d = ImageDraw.Draw(img)

    # 标题
    ty = 320
    d.text((lx, ty), "抖音聊天记录", font=font(78, bold=True), fill=(255, 255, 255, 255))
    w1 = d.textlength("抖音聊天记录", font=font(78, bold=True))
    d.text((lx, ty + 100), "导出器", font=font(78, bold=True), fill=(255, 255, 255, 255))
    # 标题下彩色下划线（青→绿渐变条）
    for i in range(220):
        k = i / 220
        col = tuple(round(a + (b - a) * k) for a, b in zip(CYAN, GREEN))
        d.rectangle((lx + i * 1.6, ty + 218, lx + i * 1.6 + 2, ty + 228), fill=(*col, 255))

    # 副标题
    d.text((lx, ty + 270), "你的抖音私信 · 一键备份 · 离线可看", font=font(30), fill=(190, 196, 208, 255))

    # 特性列表
    feats = [
        "内嵌抖音网页版，扫码登录即用",
        "私聊群聊分栏，头像昵称真实显示",
        "图片 / 视频 / 语音 / 表情 自动解密下载",
        "导出微信式气泡网页，离线随时翻看",
        "JSON / HTML / TXT / CSV 四种格式",
        "单文件免安装，数据不出本机",
    ]
    fy = ty + 340
    f14 = font(26)
    for i, f in enumerate(feats):
        col = (CYAN, GREEN)[i % 2]
        d.text((lx, fy), "√", font=font(28, bold=True), fill=(*col, 255))
        d.text((lx + 42, fy), f, font=f14, fill=(225, 228, 235, 255))
        fy += 48

    # 底部小字
    d.text((lx, H - 52), "Windows 10 / 11 · 免安装单文件 · 仅备份本人账号数据",
           font=font(20), fill=(120, 126, 140, 255))

    # ── 右侧截图：缩放 + 圆角描边 + 投影 ──
    shot = Image.open(BASE / "tools" / "app_shot_fake.png").convert("RGBA")
    # 打码右上角真实账号头像（隐私）
    w0, h0 = shot.size
    av_region = shot.crop((w0 - 95, 0, w0, 95)).filter(ImageFilter.GaussianBlur(18))
    shot.paste(av_region, (w0 - 95, 0))
    target_w = 800
    shot = shot.resize((target_w, round(shot.height * target_w / shot.width)), Image.LANCZOS)
    shot = rounded_shot(shot)

    sx, sy = W - target_w - 40, 170
    # 投影
    sh = Image.new("RGBA", img.size, (0, 0, 0, 0))
    alpha = shot.split()[3].point(lambda a: int(a * 0.55))
    black = Image.new("RGBA", shot.size, (0, 0, 0, 255))
    sh.paste(black, (sx + 18, sy + 26), alpha)
    sh = sh.filter(ImageFilter.GaussianBlur(28))
    img = Image.alpha_composite(img, sh)
    img.alpha_composite(shot, (sx, sy))

    img.convert("RGB").save(BASE / "宣传图.png", quality=95)
    print("✅ 已生成 宣传图.png", img.size)


if __name__ == "__main__":
    main()
