# TeamSpeak 6 服务端管理项目

基于 **TeamSpeak 6 Server Beta** 的 Linux 服务端全生命周期管理工具：

1. **一键部署**（`deploy/install.sh`）：Docker Compose 自动化部署
2. **Web 管理面板**（`panel/`）：基于 TS6 **WebQuery HTTP API** 的现代化管理界面（Node.js + Express）

> 详细设计背景见 [ts服务端开发文档.md](./ts服务端开发文档.md)。

## 目录结构

```
teamspeak-server/
├── ts服务端开发文档.md      # 项目开发文档
├── deploy/                  # 模块一：一键部署
│   ├── install.sh           # 一键安装脚本（Linux / bash）
│   ├── docker-compose.yml   # Compose 模板（由脚本生成）
│   └── tsserver.yaml        # 可选配置文件模板
└── panel/                   # 模块二：Web 管理面板
    ├── src/
    │   ├── server.js        # Express 入口
    │   ├── config.js        # 环境配置（.env）
    │   ├── auth.js          # 面板自带登录认证（HMAC 签名 Cookie）
    │   ├── webquery.js      # WebQuery API 连接层
    │   └── routes/          # overview / servers / clients / channels
    ├── public/              # 前端（原生 HTML/JS + Chart.js CDN）
    ├── test/
    │   ├── mock-webquery.js # 模拟 TS6 WebQuery 服务器（无需真实 TS6）
    │   └── api.test.js      # 端到端测试（29 项）
    └── .env.example         # 配置模板
```

## 快速开始

### 方式一（推荐）：面板引导式部署

**只需启动管理面板，整个部署流程在 Web 界面完成**，无需单独执行部署脚本：

```bash
cd panel
cp .env.example .env        # 修改面板登录密码（PANEL_PASSWORD）
npm install
npm start                   # 启动管理面板 http://127.0.0.1:3000
```

登录后进入 **「部署管理」** 页面，按步骤操作：

| 步骤 | 操作 | 说明 |
| ---- | ---- | ---- |
| ① 环境检测 | 自动检测 Docker / Compose / 引擎 | 缺失时页面给出按发行版的安装命令（可一键复制） |
| ② 部署配置 | 填写端口与容器名 → 生成 compose | 实时预览 docker-compose.yml |
| ③ 启动服务 | 点击「启动服务」 | 实时任务日志（拉镜像/启动过程可见） |
| ④ 初始凭证 | 自动提取并展示 | 管理员 token / Query 密码，可直接复制保存 |
| ⑤ API Key | 按指引经 SSH Query 生成 → 粘贴保存 | 保存后**立即生效，无需重启面板**，可一键检测连接 |

完成后切到「仪表盘」即可看到服务器实时状态；顶部「部署管理」页仍可随时停止/重启服务、查看日志。

### 方式二：命令行一键部署（install.sh）

```bash
cd deploy
./install.sh
```

脚本自动：检测 Docker / Docker Compose → 生成 `docker-compose.yml` → 启动服务 →
从日志提取**初始管理员凭证** → 输出 **WebQuery API Key 生成指引**。适合无面板场景或自动化脚本调用。

> ⚠️ TS6 Beta 内置 32 槽位免费预览许可证（有效期 2 个月），启动时自动接受。

### 2. 生成 WebQuery API Key

REST API 的 Key **必须通过 SSH Query 生成**（TS3 的 telnet ServerQuery 已被废弃），
也可以直接在面板「部署管理」页按指引生成并填入（保存后立即生效）：

```
ssh -p 10022 admin@127.0.0.1        # 密码为日志中的初始管理员密码
apikeyadd scope=manage lifetime=0   # 生成永不过期的管理 Key
apikeylist                          # 查看已生成的 Key
```

### 3. 启动管理面板

```bash
cd panel
cp .env.example .env                # 填写 TSSERVER_API_KEY 与面板登录密码
npm install
npm start                           # 默认 http://127.0.0.1:3000
```

## TS6 WebQuery 协议速查（已对照社区实现确认）

| 项目 | 说明 |
| ---- | ---- |
| 地址 | `http://<host>:10080` |
| 认证 | 请求头 `x-api-key: <key>` |
| URL 模式 | `/{sid}/{command}`；实例级命令（如 `serverlist`）为 `/{command}` |
| 参数 | query string（空值自动剔除） |
| 响应 | `{ status: { code, message }, body: [...] }`，`status.code !== 0` 为错误 |

