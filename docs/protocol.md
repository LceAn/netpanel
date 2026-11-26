# 协议：TP-LINK 旧版 Web 界面（`*Rpm.htm` 固件）

本文记录 TL-SG2008D（硬件 3.0，固件 1.8.1 Build 20260401）的 Web 管理接口是怎么工作的。
它是 `tplink-rpm` 适配器的依据，也是想帮忙核对、扩展这个适配器的人需要的全部信息。

> **哪些是实测的，哪些不是**
> - **读取**（登录、全部页面、端口明细、配置备份）：在真机上核对过，并用独立脚本逐项比对过（`tools/verify_panel.py`）。
> - **写入的格式**：原厂页面里的每个表单都逐个核对过（37 个静态表单，加上页面脚本动态生成或直接提交的几个接口，用 `tools/forms.py` 列出来）。33 个写操作里 24 个是 GET 查询串、9 个是 POST 表单。其中下面标 ✔ 的操作在真机上用不改变配置的方式执行过（把当前值原样再提交一遍、建一个临时 VLAN 再删掉、清空统计），设备回答 `操作成功`，执行前后 22 个页面的数据完全一致。
> - **没有在真机上执行过的**：保存配置、重启、恢复出厂、还原配置、升级固件、改 IP、改账户、改云管理——它们会改变设备的状态。请求格式和实测过的操作出自同一类表单，但第一次在真机上使用时仍请先备份配置，并从无关紧要的操作开始。

## 1. 登录与会话

```
POST /logon.cgi
Content-Type: application/x-www-form-urlencoded

username=<账号>&password=<securityEncode(密码)>&isIe=&logon=登录&code=
```

- 响应体是一段 `<script>`：`var logonInfo = new Array(<代码>, 0, 0);`。代码 `0` 表示成功，`1` 用户名或密码错误，`2` 该用户不允许登录，`3` / `4` 同时登录的用户数已满，`5` 没有登录（会话无效）。
- 成功时通过 `Set-Cookie: SessionID=…` 发会话 Cookie，之后的请求都带上它。
- 会话**空闲 8 到 15 分钟**后会失效；同一个账号允许**多个会话并存**（面板和你自己用浏览器登录不会互相踢）。

`securityEncode` 不是 MD5（原厂文件里叫 `hex_md5`），是固定密钥的异或编码：

```js
const KEY = 'RDpbLfCPsJZ7fiv';
const ALPHA = 'yLwVl0zKqws7LgKPRQ84Mdt708T1qQ3Ha7xv3H7NyU84p21BriUWBU43odz3iP4rBL3cD02KZciXTysVXiV8ngg6vL48rPJyAUw0HurW20'
  + 'xqxv9aYb4M9wK1Ae0wlro510qXeU07kV57fQMc8L6aLgMLwygtc0F10a0Dg70TOoouyFhdysuRMO51yY5ZlOZZLEal1h0t9YQW0Ko7oBwmCAHoic4HYbUyVeU3sfQ1xtXcPcf1aT303wAQhv66qzW';
function securityEncode(password) {
  let out = '';
  const len = Math.max(password.length, KEY.length);
  for (let i = 0; i < len; i++) {
    const a = i < password.length ? password.charCodeAt(i) : 187;
    const b = i < KEY.length ? KEY.charCodeAt(i) : 187;
    out += ALPHA[(a ^ b) % ALPHA.length];
  }
  return out;
}
```

校验向量：`admin` → `WaQ7xbhc9TefbwK`。

## 2. 会话令牌（`g_tid`）

登录后访问 `/` 得到"框架页"，里面有一段脚本声明全局变量：

```js
var g_Lan=0,g_level=1,g_year=2026,g_title='TL-SG2008D',g_product=2,g_tid=1388728877;
```

`g_tid` 就是这次会话的令牌。**所有写请求都必须带上它**（字段名 `token`），否则设备返回 `var tip = "token 错误";`。

## 3. 页面格式

每个功能页是一个 `*Rpm.htm`，数据全部在页面**第一个 `<script>` 里的 `var` 声明**中，是纯粹的 JS 字面量（对象、数组、字符串、数字，偶尔是 `new Array(...)`）。面板只解析这些字面量，**不求值任何代码**（`src/core/jslite.mjs`）。

- 编码是 UTF-8，个别页面实际是 GBK，解码时先按 UTF-8 严格尝试、失败再按 GB18030。
- 会话失效时任何页面都返回登录页（特征：`var logonInfo = new Array(5, …)`），据此自动重新登录。
- 登录后访问 `/index.html` 得到的是空回复，不要访问它。

