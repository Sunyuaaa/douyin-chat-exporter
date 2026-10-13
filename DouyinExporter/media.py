"""media.py — 抖音私信媒体文件下载与解密。

媒体 kind 注册表（单一权威出处；新加 kind 时改这里 + injector.js collectMedia + bubbleBody）：
  plain       普通 URL 直下；显式 ext 时做魔数校验（错误页拒绝/纠正），无 ext 按 sub 探测
  url         无后缀/签名 URL：按 Content-Type + 魔数定扩展名（表情、头像）
  image_gcm   图片，AES-256-GCM（skey=64位hex/32B，cipher 前 12B 为 IV）
  video_cenc  自拍/IM 视频，MPEG-CENC AES-128-CTR（skey=32位hex/16B），需 ftyp
  share_meta  分享视频元信息（不下载视频本体），返回 JSON 文本

HEIC/HEIF 图片浏览器不支持，尽量转 JPEG（需 pillow_heif；缺失则保留 .heic）。

对外接口：
  process_task(task, transport=None) -> (bytes, ext)
    task = {"kind": <上表>, "url": ..., "skey": ..., "ext": ..., "sub": ..., "meta": ...}
    transport: 可选，(url) -> (bytes, content_type)；默认 urllib。测试注入 fake 用。
  EXTENSIONS: download_one 去重跳过表的权威扩展名词汇（app.py 应 import，勿自复制）。
"""
import io
import json
import shutil
import struct
import subprocess
import urllib.request

_HEADERS = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.douyin.com/"}

# pythonw / console=False 的父进程里 spawn 控制台程序（ffmpeg）会闪出 cmd 黑框，每转一个闪一次
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)

# download_one 去重跳过表：process_task 实际产出 + 显式传入的合法扩展名。
# （.mpeg 从未产出——旧表幽灵项已删；.json 来自 share_meta，必须跳过。）
EXTENSIONS = (".mp4", ".jpeg", ".jpg", ".png", ".webp", ".gif",
              ".mp3", ".m4a", ".heic", ".json")

_HEIF_BRANDS = {b"heic", b"heix", b"mif1", b"msf1", b"hevc", b"hevx",
                b"heim", b"heis", b"hevm", b"hevs"}
_MP4_BRANDS = {b"mp42", b"mp41", b"isom", b"iso2", b"iso4", b"iso5",
               b"iso6", b"avc1", b"M4V ", b"qt  "}


def _urllib_transport(url, timeout=20):
    """默认传输：返回 (bytes, content_type)。
    timeout 是单次 recv 的静默上限（不是总时长）——过期/挂死的 CDN 最多拖 20 秒即失败，
    早期 60 秒会让几百个文件的批量下载被少数挂死链接拖到十几分钟。"""
    req = urllib.request.Request(url, headers=_HEADERS)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), (resp.headers.get("Content-Type") or "").lower()


def _fetch(url, timeout=20):
    return _urllib_transport(url, timeout)[0]


def detect_image_format(data):
    """返回 (kind, ext)；kind ∈ image/heif/video。"""
    if data[:3] == b"\xff\xd8\xff":
        return "image", ".jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image", ".png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image", ".webp"
    if data[:3] == b"GIF":
        return "image", ".gif"
    if data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in _HEIF_BRANDS:
            return "heif", ".heic"
        return "video", ".mp4"
    return "image", ".jpg"


