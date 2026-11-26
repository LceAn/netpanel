"""只读探测 TL-SG2008D 的 Web API。

凭据只从环境变量 SW_USER / SW_PASS 读取，不落盘；会话 Cookie 复用 tools/.session.json。
用法:
    python sw.py show <path> [...]                 抓取并打印
    python sw.py save <outdir> <path> [...]        抓取并存文件
"""
import http.cookiejar
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

from enc import security_encode

BASE = os.environ.get("SW_BASE", "").rstrip("/")  # 交换机地址必须显式给出, 不设默认值
SESSION_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".session.json")


class SwitchError(Exception):
    pass


class Switch:
    """对交换机 Web API 的最小只读客户端。"""

    def __init__(self, base=None):
        self.base = (base or BASE).rstrip("/")
        if not self.base:
            raise SystemExit("请先设置环境变量 SW_BASE (交换机地址, 例如 http://192.168.1.1)")
        self.jar = http.cookiejar.CookieJar()
        # 直连局域网设备，必须绕开系统代理
        self.opener = urllib.request.build_opener(
            urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(self.jar)
        )
        self._load_session()

    def _raw(self, path, data=None, tries=6):
        last = None
        for i in range(tries):
            try:
                req = urllib.request.Request(
                    self.base + path, data=data,
                    headers={"Referer": self.base + "/",
                             "User-Agent": "Mozilla/5.0 (sw-probe)"})
                with self.opener.open(req, timeout=15) as r:
                    return r.status, r.read()
            except urllib.error.HTTPError as e:
                return e.code, e.read()
            except Exception as e:  # 嵌入式 web 偶发 Empty reply / 连接被重置
                last = e
                time.sleep(0.3 * (i + 1))
        raise SwitchError(f"{path}: {tries} 次均失败: {last}")

    @staticmethod
    def _decode(body):
        # 页面声明的 charset 不可靠 (有的页面声明 utf-8 实际是 GBK), 一律先严格按 UTF-8 试
        try:
            return body.decode("utf-8")
        except UnicodeDecodeError:
            return body.decode("gb18030", errors="replace")

    # ---- 会话 ----
    def _save_session(self):
        for c in self.jar:
            if c.name == "SessionID":
                with open(SESSION_FILE, "w", encoding="utf-8") as f:
                    json.dump({"SessionID": c.value}, f)

    def _load_session(self):
        if os.path.exists(SESSION_FILE):
            try:
                sid = json.load(open(SESSION_FILE, encoding="utf-8"))["SessionID"]
                host = urllib.parse.urlparse(self.base).hostname
                self.jar.set_cookie(http.cookiejar.Cookie(
                    version=0, name="SessionID", value=sid, port=None, port_specified=False,
                    domain=host, domain_specified=True, domain_initial_dot=False,
                    path="/", path_specified=True, secure=False, expires=None,
                    discard=True, comment=None, comment_url=None, rest={"HttpOnly": None}))
            except Exception:
                pass

    @staticmethod
    def logged_in(body):
        return not re.search(rb"var logonInfo = new Array", body[:200])

    def login(self, user, password):
        for c in list(self.jar):
            self.jar.clear(c.domain, c.path, c.name)
        form = urllib.parse.urlencode({
            "username": user, "password": security_encode(password),
            "isIe": "", "logon": "登录", "code": ""}).encode()
        _, body = self._raw("/logon.cgi", data=form)
        m = re.search(rb"logonInfo = new Array\(\s*(\d+)", body)
        code = int(m.group(1)) if m else -1
        if code != 0:
            raise SwitchError(f"登录失败, logonInfo={code}")
        self._save_session()

    def ensure_session(self, user, password):
        status, body = self._raw("/")
        if status == 200 and self.logged_in(body):
            return False
        self.login(user, password)
        return True

    def tid(self):
        """本次会话的 CSRF token (主框架页里的 g_tid)。"""
        m = re.search(rb"g_tid=(\d+)", self._raw("/")[1])
        if not m:
            raise SwitchError("未取到 g_tid, 会话可能已失效")
        return m.group(1).decode()

    def get(self, path):
        return self._decode(self._raw(path)[1])


def main():
    user, password = os.environ.get("SW_USER"), os.environ.get("SW_PASS")
    if not user or not password:
        sys.exit("请先设置环境变量 SW_USER / SW_PASS")
    sw = Switch()
    relogin = sw.ensure_session(user, password)
    sys.stderr.write(f"[session {'re-login' if relogin else 'reused'}]\n")

    cmd = sys.argv[1]
    if cmd == "show":
        sys.stdout.reconfigure(encoding="utf-8")
        for p in sys.argv[2:]:
            text = sw.get(p.replace("{tid}", sw.tid()))
            print(f"\n=================== {p}  ({len(text)} chars)\n{text}")
    elif cmd == "save":
        outdir, paths = sys.argv[2], sys.argv[3:]
        os.makedirs(outdir, exist_ok=True)
        for p in paths:
            text = sw.get(p)
            name = p.strip("/").replace("/", "__").replace(".", "_")
            with open(os.path.join(outdir, name + ".txt"), "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            print(f"{p} -> {name}.txt ({len(text)} chars)")
    else:
        sys.exit(f"未知命令 {cmd}")


if __name__ == "__main__":
    main()