| 规范模型 | 页面 | 主要变量 |
|---|---|---|
| `overview` | `/MainRpm.htm` | `info_ds{descriStr, macStr, firmwareStr, hardwareStr, dhcpEnable, ipStr, netmaskStr, gatewayStr, dnsEnable, dnsStr, workTime, …}`、`max_port_num`、`port_info{state[], spd_cfg[], spd_act[], fc_cfg[], fc_act[], rx_rate[], tx_rate[]}`、`support_2_5G`、`qvlan`、`qvlan_ds{…}`、`loop`、`loopPortConf{loopbackEnable, …}`、`trunk`、`trunkConf{portStr_g1[], portStr_g2[], …}`、`cloud_config`、`cloud_status`、`nms_status`、`tip` |
| `ports` | `/PortSettingRpm.htm` | `max_port_num`、`all_info{state[], trunk_info[], spd_cfg[], spd_act[], fc_cfg[], fc_act[], …}` |
| `stats` | `/PortStatisticsRpm.htm` | `max_port_num`、`all_info{state[], link_status[], pkts[]}`（`pkts` 每个端口 4 个数：发送正常、发送错误、接收正常、接收错误） |
| 端口明细 | `/PortStatisticsAllRpm.htm?port=<0 起始的下标>&token=<g_tid>` | `pkts_rx_info[9]`、`pkts_tx_info[9]` |
| `system` | `/SystemInfoRpm.htm` | `info_ds{descriStr, macStr, ipStr, netmaskStr, gatewayStr, firmwareStr, productModel, hardwareStr}`、`mngt_switch`、`support_cloud` |
| `ip` | `/IpSettingRpm.htm` | `manage_vlan`、`vlan_type`、`ip_ds{state, ipStr, netmaskStr, gatewayStr, dnsEnable, dnsStr}` |
| `fixIp` | `/FixIpSettingRpm.htm` | `ip_ds{state, ipStr}` |
| `user` | `/UserAccountRpm.htm` | `user_ds{userNameStr}`、`userMinLenth`、`userMaxLenth`、`pwdMinLenth`、`pwdMaxLenth` |
| `cloud` | `/cloud.htm` | `mngt_switch`、`cloud_type`、`tums_server`、`tums_port` |
| `lag` | `/PortTrunkRpm.htm` | `trunk_conf{maxTrunkNum, portNum, portNumPerTrunk, portStr_g1[], portStr_g2[], lag_view[]}` |
| `isolation` | `/PortIsolationRpm.htm` | `portIso_conf{portNum, portStr_iso[], trunk_info[], …}` |
| `mirror` | `/PortMirrorRpm.htm` | `MirrEn`、`MirrPort`、`porttrunkid[]`、`mirr_info{ingress[], egress[]}` |
| `loop` | `/LoopPreventionRpm.htm` | `lpEn` |
| `cable` | `/CableDiagRpm.htm` | `maxPort`、`cablestate[]`、`cablelength[]`、`portdisableid[]` |
| `vlan8021q` | `/Vlan8021QRpm.htm` | `qvlan_ds{state, portNum, vids[], count, maxVids, names[], tagMbrs[], untagMbrs[]}` |
| `vlanPvid` | `/Vlan8021QPvidRpm.htm` | `pvid_ds{state, portNum, vids[], mbrs[], pvids[], …}` |
| `vlanPort` | `/VlanPortBasicRpm.htm` | `pvlan_ds{state, portNum, vids[], count, mbrs[]}` |
| `vlanMtu` | `/VlanMtuRpm.htm` | `mtu_ds{state, portNum, uplinkPort}` |
| `qosBasic` | `/QosBasicRpm.htm` | `qosMode`、`portNumber`、`pPri[]`、`pTrunk[]` |
| `qosBandwidth` | `/QosBandWidthControlRpm.htm` | `portNumber`、`portdisableid[]`、`bcInfo[]`（每个端口 3 个数：接收上限、发送上限、汇聚组） |
| `qosStorm` | `/QosStormControlRpm.htm` | `portNumber`、`scInfo[]`（每个端口 3 个数：速率、类型掩码、汇聚组；掩码位 `1` 未知单播、`2` 组播、`4` 广播） |
| `firmware` | `/fwupgradephase0.htm` | `upgrade_ds{current_firmwareStr, current_hardwareStr}`、`onlineUpgrade_flag`、`hasNewFirmware`、`new_firmwareStr`、`release_log`、`upgConflict` |

