# -*- coding: utf-8 -*-
"""用独立的方式核对面板: 直接从交换机抓原厂页面 (不经过面板的解析代码), 与面板接口返回的数据逐项比对。

只读, 不会向交换机发送任何写请求。

需要的环境变量:
    SW_BASE      交换机地址, 例如 http://192.168.1.1
    SW_USER      交换机的管理账号
    SW_PASS      交换机的密码
    PANEL_USER   面板自己的管理员账号 (面板 2.x 起有自己的账号, 不再借用交换机的账号)
    PANEL_PASS   面板密码
可选:
    PANEL_URL     面板地址, 默认 http://127.0.0.1:8208
    PANEL_DEVICE  要核对的那台设备在面板里的名称或 id; 不填时要求面板里只绑定了一台设备

用法: python verify_panel.py
"""

import http.cookiejar
import json
import os
import re
import sys
import urllib.error
import urllib.request

from sw import Switch

PANEL = os.environ.get("PANEL_URL", "http://127.0.0.1:8208")
CSRF = {"X-Requested-With": "netpanel"}  # 面板用这个请求头挡跨站请求


# ── 取数 ──────────────────────────────────────────────────────────────

def panel_client():
    jar = http.cookiejar.CookieJar()
    # 面板在本机或局域网里, 绕开系统代理
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))


def panel(op, path, body=None):
    headers = dict(CSRF)
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    req = urllib.request.Request(f"{PANEL}{path}", data=data, headers=headers)
    try:
        with op.open(req, timeout=90) as r:
            return json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"面板接口 {path} 返回 {e.code}: {e.read().decode('utf-8', 'replace')[:300]}")


def panel_login(op):
    user, pwd = os.environ["PANEL_USER"], os.environ["PANEL_PASS"]
    res = panel(op, "/api/login", {"username": user, "password": pwd})
    if not res.get("ok"):
        raise SystemExit(f"面板登录失败: {res}")


def panel_device(op):
    """要核对的设备: 按 PANEL_DEVICE 找名称或 id; 不指定时面板里只能有一台。"""
    want = os.environ.get("PANEL_DEVICE")
    devices = panel(op, "/api/devices")["devices"]
    if not want:
        if len(devices) != 1:
            names = ", ".join(d["name"] for d in devices) or "(无)"
            raise SystemExit(f"面板里绑定了 {len(devices)} 台设备 ({names}), 请用 PANEL_DEVICE 指定要核对的那一台")
        return devices[0]
    hit = next((d for d in devices if d["id"] == want or d["name"].lower() == want.lower()), None)
    if not hit:
        raise SystemExit(f"面板里找不到设备「{want}」")
    return hit


# ── 从原厂页面的 JS 里取值 (独立于面板的解析实现) ─────────────────────

def nums(text, key):
    """数组 → 整数列表 (支持 0xFF 十六进制, 以及固件里 `key = new Array(...)` 的写法)。"""
    m = re.search(r"\b" + re.escape(key) + r"\s*[:=]\s*\[([^\]]*)\]", text) \
        or re.search(r"\b" + re.escape(key) + r"\s*[:=]\s*new\s+Array\s*\(([^)]*)\)", text)
    if not m:
        raise KeyError(key)
    return [int(x.strip(), 0) for x in m.group(1).split(",") if x.strip()]


def strings(text, key):
    m = re.search(r"\b" + re.escape(key) + r"\s*[:=]\s*\[([^\]]*)\]", text)
    if not m:
        raise KeyError(key)
    return re.findall(r"['\"]([^'\"]*)['\"]", m.group(1))


def var(text, key):
    """`key = value;` 形式的赋值 (兼容 `var a=1, b="x";` 这种一行多个的写法)。"""
    m = re.search(r"\b" + re.escape(key) + r"\s*=\s*(['\"]?)([^;'\"\n]*?)\1\s*[;,]", text)
    if not m:
        raise KeyError(key)
    return m.group(2).strip()


def field(text, key):
    """对象里的 `key: 数字,`。"""
    m = re.search(r"\b" + re.escape(key) + r"\s*:\s*(-?0x[0-9A-Fa-f]+|-?\d+)", text)
    if not m:
        raise KeyError(key)
    return int(m.group(1), 0)


# ── 比对 ──────────────────────────────────────────────────────────────

