# 适配器：支持哪些设备，怎么接入新设备

适配器把"一种设备协议"封装起来。**新增一种设备的支持 = 新增一个适配器目录 + 注册一行**，界面、HTTP 接口、指标导出、命令行会自动获得它支持的能力，不支持的页面自动隐藏。

## 现有适配器

| id | 设备 | 成熟度 | 能读 | 能写 |
|---|---|---|---|---|
| `tplink-rpm` | TP-LINK 旧版 Web 界面（页面是 `*Rpm.htm` 的那一代）。**已实测：TL-SG2008D，硬件 3.0，固件 1.8.1**。使用同一套页面的其它型号理论上可用，未逐一验证 | `verified` | 全部 21 个读模型 | 全部 33 个规范操作；端口明细、配置备份 / 还原、本地 / 在线固件升级、重启、恢复出厂 |
| `tplink-json` | TP-LINK JetStream 新版 Web 界面（单页应用 + `/data/*.json` 接口）。依据公开的逆向资料实现，对应 T1600G / T2600G 的 3.x 固件 | `experimental` | 概览、端口配置、端口计数、系统信息、802.1Q VLAN、PVID | **无（只读）** |

成熟度的含义：

- **`verified`（已实测）**：读取在真机上逐项核对过。写入的表单是照原厂页面的 JS 抄的，只在模拟交换机上验证过——见 [protocol.md](protocol.md) 开头的说明。
- **`experimental`（实验性）**：按公开资料实现，**没有在真机上验证过**。界面上会给这类设备显示醒目的横幅。

"已实测"只针对上面写明的型号和固件版本。换一个固件版本，原厂可能改掉页面里的变量名或表单字段，读出来的数据就不对了——如果遇到，请提 Issue。

## 适配器的约定

```js
// src/adapters/<id>/index.mjs
import { defineAdapter } from '../../core/adapter.mjs';

export const myAdapter = defineAdapter({
  id: 'my-switch',              // 小写字母、数字、连字符
  vendor: '厂商',
  name: '给人看的名字',
  maturity: 'verified',         // 'verified' | 'experimental'
  reads: ['overview', 'ports'], // 能产出哪些规范模型 (core/models.mjs 的键)
  writes: ['port.settings'],    // 能执行哪些规范操作 (core/ops.mjs 的键)
  features: ['reboot'],         // 额外能力: statsDetail backup restore firmwareLocal firmwareOnline firmwareCheck reboot reset

  /** 不带凭据, 只看地址上是不是这类设备。连不上、认不出一律返回 false, 不要抛错。 */
  async probe({ url }) { … },

  /** 建立一条到设备的连接。 */
  create({ url, credentials, options }) {
    return {
      read(key)               // → Promise<{ data: 规范模型, tip?: string }>
      readStats(port)         // (feature 'statsDetail') → Promise<{ port, rx[20], tx[20] }>  数组下标 1–9 有效, 布局见 api.md
      submit(op, params, ctx) // → Promise<{ tip, disconnected, vars?, data? }>
      ping()                  // → Promise<boolean>  单次探测, 不重试
      identify()              // → Promise<{ model, firmware, hardware?, mac?, ports, description? }>
      logout()                // 释放设备上的会话
      backup()                // (feature 'backup')  → Promise<{ body: Buffer, filename }>
      restore(file)           // (feature 'restore') → Promise<{ tip, disconnected }>
      firmware: {             // (features 'firmware*')
        check()               // → 规范模型 firmware
        conflict()            // → boolean  设备上是否已有升级在进行
        upgradeLocal(file)    // 上传并写入固件
        upgradeOnline()       // 让设备自己从厂商服务器升级
        status()              // → 'running' | 'failed' | 'done'; 设备断开时抛错
      }
    };
  },
});
```

几条硬性要求：

- `identify()` 必须真的确认这是一台受支持的设备，并读出型号和固件版本。只看登录页像是不够的——同厂商的路由器、AP 的登录页可能一模一样。
- `submit()` 收到的 `params` 已经通过规范操作表的校验；适配器只负责换算成设备的编码。
- 连接上的请求要串行化（嵌入式设备的 Web 服务一次只经得起一个请求）。
- 设备凭据错误要抛 `code: 'BAD_CREDENTIALS'`，连不上抛 `'OFFLINE'`，超时抛 `'TIMEOUT'`，设备返回看不懂的内容抛 `'BAD_RESPONSE'`，写了但不知道结果抛 `'UNCERTAIN'`（见 `core/errors.mjs`）。设备管理器据此判断健康状态。
- `read()` / `submit()` 等方法里不要把密码写进日志或错误信息。

### 能力与界面的关系

每个功能页声明它需要的能力。设备不满足的页面不出现在导航里，直接访问会提示不支持：