def detect_audio_ext(data):
    """抖音语音容器识别。"""
    if data[:3] == b"ID3":
        return ".mp3"
    if data[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2", b"\xff\xfa"):
        return ".mp3"
    if len(data) > 2 and (data[0] & 0xE0) == 0xE0 and (data[0] & 0x18) != 0x08:
        return ".mp3"                       # MPEG audio 帧同步 0xFFE
    if data[4:8] == b"ftyp":
        brand = data[8:12]
        if brand in (b"M4A ", b"mp42", b"isom"):
            return ".m4a"
        return ".m4a"
    return ".mp3"


def _heic_to_jpeg(data):
    from PIL import Image
    import pillow_heif
    pillow_heif.register_heif_opener()
    im = Image.open(io.BytesIO(data))
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    out = io.BytesIO()
    im.save(out, "JPEG", quality=90)
    return out.getvalue()


def _decrypt_gcm(cipher, skey_hex):
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    key = bytes.fromhex(skey_hex)
    if len(key) != 32:
        raise ValueError("image skey must be 32 bytes")
    return AESGCM(key).decrypt(cipher[:12], cipher[12:], None)


# ================= MPEG-CENC 解密（自拍/IM 视频） =================
def _parse_boxes(buf, start, end):
    pos = start
    out = []
    while pos < end - 8:
        bs = struct.unpack(">I", buf[pos:pos + 4])[0]
        bt = buf[pos + 4:pos + 8].decode(errors="replace")
        hl = 8
        if bs == 1:
            bs = struct.unpack(">Q", buf[pos + 8:pos + 16])[0]
            hl = 16
        if bs == 0:
            bs = end - pos
        if bs < 8:
            break
        out.append((bt, pos, hl, bs, buf[pos + hl:pos + bs]))
        pos += bs
    return out


def _find_box(buf, start, end, path):
    for box in _parse_boxes(buf, start, end):
        if box[0] == path[0]:
            if len(path) == 1:
                return box
            return _find_box(buf, box[1] + box[2], box[1] + box[3], path[1:])
    return None


def _parse_stsz(content):
    default_size = struct.unpack(">I", content[4:8])[0]
    count = struct.unpack(">I", content[8:12])[0]
    if default_size != 0:
        return [default_size] * count
    return [struct.unpack(">I", content[12 + i * 4:16 + i * 4])[0]
            for i in range(count)]


def _parse_senc(content, iv_size=8):
    flags = struct.unpack(">I", b"\x00" + content[1:4])[0]
    count = struct.unpack(">I", content[4:8])[0]
    has_sub = bool(flags & 0x000002)
    out = []
    p = 8
    for _ in range(count):
        iv = content[p:p + iv_size]
        p += iv_size
        subs = []
        if has_sub:
            sub_count = struct.unpack(">H", content[p:p + 2])[0]
            p += 2
            for _ in range(sub_count):
                clear = struct.unpack(">H", content[p:p + 2])[0]
                prot = struct.unpack(">I", content[p + 2:p + 6])[0]
                subs.append((clear, prot))
                p += 6
        out.append({"iv": iv, "subs": subs})
    return out


def _parse_stco(content):
    count = struct.unpack(">I", content[4:8])[0]
    return [struct.unpack(">I", content[8 + i * 4:12 + i * 4])[0]
            for i in range(count)]


def _parse_stsc(content):
    count = struct.unpack(">I", content[4:8])[0]
    out = []
    for i in range(count):
        fc = struct.unpack(">I", content[8 + i * 12:12 + i * 12])[0]
        spc = struct.unpack(">I", content[12 + i * 12:16 + i * 12])[0]
        sdi = struct.unpack(">I", content[16 + i * 12:20 + i * 12])[0]
        out.append((fc, spc, sdi))
    return out


def _sample_offsets(stsc_entries, stco_offsets, stsz_sizes):
    out = []
    sample_idx = 0
    for chunk_idx, chunk_offset in enumerate(stco_offsets, start=1):
        spc = stsc_entries[0][1]
        for fc, per_chunk, _sdi in stsc_entries:
            if fc <= chunk_idx:
                spc = per_chunk
            else:
                break
        offset = chunk_offset
        for _ in range(spc):
            if sample_idx >= len(stsz_sizes):
                return out
            out.append((offset, stsz_sizes[sample_idx]))
            offset += stsz_sizes[sample_idx]
            sample_idx += 1
    return out


def _ctr(key, iv16, ciphertext):
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    c = Cipher(algorithms.AES(key), modes.CTR(iv16))
    return c.decryptor().update(ciphertext)


def _decrypt_sample(key, sample_data, info):
    iv_full = info["iv"].ljust(16, b"\x00")
    subs = info["subs"]
    if not subs:
        return _ctr(key, iv_full, sample_data)
    layout = []
    for clear, prot in subs:
        layout.append(("c", clear))
        layout.append(("p", prot))
    pos = 0
    protected = []
    for kind, length in layout:
        if kind == "p":
            protected.append(sample_data[pos:pos + length])
        pos += length
    dec = _ctr(key, iv_full, b"".join(protected))
    out = bytearray()
    pos = 0
    dp = 0
    for kind, length in layout:
        if kind == "c":
            out.extend(sample_data[pos:pos + length])
        else:
            out.extend(dec[dp:dp + length])
            dp += length
        pos += length
    return bytes(out)


def decrypt_cenc_mp4(encrypted, key_hex):
    key = bytes.fromhex(key_hex)
    if len(key) != 16:
        raise ValueError("video skey must be 16 bytes")
    buf = bytearray(encrypted)
    moov = next((b for b in _parse_boxes(buf, 0, len(buf)) if b[0] == "moov"), None)
    if not moov:
        raise ValueError("no moov box")
    traks = [b for b in _parse_boxes(buf, moov[1] + moov[2], moov[1] + moov[3])
             if b[0] == "trak"]
    for trak in traks:
        ts, te = trak[1] + trak[2], trak[1] + trak[3]
        senc = _find_box(buf, ts, te, ["mdia", "minf", "stbl", "senc"])
        if not senc:
            continue                                # 未加密轨道，跳过
        stsz = _find_box(buf, ts, te, ["mdia", "minf", "stbl", "stsz"])
        stsc = _find_box(buf, ts, te, ["mdia", "minf", "stbl", "stsc"])
        stco = _find_box(buf, ts, te, ["mdia", "minf", "stbl", "stco"])
        senc_entries = _parse_senc(senc[4])
        sizes = _parse_stsz(stsz[4])
        samples = _sample_offsets(_parse_stsc(stsc[4]), _parse_stco(stco[4]), sizes)
        for i, (offset, size) in enumerate(samples):
            buf[offset:offset + size] = _decrypt_sample(
                key, bytes(buf[offset:offset + size]), senc_entries[i])
    return bytes(buf)


def _faststart(data):
    """若本机有 ffmpeg，把 moov 移到开头（本地文件播放本就可 seek，可选）。"""
    if not shutil.which("ffmpeg"):
        return data
    try:
        p = subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", "pipe:0",
             "-c", "copy", "-movflags", "+faststart", "-f", "mp4", "pipe:1"],
            input=data, capture_output=True, timeout=120,
            creationflags=NO_WINDOW)   # 否则每转一个视频闪一个 cmd 黑框
        if p.returncode == 0 and p.stdout[:4]:
            return p.stdout
    except Exception:
        pass
    return data


