// Runs gateway scripts in a small pool of worker threads.
// A script that runs past its time limit (for example an endless async loop) or exhausts memory
// takes down only its worker: the worker is restarted with the active scripts and the gateway
// process keeps serving traffic.
//
// Scripts ask the main thread for HTTP requests and rate limits through `host(kind, args, meta)`,
// where `meta` is what the caller passed to run() plus the script's deadline.
const path = require('path');
const { Worker } = require('worker_threads');
const { PolicyError, clampTimeout } = require('./policy');

const WORKER_FILE = path.join(__dirname, 'policyWorker.js');
const RESOURCE_LIMITS = { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 32 };
// Extra time on top of the script's own limit for messaging between threads.
const MESSAGE_ALLOWANCE_MS = 1000;

const noHost = async (kind) => {
  throw new Error(`${kind} is not available here`);
};

class PolicyRunner {
  constructor({ size = 2, logger, host = noHost }) {
    this.size = Math.max(1, size);
    this.logger = logger;
    this.host = host;
    this.slots = [];
    this.nextId = 1;
    this.generation = 0;
    this.testCounter = 0;
    this.active = null; // { generation, scripts }
    this.closed = false;
    for (let index = 0; index < this.size; index += 1) this.spawn(index);
  }

  spawn(index) {
    const worker = new Worker(WORKER_FILE, { resourceLimits: RESOURCE_LIMITS });
    const slot = { index, worker, pending: new Map() };
    this.slots[index] = slot;

    worker.on('message', (message) => {
      if (message.type === 'host') {
        this.answerHost(slot, message);
        return;
      }
      const pending = slot.pending.get(message.id);
      if (!pending) return;
      slot.pending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
    });
    worker.on('error', (error) => {
      this.logger.error('policy worker failed', { worker: index, error: error.message });
    });
    worker.on('exit', () => {
      for (const pending of slot.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new PolicyError('The policy worker restarted while handling this request'));
      }
      slot.pending.clear();
      if (!this.closed && this.slots[index] === slot) {
        this.logger.warn('restarting policy worker', { worker: index });
        this.spawn(index);
      }
    });

    worker.unref();
    // A replacement worker loads the scripts that are currently live.
    if (this.active) {
      this.send(slot, { type: 'load', generation: this.active.generation, scripts: this.active.scripts }, 30000)
        .then(() => slot.worker.postMessage({ type: 'retain', generation: this.active.generation }))
        .catch(() => {});
    }
    return slot;
  }

  answerHost(slot, message) {
    const meta = slot.pending.get(message.id)?.meta || {};
    Promise.resolve()
      .then(() => this.host(message.kind, message.args || {}, { ...meta, deadline: message.deadline }))
      .then(
        (value) => ({ type: 'hostResult', callId: message.callId, ok: true, value: value === undefined ? null : value }),
        (error) => ({ type: 'hostResult', callId: message.callId, ok: false, error: String(error?.message || error) })
      )
      .then((reply) => {
        if (this.slots[slot.index] === slot) slot.worker.postMessage(reply);
      });
  }

  send(slot, message, timeoutMs, { onTimeout, meta } = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        slot.pending.delete(id);
        reject(new PolicyError('timeout'));
        if (onTimeout) onTimeout();
      }, timeoutMs);
      slot.pending.set(id, { resolve, reject, timer, meta });
      slot.worker.postMessage({ ...message, id });
    });
  }

  async loadOn(slots, generation, scripts) {
    const replies = await Promise.all(slots.map((slot) => this.send(slot, { type: 'load', generation, scripts }, 30000)));
    const errors = replies.flatMap((reply) => reply.errors || []);
    if (errors.length) throw new PolicyError(errors[0].message);
  }

  // Compiles a set of scripts on every worker. Resolves to { generation } or throws a PolicyError
  // describing the first script that failed. Live traffic is unaffected until activate().
  async load(scripts) {
    this.generation += 1;
    const { generation } = this;
    await this.loadOn(this.slots, generation, scripts);
    return { generation };
  }

  activate(generation, scripts) {
    this.active = { generation, scripts };
    for (const slot of this.slots) slot.worker.postMessage({ type: 'retain', generation });
  }

  leastBusy() {
    return this.slots.reduce((best, candidate) => (candidate.pending.size < best.pending.size ? candidate : best));
  }

  async runOn(slot, generation, key, input, timeoutMs, meta = {}) {
    let reply;
    const limit = clampTimeout(timeoutMs);
    try {
      reply = await this.send(slot, { type: 'run', generation, key, input }, limit + MESSAGE_ALLOWANCE_MS, {
        meta,
        onTimeout: () => {
          this.logger.warn('script timed out; restarting its worker', { worker: slot.index, key });
          // Put the replacement in place first so new requests never reach the stuck worker.
          this.spawn(slot.index);
          slot.worker.terminate();
        },
      });
    } catch (error) {
      if (error.message === 'timeout') {
        const timeout = new PolicyError(`The script did not finish within ${limit} ms`);
        timeout.timedOut = true;
        throw timeout;
      }
      throw error;
    }
    if (reply.error) {
      const error = new PolicyError(reply.error, { logs: reply.logs });
      if (/did not finish within/.test(reply.error)) error.timedOut = true;
      throw error;
    }
    return { ...reply.result, durationMs: reply.durationMs };
  }

  run(generation, key, input, timeoutMs, meta) {
    return this.runOn(this.leastBusy(), generation, key, input, timeoutMs, meta);
  }

  // Loads scripts that are not part of the live configuration (a flow test in the console) on one
  // worker. Returns { run(key, input, timeoutMs, meta), drop() }.
  async loadTemporary(scripts) {
    this.testCounter += 1;
    const generation = `test-${this.testCounter}`;
    const slot = this.leastBusy();
    await this.loadOn([slot], generation, scripts);
    return {
      run: (key, input, timeoutMs, meta) => {
        if (this.slots[slot.index] !== slot) {
          return Promise.reject(new PolicyError('The policy worker restarted during the test. Run it again.'));
        }
        return this.runOn(slot, generation, key, input, timeoutMs, meta);
      },
      drop: () => {
        if (this.slots[slot.index] === slot) slot.worker.postMessage({ type: 'drop', generation });
      },
    };
  }

  async close() {
    this.closed = true;
    await Promise.all(this.slots.map((slot) => slot.worker.terminate()));
  }
}

module.exports = { PolicyRunner };
