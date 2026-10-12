# -*- coding: utf-8 -*-
"""media.py 最小自检：不联网，用 fake transport 对拍 process_task 的 kind 分支。
运行：python test_media.py（全过输出 OK 并退出 0，任一失败抛 AssertionError）"""
import json
import sys

import media

# fake transport：url -> (bytes, content_type)
PNG = bytes.fromhex("89504e470d0a1a0a0000000d") + b"fake-png-body" * 8
GIF = b"GIF89a" + b"fake-gif-body" * 8
HTML_ERR = b"<!DOCTYPE html><html><body>expired</body></html>" + b"x" * 64
MP3 = b"ID3" + b"fake-mp3" * 16


def fake_transport(pages):
    def t(url):
        if url not in pages:
            raise KeyError(url)
        d = pages[url]
        return (d, "image/gif" if d[:3] == b"GIF" else
                "image/png" if d[:4] == bytes.fromhex("89504e47") else
                "text/html" if d[:1] == b"<" else "application/octet-stream")
    return t


def test_url_kind_magic():
    """url kind：魔数定扩展名；PNG 进 PNG 出。"""
    t = fake_transport({"u1": PNG, "u2": GIF})
    data, ext = media.process_task({"kind": "url", "url": "u1"}, t)
    assert data == PNG and ext == ".png", (ext,)
    data, ext = media.process_task({"kind": "url", "url": "u2"}, t)
    assert ext == ".gif"


def test_url_kind_rejects_error_page():
    """url kind：过期链接返回 HTML 错误页必须拒绝，不能当媒体存。"""
    t = fake_transport({"bad": HTML_ERR})
    try:
        media.process_task({"kind": "url", "url": "bad"}, t)
        raise SystemExit("should have raised")
    except ValueError as e:
        assert "expired" in str(e) or "unknown" in str(e), e


def test_plain_ext_mismatch_corrected():
    """plain kind：ext 标成 .gif 但内容是 PNG → 按真实格式纠正为 .png。"""
    t = fake_transport({"p": PNG})
    data, ext = media.process_task({"kind": "plain", "url": "p", "ext": ".gif"}, t)
    assert data == PNG and ext == ".png", (ext,)


def test_plain_error_page_rejected():
    """plain kind：内容是 HTML 错误页且声明 ext 不符 → 抛错。"""
    t = fake_transport({"bad": HTML_ERR})
    try:
        media.process_task({"kind": "plain", "url": "bad", "ext": ".gif"}, t)
        raise SystemExit("should have raised")
    except ValueError:
        pass


def test_voice_magic():
    """plain + sub=voice：ID3 头 → .mp3。"""
    t = fake_transport({"v": MP3})
    data, ext = media.process_task({"kind": "plain", "url": "v", "sub": "voice"}, t)
    assert ext == ".mp3"


def test_share_meta_json():
    """share_meta：meta 落成 JSON 文件，且 .json 在去重表里。"""
    data, ext = media.process_task({"kind": "share_meta", "meta": {"title": "t", "link": "l"}})
    j = json.loads(data)
    assert j["title"] == "t" and ext == ".json"
    assert ".json" in media.EXTENSIONS, ".json 必须在去重表（否则每次重写）"
    assert ".mpeg" not in media.EXTENSIONS, ".mpeg 是幽灵项，应已删除"


def test_image_gcm_roundtrip():
    """image_gcm：AES-GCM 加解密回路（cipher 前 12B 为 IV）。"""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    import os
    key = os.urandom(32)
    nonce = os.urandom(12)
    cipher = nonce + AESGCM(key).encrypt(nonce, PNG, None)
    t = fake_transport({"g": cipher})
    data, ext = media.process_task({"kind": "image_gcm", "url": "g", "skey": key.hex()}, t)
    assert data == PNG and ext == ".png"


def test_unknown_kind_raises():
    """未知 kind 抛错（跨桥字符串拼错的失败模式必须有声音）。"""
    try:
        media.process_task({"kind": "nope", "url": "x"}, fake_transport({}))
        raise SystemExit("should have raised")
    except ValueError as e:
        assert "nope" in str(e)


def test_heic_not_mistaken_for_mp4():
    """plain 无扩展名时，HEIC/HEIF 也是 ftyp 盒——以前一律当 .mp4 存，
    图片被存成 .mp4 后浏览器 <img> 解不出来，阅读器里就剩个破图标。"""
    heic = b"\x00\x00\x00\x18ftypheic\x00\x00\x02\x00" + b"fake-heic-body" * 8
    mp4 = b"\x00\x00\x00\x18ftypisom\x00\x00\x02\x00" + b"fake-mp4-body" * 8
    t = fake_transport({"h": heic, "v": mp4})
    _d, ext = media.process_task({"kind": "plain", "url": "h", "sub": "images"}, t)
    assert ext != ".mp4", "HEIC 不能再被存成 .mp4"
    assert ext in (".heic", ".jpg"), ext          # 转码成功=jpg，失败=heic，都不该是视频
    _d, ext = media.process_task({"kind": "plain", "url": "v", "sub": "videos"}, t)
    assert ext == ".mp4", ext
    assert media.is_image_bytes(heic) and not media.is_image_bytes(mp4)


def test_is_image_bytes_recognises_common_forms():
    assert media.is_image_bytes(PNG) and media.is_image_bytes(GIF)
    assert media.is_image_bytes(b"\xff\xd8\xff\xe0" + b"j" * 20)
    assert media.is_image_bytes(b"RIFF\x00\x00\x00\x00WEBPVP8 ")
    assert not media.is_image_bytes(HTML_ERR)


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    for fn in fns:
        fn()
        print("ok -", fn.__name__)
    print(f"OK — {len(fns)} tests passed")
