import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { logger } from "./logger.js";

// 验证结果缓存：5 分钟 TTL
interface CacheEntry {
  result: boolean;
  expiresAt: number;
}
const ownershipCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 分钟

// 限流：单 IP 每秒最多 3 次连接尝试
const ipAttemptMap = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS_PER_SEC = 3;

const JWT_SECRET = process.env.JWT_SECRET || "";
const ROBOT_SECRET = process.env.ROBOT_SECRET || "";
const ACCOUNT_API_URL = (process.env.ACCOUNT_API_URL || "").replace(/\/$/, "");

if (!JWT_SECRET || !ROBOT_SECRET || !ACCOUNT_API_URL) {
  logger.error("Missing required env vars: JWT_SECRET, ROBOT_SECRET, ACCOUNT_API_URL");
}

/** HMAC-SHA256 签名（与 wo-bot-control account_client._sign() 一致） */
function signHmac(robotId: string, timestamp: number): string {
  const message = `${robotId}:${timestamp}`;
  return crypto.createHmac("sha256", ROBOT_SECRET).update(message).digest("hex");
}

/** constant-time 字符串比较 */
function timingSafeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf-8");
  const bBuf = Buffer.from(b, "utf-8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

/** 检查 IP 限流 */
export function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = ipAttemptMap.get(ip);
  if (!entry || now > entry.resetAt) {
    ipAttemptMap.set(ip, { count: 1, resetAt: now + 1000 });
    return true;
  }
  if (entry.count >= MAX_ATTEMPTS_PER_SEC) return false;
  entry.count++;
  return true;
}

/** 验证客户端 JWT（本地验证，提取 userId） */
export function verifyJwt(token: string): { userId: string } | null {
  if (!JWT_SECRET) {
    logger.error("[Auth] JWT_SECRET not configured");
    return null;
  }

  try {
    // 先解码 header 检查 alg（防 alg=none 攻击）
    const decodedHeader = jwt.decode(token, { complete: true });
    if (!decodedHeader || (decodedHeader.header as { alg: string }).alg === "none") {
      logger.warn("[Auth] JWT uses alg=none, rejected");
      return null;
    }

    const payload = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
    }) as { sub?: string; exp?: number };

    const userId = payload.sub;
    if (!userId) {
      logger.warn("[Auth] JWT missing sub claim");
      return null;
    }

    return { userId };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      logger.info("[Auth] JWT expired");
    } else {
      logger.warn(`[Auth] JWT invalid: ${err}`);
    }
    return null;
  }
}

/** 查询设备归属 userId（调用帐号服务器 GET /api/devices/:robotId/owner） */
async function queryDeviceOwner(robotId: string): Promise<string | null> {
  if (!ACCOUNT_API_URL) {
    logger.error("[Auth] ACCOUNT_API_URL not configured");
    return null;
  }

  const timestamp = Date.now();
  const signature = signHmac(robotId, timestamp);

  try {
    const url = `${ACCOUNT_API_URL}/api/devices/${encodeURIComponent(robotId)}/owner`;
    const resp = await fetch(url, {
      headers: {
        "X-Robot-Id": robotId,
        "X-Timestamp": String(timestamp),
        "X-Signature": signature,
        "User-Agent": "wo-bot-signal/1.0",
      },
    });

    if (resp.status !== 200) {
      logger.warn(`[Auth] Owner query failed: ${resp.status} for ${robotId}`);
      return null;
    }

    const data = (await resp.json()) as { success: boolean; data: { userId: string | null } };
    return data.data?.userId ?? null;
  } catch (err) {
    logger.error(`[Auth] Owner query error: ${err}`);
    return null;
  }
}

/**
 * 客户端认证：JWT 验证 + 设备归属校验（两步）
 * 1. 本地验证 JWT 签名，提取 userId
 * 2. 调用帐号服务器查询设备归属，比对 userId
 * 返回 userId（验证通过）或 null（失败）
 */
export async function authenticateClient(
  token: string,
  robotId: string,
): Promise<string | null> {
  // 第 1 步：JWT 本地验证
  const jwtResult = verifyJwt(token);
  if (!jwtResult) return null;
  const { userId } = jwtResult;

  // 缓存检查
  const cacheKey = `${userId}:${robotId}`;
  const cached = ownershipCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.result ? userId : null;
  }

  // 第 2 步：设备归属校验
  const ownerUserId = await queryDeviceOwner(robotId);
  if (!ownerUserId) {
    logger.info(`[Auth] Device ${robotId} has no owner`);
    ownershipCache.set(cacheKey, { result: false, expiresAt: Date.now() + CACHE_TTL });
    return null;
  }

  if (ownerUserId !== userId) {
    logger.warn(`[Auth] JWT user ${userId} != device owner ${ownerUserId}`);
    ownershipCache.set(cacheKey, { result: false, expiresAt: Date.now() + CACHE_TTL });
    return null;
  }

  logger.info(`[Auth] Client authenticated: user=${userId}, device=${robotId}`);
  ownershipCache.set(cacheKey, { result: true, expiresAt: Date.now() + CACHE_TTL });
  return userId;
}

/**
 * 机器人认证：HMAC-SHA256 + 时间戳窗口
 * 返回 deviceId（验证通过）或 null（失败）
 */
export function authenticateRobot(
  deviceId: string,
  timestamp: string,
  signature: string,
): string | null {
  if (!ROBOT_SECRET) {
    logger.error("[Auth] ROBOT_SECRET not configured");
    return null;
  }

  // 时间戳窗口：5 分钟
  const ts = Number(timestamp);
  if (!ts || isNaN(ts)) {
    logger.warn("[Auth] Robot auth: invalid timestamp");
    return null;
  }

  const now = Date.now();
  const drift = Math.abs(now - ts);
  if (drift > 5 * 60 * 1000) {
    logger.warn(`[Auth] Robot auth: timestamp drift ${drift}ms > 5min`);
    return null;
  }

  // HMAC 比对
  const expectedSig = signHmac(deviceId, ts);
  if (!timingSafeEqual(signature, expectedSig)) {
    logger.warn(`[Auth] Robot auth: signature mismatch for ${deviceId}`);
    return null;
  }

  logger.info(`[Auth] Robot authenticated: ${deviceId}`);
  return deviceId;
}
