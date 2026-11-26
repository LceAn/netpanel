# 命令行：`switchctl`

`switchctl` 与 Web 面板共用同一套核心（数据目录、设备表、适配器、参数校验、危险操作确认），所以命令行能做的事和界面一致。

```bash
cd app
node bin/switchctl.mjs help          # 完整用法
```

想直接敲 `switchctl`：在 `app/` 目录里执行 `npm link`（把 `bin/switchctl.mjs` 链接到 PATH），或者加个别名：`alias switchctl="node /path/to/app/bin/switchctl.mjs"`。下文都写作 `switchctl`。

## 两种指定设备的方式

| | 写法 | 说明 |
|---|---|---|
| **面板里已绑定的设备** | `switchctl --device 客厅交换机 ports` | 读写面板数据目录里的设备表（需要面板已经初始化过）。只绑定了一台设备时可以省略 `--device`；也可以把设备名直接当第一个参数：`switchctl status 客厅交换机` |
| **临时指定一台交换机** | `switchctl --url http://192.168.1.1 --user admin ports` | 不经过面板，不读写任何文件。适合脚本里用、或者还没决定要不要绑定的时候 |

`--device` 后面可以写设备名（不区分大小写）或设备 id（`d_xxxxxxxxxx`，改名也不会变，适合脚本）。

## 密码从哪里来

按顺序：`--password` → 环境变量 `NETPANEL_PASSWORD` → 终端里隐藏输入 → （非交互运行时）标准输入的一行。

**脚本里建议用环境变量**，不要把密码写在命令行参数里（会留在 shell 历史和进程列表里）：

```bash
read -rs NETPANEL_PASSWORD && export NETPANEL_PASSWORD
switchctl --device 客厅交换机 port set --ports 5,6 --speed 100f
```

## 全局选项

| 选项 | 说明 |
|---|---|
| `--device <名称\|id>` | 要操作的那台（已绑定的）设备 |
| `--url <地址>` / `--user <账号>` / `--password <密码>` / `--adapter <id>` | 临时指定一台交换机。`--adapter` 省略时自动识别 |
| `--data-dir <目录>` | 面板的数据目录。默认取环境变量 `PANEL_DATA_DIR`，再没有就是 `app/data` |
| `--json` | 以 JSON 输出结果；出错时输出 `{"ok": false, "error": {"message", "code", "details"?}}` |
| `--yes` | 跳过危险操作的确认（脚本里必须加） |
| `--confirm-text RESET` | 恢复出厂设置需要手工输入的确认文字 |
| `--quiet` | 不输出过程信息（和 `--json` 不能同时用） |

退出码：`0` 成功，`1` 失败，`2` 用法错误。

## 命令

### 面板

| 命令 | 说明 |
|---|---|
| `serve` | 启动 Web 面板（与 `node server.mjs` 相同） |
| `setup [--user 账号]` | 创建面板管理员账号（首次运行，只需一次）。默认账号 `admin`，密码至少 8 个字符 |
| `user passwd` | 修改面板密码。需要 `--old-password`（或环境变量）。**忘记密码时在面板所在机器上用它重置** |
| `token [--rotate]` | 查看指标访问令牌（没有就生成）；`--rotate` 重新生成，旧令牌立即失效 |
| `adapters` | 已注册的适配器 |

### 设备管理

| 命令 | 说明 |
|---|---|
| `devices list` | 列出已绑定的设备 |
| `devices add <名称> <地址> --user <账号> [--tags 家里,机房] [--interval 15] [--notes …] [--adapter <id>]` | 绑定一台交换机。会先登录识别，识别成功才保存 |
| `devices remove <设备>` | 解除绑定（不会改动交换机） |
| `devices enable\|disable <设备>` | 启用 / 停用后台轮询 |
| `devices test <设备>` | 用保存的账号密码重新连接并识别 |
| `devices set <设备> [--name] [--url] [--user] [--password] [--tags] [--notes] [--interval <秒>\|default]` | 修改绑定信息 |

**面板在运行时也可以用这些命令**：面板每次读写数据文件之前都会核对文件有没有变过，所以命令行添加的设备会立刻出现在面板里并开始轮询，停用 / 启用 / 删除同理。

### 读取设备

| 命令 | 输出 |
|---|---|
| `status` | 设备信息和各端口状态（链路、收发速率、VLAN、汇聚组） |
| `ports` | 端口配置（状态、速率 / 双工、实际链路、流控、汇聚组） |
| `stats [--port N]` | 全部端口的收发包计数；指定 `--port` 时是该端口的报文明细 |
| `vlans` | 802.1Q VLAN 表与 PVID 表 |
| `lag` | 链路聚合 |
| `qos` | QoS 模式与端口优先级、带宽控制、风暴抑制 |
| `get <模型键>` | 读任意一个规范模型，以 JSON 输出。可用的键：`overview ports stats system ip fixIp user cloud lag isolation mirror loop cable vlanMtu vlanPort vlan8021q vlanPvid qosBasic qosBandwidth qosStorm firmware` |
| `ops` | 这台设备支持哪些写操作 |