每个页面都带一个 `tip` 变量，是设备给用户的提示文字；写操作的响应页里它就是操作结果（成功时是 `操作成功`，真机实测）。

约定：

- **端口位掩码**：第 n 个口对应第 n−1 位（`0xFF` = 全部 8 个口）。原厂页面用 32 位写法，在 32 口及以上会溢出；面板用任意精度整数计算，31 口以内结果相同，**32 口及以上没有在真机上验证过**。
- **运行时间**：`workTime` 是文本，形如 `11 day - 4 hour - 17 min - 32 sec`。

## 4. 写请求

写请求都发往 `.cgi`，字段名与取值逐条对应原厂页面的表单（见 `src/adapters/tplink-rpm/ops.mjs`）。

**提交方式必须和原厂页面完全一致。** 嵌入式服务端的 CGI 只按它预期的方式取参数，用别的方式发，交换机**直接断开连接**，什么也不回（真机实测：用 POST 请求备份接口就是这样）。怎么判断某个接口该用什么方式？看原厂页面里对应的 `<form>`，照"浏览器会怎么提交它"来发：

| 原厂页面的写法 | 浏览器的提交方式 | 接口 |
|---|---|---|
| `<form>` 没写 `method`（其中不少写了 `enctype=multipart/form-data`，但它对 GET 不起作用） | **GET**，全部字段（包括 `token`）在查询串里 | 端口配置、端口快捷设置、清空统计、设备描述、IP 设置、固定 IP、账户、链路聚合（设置 / 删除）、端口隔离、MAC 搜索、镜像开关、被监控端口、环回保护、线缆检测、802.1Q VLAN（开关 / 设置 / 删除）、设置 PVID、MTU VLAN（开关 / 上联口）、端口 VLAN（开关 / 设置 / 删除）、配置备份 |
| `<form method=post>` | POST，`application/x-www-form-urlencoded`，字段在请求体里 | 保存配置、重启、恢复出厂、云管理开关、NMS 服务器、QoS 模式 / 端口优先级 / 限速 / 风暴抑制 |
| `<form method=post enctype=multipart/form-data>` | POST，`multipart/form-data` | 配置还原、固件上传 |
| 页面脚本用 `XMLHttpRequest` 提交 | POST，请求体是空的，`token` 在查询串里 | 固件相关的 5 个接口（见"多步流程"） |
| 页面脚本用 `location.href` 提交 | GET，查询串 | 设置 PVID（`vlanPvidSet.cgi?pbm=…&pvid=…&token=…`） |

- 查询串按浏览器提交表单的规则编码（`application/x-www-form-urlencoded` 的序列化：空格是 `+`，中文按 UTF-8 百分号编码）。VLAN 名、设备描述里会有空格，不能用会把空格编成 `%20` 的编码方式。
- 在真机上实测过的操作（都是"把当前值原样再提交一遍"，设备回答 `操作成功`）：✔ 端口快捷设置　✔ 端口配置（保持不变）　✔ 清空统计　✔ 环回保护　✔ QoS 模式　✔ 设置 PVID　✔ 802.1Q VLAN 的添加和删除　✔ MAC 搜索　✔ 线缆检测　✔ 配置备份　✔ 在线检查新版本　✔ 升级前检查冲突。
- 写操作成功时，响应是对应功能页的页首数据（`Content-Type: text/html`，`Connection: close`），`tip` 是 `操作成功`。例如提交 `port_setting.cgi` 后返回的是 `PortSettingRpm` 页面的变量。
- MAC 搜索和线缆检测的响应页本身就是结果页：前者是 `mac_ds{macNum, mac_info[]}`，**没搜到时 `tip` 是 `未找到MAC地址`，`macNum` 为 0 但仍带一条占位记录 `{mac:"0", vid:0, port:0}`**（真实的条数要看 `macNum`）；后者是 `cablestate[]` / `cablelength[]`。

"保持不变"的约定：批量端口配置里 `state=7`、`flowcontrol=7`、`speed=8` 表示这一项不改。

### 多步流程

