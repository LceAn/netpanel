# 架构

本文说明 NetPanel 的内部结构：代码怎么分层、数据怎么流动、扩展点在哪里。
想接入一种新设备请直接看 [adapters.md](adapters.md)；接口与命令行的用法见 [api.md](api.md) 和 [cli.md](cli.md)。

## 一句话概括

**每一种设备协议被封成一个"适配器"，适配器把设备数据整理成与设备无关的"规范模型"；界面、HTTP 接口、指标导出、命令行只认规范模型，不接触任何设备原始数据。**

```
浏览器 ─┐
命令行 ─┼─► 设备管理器 (DeviceManager) ──► 适配器 ──► 交换机的 Web 管理接口
指标   ─┘     每台设备一个常驻连接 +         │
              后台轮询 + 缓存 + 健康状态     └─ 把设备原始数据整理成规范模型 / 把规范操作编码成设备的表单
```

## 目录结构

```
app/
├─ server.mjs                 启动入口 (只负责调用 src/http/server.mjs 的 main)
├─ bin/switchctl.mjs          命令行入口 (实现在 src/cli/)
├─ src/
│  ├─ core/                   与具体设备无关的部分
│  │  ├─ models.mjs           规范模型: 有哪些"读模型", 以及整理数据用到的纯函数
│  │  ├─ ops.mjs              规范操作: 33 个写操作的名称、参数校验、是否危险
│  │  ├─ adapter.mjs          适配器的约定 (接口定义 + 注册表 + 自动识别)
│  │  ├─ device-service.mjs   面向"一条设备连接"的流程: 读页面、提交操作、备份还原、固件任务
│  │  ├─ manager.mjs          设备管理器: 连接、后台轮询、缓存、健康状态、流量历史
│  │  ├─ metrics.mjs          Prometheus 文本格式
│  │  ├─ config.mjs           监听地址 / 端口 / 数据目录
│  │  ├─ errors.mjs           统一的错误类型与错误码 → HTTP 状态码
│  │  ├─ jslite.mjs           解析设备页面里 `var a = {...}` 字面量的解析器 (不求值任何代码)
│  │  └─ store/               数据目录里的文件: 设备表、保险箱、面板账号、设置
│  ├─ adapters/               每种设备协议一个目录
│  │  ├─ index.mjs            注册全部适配器
│  │  ├─ tplink-rpm/          TP-LINK 旧版 Web 界面 (已实测)
│  │  └─ tplink-json/         TP-LINK JetStream 新版 Web 界面 (实验性, 只读)
│  ├─ http/                   HTTP 服务: 路由、面板登录态、请求解析、静态文件
│  └─ cli/                    switchctl 的实现
├─ web/                       前端 (原生 ES 模块, 无框架、无构建步骤、无 npm 依赖)
├─ scripts/                   模拟交换机 (开发 / 演示 / 测试用)
├─ test/                      测试与合成夹具
└─ testkit/                   测试辅助 (假适配器)
```

## 三层约定

### 1. 规范模型 (`core/models.mjs`)

适配器 `read(key)` 返回的数据结构。每个键对应一种固定结构：