### 修改设备

| 命令 | 说明 |
|---|---|
| `port set --ports 1,2-4 [--state enable\|disable] [--speed auto\|10h\|10f\|100h\|100f\|1000f\|2.5g] [--flow on\|off]` | 批量设置端口。没给的那一项保持不变 |
| `port enable\|disable --ports 1,2` | 启用 / 禁用端口 |
| `mac <MAC> [--vlan N]` | 搜索 MAC 地址是从哪个端口学到的 |
| `cable [--ports 1,2]` | 线缆检测。省略 `--ports` 则检测全部可检测的端口 |
| `save` | 保存配置到 FLASH |
| `backup [--out <文件>]` | 下载配置备份。省略 `--out` 时用 `<型号>_<时间戳>.cfg` |
| `restore <文件>` | 用备份文件还原配置。设备会重启 |
| `reboot [--no-save]` | 重启交换机 |
| `firmware check` | 在线检查新固件版本 |
| `op <操作> [键=值 …]` | 提交任意一个规范操作（见 [architecture.md](architecture.md) 的操作表）。值按数字 / `true` / `false` / 字符串解析，带逗号的写成列表：`untagged=5,6` |

端口列表支持逗号和区间：`1,3-5,8`。

## 危险操作的确认

重启、恢复出厂设置、还原配置、解除绑定、禁用端口这些操作在终端里会先问一句。**非交互运行（脚本、计划任务）时必须加 `--yes`**，否则命令直接失败、什么都不会发到交换机：

```
$ switchctl --device 客厅交换机 reboot
错误: 这是危险操作, 无人值守运行时请加 --yes 表示已确认 (即将在「客厅交换机」上执行「重启交换机」。)
```

恢复出厂设置还要多一道：`--confirm-text RESET`。

所有操作都先过参数校验，不合法的参数不会发到交换机：

```
$ switchctl --device 客厅交换机 op lag.set group=2 ports=7
错误: 请选择成员端口
  - 请选择成员端口
```

## 例子

添加设备并查看状态：

```
$ export NETPANEL_PASSWORD='…'
$ switchctl devices add 客厅交换机 http://192.168.2.20 --user admin --tags 家里,客厅
已绑定 客厅交换机 (d_3a28ecb3bd): TL-SG2008D, 8 个端口, 固件 1.8.1 Build 20260401 Rel.61276

$ switchctl devices list
名称          id            地址             型号        状态  端口  标签
------------  ------------  ---------------  ----------  ----  ----  --------
客厅交换机    d_3a28ecb3bd  192.168.2.20     TL-SG2008D  在线  8/8   家里,客厅
```

`status`：

```
$ switchctl --device 客厅交换机 status
设备      客厅交换机  http://192.168.2.20
型号      TL-SG2008D
描述      TL-SG2008D
固件      1.8.1 Build 20260401 Rel.61276
硬件版本  3.0
MAC       …
管理地址  192.168.2.20 (DHCP)
运行时间  11 天 4 小时 34 分 13 秒
云管理    已启用, 已连接

端口  状态          接收      发送       VLAN  LAG
----  ------------  --------  ---------  ----  -----
1     1000M 全双工  152 Kbps  762 Kbps   1     —
2     1000M 全双工  320 Kbps  312 Kbps   1     —
3     断开          0 Kbps    0 Kbps     1     —
…
```

不经过面板，直接看一台交换机（自动识别适配器），并用 `--json` 接给 `jq`：

```
$ switchctl --url http://192.168.2.21 --user admin --password "$SW_PASS" --json status \
    | jq '.overview.ports[] | select(.speedAct == 0) | .id'
```

修改端口并保存：

```
$ switchctl --device 客厅交换机 port set --ports 5,6 --speed 100f
设置成功
$ switchctl --device 客厅交换机 save
设置成功
```

每天凌晨备份所有设备的配置：

```bash
#!/usr/bin/env bash
set -euo pipefail
export NETPANEL_PASSWORD='…'
for id in $(switchctl --json devices list | jq -r '.devices[].id'); do
  switchctl --device "$id" backup --out "/backup/$id-$(date +%F).cfg"
done
```

查看（没有就生成）给 Prometheus 抓指标用的令牌：

```
$ switchctl token
tjwPP_GCE_H2U1tfHMY3ybEe2oU13nrX
```
