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
    # imageio-ffmpeg 自带 87MB 的 ffmpeg 二进制，contrib 的 hook 会整份收进来，
    # 单文件 exe 会因此膨胀一倍多、每次启动都要解压一遍。
    # 所以有意排除：exe 版转码语音请装系统 ffmpeg 或把 ffmpeg.exe 放在 exe 旁边
    # （app.ffmpeg_exe() 两种都会找）。源码版走 venv，不受影响。
    runtime_hooks=[],
    excludes=['imageio_ffmpeg'],
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
