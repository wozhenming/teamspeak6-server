# TeamSpeak 6 点歌机器人 + 管理面板

Docker 一键部署的全栈项目：TeamSpeak 6 服务器 + Web 管理面板 + 网易云音乐点歌机器人。
点歌机器人以真实语音客户端身份加入 TS 频道推流，并支持在 TS 客户端内用聊天指令点歌。

---

## 一、总体架构

```
┌────────────────────────── Docker 网络(ts6) ─────────────────────────┐
│                                                                      │
│  teamspeak ················ TS6 服务器(语音/WebQuery:10080/SSH:10022)│
│  neteasemusic ············· 网易云 API(api-enhanced)，含图片/音频代理 │
│  music (点歌机器人) ········ 队列/播放器/电台流/聊天指令监听           │
│  panel (管理面板) ·········· WebUI + 代理 /api/music → music          │
│  backend (ts6-manager) ···· 语音引擎：真实语音客户端加入频道推流       │
│  ts6mgr-sidecar ··········· WebRTC 媒体中继                          │
│  ts6mgr-frontend ·········· ts6-manager 后台 UI(:3002)               │
└──────────────────────────────────────────────────────────────────────┘
```

**核心链路（音频）**：面板点歌 → `music` 队列/播放器 → `/api/stream` 实时转码 MP3 小广播
电台流 → `backend`(ts6-manager) 的音乐机器人作为真实语音客户端拉流 → 推进 TeamSpeak 频道。

---

## 二、功能清单 + 实现方法

### 1. 网易云登录（music/src/enhanced.js, index.js）
- **扫码登录**：`/login/qr/create` `/login/qr/check`。
- **登录持久化**：cookie jar 持久化到 `music-data` 卷的 `cookie.txt`；`loadCookies()` 启动时重读。
- **登录态判定**：`/api/status` 以真实 `/login/status` 返回为准（不靠 cookie 文件猜测）；且
  **匿名账号(`anonimousUser:true`)判为未登录**，只有带 `profile` 的真账号才显示。
- **扫码 cookie 抓取难点**：api-enhanced 在 `code=803` 时把完整会话 cookie 放在响应
  **顶层 `cookie`** 字段（Set-Cookie 风格字符串）返回；用 `absorbLogin()` **保留全部真实
  cookie**（MUSIC_U / MUSIC_R_U / MUSIC_R_T / MUSIC_SNS / NMTID / __csrf…），仅剔
  `Max-Age/Expires/Path/Domain` 属性行落盘——这样 `/login/status` 才能识别为已登录
  （之前只收白名单丢了 refresh/token cookie 导致一直 anonymous）。
- **显示**：头像 + 昵称 + VIP（黑胶VIP/SVIP/非会员，按 `account.vipType`)。
- **退出**：`/logout` + 清空本地 jar。

### 2. 点歌队列与播放器（music/src/queue.js, player.js, index.js）
- `queue.js`：内存 + 持久化 `queue.json`；**每个条目保留网易云真实 `songId`**（早期丢 ID 是无声根因）。
- `player.js`：播放/暂停/继续/切歌/进度/循环(列表/单曲/随机/关)状态机；持久化 `player.json`。
- 播放/暂停/seek/切歌都会 **`rev++`**，驱动电台流按需重启转码进程。

### 3. 电台音频流（music/src/index.js `/api/stream`）
- **ffmpeg 实时转码**为稳定 MP3(128kbps/44.1k)，`-re` 按原速推送（避免机器人把流当文件缓存造成回跳）。
- **真实时长探测**：用 `ffprobe` 探测直链文件真实时长，修正队列/自动切歌（试听/版权截断比元数据短）。
- **空闲静音保底**：无歌/暂停时回放**预生成的 32kbps 静音缓冲**，电台流永不断流（否则机器人掉线）。
- **过渡垫片**：切歌/恢复前先补一段干净静音帧，掩盖被 kill 的 ffmpeg 留下的半截帧（消除“电音”）。
- **seek 真跳转**：`ffmpeg -ss 位置` 输入端定位；媒体代理转发 Range 头并透传 206/Content-Range
  （否则 seek 永远从头播）。
- **令牌校验**：公网可达地址 + `?t=STREAM_TOKEN` 防随意收听。
- **对外地址**：`STREAM_PUBLIC_HOST` 可配，或**启动时自动探测公网 IP**（ts6-manager 的 SSRF
  防护会拒绝“解析到内网 IP”的主机名，故必须用公网地址）。
- **版权/解灰**：拿不到直链时自动走 `/song/url/match` 解灰(UnblockNeteaseMusic)，仍失败跳下一首并记原因。

### 4. ts6-manager 对接（music/src/tsbridge.js）
- 自动建连：`ensureAdmin`（自动登录/创建 ts6-manager 管理员）、`ensureServer`（自动创建指向本
  TS 的连接，**指纹变化才 PUT**，避免切页触发连接池重置）、`ensureBot`（按名字复用，不重复建）、
  `ensureStation`、`play-radio`。
- JWT **token 缓存 10 分钟**(401 自动重登)，避免轮询/切页反复登录撞 auth 限流。
- **恢复播放自愈**：暂停后机器人可能放弃电台流连接，恢复播放时额外重下达 `play-radio`。

