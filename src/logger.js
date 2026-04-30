/**
 * Logger estruturado JSON (pino).
 *
 * Em produção: JSON estrito, level INFO+ (configurável via LOG_LEVEL).
 * Em dev: pino-pretty se NODE_ENV=development e tty disponível — mas
 * pra evitar dep extra (pino-pretty), default JSON sempre. Pode plugar
 * pino-pretty manual no docker compose.
 *
 * Cada log inclui: { level, time, msg, ...context }.
 * Request logs incluem requestId via middleware/requestId.js.
 */
import pino from 'pino';

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const logger = pino({
  level,
  base: {
    service: 'rivus-api',
    version: process.env.RIVUS_API_VERSION || 'dev',
    env: process.env.NODE_ENV || 'development',
  },
  // Pino padrão — serialização eficiente, sem pino-pretty pra evitar dep
  // extra na imagem Alpine. Em dev, `npm i -D pino-pretty` + `| pino-pretty`.
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

export default logger;