_IMG_MAGIC = {".gif": (b"GIF",), ".png": (b"\x89PNG",),
              ".jpg": (b"\xff\xd8\xff",), ".jpeg": (b"\xff\xd8\xff",),
              ".webp": (b"RIFF",)}


def _detect_by_magic(data):
    """内容魔数判定扩展名（表情/头像这类 URL 无有用后缀时用）。"""
    if data[:3] == b"GIF":
        return ".gif"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if data[:3] == b"\xff\xd8\xff":
        return ".jpg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return ".webp"
    if data[4:8] == b"ftyp":
        return ".heic" if data[8:12] in _HEIF_BRANDS else ".mp4"
    return ".bin"


def is_image_bytes(data):
    """前几个字节能否认出是一张图（含 HEIF）。用来发现「图被误存成 .mp4」这类坏缓存。"""
    if data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n" or data[:3] == b"GIF":
        return True
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return True
    return data[4:8] == b"ftyp" and data[8:12] in _HEIF_BRANDS


def _looks_like_error_page(data):
    """CDN 过期/风控时常返回 200 + HTML/JSON 文本，字节头可识别。"""
    s = data[:16].lstrip()
    return (s[:1] in (b"<", b"{", b"[") or
            s.startswith(b"null") or s.startswith(b"<!DOCTYPE") or
            b"<html" in data[:64].lower())


