# 用 CDP Input 域模拟真实鼠标点击
import json, sys, time, urllib.request, websocket
BASE = "http://127.0.0.1:9222"
targets = json.load(urllib.request.urlopen(BASE + "/json/list"))
page = next(t for t in targets if t.get("type") == "page" and "douyin.com" in t.get("url", ""))
ws = websocket.create_connection(page["webSocketDebuggerUrl"], timeout=30, suppress_origin=True)

mid = [0]
def call(method, params=None):
    mid[0] += 1
    ws.send(json.dumps({"id": mid[0], "method": method, "params": params or {}}))
    end = time.time() + 20
    while time.time() < end:
        ws.settimeout(max(1, end - time.time()))
        msg = json.loads(ws.recv())
        if msg.get("id") == mid[0]:
            return msg

x, y = float(sys.argv[1]), float(sys.argv[2])
for typ, btn in (("mousePressed", "down"), ("mouseReleased", "up")):
    call("Input.dispatchMouseEvent", {
        "type": typ, "x": x, "y": y, "button": "left",
        "clickCount": 1, "buttons": 1 if btn == "down" else 0,
    })
    time.sleep(0.08)
print("clicked", x, y)
ws.close()
