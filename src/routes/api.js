const express = require('express');
const router = express.Router();
const userModel = require('../models/user');
const sessionModel = require('../models/session');
const messageModel = require('../models/message');
const auth = require('../services/auth');
const { authenticate } = require('../middleware/auth');
const whatsapp = require('../services/whatsapp');
const queue = require('../queue/sender');
const db = require('../database/db');

function asyncWrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.post('/auth/register', asyncWrap(async (req, res) => {
  const { name, email, password, maxMessages, expiryDays, planId, createdBy } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Name, email, and password required' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const hashed = await auth.hashPassword(password);
  const user = userModel.createUser({ name, email, password: hashed, maxMessages, expiryDays, planId, createdBy });
  const token = auth.generateToken(user);
  res.status(201).json({ user, token });
}));

router.post('/auth/login', asyncWrap(async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }
  const user = userModel.findByEmail(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const valid = await auth.comparePassword(password, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  if (user.status !== 'active') {
    return res.status(403).json({ error: `Account is ${user.status}` });
  }
  const token = auth.generateToken(user);
  res.json({ user: userModel.sanitize(user), token });
}));

router.get('/me', authenticate, asyncWrap(async (req, res) => {
  const user = userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const stats = messageModel.getUserStats(req.user.id);
  const plans = db.readAll('pricing');
  const plan = plans.find(p => p.id === user.planId) || null;
  const sessions = sessionModel.findByUser(req.user.id);
  res.json({
    user: userModel.sanitize(user),
    stats,
    plan,
    sessionsCount: sessions.length,
    sessionsLimit: plan?.sessions || 1
  });
}));

router.get('/pricing', asyncWrap(async (req, res) => {
  const plans = db.readAll('pricing');
  res.json(plans);
}));

router.put('/plan', authenticate, asyncWrap(async (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId required' });
  const plans = db.readAll('pricing');
  const plan = plans.find(p => p.id === planId);
  if (!plan) return res.status(400).json({ error: 'Plan not found' });
  const user = userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const days = plan.days || 30;
  const newExpiry = new Date(Date.now() + days * 86400000).toISOString();
  userModel.updateUser(req.user.id, { planId, maxMessages: plan.messages, expiryDate: newExpiry });
  res.json({ planId, maxMessages: plan.messages, sessions: plan.sessions, expiryDate: newExpiry });
}));

router.post('/regenerate-key', authenticate, asyncWrap(async (req, res) => {
  const newKey = require('uuid').v4().replace(/-/g, '');
  userModel.updateUser(req.user.id, { apiKey: newKey });
  res.json({ apiKey: newKey });
}));

router.put('/change-password', authenticate, asyncWrap(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password required' });
  }
  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters' });
  }
  const user = userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const valid = await auth.comparePassword(currentPassword, user.password);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });
  const hashed = await auth.hashPassword(newPassword);
  userModel.updateUser(req.user.id, { password: hashed });
  res.json({ message: 'Password updated successfully' });
}));

router.get('/sessions', authenticate, asyncWrap(async (req, res) => {
  const sessions = sessionModel.findByUser(req.user.id);
  const withStatus = sessions.map(s => ({
    ...s,
    status: whatsapp.getStatus(s.id),
    qrCode: s.status === 'waiting_qr' || s.status === 'waiting_code' ? s.qrCode : null
  }));
  res.json(withStatus);
}));

router.post('/sessions', authenticate, asyncWrap(async (req, res) => {
  const { phone, name } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const user = userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const plans = db.readAll('pricing');
  const plan = plans.find(p => p.id === user.planId) || { sessions: 1 };
  const maxSessions = plan.sessions || 1;
  const currentSessions = sessionModel.findByUser(req.user.id).length;
  if (currentSessions >= maxSessions) {
    return res.status(403).json({ error: `Your plan allows only ${maxSessions} session(s). Upgrade to add more.` });
  }
  const session = sessionModel.createSession(req.user.id, { phone, name });
  whatsapp.createClient(session.id, req.user.id).catch(err => {
    console.error(`Session ${session.id} init error:`, err.message);
  });
  res.status(201).json(session);
}));

