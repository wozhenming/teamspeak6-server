# TeamSpeak 6 服务端管理项目

基于 **TeamSpeak 6 Server Beta** 的全栈容器化解决方案：**TS6 服务器 + Web 管理面板**，
clone 后一条命令即可完成整个部署。

```
git clone git@github.com:wozhenming/teamspeak6-server.git
cd teamspeak6-server
docker compose up -d          # 一键启动全部服务（自动构建面板镜像）
```

- 管理面板：http://`<主机IP>`:3000 （默认账号 `admin` / `admin123`，请尽快修改）
- 语音端口：9987/udp · 文件传输：30033 · WebQuery：10080（仅本机）· SSH Query：10022（仅本机）

> 详细设计背景见 [ts服务端开发文档.md](./ts服务端开发文档.md)。

## 首次使用

`docker compose up -d` 启动后，打开管理面板并进入 **「部署管理」** 页：

1. **环境检测**：确认 Docker 引擎与 TS6 容器状态
2. **初始凭证**：自动从 TS6 日志提取 **ServerAdmin token** 与 **serveradmin 密码**（仅首次启动显示，请立即保存）
3. **API Key**：按页面指引通过 SSH Query 生成（`apikeyadd scope=manage lifetime=0`），粘贴保存——
   **立即生效、无需重启面板**（持久化到数据卷，重启不丢）
4. 完成后切到 **「仪表盘」** 即可看到服务器实时状态（在线人数 / 运行时长 / 带宽图表），
   并在「用户管理」「频道管理」中执行管理操作

## 目录结构

```
teamspeak-server/
├── docker-compose.yml         # ★ 全栈一键部署（teamspeak + panel）
├── .env.example               # compose 配置模板（端口/密码等）
├── query_ip_allowlist.txt     # Query 接口 IP 白名单（WebQuery/SSH Query）
├── deploy/                    # 备用：仅 TS6 的裸机/独立部署方案（install.sh）
├── panel/                     # Web 管理面板（Node.js + Express）
│   ├── Dockerfile             # 面板镜像
│   ├── src/                   # server/config/auth/webquery/docker + routes
│   ├── public/                # 前端（原生 HTML/JS + Chart.js）
│   └── test/                  # mock WebQuery + 端到端测试
└── ts服务端开发文档.md
```

## 配置

复制 `.env.example` 为 `.env` 后按需修改（docker compose 自动读取）：

| 变量 | 默认 | 说明 |
| ---- | ---- | ---- |
| `PANEL_USERNAME` / `PANEL_PASSWORD` | admin / admin123 | 面板登录（⚠️ 务必修改） |
| `SESSION_SECRET` | please-change-me | 会话签名密钥（`openssl rand -hex 32`） |
| `PANEL_PORT` | 3000 | 面板端口 |
| `TS_PORT_VOICE` / `TS_PORT_FILE` | 9987 / 30033 | 语音 / 文件传输端口 |
| `TS_PORT_WEBQUERY` / `TS_PORT_SSHQUERY` | 10080 / 10022 | Query 端口（默认仅绑定 127.0.0.1） |
| `TSSERVER_API_KEY` | 空 | 可预填，也可在部署页填写 |

常用命令：

```bash
docker compose up -d          # 启动
docker compose logs -f panel  # 面板日志
docker compose ps             # 状态
docker compose restart teamspeak   # 重启 TS6（修改白名单后需要）
docker compose down           # 停止（数据卷保留）
docker compose down -v        # 停止并删除数据（⚠️ 数据丢失）
```

## 两个关键配置点（TS6 默认值陷阱）

TS6 Beta 的 Query 接口**默认全部禁用**且**默认仅允许本机 IP**，本项目的 compose 已正确配置：

