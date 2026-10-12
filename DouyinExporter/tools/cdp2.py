# 截图专用：连接 CDP 拿页面截图
import base64, json, sys, time, urllib.request, websocket
BASE = "http://127.0.0.1:9222"
targets = json.load(urllib.request.urlopen(BASE + "/json/list"))
page = None
for t in targets:
    if t.get("type") == "page":
        page = t; break
if not page: raise SystemExit("no page")
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)
ws.send(json.dumps({"id": 1, "method": "Page.captureScreenshot", "params": {"format": "png"}}))
end = time.time() + 30
while time.time() < end:
    ws.settimeout(max(1, end - time.time()))
    msg = json.loads(ws.recv())
    if msg.get("id") == 1:
        data = base64.b64decode(msg["result"]["data"])
        out = sys.argv[1] if len(sys.argv) > 1 else "shot.png"
        open(out, "wb").write(data)
        print("saved", out, len(data), "bytes")
        break
ws.close()