router.delete('/sessions/:id', authenticate, asyncWrap(async (req, res) => {
  const session = sessionModel.findByUserIdAndId(req.user.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  await whatsapp.destroyClient(session.id);
  sessionModel.deleteSession(session.id);
  res.json({ success: true });
}));

router.post('/sessions/:id/reconnect', authenticate, asyncWrap(async (req, res) => {
  const session = sessionModel.findByUserIdAndId(req.user.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  // Destroy existing client to force fresh connection
  const existing = whatsapp.getClient(session.id);
  if (existing) {
    try { existing.end(undefined); } catch { try { existing.ws?.close(); } catch {} }
    whatsapp.clients.delete(session.id);
  }
  whatsapp.statuses.set(session.id, 'connecting');
  sessionModel.updateSession(session.id, { status: 'connecting', qrCode: null, updatedAt: new Date().toISOString() });
  whatsapp.createClient(session.id, req.user.id).catch(err => {
    console.error(`Reconnect ${session.id} error:`, err.message);
  });
  res.json({ success: true, status: 'connecting' });
}));

// Client: request plan upgrade (sends request to admin)
router.post('/request-upgrade', authenticate, asyncWrap(async (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId required' });
  const plans = db.readAll('pricing');
  const plan = plans.find(p => p.id === planId);
  if (!plan) return res.status(400).json({ error: 'Plan not found' });
  const user = userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.planId === planId) return res.status(400).json({ error: 'Already on this plan' });
  db.initCollection('upgrade_requests', []);
  const existing = db.findOne('upgrade_requests', r => r.userId === req.user.id && r.status === 'pending');
  if (existing) return res.status(400).json({ error: 'You already have a pending upgrade request' });
  const request = {
    id: require('uuid').v4(),
    userId: req.user.id,
    userEmail: user.email,
    userName: user.name,
    currentPlanId: user.planId,
    requestedPlanId: planId,
    status: 'pending',
    createdAt: new Date().toISOString()
  };
  db.insert('upgrade_requests', request);
  res.status(201).json({ success: true, message: 'Upgrade request sent to admin' });
}));

// Client: get my upgrade requests
router.get('/my-requests', authenticate, asyncWrap(async (req, res) => {
  db.initCollection('upgrade_requests', []);
  const requests = db.find('upgrade_requests', r => r.userId === req.user.id);
  res.json(requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
}));

// Client: reset free trial
router.post('/reset-trial', authenticate, asyncWrap(async (req, res) => {
  const user = userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const plans = db.readAll('pricing');
  const freePlan = plans.find(p => p.id === 'free');
  if (!freePlan) return res.status(500).json({ error: 'Free plan not found' });
  // Delete all user sessions
  const sessions = sessionModel.findByUser(req.user.id);
  for (const s of sessions) {
    try { await whatsapp.destroyClient(s.id); } catch {}
    sessionModel.deleteSession(s.id);
  }
  // Delete pending upgrade requests
  db.initCollection('upgrade_requests', []);
  const pending = db.find('upgrade_requests', r => r.userId === req.user.id && r.status === 'pending');
  for (const r of pending) db.remove('upgrade_requests', x => x.id === r.id);
  // Reset user to free plan
  const days = freePlan.days || 7;
  userModel.updateUser(req.user.id, {
    planId: 'free',
    maxMessages: freePlan.messages || 5,
    usedMessages: 0,
    expiryDate: new Date(Date.now() + days * 86400000).toISOString(),
    status: 'active'
  });
  res.json({ success: true, message: 'Trial reset successfully' });
}));

router.get('/sessions/:id/qr', authenticate, asyncWrap(async (req, res) => {
  const session = sessionModel.findByUserIdAndId(req.user.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ sessionId: session.id, status: whatsapp.getStatus(session.id) });
}));

router.post('/sessions/:id/request-code', authenticate, asyncWrap(async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const session = sessionModel.findByUserIdAndId(req.user.id, req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const client = whatsapp.getClient(session.id);
  if (!client) return res.status(400).json({ error: 'Session not initialized' });
  const code = await client.requestPairingCode(phone);
  res.json({ code });
}));

router.get('/messages', authenticate, asyncWrap(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const { search, status, sort: sortBy, order } = req.query;
  let result = messageModel.findByUser(req.user.id, page, limit);

  const sessions = sessionModel.findByUser(req.user.id);
  const sessionMap = {};
  sessions.forEach(s => { sessionMap[s.id] = s.name || s.phone || s.id; });
  let items = result.items.map(m => ({
    ...m,
    sender: sessionMap[m.sessionId] || m.sessionId
  }));

  if (search) {
    const q = search.toLowerCase();
    items = items.filter(m =>
      (m.to && m.to.toLowerCase().includes(q)) ||
      (m.message && m.message.toLowerCase().includes(q))
    );
  }

  if (status) {
    items = items.filter(m => m.status === status);
  }

  const sortOrder = order === 'asc' ? 1 : -1;
  if (sortBy === 'status') {
    items.sort((a, b) => sortOrder * (a.status || '').localeCompare(b.status || ''));
  } else if (sortBy === 'to') {
    items.sort((a, b) => sortOrder * (a.to || '').localeCompare(b.to || ''));
  } else {
    items.sort((a, b) => sortOrder * (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)));
  }

  const total = items.length;
  const pages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paginatedItems = items.slice(start, start + limit);

  res.json({ items: paginatedItems, total, page, pages, limit });
}));

