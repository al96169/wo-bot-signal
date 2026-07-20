import type { WebSocket } from "ws";
import { logger } from "./logger.js";
import { deviceOnline, deviceOffline, isDeviceOnline } from "./devices.js";
import { generateTurnCredentials } from "./turn.js";

// ===== 类型定义 =====

type Role = "robot" | "client";

interface RobotConnection {
  role: "robot";
  deviceId: string;
  ws: WebSocket;
}

interface ClientConnection {
  role: "client";
  userId: string;
  robotId: string;
  ws: WebSocket;
}

type Connection = RobotConnection | ClientConnection;

export type { RobotConnection, ClientConnection, Connection };

// 房间：deviceId → { robot, clients }
interface Room {
  deviceId: string;
  robot: RobotConnection | null;
  clients: Map<WebSocket, ClientConnection>;
}

// ===== 房间管理 =====

const rooms = new Map<string, Room>();

function getOrCreateRoom(deviceId: string): Room {
  let room = rooms.get(deviceId);
  if (!room) {
    room = { deviceId, robot: null, clients: new Map() };
    rooms.set(deviceId, room);
  }
  return room;
}

function removeRoomIfEmpty(deviceId: string): void {
  const room = rooms.get(deviceId);
  if (room && !room.robot && room.clients.size === 0) {
    rooms.delete(deviceId);
    logger.info(`[Signal] Room removed: ${deviceId}`);
  }
}

// ===== 消息协议 =====

interface IncomingMessage {
  type: string;
  sdp?: unknown;
  candidate?: unknown;
  clientId?: string;
}

interface OutgoingMessage {
  type: string;
  [key: string]: unknown;
}

function send(ws: WebSocket, msg: OutgoingMessage): void {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ===== 连接管理 =====

/** 机器人上线 */
export function handleRobotConnect(conn: RobotConnection): void {
  const { deviceId, ws } = conn;
  const room = getOrCreateRoom(deviceId);

  // 新连接踢旧连接
  if (room.robot && room.robot.ws !== ws) {
    logger.info(`[Signal] Kicking old robot connection: ${deviceId}`);
    send(room.robot.ws, { type: "kick", reason: "replaced" });
    room.robot.ws.close();
  }

  room.robot = conn;
  deviceOnline(deviceId);

  // 通知所有已等待的客户端：机器人上线
  for (const [, client] of room.clients) {
    send(client.ws, { type: "presence", deviceId, online: true });
  }

  logger.info(`[Signal] Robot connected: ${deviceId}, clients waiting: ${room.clients.size}`);
}

/** 客户端加入 */
export function handleClientConnect(conn: ClientConnection): void {
  const { userId, robotId, ws } = conn;
  const room = getOrCreateRoom(robotId);
  room.clients.set(ws, conn);

  // 通知客户端当前设备状态
  send(ws, {
    type: "presence",
    deviceId: robotId,
    online: room.robot !== null,
  });

  logger.info(`[Signal] Client connected: user=${userId}, device=${robotId}, online=${room.robot !== null}`);
}

/** 机器人断开 */
export function handleRobotDisconnect(deviceId: string, ws: WebSocket): void {
  const room = rooms.get(deviceId);
  if (!room || !room.robot || room.robot.ws !== ws) return;

  room.robot = null;
  deviceOffline(deviceId);

  // 通知所有客户端：机器人离线
  for (const [, client] of room.clients) {
    send(client.ws, { type: "presence", deviceId, online: false });
  }

  logger.info(`[Signal] Robot disconnected: ${deviceId}`);
  removeRoomIfEmpty(deviceId);
}

/** 客户端断开 */
export function handleClientDisconnect(ws: WebSocket): void {
  for (const [, room] of rooms) {
    const client = room.clients.get(ws);
    if (!client) continue;

    room.clients.delete(ws);

    // 通知机器人：客户端断开
    if (room.robot) {
      send(room.robot.ws, {
        type: "client-disconnect",
        clientId: client.userId,
      });
    }

    logger.info(`[Signal] Client disconnected: user=${client.userId}, device=${client.robotId}`);
    removeRoomIfEmpty(client.robotId);
    return;
  }
}

/** 处理信令消息 */
export function handleMessage(
  conn: Connection,
  data: IncomingMessage,
): void {
  const { type } = data;

  switch (type) {
    case "call":
      handleCall(conn, data);
      break;
    case "answer":
      handleAnswer(conn, data);
      break;
    case "ice":
      handleIce(conn, data);
      break;
    case "ping":
      send(conn.ws, { type: "pong" });
      break;
    default:
      logger.warn(`[Signal] Unknown message type: ${type}`);
  }
}

/** 客户端 → 机器人：发起 WebRTC call（携带 SDP offer） */
function handleCall(conn: Connection, data: IncomingMessage): void {
  if (conn.role !== "client") return;

  const room = rooms.get(conn.robotId);
  if (!room?.robot) {
    send(conn.ws, { type: "error", message: "Device offline" });
    return;
  }

  // 生成 TURN 凭证
  let turn: { username: string; credential: string; ttl: number } | null = null;
  try {
    turn = generateTurnCredentials(conn.userId);
  } catch (err) {
    logger.error(`[Signal] Failed to generate TURN credentials: ${err}`);
  }

  // 转发 call 给机器人
  send(room.robot.ws, {
    type: "call",
    clientId: conn.userId,
    sdp: data.sdp,
  });

  // 回复客户端：携带 TURN 凭证
  send(conn.ws, {
    type: "call-ack",
    turn,
  });

  logger.info(`[Signal] Call forwarded: user=${conn.userId}, device=${conn.robotId}`);
}

/** 机器人 → 客户端：回复 SDP answer */
function handleAnswer(conn: Connection, data: IncomingMessage): void {
  if (conn.role !== "robot") return;

  const room = rooms.get(conn.deviceId);
  if (!room) return;

  // 转发 answer 给所有客户端（或指定 clientId）
  const targetClientId = data.clientId;
  for (const [, client] of room.clients) {
    if (!targetClientId || client.userId === targetClientId) {
      send(client.ws, {
        type: "answer",
        sdp: data.sdp,
      });
    }
  }

  logger.info(`[Signal] Answer forwarded: device=${conn.deviceId}, client=${targetClientId || "all"}`);
}

/** 双向转发 ICE candidate */
function handleIce(conn: Connection, data: IncomingMessage): void {
  const targetClientId = data.clientId;

  if (conn.role === "client") {
    // 客户端 → 机器人
    const room = rooms.get(conn.robotId);
    if (!room?.robot) return;

    send(room.robot.ws, {
      type: "ice",
      clientId: conn.userId,
      candidate: data.candidate,
    });
  } else {
    // 机器人 → 客户端（指定或全部）
    const room = rooms.get(conn.deviceId);
    if (!room) return;

    for (const [, client] of room.clients) {
      if (!targetClientId || client.userId === targetClientId) {
        send(client.ws, {
          type: "ice",
          candidate: data.candidate,
        });
      }
    }
  }
}

/** 获取连接信息（用于日志） */
export function getStats(): { rooms: number; robots: number; clients: number } {
  let robots = 0;
  let clients = 0;
  for (const room of rooms.values()) {
    if (room.robot) robots++;
    clients += room.clients.size;
  }
  return { rooms: rooms.size, robots, clients };
}
