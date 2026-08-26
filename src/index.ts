import http from "node:http";
import { URL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { logger } from "./logger.js";
import { authenticateClient, authenticateRobot, checkRateLimit } from "./auth.js";
import { isDeviceOnline, getOnlineCount } from "./devices.js";
import {
  handleRobotConnect,
  handleClientConnect,
  handleRobotDisconnect,
  handleClientDisconnect,
  handleMessage,
  getStats,
  type RobotConnection,
  type ClientConnection,
} from "./signaling.js";

const SIGNAL_PORT = Number(process.env.SIGNAL_PORT) || 3000;

// ===== HTTP 服务器（健康检查 + 状态查询） =====

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || "/", `http://localhost:${SIGNAL_PORT}`);

  // GET /api/health
  if (url.pathname === "/api/health" && req.method === "GET") {
    res.writeHead(200);
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }

  // GET /api/stats — 服务统计
  if (url.pathname === "/api/stats" && req.method === "GET") {
    const stats = getStats();
    res.writeHead(200);
    res.end(JSON.stringify({ ...stats, onlineDevices: getOnlineCount() }));
    return;
  }

  // GET /api/devices/:robotId/status — 设备在线状态
  const statusMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/status$/);
  if (statusMatch && req.method === "GET") {
    const robotId = decodeURIComponent(statusMatch[1]);
    res.writeHead(200);
    res.end(JSON.stringify({ robotId, online: isDeviceOnline(robotId) }));
    return;
  }

  // 404
  res.writeHead(404);
  res.end(JSON.stringify({ error: "Not found" }));
});

// ===== WebSocket 信令服务器 =====

const wss = new WebSocketServer({ server: httpServer, path: "/ws" });

wss.on("connection", async (ws: WebSocket, req) => {
  const clientIp = req.socket.remoteAddress || "unknown";

  // 限流检查
  if (!checkRateLimit(clientIp)) {
    logger.warn(`[WS] Rate limited: ${clientIp}`);
    ws.close(1013, "Too many connections");
    return;
  }

  // 解析 URL 参数
  const url = new URL(req.url || "", `http://localhost:${SIGNAL_PORT}`);
  const role = url.searchParams.get("role");

  if (role === "robot") {
    await handleRobotConnection(ws, url, clientIp);
  } else if (role === "client") {
    await handleClientConnection(ws, url, clientIp);
  } else {
    logger.warn(`[WS] Invalid role: ${role}, ip=${clientIp}`);
    ws.close(1008, "Invalid role");
  }
});

/** 处理机器人连接 */
async function handleRobotConnection(ws: WebSocket, url: URL, ip: string): Promise<void> {
  const deviceId = url.searchParams.get("deviceId") || "";
  const timestamp = url.searchParams.get("timestamp") || "";
  const signature = url.searchParams.get("signature") || "";
  const deviceSecretHash = url.searchParams.get("deviceSecretHash") || "";

  if (!deviceId || !timestamp || !signature) {
    logger.warn(`[WS] Robot missing auth params, ip=${ip}`);
    ws.close(1008, "Missing auth params");
    return;
  }

  const result = await authenticateRobot(deviceId, timestamp, signature, deviceSecretHash || undefined);
  if (!result) {
    ws.close(1008, "Authentication failed");
    return;
  }

  const conn: RobotConnection = { role: "robot", deviceId, ws };
  handleRobotConnect(conn);

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      handleMessage(conn, data);
    } catch (err) {
      logger.warn(`[WS] Failed to parse robot message: ${err}`);
    }
  });

  ws.on("close", () => {
    handleRobotDisconnect(deviceId, ws);
  });

  ws.on("error", (err) => {
    logger.error(`[WS] Robot error: ${deviceId}: ${err}`);
  });
}

/** 处理客户端连接 */
async function handleClientConnection(ws: WebSocket, url: URL, ip: string): Promise<void> {
  const token = url.searchParams.get("token") || "";
  const robotId = url.searchParams.get("robotId") || "";

  if (!token || !robotId) {
    logger.warn(`[WS] Client missing auth params, ip=${ip}`);
    ws.close(1008, "Missing auth params");
    return;
  }

  const userId = await authenticateClient(token, robotId);
  if (!userId) {
    ws.close(1008, "Authentication failed");
    return;
  }

  const conn: ClientConnection = { role: "client", userId, robotId, ws };
  handleClientConnect(conn);

  ws.on("message", (raw) => {
    try {
      const data = JSON.parse(raw.toString());
      handleMessage(conn, data);
    } catch (err) {
      logger.warn(`[WS] Failed to parse client message: ${err}`);
    }
  });

  ws.on("close", () => {
    handleClientDisconnect(ws);
  });

  ws.on("error", (err) => {
    logger.error(`[WS] Client error: user=${userId}, device=${robotId}: ${err}`);
  });
}

// ===== 启动服务器 =====

httpServer.listen(SIGNAL_PORT, () => {
  logger.info(`[Server] wo-bot-signal listening on port ${SIGNAL_PORT}`);
  logger.info(`[Server] WebSocket: ws://localhost:${SIGNAL_PORT}/ws`);
  logger.info(`[Server] Health: http://localhost:${SIGNAL_PORT}/api/health`);
});

// 优雅退出
process.on("SIGTERM", () => {
  logger.info("[Server] SIGTERM received, shutting down...");
  wss.close();
  httpServer.close(() => {
    process.exit(0);
  });
});

process.on("SIGINT", () => {
  logger.info("[Server] SIGINT received, shutting down...");
  wss.close();
  httpServer.close(() => {
    process.exit(0);
  });
});