1. `TSSERVER_QUERY_HTTP_ENABLED=true` / `TSSERVER_QUERY_SSH_ENABLED=true` — 启用 WebQuery 与 SSH Query
2. `TSSERVER_QUERY_ALLOW_LIST=/etc/tsserver/query_ip_allowlist.txt` — 白名单文件（项目根 `query_ip_allowlist.txt`），
   不在白名单的 IP 连接会被立即断开；远程管理请把网段加入该文件后 `docker compose restart teamspeak`

## 管理面板功能

- **部署管理**：环境检测、初始凭证提取、API Key 配置、TS6 容器快捷启停、日志查看
  （容器化模式下由 compose 管理；独立模式下可生成 compose 并一键部署）
- **仪表盘**：在线用户、运行时长、带宽实时图表、服务器信息、最近加入用户
- **用户管理**：在线列表、踢出 / 封禁（含 IP）/ 移动 / 私聊 / Poke
- **频道管理**：频道树、创建 / 编辑 / 删除（名称 / 主题 / 密码 / 最大用户 / 排序）

## 面板 API

面板 API 经 `/api` 前缀暴露，需面板登录会话（Cookie），前端不直接接触 TS6（API Key 只存在服务端）：

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/login` `/api/logout` | 登录 / 登出 |
| GET | `/api/overview?sid=1` | 仪表盘聚合（服务器信息 + 带宽速率 + 用户 + 频道） |
| GET | `/api/servers` | 虚拟服务器列表 |
| GET | `/api/deploy/status` | 部署综合状态（Docker/容器/WebQuery） |
| POST | `/api/deploy/up` `/down` `/restart` | 启动 / 停止 / 重启（后台任务） |
| GET | `/api/deploy/task/:id` | 任务进度（实时输出行） |
| GET | `/api/deploy/logs?tail=N` | TS6 容器日志 |
| GET | `/api/deploy/credentials` | 提取初始管理员凭证 |
| POST | `/api/deploy/apikey` | 保存 API Key（持久化 + 立即生效） |
| GET | `/api/deploy/check` | 检测 WebQuery 连通性 |
| GET | `/api/servers/:sid/clients` | 在线用户列表 |
| POST | `/api/servers/:sid/clients/:clid/kick` `/ban` `/move` `/poke` `/message` | 用户操作 |
| GET | `/api/servers/:sid/channels` | 频道列表 |
| POST | `/api/servers/:sid/channels` · PUT `/:cid` · DELETE `/:cid` | 频道增改删 |

## 测试（无需真实 TS6）

```bash
cd panel
node test/mock-webquery.js 10081          # 终端 1：模拟 TS6 WebQuery
$env:PORT='3100'; $env:TSSERVER_BASE_URL='http://127.0.0.1:10081'; node src/server.js  # 终端 2
$env:TEST_BASE='http://127.0.0.1:3100'
node test/api.test.js                     # 业务 API（29 项）
node test/deploy.test.js                  # 部署管理 API（31 项）
node test/task.test.js                    # 后台任务流（8 项）
```

> 已用真实 TS6（6.0.0-beta12.1）完成端到端验证：凭证提取、SSH Query 生成 API Key、
> WebQuery 认证、服务器/频道/用户数据拉取、面板重启后 Key 持久化。

## 备用方案：仅 TS6 独立部署（不使用面板容器）

```bash
cd deploy && ./install.sh
```

脚本自动：检测 Docker → 生成 compose（含 WebQuery/SSH 启用与白名单）→ 启动 →
提取初始管理员凭证 → 输出 API Key 生成指引。面板以独立进程运行（见 `panel/.env.example`）。

## 安全注意事项

- 修改默认面板密码与 `SESSION_SECRET`（`.env`）
- WebQuery / SSH Query 默认仅绑定 127.0.0.1，远程管理需改端口绑定与 `query_ip_allowlist.txt`
- API Key 只存服务端（数据卷），不写入前端与代码仓库
- TS6 Beta 内置 32 槽位免费预览许可证（有效期 2 个月）