### 5. TS 频道聊天点歌（music/src/tschat.js）★核心特色
- **SSH ServerQuery 监听**：以 serveradmin 登 TS 的 SSH Query(10022)（`shell(false)` 无伪终端，
  **等服务端 TS3 横幅后才发命令**），加入点歌机器人所在频道，`servernotifyregister event=textchannel/
  textprivate/textserver`，接收频道聊天消息。
- **指令**（支持中/英文，面板可逐项开启/关闭）：
  - `!点歌 <歌曲ID|网易云链接>`（或裸 ID/链接）→ 自动提取 ID 入队并自动开播
  - `!播放`/`!继续`、`!暂停`、`!切歌`/`!下一首`、`!循环 <列表|单曲|随机|关>`、`!状态`
- 单命令应答 FIFO 分发器（防多监听器抢行）；断线指数重连；昵称冲突自愈；频道回执结果。

### 6. Web 管理面板（panel）
- **多页面**：仪表盘、服务器/频道/用户/权限管理、点歌页、部署管理、统计。
- **点歌机器人代理**（panel/src/routes/music.js）：`/api/music/*` → music 服务，保持面板登录鉴权。
- **用户管理连接时长**：TS6 的 `connection_connected_time` 是**周期性快照**，会冻结/跳变；
  `utils/smooth.js` 以**本地单调时钟为主 + 快照校准/重置识别/尖峰过滤**，让显示每秒平滑递增。
- **部署管理**：检测 Docker/Compose、提取服务器管理员初识凭证、WebQuery 连通性与版本显示。
- **点歌页设置**：TS WebQuery API Key、频道下拉、频道聊天点歌开关 + 各指令开关、网易云登录信息。

### 7. Docker 部署（docker-compose.yml）
- 全部服务同一 `ts6` 网络；services：teamspeak / neteasemusic / music / panel / backend / sidecar / frontend。
- 国内加速：npm 走 npmmirror、Alpine ffmpeg 走阿里云镜像源。
- 命名卷持久化：teamspeak-data / music-data / panel-config / ts6mgr-data 等（`down` 不清，`down -v` 清）。
- 音乐镜像 `RUN apk add ffmpeg` 放最前稳定层缓存，避免每次 build 重装。

---

## 三、关键问题排查经验（遇到过的坑）

| 现象 | 根因 | 解法 |
|------|------|------|
| 点歌无声音/5 秒回跳 | 直链取歌用了**队列内部序号**而非网易云 songId；AAC 直传当 MP3 | 保留 songId；ffmpeg 转码稳定 MP3 |
| 机器人无声音 | 空闲时 `/api/stream` 零字节，机器人解码器停摆 | 空闲回放静音缓冲，流不断 |
| 频道列表 404 | ts6-manager 频道接口真实路径是 `/api/servers/:id/vs/:sid/channels` | 先查虚拟服务器 sid 再取频道 |
| 建电台 `private IP` | ts6-manager 有 SSRF 防护，拒绝解析到内网的主机名 | 电台 URL 用服务器公网 IP/域名 |
| 暂停电音 / 切循环毛刺 | kill 转码进程留半截帧；setLoop 误 bump rev 重启流 | 过渡静音垫片；循环不重启流 |
| seek 回到开头 | 媒体代理不转发 Range 头，`-ss` 无法在源上定位 | 代理转发 Range 并透传 206 |
| 登录后仍“未登录” | 803 成功但丢弃了 cookie；只收白名单丢了 refresh/token cookie | 顶层 `res.cookie` + `absorbLogin` 全量保留 |
| 卸 UI 卡顿返页 | ts6-manager auth 限流 + 每次 PUT 刷新连接池 | token 缓存 10 分钟 + 指纹变化才 PUT |
| 聊天指令无反应 | `handleRequest` 改同步后残留 `.catch` 抛 TypeError 断连 | 去掉多余 `.catch` |
| 频道无人自动暂停失效 | 点歌助手(serveradmin Query) `clientmove` 进频道常驻，channellist `total_clients` 永远 ≥2 | 按 clients 端点 `client_type` 只统计真实语音用户（排除机器人自身与 Query 客户端） |
| 修复计数后重启又失效 | 看门狗 `desiredLinked` 只在 `link()` 时置 true，容器重启后 tick 直接 return，自动暂停/自动重连全部停摆（机器人活在 ts6-manager 进程里，现象隐蔽） | 模块加载时若 botId 已持久化则同步置回 `desiredLinked=true` 再启看门狗 |
| 队列筛选无效 | 前端 input 事件只翻页没把输入值写入 `queueQ`，请求永远带空 q | 事件回调读取 `e.target.value` 再防抖请求 |
| 每次进点歌页图片全量重拉 | 面板 `/api/music` 代理只回传 content-type，丢掉了上游 `Cache-Control`/`ETag` | 代理透传缓存相关响应头 |

---

## 四、常用指令/命令

**点歌机器人 API（`http://music:3200`）**
- `/api/status` 登录状态（含 profile/vip）
- `/api/player/*` 播放器控制（play/pause/resume/toggle/seek/next/prev/loop）
- `/api/queue` 队列增删查
- `/api/stream?t=<TOKEN>` 电台音频流
- `/api/ts-bot/config`+`/link`+`/unlink`+`/channels`+`/chat/status` ts6-manager 对接与设置

**TS 频道聊天指令**
```
!点歌 <歌曲ID或网易云链接>
!播放  !暂停  !切歌  !循环 <列表|单曲|随机|关>  !状态
```

**部署**
```bash
cd teamspeak6-server && git pull
docker-compose up -d --build --remove-orphans music panel   # 更新
```