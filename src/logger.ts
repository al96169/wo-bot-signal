type LogLevel = "debug" | "info" | "warn" | "error";

const levelPriority: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const currentLevel: LogLevel = (process.env.LOG_LEVEL as LogLevel) || "info";

function timestamp(): string {
  return new Date().toISOString();
}

export const logger = {
  debug(msg: string) {
    if (levelPriority.debug >= levelPriority[currentLevel]) {
      console.log(`[${timestamp()}] [DEBUG] ${msg}`);
    }
  },
  info(msg: string) {
    if (levelPriority.info >= levelPriority[currentLevel]) {
      console.log(`[${timestamp()}] [INFO]  ${msg}`);
    }
  },
  warn(msg: string) {
    if (levelPriority.warn >= levelPriority[currentLevel]) {
      console.warn(`[${timestamp()}] [WARN]  ${msg}`);
    }
  },
  error(msg: string) {
    if (levelPriority.error >= levelPriority[currentLevel]) {
      console.error(`[${timestamp()}] [ERROR] ${msg}`);
    }
  },
};