router.post('/send', authenticate, asyncWrap(async (req, res) => {
  const { to, message, sessionId, delay = 0, webhookUrl } = req.body;
  if (!to || !message || !sessionId) {
    return res.status(400).json({ error: 'to, message, and sessionId required' });
  }

  const user = userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.usedMessages >= user.maxMessages) {
    return res.status(403).json({ error: 'Message quota exceeded. Upgrade your plan.' });
  }

  const session = sessionModel.findByUserIdAndId(req.user.id, sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const status = whatsapp.getStatus(sessionId);
  if (status !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp session not connected' });
  }

  const msg = messageModel.createMessage({
    userId: req.user.id, sessionId, to, message, webhookUrl
  });

  await queue.addToQueue({
    userId: req.user.id, sessionId, to, message, messageId: msg.id, delay
  });

  res.status(202).json({ messageId: msg.id, status: 'queued' });
}));

router.post('/send-bulk', authenticate, asyncWrap(async (req, res) => {
  const { messages, sessionId, webhookUrl } = req.body;
  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }
  if (!sessionId) return res.status(400).json({ error: 'sessionId required' });

  const user = userModel.findById(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.usedMessages >= user.maxMessages) {
    return res.status(403).json({ error: 'Message quota exceeded. Upgrade your plan.' });
  }
  const remaining = user.maxMessages - user.usedMessages;
  if (messages.length > remaining) {
    return res.status(400).json({ error: `Only ${remaining} messages remaining in your quota. Reduce the batch size.` });
  }

  const session = sessionModel.findByUserIdAndId(req.user.id, sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const status = whatsapp.getStatus(sessionId);
  if (status !== 'connected') {
    return res.status(400).json({ error: 'WhatsApp session not connected' });
  }

  const ids = [];
  for (let i = 0; i < messages.length; i++) {
    const { to, message } = messages[i];
    if (!to || !message) continue;

    const msg = messageModel.createMessage({
      userId: req.user.id, sessionId, to, message, webhookUrl
    });

    const baseDelay = parseInt(req.body.baseDelay) || 5;
    const randomExtra = parseInt(req.body.randomDelay) || 5;
    const delay = baseDelay + Math.floor(Math.random() * randomExtra);

    await queue.addToQueue({
      userId: req.user.id, sessionId, to, message, messageId: msg.id, delay
    });

    ids.push(msg.id);
  }

  res.status(202).json({ messageIds: ids, total: ids.length });
}));

