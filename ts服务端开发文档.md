# TeamSpeak 6 服务器管理项目开发提示词

> **版本说明**：本项目基于 TeamSpeak 6 Server Beta 版本开发。TS6 是 TeamSpeak 的重大版本更新，引入了现代化的管理接口和架构。


## 一、项目核心定位

构建一个面向 Linux 服务器的 **TeamSpeak 6** 服务端全生命周期管理工具，核心功能包括：

1. **服务端一键部署**：基于 Docker 实现自动化部署，支持 TS6 特有的配置方式
2. **Web 管理面板**：基于 TS6 全新的 **WebQuery HTTP API** 构建现代化管理界面


## 二、核心变更：TeamSpeak 6 的关键差异

开发前务必了解 TS6 与 TS3 的以下核心区别：

### 2.1 管理接口变革

TS6 废弃了 TS3 传统的 telnet ServerQuery（端口 10011），采用两种新方式：

| 接口类型              | 端口      | 说明                                     |
| --------------------- | --------- | ---------------------------------------- |
| **WebQuery HTTP API** | 10080/tcp | 现代化 RESTful API，推荐用于管理面板开发 |
| **SSH Query**         | 10022/tcp | 替代 telnet 的安全命令行管理方式         |

> ⚠️ **重要**：REST API 的 API Key **必须通过 SSH Query 生成**，命令为 `apikeyadd scope=manage lifetime=0`。

### 2.2 配置方式升级

TS6 支持三种配置方式，推荐使用 YAML 文件 ：

- 命令行参数（临时调整）
- 环境变量（Docker 场景）
- **YAML 配置文件**（`tsserver.yaml`，推荐生产环境）

### 2.3 许可证模式变更

TS6 Beta 版本内置 **32 槽位免费预览许可证**，有效期为 **2 个月**。


## 三、模块一：TeamSpeak 6 服务器一键部署

### 3.1 技术方案

**仅支持 Docker Compose 部署**（TS6 官方推荐方式）。

### 3.2 docker-compose.yml 模板

```yaml
version: '3'

services:
  teamspeak:
    image: teamspeaksystems/teamspeak6-server:latest
    container_name: teamspeak-server
    restart: unless-stopped
    ports:
      - "9987:9987/udp"   # 语音端口（必须）
      - "30033:30033/tcp" # 文件传输端口
      - "10080:10080/tcp" # WebQuery HTTP API（管理面板必需）
      # - "10022:10022/tcp" # SSH Query（可选，用于API Key生成）
    environment:
      - TSSERVER_LICENSE_ACCEPTED=accept  # 接受许可证 
      # - TSSERVER_QUERY_ADMIN_PASSWORD=your_password  # 覆盖默认管理员密码 
    volumes:
      - teamspeak-data:/var/tsserver/     # 数据持久化 
      - ./tsserver.yaml:/etc/tsserver/tsserver.yaml  # 可选：挂载自定义配置

volumes:
  teamspeak-data:
```

### 3.3 一键安装脚本功能要求

- 自动检测 Docker 和 Docker Compose 是否已安装，若未安装则引导安装
- 生成 `docker-compose.yml` 文件
- 执行 `docker compose up -d` 启动服务
- 自动从日志中提取**初始管理员凭证**并展示给用户
- 记录 WebQuery API Key 生成步骤指引


## 四、模块二：TeamSpeak 6 服务端管理面板

### 4.1 技术架构变更

TS6 管理面板的通信方式与 TS3 完全不同：

| 对比项           | TS3                        | TS6                           |
| ---------------- | -------------------------- | ----------------------------- |
| **管理接口**     | telnet ServerQuery (10011) | WebQuery HTTP API (10080)     |
| **认证方式**     | 用户名/密码                | API Key                       |
| **通信协议**     | 原始 TCP 文本协议          | RESTful HTTP/JSON             |
| **API Key 生成** | 不适用                     | 需通过 SSH Query (10022) 生成 |

### 4.2 后端框架推荐

1. **直接对接 WebQuery API**（推荐）
   - 使用 HTTP 客户端（如 Python `requests`、Node.js `axios`）调用 `http://localhost:10080` 的 REST API
   - 需在请求头中携带 `x-api-key` 

2. **兼容层方案**（可选）
   - 使用 `ts3-query-proxy` 作为桥接层，将 TS3 协议转换为 TS6 SSH Query 

### 4.3 已知 WebQuery API 端点

TS6 WebQuery 支持与旧版 ServerQuery 功能对应的命令，当前已知端点包括 ：

- `GET /whoami` — 获取当前认证信息
- `GET /serverlist` — 获取服务器列表
- `GET /1/clientlist` — 获取客户端列表（`1` 为服务器 ID）
- `GET /version` — 获取版本信息

> 📘 **提示**：TS6 REST API 支持自动生成文档，完整端点列表请关注官方更新。

### 4.4 管理面板核心功能

参考社区已有项目（如 TS6 Manager）的设计思路 ：

**仪表盘**
- 在线用户数、服务器运行时长、带宽使用情况图表

**频道管理**
- 频道树展示、创建/删除频道
- 调整频道排序、最大用户数、密码设置、发言权限（Talk Power）

**用户管理**
- 在线用户列表
- 踢出/封禁/移动用户
- 发送私聊消息或 Poke

**权限管理**
- 服务器组分配
- 频道组管理
- 权限编辑器

**高级功能（参考）**
- 频道自动创建（用户加入特定频道自动生成个人临时频道）
- AFK 自动移动器
- 欢迎消息
- 在线人数计数器（动态频道名）

### 4.5 安全注意事项

1. **API Key 安全**：禁止硬编码 API Key，应从配置文件或环境变量读取
2. **WebQuery 端口**：建议仅监听 `127.0.0.1` 或通过防火墙限制访问
3. **面板认证**：管理面板自身应具备用户认证机制，不应依赖 TS6 原生认证
4. **权限最小化**：使用专用 API Key，仅授予必要权限


## 五、参考资源

| 资源                                                         | 说明                                |
| ------------------------------------------------------------ | ----------------------------------- |
| [官方 TS6 Docker 镜像](https://hub.docker.com/r/teamspeaksystems/teamspeak6-server) | 官方维护的 Docker 镜像              |
| [TS6 Manager](https://github.com/Clusterzx/ts6-manager)      | 社区 Web 管理面板参考实现，MIT 开源 |
| [TS6 部署指南](https://support.teamspeak.com/hc/en-us/articles/28866578414877) | 官方部署文档                        |
| [ARM 架构镜像](https://hub.docker.com/r/fezlight/teamspeak6-server-arm) | 支持 Raspberry Pi 等 ARM 设备       |


## 六、开发路线图建议

- **Phase 1**：完成一键部署脚本，确保 Docker Compose 方案可用
- **Phase 2**：实现 WebQuery API 连接层，获取服务器状态数据
- **Phase 3**：构建基础管理界面（仪表盘 + 用户/频道管理）
- **Phase 4**：完善权限管理和高级功能
- **Phase 5**：容器化管理面板本身，实现全栈 Docker 部署