"""测量交换机 Web 会话的两个特性 (纯只读 GET):

1. 同一账号能否多会话并存 (决定面板多浏览器登录时会不会互踢)
2. 空闲多久会话过期

用法: python session_timeout.py   (需要环境变量 SW_BASE / SW_USER / SW_PASS)
"""

import http.cookiejar
import os
import sys
import time
import urllib.parse
import urllib.request

from enc import security_encode

BASE = os.environ.get("SW_BASE", "").rstrip("/")  # 交换机地址必须显式给出, 不设默认值
if not BASE:
    sys.exit("请先设置环境变量 SW_BASE (交换机地址, 例如 http://192.168.1.1)")
GAPS = [60, 180, 300, 480, 900, 1800]  # 每轮空闲秒数, 逐级加大


def opener(with_jar=False):
    handlers = [urllib.request.ProxyHandler({})]  # 直连局域网设备, 绕开系统代理
    jar = http.cookiejar.CookieJar()
    if with_jar:
        handlers.append(urllib.request.HTTPCookieProcessor(jar))
    return urllib.request.build_opener(*handlers), jar


def login(user, pwd):
    op, jar = opener(with_jar=True)
    form = urllib.parse.urlencode({"username": user, "password": security_encode(pwd), "isIe": "", "logon": "登录", "code": ""}).encode()
    with op.open(urllib.request.Request(f"{BASE}/logon.cgi", data=form), timeout=10) as r:
        text = r.read().decode("utf-8", "replace")
    sid = [c.value for c in jar if c.name == "SessionID"]
    return sid[0] if sid and "new Array(\n0," in text else None


def alive(sid):
    """用给定会话访问一次首页; 返回 True=仍有效, False=已失效, 其它=出错。"""
    op, _ = opener()
    req = urllib.request.Request(f"{BASE}/", headers={"Cookie": f"SessionID={sid}"})
    try:
        with op.open(req, timeout=10) as r:
            return b"logonInfo" not in r.read(300)
    except Exception as e:  # 嵌入式 web 偶发断连
        time.sleep(1)
        try:
            with op.open(req, timeout=10) as r:
                return b"logonInfo" not in r.read(300)
        except Exception as e2:
            return f"err {e2}"


def main():
    user, pwd = os.environ["SW_USER"], os.environ["SW_PASS"]
    t0 = time.time()

    def say(msg):
        print(f"[{time.time() - t0:7.0f}s] {msg}", flush=True)

    a = login(user, pwd)
    b = login(user, pwd)
    say(f"同账号连续登录两次: A={'ok' if a else 'FAIL'} B={'ok' if b else 'FAIL'}")
    say(f"登录 B 之后立刻检查 A: {'仍有效 → 允许同账号多会话' if alive(a) is True else '已失效 → 同账号只允许一个会话'}")

    prev = 0
    for gap in GAPS:
        time.sleep(gap)
        state = alive(b)
        say(f"空闲 {gap}s 后: {'有效 (超时 >= ' + str(gap) + 's)' if state is True else f'失效 (超时 < {gap}s, >= {prev}s) → {state}'}")
        if state is not True:
            return
        prev = gap
    say("空闲超过 1800s 仍有效, 放弃继续测")


if __name__ == "__main__":
    main()
