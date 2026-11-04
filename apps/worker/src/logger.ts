type Level = 'info' | 'warn' | 'error';
function log(level: Level, msg: string, meta: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, service: 'worker', msg, ...meta });
  (level === 'info' ? console.log : console.error)(line);
}
export const logger = {
  info: (m: string, meta?: Record<string, unknown>) => log('info', m, meta),
  warn: (m: string, meta?: Record<string, unknown>) => log('warn', m, meta),
  error: (m: string, meta?: Record<string, unknown>) => log('error', m, meta),
};
