"""用独立的方式核对面板: 直接从交换机抓原厂页面 (不经过面板的解析代码), 与面板接口返回的数据逐项比对。

只读, 不会向交换机发送任何写请求。
用法: python verify_panel.py   (需要环境变量 SW_USER / SW_PASS, 即交换机的账号密码)
"""

import http.cookiejar
import json
import os
import re
import sys
import urllib.request

from sw import Switch

PANEL = os.environ.get("PANEL_URL", "http://127.0.0.1:8208")


# ── 取数 ──────────────────────────────────────────────────────────────

def panel_login(user, pwd):
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(jar))
    body = json.dumps({"username": user, "password": pwd}).encode()
    req = urllib.request.Request(f"{PANEL}/api/login", data=body, headers={"Content-Type": "application/json", "X-Requested-With": "switch-panel"})
    with op.open(req, timeout=20) as r:
        assert r.status == 200, "面板登录失败"
    return op


def panel(op, path):
    req = urllib.request.Request(f"{PANEL}{path}", headers={"X-Requested-With": "switch-panel"})
    with op.open(req, timeout=60) as r:
        return json.loads(r.read().decode("utf-8"))


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
    user, pwd = os.environ["SW_USER"], os.environ["SW_PASS"]
    r = Report()

    # 1) 直接从交换机抓原厂页面
    sw = Switch()
    sw.ensure_session(user, pwd)
    names = ["MainRpm", "PortSettingRpm", "PortStatisticsRpm", "SystemInfoRpm", "cloud", "Vlan8021QRpm",
             "PortTrunkRpm", "QosStormControlRpm", "IpSettingRpm", "LoopPreventionRpm", "QosBasicRpm"]
    raw = {name: sw.get(f"/{name}.htm") for name in names}
    tid = var(sw.get("/"), "g_tid")
    detail = sw.get(f"/PortStatisticsAllRpm.htm?port=5&token={tid}")  # 原厂用 0 起始下标: 5 → 6 号口

    # 2) 面板接口
    pop = panel_login(user, pwd)
    pg = {}  # 面板单次最多读 8 个页面, 分两次
    pg.update(panel(pop, "/api/pages?keys=ports,stats,system,cloud,vlan8021q,lag,qosStorm,ip"))
    pg.update(panel(pop, "/api/pages?keys=loop,qosBasic"))
    over = panel(pop, "/api/overview")["data"]
    det = panel(pop, "/api/stats/6")
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
