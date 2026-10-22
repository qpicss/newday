// JSON-lines logger for stdout (collected by docker logs or journald).
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const createLogger = (level = 'info', write = (line) => process.stdout.write(`${line}\n`)) => {
  const threshold = LEVELS[level] ?? LEVELS.info;
  const log = (name) => (message, fields = {}) => {
    if (LEVELS[name] < threshold) return;
    write(JSON.stringify({ time: new Date().toISOString(), level: name, message, ...fields }));
  };
  return {
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
  };
};

module.exports = { createLogger };
