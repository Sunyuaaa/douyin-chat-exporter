# 从抖音 JS bundle 提取完整的 [表情名] → URL 映射，保存为 emoji-map.json
import json, re, urllib.request

URL = None
hits = json.load(open("tools/emoji_js_hits.json", encoding="utf-8"))
ctx = hits[0]["ctx"]
# 从命中上下文里还原文件 URL（取命中文件全文更稳，直接重新下载）
src_url = hits[0]["url"]
# url 被截断过（[-90:]），从 JS 资源列表重新拿完整地址
import websocket, time
BASE = "http://127.0.0.1:9222"
targets = json.load(urllib.request.urlopen(BASE + "/json/list"))
page = next(t for t in targets if t.get("type") == "page" and "douyin.com" in t.get("url", ""))
import websocket as _w
ws = _w.create_connection(page["webSocketDebuggerUrl"], timeout=60, suppress_origin=True)
ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate", "params": {
    "expression": "JSON.stringify(performance.getEntriesByType('resource').map(r=>r.name))",
    "returnByValue": True}}))
while True:
    msg = json.loads(ws.recv())
    if msg.get("id") == 1:
        urls = json.loads(msg["result"]["result"]["value"]); break
ws.close()
full = next(u for u in urls if "client-entry~5b58af49" in u and u.endswith(".js"))
print("下载", full[-80:])
req = urllib.request.Request(full, headers={"User-Agent": "Mozilla/5.0"})
txt = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", errors="ignore")

# 提取映射："[\u00xx…]":{name:"[…]",originUri:"...",hide:0,img:"https://..."}
pat = re.compile(r'"(\[[^\[\]]{1,20}\])":\{name:"\1",originUri:"([^"]*)",hide:(\d),img:"(https://[^"]+)"')
mapping = {}
for m in pat.finditer(txt):
    name, origin, hide, img = m.group(1), m.group(2), m.group(3), m.group(4)
    if hide == 1:      # 隐藏表情不收录
        continue
    mapping[name] = img

print(f"共提取 {len(mapping)} 个表情")
for k in list(mapping)[:8]:
    print(" ", k, "→", mapping[k][:70])
json.dump(mapping, open("emoji-map.json", "w", encoding="utf-8"), ensure_ascii=False, indent=0)
print("已保存 emoji-map.json")