| 页面 | 需要 |
|---|---|
| 概览 | 读 `overview` |
| 系统信息 / IP 设置 / 云管理 | 读 `system` / `ip` / `cloud` |
| 设备账户 | 读 `user`，且支持 `user.account` |
| 系统工具 | `config.save` `system.reboot` `system.reset` 之一，或 `backup` / `restore` |
| 固件升级 | 读 `firmware`（升级按钮还要对应的 `firmware*` 能力） |
| 端口配置 | 读 `ports`（可写设备还要求支持 `port.settings`） |
| 端口统计 | 读 `stats`（单口明细另需 `statsDetail`） |
| 链路聚合 / 端口隔离 / 端口镜像 / 环回保护 | 读 `lag` / `isolation` / `mirror` / `loop` |
| MAC 搜索 / 线缆检测 | `mac.search` / 读 `cable` 且支持 `cable.run` |
| 802.1Q VLAN / 端口 VLAN / MTU VLAN / PVID | 读 `vlan8021q` / `vlanPort` / `vlanMtu` / `vlanPvid` |
| QoS 三个页面 | 读 `qosBasic` / `qosBandwidth` / `qosStorm` |

**只读适配器**（`writes` 为空）的设备：能读到数据的页面都可以看，页面里的表单控件会被禁用；纯操作页（系统工具、MAC 搜索）不显示。

## 新增一个适配器

1. **弄清协议。** 能读到哪些数据、怎么登录、令牌怎么带。先只做读取。
2. **新建目录** `src/adapters/<id>/`，建议拆成三个文件：
   - `client.mjs`：传输层。登录、会话、串行队列、超时与错误翻译。
   - `pages.mjs`：把设备的原始数据整理成规范模型（纯函数，方便单独测试）。
   - `ops.mjs`：（有写操作时）把规范操作编码成设备的请求。
   - `index.mjs`：组装成适配器对象。
3. **写一个模拟设备**（或者扩展 `scripts/mock-switch.mjs`），让测试和演示不依赖真机。
4. **注册**：在 `src/adapters/index.mjs` 里加一行。
5. **测试**：至少覆盖——识别成功与失败、每个读模型的结构、凭据错误、会话失效后重新登录、以及（如果有写操作）每个操作的请求编码。参考 `test/json-adapter.test.mjs`。
6. 在 `docs/adapters.md`（本文）的表格里加上你的适配器，并在 README 的支持列表里加一行。

规范模型里没有你需要的字段时（例如 PoE、光模块信息）：先在 issue 里讨论，再往 `core/models.mjs` 加一个新的模型键，并给对应的页面加上"需要这个模型"的声明。

### 自动识别是怎么工作的

用户添加设备时选"自动识别"，面板会依次调用每个适配器的 `probe({ url })`，第一个返回 `true` 的胜出。所以 `probe` 要只认自己这一类设备：

- `tplink-rpm`：`GET /` 的响应里有 `var logonInfo = new Array(`（旧版的登录页）。
- `tplink-json`：向 `/data/version.json` 发一个没有会话的 `POST`，响应是 JSON 信封 `{"success": false, …}`；旧版固件回答的是 HTML。

两个都不认得时，用户可以在"适配器"下拉框里手动指定。

## 关于实验性的 `tplink-json` 适配器

它依据两个开源项目公开的逆向资料（针对 T1600G / T2600G 的固件 3.0.3）。接口和字段名是确定的，但下面这些**取值编码是推测的**，所以这个适配器不提供任何写操作——读错了只是显示不对，写错却可能改坏交换机：

| 字段 | 推测的含义 |
|---|---|
| 端口 `state` | `1` 启用，`0` 禁用 |
| 配置速率 `speedCfg` | `0` 自动、`2` 10M、`3` 100M、`4` 1000M |
| 实际速率 `speedLink` | `1` 10M、`2` 100M、`3` 1000M（是否 `0` 表示断开、`1` 另有含义未能确认） |
| 双工 `duplexCfg` / `duplexLink` | `1` 全双工、`2` 半双工 |
| 运行时间 `run_time` | 接受 `4d3h12m30s` 或 `4:3:12:30` 两种写法 |
| VLAN 成员列表 | `1/0/1`、`1/0/1,1/0/4`，以及推测支持的区间 `1/0/1-1/0/4` |

已实现的读取接口：`login`、`logout`、`systemSummaryConfig`、`port`、`trafficMonitorCfgDetailModel`（每个端口一次，速率由前后两次的字节计数差算出）、`vlanCfg`、`vlanPortCfg`、`version`。公开资料里还有写入接口（`swtPortCfg`、`vlanCfg` 的增改删、`vlanPortCfg` 改 PVID、`poeCfgGrid`、`configsaveFile`），因为同样的原因没有实现。

### 你可以帮忙验证

如果你手上有使用新版 Web 界面的 JetStream 交换机（T1600G / T2600G 系列等，固件 3.x）：

1. 在面板里添加它（会自动识别成 `TP-LINK JetStream 新版 Web 界面`），或者用命令行：`switchctl --url http://交换机地址 --user 账号 status`。
2. 对照交换机自己的管理页面，看下面这些对不对：型号、固件版本、MAC、运行时间、每个端口的状态和速率、VLAN 表、PVID、端口计数。
3. 不管对不对，都欢迎提 Issue 告诉我们：型号、固件版本、哪一项不符、以及 `switchctl --url … --json get overview` 的输出（**输出里没有密码**）。
4. 想让写入也得到支持，需要你在浏览器开发者工具里抓一次原厂界面提交某个表单时的请求（方法、地址、请求体）和响应，附在 Issue 里。