| 键 | 内容 | 主要字段 |
|---|---|---|
| `overview` | 概览：设备信息 + 各端口实时状态 | `maxPorts` `support2_5G` `flags` `device{model, description, mac, ip, netmask, gateway, dns, dhcp, dnsAuto, firmware, uptime, uptimeText}` `cloud{enabled, connected}` `ports[]` |
| `ports` | 端口配置 | `maxPorts` `ports[{id, enabled, speedCfg, speedAct, flowCfg, flowAct, lag}]` |
| `stats` | 端口计数 | `maxPorts` `ports[{id, enabled, link, txGood, txBad, rxGood, rxBad}]` |
| `system` | 系统信息 | `description` `mac` `ip` `netmask` `gateway` `firmware` `model` `hardware` `cloudManaged` `supportsCloud` |
| `ip` | 管理 IP 与 DNS | `dhcp` `ip` `netmask` `gateway` `dnsAuto` `dns` `manageVlan` `vlanEditable` |
| `fixIp` | 应急固定 IP | `enabled` `ip` |
| `user` | 设备管理账户 | `username` `limits{userMin, userMax, pwdMin, pwdMax}` |
| `cloud` | 云管理 | `enabled` `type` (`cloud` \| `nms`) `nms{server, port}` `boundId` |
| `lag` | 链路聚合 | `maxLag` `portCount` `portsPerLag` `ranges` `groups[{id, members}]` |
| `isolation` | 端口隔离 | `portCount` `lags[]` `rules[{port, lag, forward}]`（`forward` 是"能转发到哪些端口"的文本） |
| `mirror` | 端口镜像 | `maxPorts` `enabled` `mirroringPort` `ports[{id, ingress, egress, lag}]` |
| `loop` | 环回保护 | `enabled` |
| `cable` | 线缆检测 | `maxPorts` `results[{id, state, length, enabled}]` |
| `vlanMtu` | MTU VLAN | `enabled` `portCount` `uplinkPort` |
| `vlanPort` | 端口 VLAN | `enabled` `portCount` `maxVid` `vlans[{id, members}]` |
| `vlan8021q` | 802.1Q VLAN | `enabled` `portCount` `maxVlans` `vlans[{id, name, tagged, untagged}]` |
| `vlanPvid` | PVID | `enabled` `portCount` `vlans[{id, mask}]` `ports[{id, pvid, lag}]` |
| `qosBasic` | QoS 模式与优先级 | `mode` `portCount` `ports[{id, priority, lag}]` |
| `qosBandwidth` | 带宽控制 (Kbps) | `portCount` `ports[{id, ingress, egress, lag, enabled}]` |
| `qosStorm` | 风暴抑制 | `portCount` `ports[{id, rate, enabled, types, lag}]`（`types` ⊂ `1 未知单播 / 2 组播 / 4 广播`） |
| `firmware` | 固件 | `firmware` `hardware` `onlineUpgrade` `hasNew` `newFirmware` `releaseLog` |
| `macSearch` | MAC 搜索结果 (只在写操作的返回里出现) | `qvlan` `results[{mac, vid, port}]` |

`overview.ports[]` 的每一项：`id` `enabled` `speedCfg` `speedAct` `flowCfg` `flowAct` `lag` `vlans` `loop` `rxKbps` `txKbps`。

**端口速率 / 双工的编码**是规范的一部分（沿用第一代适配器）：`0` 关闭、`1` 自动、`2` 10M 半双工、`3` 10M 全双工、`4` 100M 半双工、`5` 100M 全双工、`6` 1000M 全双工、`7` 2.5G 全双工。其它适配器负责把设备的编码换算成这一套。

### 2. 规范操作 (`core/ops.mjs`)

写操作不是"转发任意表单"，而是一张白名单。每个操作定义：名称、参数校验、提交前要读哪个模型作为校验上下文（例如端口数量、已有的 VLAN）、成功后回读哪些模型、是否必须明确确认、设备处理时会不会断开连接。

