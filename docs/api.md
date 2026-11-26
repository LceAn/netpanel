# 接口参考：HTTP API 与 Prometheus 指标

所有接口都在面板的地址下（默认 `http://127.0.0.1:8208`），返回 JSON（`Content-Type: application/json; charset=utf-8`）。字段名和错误信息都是稳定的，可以脚本化使用。

- 命令行 `switchctl` 见 [cli.md](cli.md)。
- 规范模型与规范操作的结构见 [architecture.md](architecture.md)。

## 约定

**登录态。** 面板有自己的管理员账号。登录后拿到会话 Cookie `netpanel_session`（HttpOnly、SameSite=Strict、12 小时），之后每个请求都带上。只有 `GET /api/status`、`POST /api/setup`、`POST /api/login`、`POST /api/logout` 不需要登录。

**防跨站。** 所有不是 `GET` 的请求必须带请求头 `X-Requested-With: netpanel`，并且 `Origin`（如果有）必须与 `Host` 同源，否则返回 `403`。浏览器里的跨站表单发不出自定义请求头，所以这一条就挡住了跨站请求伪造。

```bash
curl -s -c jar.txt -H 'X-Requested-With: netpanel' -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"…"}' http://127.0.0.1:8208/api/login
curl -s -b jar.txt http://127.0.0.1:8208/api/dashboard
```

**错误。** 出错时不返回 200，响应体是：

```json
{ "error": "给人看的说明", "code": "错误码", "details": ["逐条的校验错误（仅参数校验失败时）"] }
```

| HTTP | `code` | 含义 |
|---|---|---|
| 400 | `BAD_PARAM` | 参数不合法（`details` 里有逐条的原因） |
| 400 | `UNSUPPORTED` | 这台设备（的适配器）不支持该模型 / 操作 / 能力 |
| 401 | `UNAUTHENTICATED` | 面板未登录或登录已过期 |
| 401 | `BAD_CREDENTIALS` | 面板账号或密码不正确（只出现在登录接口） |
| 403 | `CSRF` | 缺少防跨站校验，或请求是跨站的 |
| 404 | `NOT_FOUND` | 接口、设备或操作不存在 |
| 405 | `METHOD` | 请求方法不对 |
| 409 | `CONFLICT` | 冲突（例如重复的设备名、重复初始化） |
| 409 | `DISABLED` | 设备已停用 |
| 409 | `BUSY` | 设备正忙（例如已有升级任务在进行） |
| 429 | `RATE_LIMITED` | 登录尝试过于频繁（每个来源地址每分钟 10 次） |
| 502 | `OFFLINE` `TIMEOUT` `BAD_RESPONSE` `UNCERTAIN` | 设备连不上、超时、返回了看不懂的内容、写操作结果未知。**设备凭据错误也是 502**（`BAD_CREDENTIALS`）——401 只保留给"面板登录态失效"，免得把人踢出面板 |
| 503 | `LOGIN_FAILED` | 设备拒绝登录（不是密码错误） |

**大小限制。** JSON 请求体最大 64 KB；上传（配置还原、固件）最大 32 MB。

## 面板本身

| 方法与路径 | 说明 |
|---|---|
| `GET /api/status` | `{ setupRequired, authed, user }`。不需要登录，也不泄露任何设备信息。首次运行 `setupRequired` 为 `true` |
| `POST /api/setup` | 首次初始化：`{ username, password }`（密码至少 8 个字符）→ `{ ok, user }`，并直接登录。只能做一次 |
| `POST /api/login` | `{ username, password }` → `{ ok, user }` |
| `POST /api/logout` | `{ ok }` |
| `POST /api/password` | `{ oldPassword, newPassword }` → `{ ok }`。其它浏览器上的登录态立即失效，当前这个保留 |
| `GET /api/settings` | `{ settings: { pollIntervalSec, statsIntervalSec } }` |
| `POST /api/settings` | 同上结构的子集 → `{ ok, settings }`。轮询间隔 5–3600 秒，统计间隔 10–3600 秒；立即对所有没有单独设置的设备生效 |
| `GET /api/settings/metrics-token` | `{ ok, metricsToken }`。没有令牌时自动生成 |
| `POST /api/settings/metrics-token` | `{ ok, metricsToken }`。重新生成，旧令牌立即失效 |
| `GET /api/adapters` | `{ adapters: [{ id, name, vendor, maturity }] }` |
| `GET /api/about` | `{ version, node, adapters }` |

## 设备管理

设备对象（下文记作 **Device**）：