router.get('/stats', authenticate, asyncWrap(async (req, res) => {
  const stats = messageModel.getUserStats(req.user.id);
  const sessions = sessionModel.findByUser(req.user.id);
  const connected = sessions.filter(s => whatsapp.getStatus(s.id) === 'connected').length;
  res.json({ ...stats, sessions: sessions.length, connectedSessions: connected });
}));

// Client: request pairing code for first waiting session
router.post('/pairing-code', authenticate, asyncWrap(async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const sessions = sessionModel.findByUser(req.user.id);
  const waiting = sessions.find(s => s.status === 'waiting_qr' || s.status === 'waiting_code');
  if (!waiting) return res.status(400).json({ error: 'No active session waiting for pairing' });
  const client = whatsapp.getClient(waiting.id);
  if (!client) return res.status(400).json({ error: 'Session not initialized' });
  const code = await client.requestPairingCode(phone);
  sessionModel.updateSession(waiting.id, { status: 'waiting_code', pairingCode: code, updatedAt: new Date().toISOString() });
  res.json({ code });
}));

// Client: message history
router.get('/history', authenticate, asyncWrap(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const { search, status, sort: sortBy, order } = req.query;
  let result = messageModel.findByUser(req.user.id, page, limit);

  const sessions = sessionModel.findByUser(req.user.id);
  const sessionMap = {};
  sessions.forEach(s => { sessionMap[s.id] = s.name || s.phone || s.id; });
  let items = result.items.map(m => ({
    ...m,
    sender: sessionMap[m.sessionId] || m.sessionId
  }));

  // Search by phone or message content
  if (search) {
    const q = search.toLowerCase();
    items = items.filter(m =>
      (m.to && m.to.toLowerCase().includes(q)) ||
      (m.message && m.message.toLowerCase().includes(q))
    );
  }

  // Filter by status
  if (status) {
    items = items.filter(m => m.status === status);
  }

  // Sort
  const sortOrder = order === 'asc' ? 1 : -1;
  if (sortBy === 'status') {
    items.sort((a, b) => sortOrder * (a.status || '').localeCompare(b.status || ''));
  } else if (sortBy === 'to') {
    items.sort((a, b) => sortOrder * (a.to || '').localeCompare(b.to || ''));
  } else {
    items.sort((a, b) => sortOrder * (new Date(a.createdAt || 0) - new Date(b.createdAt || 0)));
  }

  // Re-paginate after filtering
  const total = items.length;
  const pages = Math.ceil(total / limit);
  const start = (page - 1) * limit;
  const paginatedItems = items.slice(start, start + limit);

  res.json({ items: paginatedItems, total, page, pages, limit });
}));

router.get('/rates', asyncWrap(async (req, res) => {
  try {
    const axios = require('axios');
    const response = await axios.get('https://api.exchangerate-api.com/v4/latest/USD', { timeout: 8000 });
    res.json({ base: 'USD', rates: response.data.rates, date: response.data.date });
  } catch {
    res.json({ base: 'USD', rates: { EUR: 0.865, GBP: 0.743, SAR: 3.75, AED: 3.67, EGP: 51.82, TRY: 46.09, INR: 95.27, PKR: 278.68, BDT: 122.72, IDR: 18096 }, date: 'fallback' });
  }
}));

router.get('/queue-status', authenticate, asyncWrap(async (req, res) => {
  try {
    const stats = await queue.getQueueStats();
    res.json(stats);
  } catch {
    res.json({ waiting: 0, active: 0, completed: 0, failed: 0, note: 'Redis not available' });
  }
}));

module.exports = router;