| 操作 | 说明 | 参数 | 危险 |
|---|---|---|---|
| `port.quick` | 设置单个端口的状态 / 速率 | `port` `speed` | |
| `port.settings` | 批量配置端口 | `ports[]` `state` `speed` `flow` | |
| `port.stats.clear` | 清空端口统计 | — | |
| `system.description` | 修改设备描述 | `description` | |
| `system.reboot` | 重启交换机 | `save` | ✔ 会断开连接 |
| `system.reset` | 恢复出厂设置 | — | ✔ 需输入 `RESET`，会断开连接 |
| `config.save` | 保存配置到 FLASH | — | |
| `ip.setting` | 修改管理 IP 与 DNS | `manageVlan` `dhcp` `dnsAuto` `ip` `netmask` `gateway` `dns` | ✔ |
| `ip.fix` | 启用 / 关闭应急固定 IP | `enabled` | |
| `user.account` | 修改设备管理账户 | `username` `oldPassword` `newPassword` `confirmPassword` | ✔ |
| `cloud.setting` | 开启 / 关闭云管理 | `enabled` `type` | ✔ |
| `cloud.nms` | 设置本地 NMS 服务器 | `server` `port` | |
| `lag.set` | 配置链路聚合 | `group` `ports[]` | |
| `lag.delete` | 删除链路聚合 | `groups[]` | |
| `isolation.set` | 配置端口隔离 | `ports[]` `from[]` | |
| `mirror.enable` | 开启 / 关闭端口镜像 | `enabled` `port` | |
| `mirror.ports` | 设置被监控端口 | `ports[]` `ingress` `egress` | |
| `loop.set` | 开启 / 关闭环回保护 | `enabled` | |
| `mac.search` | 搜索 MAC 地址 | `mac` `vid` | |
| `cable.run` | 线缆检测 | `ports[]` | |
| `vlan.mtu.enable` | 启用 / 禁用 MTU VLAN | `enabled` | ✔ |
| `vlan.mtu.uplink` | 设置 MTU VLAN 上联口 | `port` | |
| `vlan.port.enable` | 启用 / 禁用端口 VLAN | `enabled` | ✔ |
| `vlan.port.set` | 设置端口 VLAN 组 | `vid` `ports[]` | |
| `vlan.port.delete` | 删除端口 VLAN 组 | `vids[]` | |
| `vlan.q.enable` | 启用 / 禁用 802.1Q VLAN | `enabled` | ✔ |
| `vlan.q.set` | 添加 / 编辑 802.1Q VLAN | `vid` `name` `tagged[]` `untagged[]` | |
| `vlan.q.delete` | 删除 802.1Q VLAN | `vids[]` | |
| `vlan.pvid.set` | 设置端口 PVID | `pvid` `ports[]` | |
| `qos.mode` | 设置 QoS 模式 | `mode` | |
| `qos.priority` | 设置端口优先级 | `ports[]` `queue` | |
| `qos.bandwidth` | 设置端口限速 | `ports[]` `ingress` `egress` | |
| `qos.storm` | 设置风暴抑制 | `ports[]` `enabled` `rate` `types[]` | |

"危险"的操作必须带 `params.confirm === true`，否则校验不通过、请求不会到达交换机；`system.reset` 还必须带 `confirmText: 'RESET'`。参数不合法的请求同样在校验这一步被拦下。每一次提交的流程都是：能力检查 → 读校验上下文 → 校验参数 → 交给适配器编码发送 → 回读受影响的模型。

### 3. 适配器 (`core/adapter.mjs`)

每种设备协议实现同一个约定，详见 [adapters.md](adapters.md)：

```js
{
  id: 'tplink-rpm', vendor: 'TP-LINK', name: '…', maturity: 'verified' | 'experimental',
  reads: [...],        // 能产出哪些规范模型
  writes: [...],       // 能执行哪些规范操作
  features: [...],     // 额外能力: statsDetail backup restore firmwareLocal firmwareOnline firmwareCheck reboot reset
  probe({ url }),      // 不带凭据, 判断这个地址上是不是这类设备
  create({ url, credentials, options }) → connection
}
```

## 设备管理器 (`core/manager.mjs`)

HTTP 接口、指标导出、命令行都通过它访问设备，它负责：

- **连接**：每台设备一个常驻连接；设备密码从保险箱解密后只在内存里使用。连接参数（地址、账号、密码、适配器）被修改后自动换一条新连接——包括面板运行期间用命令行改的。
- **后台轮询**：默认每 15 秒读一次概览、每 30 秒读一次端口计数（可在设置里改，每台设备也可以单独设）。界面和指标读的是缓存，所以开多少个浏览器标签页都不会增加交换机的负担。同时访问的设备数上限为 3。
- **健康状态**：`online` 在线、`offline` 离线、`auth` 凭据失效、`error` 出错、`disabled` 已停用、`unknown` 还没轮询过。之前在线的设备偶发一次连不上不算离线（连续失败，或超过三个轮询周期没成功才算）。**单台设备出任何问题都只影响它自己的状态，不影响面板登录态和其它设备。**
- **流量历史**：每台设备保留最近 240 个采样点（最快 2 秒一个），供总览页画趋势。
- **与命令行共存**：设备表、设置、面板账号的文件可能在面板运行期间被 `switchctl` 修改。各个存储在每次读写之前核对文件有没有变过；管理器据此自动开始轮询新添加的设备、恢复被重新启用的设备，并给被删除或停用的设备收尾。

