# -*- mode: python ; coding: utf-8 -*-
from PyInstaller.utils.hooks import collect_all

datas = [('injector.js', '.'), ('emoji-map.json', '.'), ('im-schema.json', '.'),
         ('app-icon.ico', '.'), ('app-icon-dark.ico', '.')]
binaries = []
hiddenimports = []
tmp_ret = collect_all('pillow_heif')
datas += tmp_ret[0]; binaries += tmp_ret[1]; hiddenimports += tmp_ret[2]


a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 不再排除 imageio-ffmpeg：它自带约 87MB 的 ffmpeg 二进制，收进来后 exe 也能
    # 直接把抖音的 m4a 语音转成 mp3 送进只收 wav/mp3 的网关（MiMo 这类），
    # 用户不必再自己装 ffmpeg。实测 exe 从 29MB 涨到 59MB（二进制压缩后净增 30MB），
    # 首启动到注入成功 6.6 秒。contrib 的 hook-imageio_ffmpeg 会同时
    # 补上 binaries 数据文件和 imageio_ffmpeg.binaries 这个隐式包。
    # 源码版不受影响；装了系统 ffmpeg 或 exe 旁边放了 ffmpeg.exe 时仍然优先用它们
    # （app.ffmpeg_exe() 的顺序：PATH → 程序目录 → 内置）。
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='DouyinExporter',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=['app-icon.ico'],
)
