# wo-bot-signal

wo-bot 机器人的**云端信令与授权服务器**：为跨网络的 Web / 手机 App 远程控制提供
WebRTC 信令转发、设备在线管理、机器人身份校验与 TURN 凭证下发。

> 局域网本地调试**不需要**本服务（web-debug 直连机器人即可）；只有跨网络远控才需要部署它。

## 职责

| 能力 | 说明 |
|---|---|
| WebRTC 信令转发 | 客户端 ↔ 机器人之间的 SDP / ICE candidate 双向转发 |
| 设备在线管理 | 机器人上线注册、心跳维持、在线列表 |
| 身份校验 | 机器人用 `ROBOT_SECRET`，客户端用账号服务签发的 JWT |
| TURN 凭证下发 | 按需签发 coturn 临时凭证（`TURN_SECRET`），应对对称 NAT |
| 账号对接 | 经 `ACCOUNT_API_URL` 校验用户与设备归属关系 |

## 技术栈

TypeScript + Node.js（`ws` 做信令、`jsonwebtoken` 做鉴权）+ coturn（TURN 中继）

## 快速开始

```bash
npm install
cp .env.example .env     # 按注释填写，至少 ROBOT_SECRET / TURN_SECRET / JWT_SECRET
npm run dev              # tsx watch 热重载，默认监听 SIGNAL_PORT=3000
```

| 命令 | 作用 |
|---|---|
| `npm run dev` | 开发模式（tsx watch） |
| `npm run build` | 编译到 `dist/`（tsc） |
| `npm start` | 运行编译产物 |
| `npm run typecheck` | 类型检查（`tsc --noEmit`） |
| `npm run lint:check` | ESLint 检查（CI 用；`lint` 会自动修） |
| `npm run format:check` | Prettier 检查（CI 用；`format` 会自动修） |

## 环境变量

见 [`.env.example`](.env.example)。

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `SIGNAL_DOMAIN` | ✅ | — | 对外域名 |
| `ROBOT_SECRET` | ✅ | — | 机器人接入密钥 |
| `TURN_SECRET` | ✅ | — | coturn 凭证签发密钥（需与 turnserver 一致） |
| `JWT_SECRET` | ✅ | — | 客户端 JWT 校验密钥 |
| `ACCOUNT_API_URL` | — | — | 账号服务地址，用于校验设备归属 |
| `SIGNAL_PORT` | — | `3000` | 监听端口 |
| `TURN_PORT` | — | `3478` | TURN 端口 |
| `TURN_RELAY_MIN` / `TURN_RELAY_MAX` | — | `49152` / `65535` | TURN 中继端口范围 |
| `LOG_LEVEL` | — | — | 日志级别 |

## 项目结构

```
src/
  index.ts       入口（HTTP + WebSocket 服务）
  signaling.ts   SDP / ICE 转发与房间管理
  devices.ts     机器人上线注册与心跳
  auth.ts        机器人 / 客户端鉴权
  turn.ts        coturn 临时凭证签发
  logger.ts      日志
turnserver.conf                  coturn 配置样例
Dockerfile / docker-compose.yml  容器化部署
```

## 部署

```bash
docker compose up -d     # 含 coturn
```

架构背景见 wiki 的
[跨网络 WebRTC 远程控制方案](https://github.com/al96169/wo-bot-wiki/blob/main/方案/跨网络WebRTC远程控制方案.md)。

## 相关项目

| 仓库 | 关系 |
|---|---|
| [wo-bot-control](https://github.com/al96169/wo-bot-control) | 机器人端，作为信令客户端接入 |
| [wo-bot-account](https://github.com/al96169/wo-bot-account) | 账号与设备授权，本服务校验其签发的 JWT |
| [wo-bot-web-debug](https://github.com/al96169/wo-bot-web-debug) | Web 调试端 |
| [wo-bot-wiki](https://github.com/al96169/wo-bot-wiki) | 项目文档与部署方案 |

## License

[MIT](LICENSE)