## 数据目录

默认在 `app/data/`（可用 `PANEL_DATA_DIR` 或 `config.json` 的 `dataDir` 改）。**这个目录里有机密，不要提交到版本库、不要放进备份的公开位置。**

| 文件 | 内容 |
|---|---|
| `devices.json` | 设备表。密码字段是 AES-256-GCM 密文（`v1:iv:tag:密文`），以设备 id 作为附加认证数据 |
| `secret.key` | 上面用的 32 字节密钥。**丢了它，已保存的设备密码就解不回来**（重新输入即可） |
| `auth.json` | 面板管理员账号。只存 scrypt 哈希 |
| `settings.json` | 轮询间隔、指标访问令牌 |
| `*.tmp` | 写文件时先写临时文件再覆盖正式文件；正式文件写坏时用它恢复 |

## 配置

环境变量优先，其次 `app/config.json`，都没有就用默认值：

| 环境变量 | `config.json` | 默认 | 说明 |
|---|---|---|---|
| `PANEL_HOST` | `host` | `127.0.0.1` | 监听地址。`0.0.0.0` 表示局域网可访问 |
| `PANEL_PORT` | `port` | `8208` | 端口 |
| `PANEL_DATA_DIR` | `dataDir` | `app/data` | 数据目录（相对路径以 `app/` 为基准） |
| `PANEL_CONFIG` | — | `app/config.json` | 配置文件路径 |

交换机不在配置里：它们在界面或命令行里添加，保存在数据目录中。

## 前端 (`web/`)

- 原生 ES 模块，没有框架、构建步骤和 npm 依赖；不拼接 HTML 字符串，交换机返回的任何文本都经文本节点进入页面。
- 地址即路由（hash）：`#/` 全部设备、`#/devices` 设备管理、`#/devices/new` 与 `#/devices/<id>/edit` 添加 / 修改设备、`#/settings` 面板设置、`#/d/<设备id>/<页面>` 某台设备的功能页（页面 id 里的 `.` 对应地址里的 `/`，例如 `ports/stats`）。
- 每个功能页声明它需要适配器具备的能力（要读哪些模型、至少支持哪些操作）。**设备不满足的页面不出现在导航里**；只读适配器的设备可以查看能读到数据的页面，表单控件会被禁用。
- 页面只通过 `ctx.api.device(id)` 访问后端，通过 `ctx.can(op)` / `ctx.has(feature)` 判断设备能做什么。

## 测试

`cd app && node --test`，不需要安装任何东西。测试分四层：

- **单元测试**：解析器、模型、操作校验与编码、存储与加密、指标格式、配置。设备页面用 `test/fixtures/rpm/` 里的合成数据（身份信息全部是虚构的）。
- **进程内集成**：`testkit/fake-adapter.mjs` 是一个内存里的假适配器，用来测设备管理器和 HTTP 接口的各种状态（离线、凭据失效、并发修改等）。
- **端到端**：`scripts/mock-switch.mjs` 与 `scripts/mock-json-switch.mjs` 是两代固件的模拟交换机。测试里用真实的适配器 + 模拟交换机 + 真实监听的面板，把初始化、登录、绑定设备、后台轮询、读写、指标接口、命令行完整走一遍。
- **契约**：`test/mock.test.mjs` 把适配器的每一个写操作逐个打到模拟交换机上。模拟交换机只接受原厂表单的那种提交方式（提交方式不对就断开连接，和真机一样），所以哪个操作的编码退回到了错误的方式，这里会立刻失败。