| 流程 | 请求 | 真机 |
|---|---|---|
| 配置备份 | `GET config_back.cgi?btnBackup=…&token=<g_tid>` → 响应体就是配置文件（二进制，约 2.7 KB）。响应头 `Content-Type: application/octet-stream; name=config.cfg`、`Content-Disposition: attachment; filename=config.cfg`。拿到 HTML 说明出错 | ✔ 实测 |
| 配置还原 | `POST conf_restore.cgi?token=<g_tid>`（multipart，请求体里只有文件，字段名 `configfile`；`token` 是页面脚本拼到 action 上的）。原厂页面提示还原后需要等待设备重启 | 未执行 |
| 重启 | `POST reboot.cgi`（表单编码：`reboot_op=reboot`、`save_op=true\|false`、`token`）。表单里只有这三个字段——按钮和"保存配置"复选框在 `<form>` 之外，由页面脚本把复选框的状态写进 `save_op` | 未执行 |
| 恢复出厂 | `POST reset.cgi`（表单编码：`reset_op=factory`、`token`） | 未执行 |
| 在线检查新版本 | `POST check_new_version_start.cgi?token=<g_tid>`（空请求体），之后每秒 `POST check_new_version.cgi?token=<g_tid>`，响应体为 `2` 表示还在检查，否则结束；然后读 `/fwupgradephase0.htm` | ✔ 实测 |
| 升级前检查冲突 | `POST upgradeConflict.cgi?token=<g_tid>`。真机返回 `<!DOCTYPE html> <htm> <div id="confFlag" value="0"></div> </htm> <div id=confFlag value=0> </div>`：`value` 之后第一个 `0` / `1` 表示是否已有升级在进行（同一个标志写了带引号、不带引号两遍，标签名还写成了 `htm`） | ✔ 实测（值为 0） |
| 本地升级 | `POST httpupg.cgi?cmd=fw_upgrade&token=<g_tid>`（multipart，文件字段名 `firmware`） | 未执行 |
| 在线升级 | `POST upgrade_online.cgi?token=<g_tid>` | 未执行 |
| 升级进度 | `POST upgradeStatusCheck.cgi?token=<g_tid>`，响应体 `1` 失败、`0` 完成、其它表示进行中；设备写完固件会自行重启并断开连接 | 未执行 |

仓库里的模拟交换机（`app/scripts/mock-switch.mjs`）照上面这些实测结果实现：提交方式不对就断开连接，成功时回答 `操作成功`，返回对应的页面。`app/test/mock.test.mjs` 把适配器的每个写操作逐个打到它上面。

## 5. 传输上的坑

这些都是在真机上遇到过的，适配器里都有对应的处理：

- **提交方式不对，交换机直接断开连接。** 2.0.0 及之前的版本把"没写 `method` 的表单"当成 POST 发送，在真机上这些操作全部不会生效（面板显示"结果未知"）。读取不受影响。
- **连接偶尔被直接断开**（尤其是读页面的时候）。适配器把同一连接上的请求串行化，只对**读**请求自动重试（150 / 400 / 900 / 1800 毫秒后），写请求绝不盲目重发——重复提交一次"修改 IP"的后果比失败严重得多。
- 会话空闲超时短。面板常驻轮询（默认 15 秒）顺带保活了会话；失效后靠"响应是登录页"自动重新登录。
- 写操作可能很慢（保存配置要等 FLASH）：写超时 30 秒，固件上传 10 分钟，读 10 秒。
- 超时或断开时操作**可能已经生效**，面板会把它报告为"结果未知，请刷新后确认"，而不是当成失败。

## 6. 自己核对

`tools/` 里是逆向时用到的几个 Python 小脚本（只用标准库，全部**只读**）：

```bash
export SW_BASE=http://192.168.1.1 SW_USER=admin SW_PASS='…'
python tools/sw.py show /MainRpm.htm            # 登录交换机, 抓取并打印某个页面
python tools/sw.py save out/ /MainRpm.htm /PortSettingRpm.htm …   # 抓取并存成文件
python tools/enc.py admin                        # 密码编码 (和原厂页面实际发送的值对照)
python -I tools/extract.py out/ MainRpm          # 从存下来的页面里提取: 数据块、表单、控件、提交函数
python -I tools/options.py out/ QosBasic         # 列出页面里每个下拉框的全部选项
python -I tools/forms.py out/ out/js/            # 每个表单的提交方式 (GET 查询串 / POST 表单 / POST multipart) 和字段, 以及页面脚本自己提交的接口
python tools/session_timeout.py                  # 测量会话空闲多久过期、同一账号能否多会话并存
```

`SW_BASE`、`SW_USER`、`SW_PASS` 只从环境变量读，不落盘。要核对面板读出来的数据和原厂页面是否一致（只读）：

```bash
export PANEL_USER=admin PANEL_PASS='…'           # 面板自己的账号
python tools/verify_panel.py                     # 面板里只绑定了一台设备时不用再指定; 多台时用 PANEL_DEVICE=<名称>
```
