class WorkGate {
  constructor({ concurrency, maxQueue }) {
    this.concurrency = concurrency;
    this.maxQueue = maxQueue;
    this.running = 0;
    this.queue = [];
  }

  async run(task) {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  acquire() {
    if (this.running < this.concurrency) {
      this.running += 1;
      return Promise.resolve();
    }
    if (this.queue.length >= this.maxQueue) {
      const error = new Error(
        "O conversor está ocupado. Aguarde alguns instantes e tente novamente.",
      );
      error.status = 503;
      error.expected = true;
      return Promise.reject(error);
    }
    return new Promise((resolve) => this.queue.push(resolve));
  }

  release() {
    const next = this.queue.shift();
    if (next) next();
    else this.running = Math.max(0, this.running - 1);
  }
}

function createRateLimit({ limit, windowMs }) {
  const buckets = new Map();
  const middleware = (req, res, next) => {
    const now = Date.now();
    const key = clientKey(req);
    const recent = (buckets.get(key) || []).filter(
      (timestamp) => now - timestamp < windowMs,
    );
    res.set("RateLimit-Limit", String(limit));
    res.set("RateLimit-Remaining", String(Math.max(0, limit - recent.length)));
    if (recent.length >= limit) {
      const retryAfter = Math.max(
        1,
        Math.ceil((windowMs - (now - recent[0])) / 1000),
      );
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({
        error: "Limite temporário de conversões atingido. Tente novamente mais tarde.",
      });
    }
    recent.push(now);
    buckets.set(key, recent);
    return next();
  };
  middleware.cleanup = () => {
    const now = Date.now();
    for (const [key, values] of buckets) {
      const recent = values.filter((timestamp) => now - timestamp < windowMs);
      if (recent.length) buckets.set(key, recent);
      else buckets.delete(key);
    }
  };
  return middleware;
}

function clientKey(req) {
  return String(req.ip || req.socket.remoteAddress || "desconhecido")
    .toLowerCase()
    .replace(/^::ffff:/, "");
}

module.exports = { WorkGate, createRateLimit };
