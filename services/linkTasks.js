// Work the console hands to pull nodes over the gateway link. Pull nodes have no inbound port, so
// they long-poll GET /v1/tasks (services/linkServer.js) and post the result back. Used for flow
// tests from the policy editor and for the live request log. In memory: tasks only live while
// someone waits for them.
const crypto = require('crypto');

// A node that polled within this time is connected: it polls again as soon as a task is done.
const CONNECTED_MS = 75000;

const waiters = new Map(); // gatewayId -> [{ nodeName, resolve }]
const queued = new Map(); // gatewayId -> [task waiting for a poll]
const pending = new Map(); // taskId -> { gatewayId, node, resolve, timer }
const lastPoll = new Map(); // `${gatewayId}/${nodeName}` -> time of the last poll

const listOf = (map, gatewayId) => {
  if (!map.has(gatewayId)) map.set(gatewayId, []);
  return map.get(gatewayId);
};

// Names of the nodes of a gateway that are connected to the link right now.
const pollingNodes = (gatewayId) => {
  const names = new Set((waiters.get(gatewayId) || []).map((waiter) => waiter.nodeName));
  const prefix = `${gatewayId}/`;
  for (const [key, time] of lastPoll) {
    if (key.startsWith(prefix) && Date.now() - time < CONNECTED_MS) names.add(key.slice(prefix.length));
  }
  return [...names];
};

const forNode = (task, nodeName) => !task.node || task.node === nodeName;

// Hands a task to a node and starts waiting for its result.
const dispatch = (gatewayId, task, nodeName, resolveTask) => {
  pending.set(task.id, { gatewayId, node: nodeName, resolve: task.resolve, timer: task.timer });
  resolveTask({ id: task.id, kind: task.kind, payload: task.payload });
};

// Called by the link for a node's poll. Resolves to a task, or null after `waitMs`.
// `cancel` stops waiting early (the node disconnected).
const nextTask = (gatewayId, nodeName, waitMs) => {
  lastPoll.set(`${gatewayId}/${nodeName}`, Date.now());
  const queue = listOf(queued, gatewayId);
  const index = queue.findIndex((task) => forNode(task, nodeName));
  if (index >= 0) {
    const [task] = queue.splice(index, 1);
    let delivered;
    const promise = new Promise((resolve) => { delivered = resolve; });
    dispatch(gatewayId, task, nodeName, delivered);
    return { promise, cancel: () => {} };
  }
  let waiter;
  const promise = new Promise((resolve) => {
    const timer = setTimeout(() => finish(null), waitMs);
    const finish = (task) => {
      clearTimeout(timer);
      const list = listOf(waiters, gatewayId);
      const at = list.indexOf(waiter);
      if (at >= 0) list.splice(at, 1);
      lastPoll.set(`${gatewayId}/${nodeName}`, Date.now());
      resolve(task);
    };
    waiter = { nodeName, resolve: finish };
    listOf(waiters, gatewayId).push(waiter);
  });
  return { promise, cancel: () => waiter.resolve(null) };
};

// Gives a task to a connected node of the gateway (`node` names one) and waits for its result:
// { status, body, node }. Resolves to null when no such node is connected.
const runTask = (gatewayId, kind, payload, { timeoutMs = 60000, node = null } = {}) => {
  const connected = pollingNodes(gatewayId).filter((name) => !node || name === node);
  if (!connected.length) return Promise.resolve(null);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const task = { id, kind, payload, node, resolve };
    task.timer = setTimeout(() => {
      const queue = listOf(queued, gatewayId);
      const at = queue.indexOf(task);
      if (at >= 0) queue.splice(at, 1);
      const running = pending.get(id);
      pending.delete(id);
      const name = running?.node || node || connected[0];
      resolve({ status: 504, body: { message: `The node ${name} took longer than ${timeoutMs / 1000} seconds to answer` }, node: name });
    }, timeoutMs);
    const waiter = (waiters.get(gatewayId) || []).find((candidate) => forNode(task, candidate.nodeName));
    if (waiter) dispatch(gatewayId, task, waiter.nodeName, waiter.resolve);
    else listOf(queued, gatewayId).push(task); // the node is busy: it takes the task on its next poll
  });
};

// Called by the link when a node posts a result. Returns false for an unknown task.
const completeTask = (gatewayId, taskId, result) => {
  const task = pending.get(taskId);
  if (!task || task.gatewayId !== gatewayId) return false;
  pending.delete(taskId);
  clearTimeout(task.timer);
  task.resolve({ status: Number(result?.status) || 500, body: result?.body || null, node: task.node });
  return true;
};

module.exports = { nextTask, runTask, completeTask, pollingNodes };