```jsonc
{
  "id": "d_3a28ecb3bd",            // 稳定, 不随改名变化
  "name": "客厅交换机",
  "url": "http://192.168.2.20",
  "adapter": "tplink-rpm", "adapterName": "TP-LINK 旧版 Web 界面", "adapterMaturity": "verified", "vendor": "TP-LINK",
  "enabled": true,
  "username": "admin", "hasSecret": true,     // 只告诉你存没存密码, 密码本身永远不返回
  "pollIntervalSec": 15, "statsIntervalSec": 30,
  "tags": ["家里"], "notes": "",
  "identified": { "model": "…", "firmware": "…", "hardware": "…", "mac": "…", "ports": 8 },  // 添加时识别到的
  "health": "online",              // online offline auth error disabled unknown
  "lastOk": 1795662121504, "lastError": null,
  "model": "…", "firmware": "…", "mac": "…",  // 设备当前报告的值; 连不上时退回 identified 里的
  "portCount": 8, "portsUp": 8, "rxKbps": 2030, "txKbps": 4220, "uptime": 965852,
  "cloud": { "enabled": true, "connected": true },
  "portStates": [{ "id": 1, "enabled": true, "speedAct": 6 }],
  "capabilities": { "reads": ["…"], "writes": ["…"], "features": ["…"] },
  "createdAt": "…", "updatedAt": "…"
}
```

| 方法与路径 | 说明 |
|---|---|
| `GET /api/devices` | `{ devices: [Device] }` |
| `GET /api/dashboard` | `{ devices: [Device + history: [{ t, rx, tx, up }]（最近 60 个采样点）], totals: { total, online, offline, auth, error, disabled, unknown, portsUp, ports, rxKbps, txKbps } }`。离线设备的端口和流量不计入合计 |
| `POST /api/probe` | `{ url }` → `{ url, adapter: { id, name, maturity } \| null, adapters: […] }`。不带凭据，只看这个地址上像是哪类设备 |
| `POST /api/devices/test` | `{ url, username, password, adapter? }` → `{ adapter, identified: { model, firmware, hardware, mac, ports, description } }`。真的登录一次，读完立刻退出；**不保存** |
| `POST /api/devices` | 添加设备：`test` 的参数 + `name`（必填、唯一）、`tags[]`、`notes`、`pollIntervalSec`（5–3600，省略用默认）、`enabled`（默认 `true`）→ Device。识别成功才保存 |
| `GET /api/devices/:id` | → Device |
| `PATCH /api/devices/:id` | 修改。可以用：`name` `url` `adapter` `username` `password`（留空 = 不改）`enabled` `pollIntervalSec`（`null` = 用默认）`tags` `notes` → Device |
| `DELETE /api/devices/:id` | → `{ ok }`。只是从面板移除，不改动交换机 |
| `POST /api/devices/:id/test` | 用已保存的账号密码重新识别（也可以在请求体里给新的 `url` / `username` / `password` / `adapter` 来试，不影响已保存的记录） |
| `POST /api/devices/:id/refresh` | 立即轮询一次 → Device |
| `GET /api/devices/:id/history` | `{ history: [{ t, rx, tx, up }] }`（最多 240 个点） |

## 访问设备

全部针对某一台已绑定的设备。设备已停用时返回 `409 DISABLED`；适配器不支持时返回 `400 UNSUPPORTED`。

| 方法与路径 | 说明 |
|---|---|
| `GET /api/devices/:id/overview` | → `{ data: 概览模型, tip, cached, ageMs, health }`。默认返回后台轮询的缓存（`cached: true`）；加 `?live=1` 时一定去设备实时读取 |
| `GET /api/devices/:id/pages?keys=ports,vlan8021q,…` | 依次读取若干模型 → `{ <模型键>: 数据, … }`。一次最多 8 个 |
| `GET /api/devices/:id/stats/:port` | 单个端口的报文明细 → `{ port, rx[20], tx[20] }`。数组下标 `1`–`9` 有效：`1`–`4` 是单播 / 组播 / 广播 / Pause 帧，`5`–`9` 是小于 64 字节、CRC 错误、Fragments、Jabbers、Collisions；下标 `0` 和 `10` 之后恒为 0（沿用原厂页面的数组布局）。需要能力 `statsDetail` |
| `GET /api/devices/:id/ping` | `{ online }`。单次探测，不重试 |
| `GET /api/devices/:id/backup` | 下载配置备份（`application/octet-stream`，`Content-Disposition: attachment`）。需要能力 `backup` |
| `POST /api/devices/:id/op` | 提交一个规范操作：`{ op, params }` → `{ ok, tip, disconnected, data?, fresh }`。`fresh` 是操作成功后回读的模型（例如 `{ ports: {…}, overview: {…} }`）；`tip` 是设备的提示文字。**危险操作**必须在 `params` 里带 `confirm: true`，`system.reset` 还要带 `confirmText: "RESET"`，否则返回 `400 BAD_PARAM` 且不会到达交换机 |
| `POST /api/devices/:id/mac-search` | `{ mac, vid }`，等价于 `op: "mac.search"` |
| `POST /api/devices/:id/restore` | `multipart/form-data`，字段名 `file`（`.cfg`）→ `{ tip, disconnected }`。`disconnected: true` 表示还原完成后设备自己重启了。需要能力 `restore` |
| `POST /api/devices/:id/firmware/check` | 让设备在线检查新版本 → 固件模型。需要能力 `firmwareCheck` |
| `POST /api/devices/:id/firmware/upgrade` | `multipart/form-data`，字段名 `file`（`.bin`）→ 升级任务。需要能力 `firmwareLocal` |
| `POST /api/devices/:id/firmware/online` | → 升级任务。需要能力 `firmwareOnline` |
| `GET /api/devices/:id/firmware/job` | 升级任务：`{ state, log[], error, kind, startedAt }`。`state`：`idle` 没有 / `running` 进行中 / `rebooting` 固件已写入、设备重启中 / `done` 设备已重新上线 / `failed` 失败 |
| `POST /api/devices/:id/firmware/job/settle` | 设备重新上线后把 `rebooting` 标记为 `done` → 升级任务 |
| `POST /api/devices/:id/firmware/job/clear` | 清掉已结束的任务 → `{ ok }` |