def process_task(task, transport=None):
    """下载并按类型处理，返回 (文件字节, 扩展名)。transport 供测试注入。"""
    t = transport if transport is not None else _urllib_transport
    kind = task.get("kind")
    if kind == "share_meta":
        payload = json.dumps(task.get("meta", {}), ensure_ascii=False, indent=2).encode("utf-8")
        return payload, ".json"
    url = task["url"]
    if kind == "url":
        # 无后缀/签名 URL（表情、头像）：按 Content-Type + 魔数定扩展名，避开后缀误判
        data, ctype = t(url)
        if len(data) < 64:
            raise ValueError(f"file too small ({len(data)} bytes), URL likely expired")
        ext = _detect_by_magic(data)
        if ext == ".bin":
            for tok, e in (("gif", ".gif"), ("png", ".png"), ("jpeg", ".jpg"),
                           ("webp", ".webp"), ("heic", ".heic")):
                if tok in ctype:
                    ext = e
                    break
        if ext == ".bin":
            raise ValueError("unknown content type for url task")
        if ext == ".heic":
            try:
                return _heic_to_jpeg(data), ".jpg"
            except Exception:
                return data, ".heic"
        return data, ext
    if kind == "plain":
        data = t(url)[0]
        ext = task.get("ext")
        if ext:
            # 魔数校验：CDN 链接过期时常返回 HTML 错误页（200 状态），不能把坏文件当媒体存
            if len(data) < 64:
                raise ValueError(f"file too small ({len(data)} bytes), URL likely expired")
            expect = _IMG_MAGIC.get(ext.lower())
            if expect and not data.startswith(expect[0]):
                if _looks_like_error_page(data):
                    raise ValueError(f"content is not {ext} (likely an error page)")
                k, det = detect_image_format(data)
                if k == "image":
                    return data, det          # 后缀标错但内容确实是图，按真实格式存
                raise ValueError(f"content is not {ext} (likely an error page)")
            if ext.lower() == ".webp" and len(data) > 12 and data[8:12] != b"WEBP":
                k, det = detect_image_format(data)
                if k == "image":
                    return data, det
                raise ValueError("content is not webp")
            return data, ext
        if _looks_like_error_page(data):
            raise ValueError("content looks like an error page, URL likely expired")
        if task.get("sub") == "voice":
            return data, detect_audio_ext(data)
        if data[4:8] == b"ftyp":
            # ftyp 不只视频有：iOS 的 HEIC/HEIF 图片也是 ftyp 盒，以前一律当 .mp4 存，
            # 结果图片被存成 .mp4，浏览器 <img> 解不出来就剩个破图标。
            if data[8:12] in _HEIF_BRANDS:
                try:
                    return _heic_to_jpeg(data), ".jpg"
                except Exception:
                    return data, ".heic"
            return data, ".mp4"
        if data[:3] == b"\xff\xd8\xff" or data[:8] == b"\x89PNG\r\n\x1a\n":
            return data, detect_image_format(data)[1]
        return data, detect_audio_ext(data)
    if kind == "image_gcm":
        plain = _decrypt_gcm(t(url)[0], task["skey"])
        k, ext = detect_image_format(plain)
        if k == "heif":
            try:
                return _heic_to_jpeg(plain), ".jpg"
            except Exception:
                return plain, ".heic"
        return plain, ext
    if kind == "video_cenc":
        enc = t(url)[0]
        if enc[4:8] != b"ftyp":
            raise ValueError("bad encrypted mp4 (no ftyp)")
        return _faststart(decrypt_cenc_mp4(enc, task["skey"])), ".mp4"
    raise ValueError("unknown task kind: %r" % kind)
