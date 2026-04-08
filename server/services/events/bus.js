const { EventEmitter } = require("events");
const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const logger = require("../../lib/logger");

const REDIS_URL = String(process.env.REDIS_URL || "").trim();
const QUEUE_NAME = String(process.env.EVENT_QUEUE_NAME || "events");

const localBus = new EventEmitter();
localBus.setMaxListeners(100);

let redisConnection = null;
let queue = null;

if (REDIS_URL) {
  redisConnection = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, enableReadyCheck: false });
  queue = new Queue(QUEUE_NAME, { connection: redisConnection });
}

async function publishEvent(type, payload) {
  const event = {
    type,
    payload: payload || {},
    timestamp: new Date().toISOString(),
  };

  if (queue) {
    try {
      await queue.add(type, event, {
        removeOnComplete: 500,
        removeOnFail: 1000,
      });
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      logger.error("events.queue.publish_failed", { type, error: msg });
      const err = new Error(`events.queue.publish_failed:${type}:${msg}`);
      err.cause = e;
      throw err;
    }
    return;
  }

  localBus.emit(type, event);
  localBus.emit("*", event);
}

function subscribeEvent(type, handler) {
  localBus.on(type, handler);
  return () => localBus.off(type, handler);
}

function getEventQueueConnection() {
  return { queueName: QUEUE_NAME, connection: redisConnection, enabled: Boolean(queue) };
}

module.exports = {
  publishEvent,
  subscribeEvent,
  getEventQueueConnection,
};
