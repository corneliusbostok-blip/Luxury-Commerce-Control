const { Worker } = require("bullmq");
const logger = require("../../lib/logger");
const { getEventQueueConnection, subscribeEvent } = require("./bus");

function startEventWorker(handlers = {}) {
  const { queueName, connection, enabled } = getEventQueueConnection();
  if (!enabled || !connection) {
    subscribeEvent("*", async (event) => {
      const h = handlers[event.type] || handlers["*"];
      if (typeof h === "function") await h(event);
    });
    return { mode: "in-process" };
  }

  const worker = new Worker(
    queueName,
    async (job) => {
      const event = job.data || {};
      const h = handlers[event.type] || handlers["*"];
      if (typeof h === "function") await h(event);
    },
    { connection, concurrency: Number(process.env.EVENT_WORKER_CONCURRENCY) || 8 }
  );

  worker.on("failed", (job, err) => {
    logger.error("events.worker.failed", { jobId: job && job.id, error: err.message || String(err) });
  });

  return { mode: "bullmq", worker };
}

module.exports = { startEventWorker };
