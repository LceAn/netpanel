# 参与贡献

NetPanel 是一个零依赖的 Node.js 项目：不需要安装任何 npm 包就能开发、测试、运行。

## 开发环境

需要 Node.js 20 或更高版本。

```bash
git clone https://github.com/LceAn/netpanel.git
cd netpanel/app
node --test                 # 跑全部测试 (约 15 秒)
```

不需要真机。仓库里有两个模拟交换机：

```bash
node scripts/mock-switch.mjs 8269                 # 旧版 Web 界面的模拟交换机 (MOCK_PROFILE=lab 预置一份有内容的配置)
node scripts/mock-json-switch.mjs 8280            # 新版 (JSON 接口) 的模拟交换机
PANEL_PORT=8210 node server.mjs              # 在 8210 端口起一个开发用的面板 (数据在 app/data/ 里)
```

打开 `http://127.0.0.1:8210` 创建账号，然后添加 `http://127.0.0.1:8269`（账号 `admin` / `admin`）。两个模拟器都记录收到的每个写请求，可以核对面板发给交换机的内容。

## 项目结构

代码在 `app/` 下，分三层：`src/adapters/`（设备协议）、`src/core/`（与设备无关的模型、操作、管理器、存储）、`src/http/` 与 `src/cli/`（两种入口）；前端在 `web/`。完整的说明见 [docs/architecture.md](docs/architecture.md)。

| 我想…… | 看 |
|---|---|
| 搞清楚交换机的接口是怎么逆向出来的 | [docs/protocol.md](docs/protocol.md) 和 `tools/` |
| 接入一种新的交换机 | [docs/adapters.md](docs/adapters.md) |
| 改 HTTP 接口或指标 | [docs/api.md](docs/api.md) |
| 改命令行 | [docs/cli.md](docs/cli.md) |
| 安全相关的设计 | [docs/security.md](docs/security.md) |

## 提 Issue

**设备读出来的数据不对 / 某个操作不生效**时，请附上：

- 交换机的型号和固件版本（在面板的"系统信息"页，或交换机自己的页面里）
- 哪一项不对：面板显示的是什么，交换机自己的管理页面显示的是什么
- `node bin/switchctl.mjs --device <设备> --json get overview` 的输出（里面没有密码）
- 如果是写操作：是哪一个操作、参数是什么、面板的提示是什么。**请先把输出里的账号、MAC、IP 换成示例值**

**面板本身的问题**：复现步骤、浏览器控制台和网络面板里的报错、面板的版本（设置页底部）和运行方式。

## 提 Pull Request

- 新功能先开 Issue 讨论，尤其是要往规范模型里加字段、或者要改接口返回结构的。
- 修 bug 请带上能复现它的测试。测试分层见 [docs/architecture.md](docs/architecture.md#测试)：优先用进程内的模拟交换机，不要让测试依赖真机或网络。
- 不要在代码、测试数据、截图里出现真实的账号、密码、MAC 或内网地址。`test/fixtures/` 里的设备身份信息都是虚构的，请保持这样。
- 保持零依赖：确有需要引入依赖时，先在 Issue 里说明理由。
- 代码注释用中文，解释"为什么这样做"而不是"做了什么"；错误信息和界面文案是给使用者看的，说清楚出了什么问题、该怎么办。
- 提交前跑一遍 `node --test`。CI 会在 Node 20 / 22 / 24 上运行测试并构建 Docker 镜像。

## 帮忙验证实验性适配器

`tplink-json` 适配器（新版 Web 界面的 JetStream 交换机）还没有在真机上验证过。如果你有这样的设备，验证步骤见 [docs/adapters.md](docs/adapters.md#你可以帮忙验证)——只需要读操作，没有任何风险。

## 许可证

项目采用 [MIT 许可证](LICENSE)。提交 Pull Request，即表示你同意自己的贡献以同样的许可证授权。