**常用命令**：`version` / `whoami` / `serverlist` / `serverinfo` / `serverrequestconnectioninfo`
（每秒带宽）/ `clientlist`（支持 `-uid -away -voice -times -groups -info -country -ip` 标志）/
`clientkick` / `banclient` / `clientmove` / `clientpoke` / `sendtextmessage` / `channellist` /
`channelcreate` / `channeledit` / `channeldelete`。

> ⚠️ **注意**：Node.js 全局 `fetch` 遵循 Fetch 规范，端口 **10080 在禁止端口黑名单中**
> （`bad port`）。连接层使用原生 `http/https` 模块规避此问题。

## 面板 API

面板 API 统一经 `/api` 前缀暴露，全部需要面板登录会话（Cookie），前端不直接接触 TS6：

| 方法 | 路径 | 说明 |
| ---- | ---- | ---- |
| POST | `/api/login` `/api/logout` | 面板登录 / 登出 |
| GET | `/api/me` | 当前会话 |
| GET | `/api/overview?sid=1` | 仪表盘聚合（服务器信息 + 带宽速率 + 用户 + 频道） |
| GET | `/api/servers` | 虚拟服务器列表 |
| GET | `/api/deploy/status` | 部署综合状态（Docker/Compose/容器/WebQuery） |
| GET | `/api/deploy/preview` | 预览 docker-compose.yml |
| POST | `/api/deploy/compose` | 生成 docker-compose.yml |
| POST | `/api/deploy/up` `/down` `/restart` | 启动/停止/重启（返回后台任务 taskId） |
| GET | `/api/deploy/task/:id` | 后台任务进度（实时输出行） |
| GET | `/api/deploy/logs?tail=N` | 容器日志 |
| GET | `/api/deploy/credentials` | 提取初始管理员凭证 |
| POST | `/api/deploy/apikey` | 保存 API Key（.env 持久化 + 立即生效） |
| GET | `/api/deploy/check` | 检测 WebQuery 连通性 |
| GET | `/api/servers/:sid/clients` | 在线用户列表（含频道名） |
| POST | `/api/servers/:sid/clients/:clid/kick` | 踢出 `{ reason, from: server\|channel }` |
| POST | `/api/servers/:sid/clients/:clid/ban` | 封禁 `{ reason, time 分钟, ipban }` |
| POST | `/api/servers/:sid/clients/:clid/move` | 移动 `{ cid }` |
| POST | `/api/servers/:sid/clients/:clid/poke` | Poke `{ msg }` |
| POST | `/api/servers/:sid/clients/:clid/message` | 私聊 `{ msg }` |
| GET | `/api/servers/:sid/channels` | 频道列表（含人数与成员） |
| POST | `/api/servers/:sid/channels` | 创建频道（名称/父频道/排序/最大用户/密码/主题） |
| PUT | `/api/servers/:sid/channels/:cid` | 编辑频道 |
| DELETE | `/api/servers/:sid/channels/:cid` | 删除频道（force） |

## 测试（无需真实 TS6）

```bash
cd panel
node test/mock-webquery.js                          # 终端 1：模拟 TS6 WebQuery
$env:TSSERVER_API_KEY='test-api-key'; node src/server.js   # 终端 2：面板
node test/api.test.js                               # 终端 3：业务 API（29 项）
node test/deploy.test.js                            # 部署管理 API（27 项）
node test/task.test.js                              # 后台任务流（8 项）
```

## 安全注意事项

- **API Key 禁止硬编码**：从 `.env` 读取，不要提交到代码仓库
- **WebQuery 端口**（10080）建议仅监听 127.0.0.1 或用防火墙限制访问
- **面板自带认证**：独立于 TS6 原生认证，默认账号 `admin`，请立即修改密码与 `SESSION_SECRET`
- **权限最小化**：使用专用 API Key，仅授予必要权限（scope=manage 按需收紧）

## 路线图进度

- [x] Phase 1：一键部署（面板「部署管理」引导式：环境检测 / 生成 Compose / 启动 / 提取凭证 / API Key；`deploy/install.sh` 作为命令行备用）
- [x] Phase 2：WebQuery API 连接层（认证、错误映射、keep-alive 连接池）
- [x] Phase 3：基础管理界面（仪表盘 + 用户管理 + 频道管理）
- [ ] Phase 4：权限管理（服务器组 / 频道组 / 权限编辑器）与高级功能（自动频道、AFK 移动器、欢迎消息、在线人数计数器）
- [ ] Phase 5：面板容器化
