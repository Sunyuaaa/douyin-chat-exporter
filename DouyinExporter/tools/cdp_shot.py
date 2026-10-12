# -*- coding: utf-8 -*-
"""CDP 截取页面视口"""
import base64
import json
import sys
import urllib.request
import websocket

BASE = "http://127.0.0.1:9222"
ts = json.load(urllib.request.urlopen(BASE + "/json/list"))
pages = [t for t in ts if t.get("type") == "page"]
page = ([t for t in pages if "douyin.com" in t.get("url", "")] or pages)[0]
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=40, suppress_origin=True)
_mid = 0

def call(method, params=None):
    global _mid
    _mid += 1
    my = _mid
    ws.send(json.dumps({"id": my, "method": method, "params": params or {}}))
    while True:
        m = json.loads(ws.recv())
        if m.get("id") == my:
            return m

out = sys.argv[1] if len(sys.argv) > 1 else "_cdp.png"
r = call("Page.captureScreenshot", {"format": "png"})
data = r["result"]["data"]
with open(out, "wb") as f:
    f.write(base64.b64decode(data))
print("saved", out)
ws.close()
