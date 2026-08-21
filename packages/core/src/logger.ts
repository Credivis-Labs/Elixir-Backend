import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(name: string, level = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    name,
    level,
    redact: { paths: ["*.secret", "*.secrets", "*.seed", "*.privateKey"], censor: "[redacted]" },
  });
}