class Report:
    def __init__(self):
        self.rows = []   # (说明, 面板值, 原厂值, 是否必须相等)

    def eq(self, label, got, want):
        self.rows.append((label, got, want, True))

    def ge(self, label, got, want):
        """计数器: 面板读得比原厂晚几秒, 只要求不小于 (且差距在合理范围内)。"""
        self.rows.append((label, got, want, ("ge",)))

    def info(self, label, got, want):
        self.rows.append((label, got, want, False))

    def done(self):
        def failed(got, want, mode):
            if mode is True:
                return got != want
            return not (want <= got <= want + 2_000_000)  # 几秒内涨不了两百万个包
        bad = [r for r in self.rows if r[3] and failed(r[1], r[2], r[3])]
        for label, got, want, _ in bad:
            print(f"  ✗ {label}: 面板={got!r}  原厂={want!r}")
        strict = sum(r[3] is True for r in self.rows)
        counter = sum(r[3] not in (True, False) for r in self.rows)
        print(f"完全相等比对 {strict} 项 + 计数器比对 {counter} 项, 不一致 {len(bad)} 项; 另有 {sum(r[3] is False for r in self.rows)} 项实时速率仅供参照")
        return len(bad)


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    r = Report()

    # 1) 直接从交换机抓原厂页面
    sw = Switch()
    sw.ensure_session(os.environ["SW_USER"], os.environ["SW_PASS"])
    names = ["MainRpm", "PortSettingRpm", "PortStatisticsRpm", "SystemInfoRpm", "cloud", "Vlan8021QRpm",
             "PortTrunkRpm", "QosStormControlRpm", "IpSettingRpm", "LoopPreventionRpm", "QosBasicRpm"]
    raw = {name: sw.get(f"/{name}.htm") for name in names}
    tid = var(sw.get("/"), "g_tid")
    detail = sw.get(f"/PortStatisticsAllRpm.htm?port=5&token={tid}")  # 原厂用 0 起始下标: 5 → 6 号口

    # 2) 面板接口 (面板自己的账号; 设备地址不一定等于 SW_BASE, 所以确认一下是同一台)
    pop = panel_client()
    panel_login(pop)
    device = panel_device(pop)
    base = f"/api/devices/{device['id']}"
    over = panel(pop, f"{base}/overview?live=1")["data"]  # live: 让面板此刻去交换机读, 而不是给缓存
    if over["device"]["mac"] and raw["MainRpm"] and strings(raw["MainRpm"], "macStr")[0].lower() != over["device"]["mac"].lower():
        raise SystemExit(f"面板里的「{device['name']}」({device['url']}) 与 SW_BASE 不是同一台交换机 "
                         f"(MAC {over['device']['mac']} vs {strings(raw['MainRpm'], 'macStr')[0]})")
    pg = panel(pop, f"{base}/pages?keys=ports,stats,system,cloud,vlan8021q,lag,qosStorm,ip")
    pg.update(panel(pop, f"{base}/pages?keys=loop,qosBasic"))
    det = panel(pop, f"{base}/stats/6")
    main_again = sw.get("/MainRpm.htm")  # 紧接着再抓一次原厂首页, 给实时速率做参照

    m = raw["MainRpm"]
    d = over["device"]
    r.eq("型号", d["model"], strings(m, "hardwareStr")[0])
    r.eq("固件版本", d["firmware"], strings(m, "firmwareStr")[0])
    r.eq("MAC", d["mac"], strings(m, "macStr")[0])
    r.eq("IP 地址", d["ip"], strings(m, "ipStr")[0])
    r.eq("子网掩码", d["netmask"], strings(m, "netmaskStr")[0])
    r.eq("默认网关", d["gateway"], strings(m, "gatewayStr")[0])
    r.eq("DNS", d["dns"], strings(m, "dnsStr")[0])
    r.eq("DHCP 获取地址", d["dhcp"], field(m, "dhcpEnable") == 1)
    r.eq("DNS 自动", d["dnsAuto"], field(m, "dnsEnable") == 1)
    r.eq("云管理已启用", over["cloud"]["enabled"], var(raw["cloud"], "mngt_switch") == "1")
    r.eq("云管理类型", pg["cloud"]["type"], "nms" if var(raw["cloud"], "cloud_type") == "1" else "cloud")

    ps = raw["PortSettingRpm"]
    for i, p in enumerate(over["ports"]):
        r.eq(f"{i + 1} 口 实际速率码", p["speedAct"], nums(m, "spd_act")[i])
        r.eq(f"{i + 1} 口 配置速率码", p["speedCfg"], nums(m, "spd_cfg")[i])
        r.eq(f"{i + 1} 口 启用", p["enabled"], nums(m, "state")[i] == 1)
        r.eq(f"{i + 1} 口 实际速率码 (端口配置页)", pg["ports"]["ports"][i]["speedAct"], nums(ps, "spd_act")[i])
        r.eq(f"{i + 1} 口 流控配置", pg["ports"]["ports"][i]["flowCfg"], nums(ps, "fc_cfg")[i])
        r.eq(f"{i + 1} 口 流控实际", pg["ports"]["ports"][i]["flowAct"], nums(ps, "fc_act")[i])
        r.info(f"{i + 1} 口 接收速率 Kbps", p["rxKbps"], (nums(m, "rx_rate")[i], nums(main_again, "rx_rate")[i]))

    pk = nums(raw["PortStatisticsRpm"], "pkts")
    for i, p in enumerate(pg["stats"]["ports"]):
        for k, off in (("txGood", 0), ("txBad", 1), ("rxGood", 2), ("rxBad", 3)):
            r.ge(f"{i + 1} 口 {k}", p[k], pk[4 * i + off])
        r.eq(f"{i + 1} 口 链路码 (统计页)", p["link"], nums(raw["PortStatisticsRpm"], "link_status")[i])
    for i in range(9):
        r.ge(f"6 号口明细 接收[{i}]", det["rx"][i], nums(detail, "pkts_rx_info")[i])
        r.ge(f"6 号口明细 发送[{i}]", det["tx"][i], nums(detail, "pkts_tx_info")[i])

    s, si = pg["system"], raw["SystemInfoRpm"]
    r.eq("系统信息·设备型号", s["model"], strings(si, "productModel")[0])
    r.eq("系统信息·硬件版本", s["hardware"], strings(si, "hardwareStr")[0])
    r.eq("系统信息·固件", s["firmware"], strings(si, "firmwareStr")[0])
    r.eq("系统信息·设备描述", s["description"], strings(si, "descriStr")[0])
    r.eq("系统信息·云管理锁定描述", s["cloudManaged"], var(si, "mngt_switch") == "1")

    qv = raw["Vlan8021QRpm"]
    vlans = pg["vlan8021q"]["vlans"]
    r.eq("802.1Q VLAN 启用", pg["vlan8021q"]["enabled"], field(qv, "state") == 1)
    r.eq("802.1Q VLAN 数量", len(vlans), field(qv, "count"))
    r.eq("802.1Q VLAN ID", [v["id"] for v in vlans], nums(qv, "vids"))
    r.eq("802.1Q VLAN 名称", [v["name"] for v in vlans], strings(qv, "names"))
    r.eq("802.1Q Untagged 成员掩码", [sum(1 << (p - 1) for p in v["untagged"]) for v in vlans], nums(qv, "untagMbrs"))
    r.eq("802.1Q Tagged 成员掩码", [sum(1 << (p - 1) for p in v["tagged"]) for v in vlans], nums(qv, "tagMbrs"))

    tc = raw["PortTrunkRpm"]
    for g, grp in enumerate(pg["lag"]["groups"], start=1):
        members = nums(tc, f"portStr_g{g}")
        r.eq(f"LAG{g} 成员", grp["members"], [i + 1 for i, x in enumerate(members) if x])
    r.eq("汇聚组数", pg["lag"]["maxLag"], field(tc, "maxTrunkNum"))

    sc = nums(raw["QosStormControlRpm"], "scInfo")
    n = pg["qosStorm"]["portCount"]
    r.eq("风暴抑制·速率", [p["rate"] for p in pg["qosStorm"]["ports"]], sc[0::3][:n])
    r.eq("风暴抑制·类型", [sum(p["types"]) for p in pg["qosStorm"]["ports"]], sc[1::3][:n])
    r.eq("QoS 模式", pg["qosBasic"]["mode"], int(var(raw["QosBasicRpm"], "qosMode")))
    r.eq("端口优先级", [p["priority"] for p in pg["qosBasic"]["ports"]], nums(raw["QosBasicRpm"], "pPri"))

    ipr = raw["IpSettingRpm"]
    r.eq("IP 设置·DHCP", pg["ip"]["dhcp"], field(ipr, "state") == 1)
    r.eq("IP 设置·管理 VLAN", pg["ip"]["manageVlan"], var(ipr, "manage_vlan") and int(var(ipr, "manage_vlan")))
    r.eq("环回保护", pg["loop"]["enabled"], var(raw["LoopPreventionRpm"], "lpEn") == "1")

    # 运行时间: 原厂是文本, 面板是秒数
    wt = strings(m, "workTime")[0]
    dd, hh, mm, ss = (int(x) for x in re.search(r"(\d+) day - (\d+) hour - (\d+) min - (\d+) sec", wt).groups())
    secs = ((dd * 24 + hh) * 60 + mm) * 60 + ss
    r.info("运行时间 (秒)", d["uptime"], (secs, secs + 3))

    return 1 if r.done() else 0


if __name__ == "__main__":
    sys.exit(main())
