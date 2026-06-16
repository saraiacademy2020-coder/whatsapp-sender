const messageModel = require('../models/message');
const userModel = require('../models/user');
const whatsapp = require('../services/whatsapp');
const { sendWebhook } = require('../routes/webhook');

async function fireWebhook(messageId, status, error) {
  const msg = messageModel.findById(messageId);
  if (!msg || !msg.webhookUrl || msg.webhookSent) return;
  await sendWebhook(msg.webhookUrl, { messageId, to: msg.to, status, error, timestamp: new Date().toISOString() });
  messageModel.updateMessage(messageId, { webhookSent: true });
}

let redisAvailable = false;

try {
  const Redis = require('ioredis');
  const { Queue, Worker } = require('bullmq');

  const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: () => null
  };

  const testClient = new Redis(connection);
  testClient.on('ready', () => {
    redisAvailable = true;
    testClient.disconnect();
  });
  testClient.on('error', () => {
    redisAvailable = false;
    testClient.disconnect();
  });

  let messageQueue = null;
  let worker = null;

  function getQueue() {
    if (!messageQueue) {
      messageQueue = new Queue('whatsapp-messages', { connection });
    }
    return messageQueue;
  }

  async function startWorker(io) {
    if (worker) return;

    if (!redisAvailable) {
      console.log('  Queue: Redis not available, messages sent directly');
      return;
    }

    worker = new Worker('whatsapp-messages', async (job) => {
      const { userId, sessionId, to, message, messageId, delay } = job.data;

      if (delay && delay > 0) {
        await new Promise(resolve => setTimeout(resolve, delay * 1000));
      }

      try {
        const sent = await whatsapp.sendMessage(sessionId, to, message, messageId);
        messageModel.updateMessage(messageId, { status: 'sent' });
        userModel.incrementUsed(userId);
        fireWebhook(messageId, 'sent');
        if (io) {
          io.to(`user:${userId}`).emit('message-status', { messageId, status: 'sent', to });
        }
        return { status: 'sent' };
      } catch (err) {
        messageModel.updateMessage(messageId, { status: 'failed', error: err.message });
        fireWebhook(messageId, 'failed', err.message);
        if (io) {
          io.to(`user:${userId}`).emit('message-status', { messageId, status: 'failed', to, error: err.message });
        }
        return { status: 'failed', error: err.message };
      }
    }, { connection, concurrency: 5 });

    worker.on('failed', (job, err) => console.error(`  Job ${job.id} failed:`, err.message));
  }

  async function addToQueue({ userId, sessionId, to, message, messageId, delay = 0 }) {
    if (!redisAvailable) {
      await new Promise(resolve => setTimeout(resolve, (delay || 0) * 1000));
      try {
        const sent = await whatsapp.sendMessage(sessionId, to, message, messageId);
        messageModel.updateMessage(messageId, { status: 'sent' });
        userModel.incrementUsed(userId);
        fireWebhook(messageId, 'sent');
        return { status: 'sent' };
      } catch (err) {
        messageModel.updateMessage(messageId, { status: 'failed', error: err.message });
        fireWebhook(messageId, 'failed', err.message);
        return { status: 'failed', error: err.message };
      }
    }
    const queue = getQueue();
    return queue.add('send-message', { userId, sessionId, to, message, messageId, delay }, {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 }
    });
  }

  async function getQueueStats() {
    if (!redisAvailable) return { waiting: 0, active: 0, completed: 0, failed: 0, mode: 'direct' };
    const queue = getQueue();
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(), queue.getActiveCount(),
      queue.getCompletedCount(), queue.getFailedCount()
    ]);
    return { waiting, active, completed, failed, mode: 'redis' };
  }

  async function closeQueue() {
    if (worker) await worker.close();
    if (messageQueue) await messageQueue.close();
  }

  module.exports = { startWorker, addToQueue, getQueueStats, closeQueue };

} catch (err) {
  console.log('  Queue: BullMQ not available, sending directly');
  module.exports = {
    startWorker: async () => {},
    addToQueue: async ({ userId, sessionId, to, message, messageId, delay = 0 }) => {
      if (delay) await new Promise(r => setTimeout(r, delay * 1000));
      try {
        const sent = await whatsapp.sendMessage(sessionId, to, message, messageId);
        messageModel.updateMessage(messageId, { status: 'sent' });
        userModel.incrementUsed(userId);
        fireWebhook(messageId, 'sent');
        return { status: 'sent' };
      } catch (err) {
        messageModel.updateMessage(messageId, { status: 'failed', error: err.message });
        fireWebhook(messageId, 'failed', err.message);
        return { status: 'failed', error: err.message };
      }
    },
    getQueueStats: async () => ({ waiting: 0, active: 0, completed: 0, failed: 0, mode: 'direct' }),
    closeQueue: async () => {}
  };
}
