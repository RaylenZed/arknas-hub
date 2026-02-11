export function logInfo(message, meta = {}) {
  console.log(JSON.stringify({ level: "info", message, ...meta, ts: new Date().toISOString() }));
}

export function logError(message, error, meta = {}) {
  console.error(
    JSON.stringify({
      level: "error",
      message,
      error: error?.message || String(error),
      stack: error?.stack,
      ...meta,
      ts: new Date().toISOString()
    })
  );
}
