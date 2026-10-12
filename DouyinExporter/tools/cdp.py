# -*- coding: utf-8 -*-
"""CDP 调试辅助：对 WebView2 远程调试口执行 JS
用法:
  python cdp.py list
  python cdp.py eval <js文件路径>        # 在第一个 douyin 页面执行 JS 文件，打印结果
  python cdp.py nav <url>
"""
import json
import sys
import time
import urllib.request
import websocket

BASE = "http://127.0.0.1:9222"


def targets():
    return json.load(urllib.request.urlopen(BASE + "/json/list"))


def pick_page():
    for t in targets():
        if t.get("type") == "page" and "douyin.com" in t.get("url", ""):
            return t
    for t in targets():
        if t.get("type") == "page":
            return t
    raise RuntimeError("no page target")


def call(ws, mid, method, params=None, timeout=40):
    ws.send(json.dumps({"id": mid, "method": method, "params": params or {}}))
    end = time.time() + timeout
    while time.time() < end:
        ws.settimeout(max(1, end - time.time()))
        msg = json.loads(ws.recv())
        if msg.get("id") == mid:
            return msg
    raise TimeoutError(method)


def main():
    cmd = sys.argv[1]
    if cmd == "list":
        for t in targets():
            print(t.get("type"), "|", t.get("url", "")[:110], "|", t.get("id"))
        return
    page = pick_page()
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=300, suppress_origin=True)
    call(ws, 1, "Runtime.enable")
    if cmd == "nav":
        call(ws, 2, "Page.enable")
        r = call(ws, 3, "Page.navigate", {"url": sys.argv[2]})
        print(json.dumps(r, ensure_ascii=False)[:300])
    elif cmd == "eval":
        expr = open(sys.argv[2], encoding="utf-8").read()
        r = call(ws, 4, "Runtime.evaluate",
                 {"expression": expr, "returnByValue": True, "awaitPromise": True, "timeout": 300000},
                 timeout=300)
        res = r.get("result", {})
        if "exceptionDetails" in res:
            print("JS ERROR:", json.dumps(res["exceptionDetails"], ensure_ascii=False)[:2000])
        else:
            print(json.dumps(res.get("result", {}).get("value"), ensure_ascii=False, indent=1)[:6000])
    ws.close()


if __name__ == "__main__":
    main()