### 例：修改一个端口的速率

```bash
# 5 = 100M 全双工 (编码见 architecture.md)。先把端口 5 改成 100M 全双工, 流控保持不变 (7):
curl -s -b jar.txt -H 'X-Requested-With: netpanel' -H 'Content-Type: application/json' \
  -d '{"op":"port.settings","params":{"ports":[5],"state":7,"speed":5,"flow":7}}' \
  http://127.0.0.1:8208/api/devices/d_3a28ecb3bd/op
# → {"ok":true,"tip":"…","disconnected":false,"fresh":{"ports":{"maxPorts":8,"ports":[…]}}}
```

### 例：重启（危险操作要带 confirm）

```bash
curl -s -b jar.txt -H 'X-Requested-With: netpanel' -H 'Content-Type: application/json' \
  -d '{"op":"system.reboot","params":{"save":true,"confirm":true}}' \
  http://127.0.0.1:8208/api/devices/d_3a28ecb3bd/op
# → {"ok":true,"tip":"","disconnected":true}
```

设备随后会离线一到几分钟。用它是否恢复应答来判断重启完成（`GET …/ping`）。

## Prometheus 指标

`GET /metrics`，Prometheus 文本格式（`text/plain; version=0.0.4`）。**需要 Bearer 令牌**（设置页 → 指标接口 → 显示，或 `switchctl token`），没有令牌返回 `401`：

```bash
curl -s -H "Authorization: Bearer $NETPANEL_TOKEN" http://127.0.0.1:8208/metrics
```

```yaml
scrape_configs:
  - job_name: netpanel
    authorization:
      type: Bearer
      credentials: <访问令牌>
    static_configs:
      - targets: ['panel.lan:8208']
```

指标读的是后台轮询的缓存，抓取再频繁也不会增加交换机的负担。

标签：`device`（设备 id，稳定）、`name`（设备名称）、`port`（端口号）。

| 指标 | 类型 | 含义 |
|---|---|---|
| `netpanel_up` | gauge | 面板在运行（恒为 1） |
| `netpanel_build_info{version}` | gauge | 面板版本 |
| `netpanel_devices{health}` | gauge | 各健康状态的设备数 |
| `switch_up{device,name}` | gauge | 最近一次轮询是否成功。离线 / 凭据失效 / 出错为 0；还没轮询过和已停用的设备不输出 |
| `switch_info{device,name,adapter,vendor,model,firmware,hardware}` | gauge | 设备信息（恒为 1） |
| `switch_last_poll_timestamp_seconds{device,name}` | gauge | 最近一次成功轮询的时间 |
| `switch_uptime_seconds{device,name}` | gauge | 设备运行时间 |
| `switch_ports_up{device,name}` | gauge | 有链路的端口数 |
| `switch_rx_rate_bytes` / `switch_tx_rate_bytes{device,name}` | gauge | 全部端口的接收 / 发送速率合计，字节 / 秒 |
| `switch_cloud_enabled` / `switch_cloud_connected{device,name}` | gauge | 云管理是否开启 / 已连接 |
| `switch_port_enabled` / `switch_port_up{device,name,port}` | gauge | 端口是否启用 / 是否有链路 |
| `switch_port_speed_bytes{device,name,port}` | gauge | 端口链路速率，字节 / 秒（没有链路为 0） |
| `switch_port_lag{device,name,port}` | gauge | 端口所在的汇聚组编号（0 = 不在汇聚组） |
| `switch_port_rx_rate_bytes` / `switch_port_tx_rate_bytes{device,name,port}` | gauge | 端口接收 / 发送速率，字节 / 秒 |
| `switch_port_rx_packets_total` / `switch_port_tx_packets_total{…}` | counter | 累计接收 / 发送的正常包数（设备重启后清零） |
| `switch_port_rx_errors_total` / `switch_port_tx_errors_total{…}` | counter | 累计接收 / 发送的错误包数 |
| `switch_port_stats_age_seconds{…}` | gauge | 端口统计数据距现在多少秒 |

离线设备只输出 `switch_up 0` 和静态信息——它的端口状态是最后一次成功轮询时的旧数据，不当作当前值导出。

常用的查询：

```promql
# 各设备接收 + 发送总速率
switch_rx_rate_bytes + switch_tx_rate_bytes
# 端口是否有链路 (按设备名称与端口)
switch_port_up{name="客厅交换机", port="1"}
# 端口错误包的增长速率
rate(switch_port_rx_errors_total[5m]) > 0
# 30 分钟内掉过线的设备
min_over_time(switch_up[30m]) == 0
```
