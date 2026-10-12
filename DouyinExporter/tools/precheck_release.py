# -*- coding: utf-8 -*-
"""precheck_release.py — 分发前检查：这个文件夹能不能直接发给别人。

只读，不删任何东西；发现问题就列出来并给出处置建议。
用法：
    .\\.venv\\Scripts\\python.exe tools\\precheck_release.py        # 检查 DouyinExporter 目录
    .\\.venv\\Scripts\\python.exe tools\\precheck_release.py --json  # 机器可读输出

检查项：
  1) Data/            登录 Cookie（含 WebView2 缓存）——发出去等于把账号交给对方
  2) Data/llm_config.json  API Key 是否已 DPAPI 加密（明文必须删）
  3) exports/         真实聊天内容与媒体
  4) boot.log         含会话名/统计/错误细节，可远程推断你的使用情况
  5) 源码版却没有 exe 时，README 是否还在承诺「双击 exe」（一致性）
  6) im-schema.json   存在且是合法 JSON（缺失只会退回内置默认，不报错但改版无效）
  7) _build/ build/ dist/ __pycache__/ .venv/ *.part tools/_*.png 等可再生构建产物
  8) exe 是否比源码旧（打完包又改了代码 → 成品跑的还是旧逻辑）
"""
import json
import sys
from pathlib import Path

try:      # Windows 控制台默认 GBK，中文报告与 ✗ 符号会直接崩，先强切 UTF-8
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:  # noqa: BLE001
    pass

BASE = Path(__file__).resolve().parent.parent


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return "%.1f%s" % (n, unit)
        n /= 1024.0
    return "%.1fTB" % n


def dir_size(p: Path):
    total = 0
    files = 0
    for f in p.rglob("*"):
        if f.is_file():
            total += f.stat().st_size
            files += 1
    return files, total


def main():
    as_json = "--json" in sys.argv
    issues = []      # 必须处理
    warns = []       # 建议处理
    infos = []

    data = BASE / "Data"
    if data.exists():
        files, size = dir_size(data)
        issues.append(("Data/ 存在（%d 个文件 / %s）：里面是抖音登录 Cookie，"
                       "拿到的人可直接进你的账号。分发前整个删掉。" % (files, human(size)),
                       "rm -r Data/"))

    cfg = data / "llm_config.json"
    if cfg.exists():
        try:
            j = json.loads(cfg.read_text(encoding="utf-8"))
        except ValueError:
            j = {}
            warns.append(("Data/llm_config.json 解析不了（软件会当未配置处理）", "删掉该文件"))
        if j:
            if str(j.get("api_key") or ""):
                issues.append(("llm_config.json 里 API Key 是明文（旧版本存的）",
                               "删掉 Data/ 或在软件设置里重新保存一次（新版会 DPAPI 加密）"))
            elif str(j.get("api_key_dpapi") or ""):
                infos.append("API Key 已用 DPAPI 加密：只对当前 Windows 账号可解，"
                             "别人拿到文件也读不出（但 Key 本来也不该外发）")
            else:
                infos.append("llm_config.json 里没有 Key")

    exp = BASE / "exports"
    if exp.exists():
        convs = [d for d in exp.iterdir() if d.is_dir()]
        files, size = dir_size(exp)
        if convs:
            issues.append(("exports/ 有 %d 个会话、%d 个文件 / %s 的真实聊天内容"
                           % (len(convs), files, human(size)), "rm -r exports/"))

    log = BASE / "boot.log"
    if log.exists():
        issues.append(("boot.log（%s）会暴露会话名、条数与报错细节" % human(log.stat().st_size),
                       "rm boot.log"))

    exe = BASE / "DouyinExporter.exe"
    readme = BASE / "README.md"
    if not readme.exists():
        readme = BASE.parent / "README.md"      # README 已上移到仓库根，两处都认
    if exe.exists():
        infos.append("DouyinExporter.exe 已在目录内（%s），可直接按 README 双击使用"
                     % human(exe.stat().st_size))
    elif readme.exists() and "DouyinExporter.exe" in readme.read_text(encoding="utf-8"):
        warns.append(("目录里没有 exe，但 README 提到「双击 DouyinExporter.exe」",
                      "要么先打包，要么在 README 顶部注明本目录为源码版（用 启动.bat）"))

    schema = BASE / "im-schema.json"
    if not schema.exists():
        warns.append(("im-schema.json 缺失：软件仍能用内置默认跑，但改版时改不到字段表",
                      "把 im-schema.json 放回程序目录"))
    else:
        try:
            json.loads(schema.read_text(encoding="utf-8"))
            infos.append("im-schema.json 存在且格式正确")
        except ValueError as e:
            issues.append(("im-schema.json 不是合法 JSON：%s" % str(e)[:80], "修好或删除该文件"))

    # 打包 / 运行留下的可再生成品：都不该出现在发给别人的文件夹里
    arts = []
    for d in ("_build", "build", "dist", "__pycache__", ".venv"):
        if (BASE / d).is_dir():
            arts.append(d + "/")
    for f in sorted(BASE.rglob("*.part")):
        arts.append(str(f.relative_to(BASE)))
    for f in sorted((BASE / "tools").glob("_*.png")) if (BASE / "tools").is_dir() else []:
        arts.append("tools/" + f.name)
    if arts:
        warns.append(("有 %d 项可再生的构建/调试产物：%s"
                      % (len(arts), "、".join(arts[:6]) + ("…" if len(arts) > 6 else "")),
                      "分发前删掉；.venv/ 由接手者跑 启动.bat 自动重建"))

    # exe 比源码旧 = 打的是上一版的包，接手者拿到的成品和 README 描述不一致
    if exe.exists():
        src_newer = [n for n in ("app.py", "injector.js", "media.py", "im-schema.json",
                                 "emoji-map.json", "app-icon.ico", "app-icon-dark.ico",
                                 "DouyinExporter.spec")
                     if (BASE / n).exists() and (BASE / n).stat().st_mtime > exe.stat().st_mtime]
        if src_newer:
            warns.append(("exe 比源码旧（打包后改过：%s）——成品里跑的还是旧逻辑" % "、".join(src_newer),
                          "关闭软件后重跑：python -m PyInstaller --noconfirm --clean "
                          "--distpath . --workpath _build DouyinExporter.spec"))

    if as_json:
        print(json.dumps({
            "base": str(BASE),
            "blockers": [i[0] for i in issues],
            "warnings": [w[0] for w in warns],
            "info": infos,
            "safe_to_share": not issues,
        }, ensure_ascii=False, indent=2))
        return 1 if issues else 0

    print("检查目录：%s" % BASE)
    if issues:
        print("\n【不能直接分发】必须先处理 %d 项：" % len(issues))
        for msg, how in issues:
            print("  ✗ %s\n      处置：%s" % (msg, how))
    if warns:
        print("\n【建议处理】%d 项：" % len(warns))
        for msg, how in warns:
            print("  ! %s\n      处置：%s" % (msg, how))
    if infos:
        print("\n【正常】")
        for s in infos:
            print("  · %s" % s)
    if not issues:
        print("\n结论：可以分发（删掉上面列出的私有内容之后再发）"
              if warns else "\n结论：干净，可以直接分发")
        return 0
    print("\n结论：先处理「不能直接分发」的条目，再重新跑一次本脚本。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
