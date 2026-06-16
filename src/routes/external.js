const express = require('express');
const router = express.Router();
const RateLimit = require('express-rate-limit');
const messageModel = require('../models/message');
const userModel = require('../models/user');
const sessionModel = require('../models/session');
const whatsapp = require('../services/whatsapp');
const queue = require('../queue/sender');
const { apiKeyAuth } = require('../middleware/auth');
const { antiBanDelay, validateMessageContent, enforceQuota } = require('../utils/protection');

const apiLimiter = RateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(apiLimiter);

function asyncWrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.post('/send', apiKeyAuth, enforceQuota, asyncWrap(async (req, res) => {
  const { to, message, sessionId, webhookUrl } = req.body;
  if (!to || !message || !sessionId) {
    return res.status(400).json({ error: 'to, message, sessionId required' });
  }

  if (!validateMessageContent(message)) {
    return res.status(400).json({ error: 'Message flagged as spam. Please revise content.' });
  }

  const session = sessionModel.findByUserIdAndId(req.apiUser.id, sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const status = whatsapp.getStatus(sessionId);
  if (status !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }

  const msg = messageModel.createMessage({
    userId: req.apiUser.id, sessionId, to, message, webhookUrl
  });

  const delay = antiBanDelay(0, 1);
  await queue.addToQueue({ userId: req.apiUser.id, sessionId, to, message, messageId: msg.id, delay });

  res.status(202).json({ messageId: msg.id, status: 'queued', estimatedDelay: delay });
}));

router.post('/send-bulk', apiKeyAuth, enforceQuota, asyncWrap(async (req, res) => {
  const { messages, sessionId, webhookUrl } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  if (messages.length > 500) {
    return res.status(400).json({ error: 'Max 500 messages per request' });
  }

  const session = sessionModel.findByUserIdAndId(req.apiUser.id, sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const status = whatsapp.getStatus(sessionId);
  if (status !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp not connected' });
  }

  const user = req.apiUser;
  const remaining = user.maxMessages - user.usedMessages;
  if (messages.length > remaining) {
    return res.status(403).json({ error: `Quota exceeded. You have ${remaining} messages remaining.` });
  }

  const ids = [];
  let spamCount = 0;

  for (let i = 0; i < messages.length; i++) {
    const { to, message } = messages[i];
    if (!to || !message) continue;

    if (!validateMessageContent(message)) {
      spamCount++;
      continue;
    }

    const msg = messageModel.createMessage({
      userId: req.apiUser.id, sessionId, to, message, webhookUrl
    });

    const delay = antiBanDelay(i, messages.length);

    await queue.addToQueue({
      userId: req.apiUser.id, sessionId, to, message, messageId: msg.id, delay
    });

    ids.push(msg.id);
  }

  res.status(202).json({
    messageIds: ids,
    total: ids.length,
    spamFiltered: spamCount,
    note: 'Messages queued with anti-ban delays'
  });
}));

router.get('/status/:messageId', apiKeyAuth, asyncWrap(async (req, res) => {
  const msg = messageModel.findById(req.params.messageId);
  if (!msg) return res.status(404).json({ error: 'Message not found' });
  if (msg.userId !== req.apiUser.id) return res.status(403).json({ error: 'Unauthorized' });
  res.json({ id: msg.id, to: msg.to, status: msg.status, error: msg.error, createdAt: msg.createdAt });
}));

router.get('/balance', apiKeyAuth, asyncWrap(async (req, res) => {
  const user = req.apiUser;
  res.json({
    apiKey: user.apiKey,
    maxMessages: user.maxMessages,
    usedMessages: user.usedMessages,
    remaining: user.maxMessages - user.usedMessages,
    expiryDate: user.expiryDate,
    status: user.status
  });
}));

router.post('/regenerate-key', apiKeyAuth, asyncWrap(async (req, res) => {
  const { v4: uuidv4 } = require('uuid');
  const newKey = uuidv4().replace(/-/g, '');
  userModel.updateUser(req.apiUser.id, { apiKey: newKey });
  res.json({ apiKey: newKey });
}));

router.post('/sessions', apiKeyAuth, asyncWrap(async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const session = sessionModel.createSession(req.apiUser.id, { phone, name });
  whatsapp.createClient(session.id, req.apiUser.id).catch(err => {
    console.error(`Session ${session.id} error:`, err.message);
  });
  res.status(201).json({ id: session.id, phone: session.phone, status: 'initializing' });
}));

router.get('/sessions', apiKeyAuth, asyncWrap(async (req, res) => {
  const sessions = sessionModel.findByUser(req.apiUser.id);
  res.json(sessions.map(s => ({ id: s.id, phone: s.phone, name: s.name, status: whatsapp.getStatus(s.id), createdAt: s.createdAt })));
}));

router.delete('/sessions/:id', apiKeyAuth, asyncWrap(async (req, res) => {
  const session = sessionModel.findByUserIdAndId(req.apiUser.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  await whatsapp.destroyClient(session.id);
  sessionModel.deleteSession(session.id);
  res.json({ success: true });
}));

module.exports = router;
