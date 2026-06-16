const express = require('express');
const router = express.Router();
const RateLimit = require('express-rate-limit');
const userModel = require('../models/user');
const sessionModel = require('../models/session');
const messageModel = require('../models/message');
const auth = require('../services/auth');
const db = require('../database/db');
const activity = require('../models/activity');

const adminLimiter = RateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(adminLimiter);

function asyncWrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

router.get('/stats', asyncWrap(async (req, res) => {
  const users = userModel.listUsers(1, 10000);
  const allSessions = sessionModel.listAll(1, 10000);
  const msgStats = messageModel.getStats();

  res.json({
    users: {
      total: users.total,
      active: users.items.filter(u => u.status === 'active').length,
      expired: users.items.filter(u => u.status === 'expired').length
    },
    sessions: {
      total: allSessions.total
    },
    messages: msgStats
  });
}));

router.get('/users', asyncWrap(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const search = (req.query.search || '').toLowerCase();
  const statusFilter = (req.query.status || '').toLowerCase();
  const sortBy = req.query.sortBy || '';
  const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
  let result = userModel.listUsers(page, limit);
  const allSessions = sessionModel.listAll(1, 10000);
  const sessionCounts = {};
  allSessions.items.forEach(s => {
    sessionCounts[s.userId] = (sessionCounts[s.userId] || 0) + 1;
  });
  const adminEmails = new Set();
  (db.readAll('admins') || []).forEach(a => { if (a.email) adminEmails.add(a.email); });
  if (process.env.ADMIN_EMAIL) adminEmails.add(process.env.ADMIN_EMAIL);
  result.items = result.items.map(u => {
    const safe = userModel.sanitize(u);
    safe.sessionCount = sessionCounts[safe.id] || 0;
    return safe;
  }).filter(u => !adminEmails.has(u.email));
  if (statusFilter) {
    result.items = result.items.filter(u => u.status === statusFilter);
  }
  if (search) {
    result.items = result.items.filter(u =>
      u.name?.toLowerCase().includes(search) ||
      u.email?.toLowerCase().includes(search) ||
      u.id?.toLowerCase().includes(search)
    );
  }
  const sortField = ['name','email','status','planId','sessionCount','usedMessages','expiryDate','createdAt'].includes(sortBy) ? sortBy : '';
  if (sortField) {
    result.items.sort((a, b) => {
      let va = a[sortField] || '', vb = b[sortField] || '';
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return -1 * sortOrder;
      if (va > vb) return 1 * sortOrder;
      return 0;
    });
  }
  result.total = result.items.length;
  result.pages = Math.ceil(result.total / limit);
  if (page > result.pages) result.pages = 1;
  const start = (page - 1) * limit;
  result.items = result.items.slice(start, start + limit);
  res.json(result);
}));

router.get('/users/:id', asyncWrap(async (req, res) => {
  const user = userModel.findById(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const sessions = sessionModel.findByUser(user.id);
  const msgStats = messageModel.getUserStats(user.id);
  res.json({ user: userModel.sanitize(user), sessions, stats: msgStats });
}));

router.put('/users/:id', asyncWrap(async (req, res) => {
  const allowed = ['maxMessages', 'status', 'expiryDate', 'name', 'email', 'planId'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }
  const user = userModel.updateUser(req.params.id, updates, req.admin.email);
  if (!user) return res.status(404).json({ error: 'User not found' });
  activity.log({ admin: req.admin, action: 'update', targetType: 'user', targetId: req.params.id, details: updates, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json(user);
}));

router.delete('/users/:id', asyncWrap(async (req, res) => {
  const user = userModel.findById(req.params.id);
  await sessionModel.deleteUserSessions(req.params.id);
  userModel.deleteUser(req.params.id);
  activity.log({ admin: req.admin, action: 'delete', targetType: 'user', targetId: req.params.id, details: { email: user?.email }, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true });
}));

router.get('/sessions', asyncWrap(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const result = sessionModel.listAll(page, limit);
  res.json(result);
}));

router.get('/messages', asyncWrap(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const result = messageModel.listAll(page, limit);
  res.json(result);
}));

router.get('/users/export/csv', asyncWrap(async (req, res) => {
  const result = userModel.listUsers(1, 100000);
  const allSessions = sessionModel.listAll(1, 100000);
  const sessionCounts = {};
  allSessions.items.forEach(s => { sessionCounts[s.userId] = (sessionCounts[s.userId] || 0) + 1; });
  let csv = 'Name,Email,API Key,Status,Messages Used,Max Messages,Session Count,Expiry Date,Created\n';
  result.items.forEach(u => {
    csv += `"${u.name || ''}","${u.email || ''}","${u.apiKey}","${u.status}",${u.usedMessages || 0},${u.maxMessages || 0},${sessionCounts[u.id] || 0},"${u.expiryDate}","${u.createdAt}"\n`;
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename=users-export.csv');
  res.send(csv);
}));

router.get('/pricing', asyncWrap(async (req, res) => {
  const plans = db.readAll('pricing');
  res.json(plans);
}));

router.put('/pricing', asyncWrap(async (req, res) => {
  const plans = req.body;
  if (!Array.isArray(plans)) return res.status(400).json({ error: 'Expected array of plans' });
  db.writeAll('pricing', plans);
  activity.log({ admin: req.admin, action: 'update', targetType: 'pricing', targetId: 'all', details: { planCount: plans.length }, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true });
}));

// Upgrade requests
router.get('/upgrade-requests', asyncWrap(async (req, res) => {
  db.initCollection('upgrade_requests', []);
  const requests = db.readAll('upgrade_requests');
  res.json(requests.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
}));

router.post('/upgrade-requests/:id/approve', asyncWrap(async (req, res) => {
  db.initCollection('upgrade_requests', []);
  const request = db.findOne('upgrade_requests', r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already ' + request.status });
  const plans = db.readAll('pricing');
  const plan = plans.find(p => p.id === request.requestedPlanId);
  if (!plan) return res.status(400).json({ error: 'Requested plan not found' });
  const days = plan.days || 30;
  const newExpiry = new Date(Date.now() + days * 86400000).toISOString();
  userModel.updateUser(request.userId, { planId: request.requestedPlanId, maxMessages: plan.messages, expiryDate: newExpiry });
  db.update('upgrade_requests', r => r.id === request.id, { status: 'approved' });
  activity.log({ admin: req.admin, action: 'approve_upgrade', targetType: 'upgrade_request', targetId: request.id, details: { userId: request.userId, requestedPlanId: request.requestedPlanId, planName: plan.name?.en }, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true, message: `User upgraded to ${plan.name?.en || request.requestedPlanId}` });
}));

router.post('/upgrade-requests/:id/reject', asyncWrap(async (req, res) => {
  db.initCollection('upgrade_requests', []);
  const request = db.findOne('upgrade_requests', r => r.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found' });
  if (request.status !== 'pending') return res.status(400).json({ error: 'Request already ' + request.status });
  db.update('upgrade_requests', r => r.id === request.id, { status: 'rejected' });
  activity.log({ admin: req.admin, action: 'reject_upgrade', targetType: 'upgrade_request', targetId: request.id, details: { userId: request.userId, requestedPlanId: request.requestedPlanId }, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true, message: 'Request rejected' });
}));

router.get('/analytics', asyncWrap(async (req, res) => {
  const days = Math.min(parseInt(req.query.days) || 30, 90);
  const msgTrend = messageModel.getDailyTrend(days);
  const userTrend = userModel.getRegistrationTrend(days);
  const sessionDist = sessionModel.getSessionStatusDistribution();
  const planDist = userModel.getPlanDistribution();
  const topUsers = messageModel.getTopUsers(10);
  const allUsers = userModel.listUsers(1, 10000);
  const userMap = {};
  allUsers.items.forEach(u => { userMap[u.id] = u.name || u.email; });
  const topUsersWithNames = topUsers.map(tu => ({
    userId: tu.userId,
    name: userMap[tu.userId] || tu.userId.substring(0, 8),
    count: tu.count
  }));
  res.json({ msgTrend, userTrend, sessionDist, planDist, topUsers: topUsersWithNames });
}));

router.get('/activity', asyncWrap(async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const search = req.query.search || '';
  const result = activity.listLogs(page, limit, search);
  res.json(result);
}));

// Branding/Settings
router.get('/settings', asyncWrap(async (req, res) => {
  db.initCollection('settings', {});
  const settings = db.readAll('settings');
  res.json(settings || {});
}));

router.put('/settings', asyncWrap(async (req, res) => {
  db.initCollection('settings', {});
  db.writeAll('settings', req.body);
  activity.log({ admin: req.admin, action: 'update', targetType: 'settings', targetId: 'branding', details: { fields: Object.keys(req.body) }, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true });
}));

// ============ Two-Factor Authentication ============

// Get 2FA status for current admin
router.get('/2fa/status', asyncWrap(async (req, res) => {
  db.initCollection('totp_secrets', {});
  const totpSettings = db.readAll('totp_secrets');
  const adminTOTP = totpSettings[req.admin.email];
  res.json({
    enabled: !!(adminTOTP && adminTOTP.enabled),
    setupDate: adminTOTP?.setupDate || null,
    hasRecoveryCodes: !!(adminTOTP?.recoveryCodes && adminTOTP.recoveryCodes.length > 0)
  });
}));

// Generate a new TOTP secret for setup
router.post('/2fa/setup', asyncWrap(async (req, res) => {
  db.initCollection('totp_secrets', {});
  const totpSettings = db.readAll('totp_secrets');
  const adminTOTP = totpSettings[req.admin.email];

  if (adminTOTP && adminTOTP.enabled) {
    return res.status(400).json({ error: '2FA is already enabled. Disable it first to reconfigure.' });
  }

  const { generateSecret, generateQRCode, generateRecoveryCodes } = require('../services/auth');
  const secret = generateSecret();
  const email = encodeURIComponent(req.admin.email);
  const issuer = encodeURIComponent('WhatsApp Sender Admin');
  const otpauthUrl = `otpauth://totp/${issuer}:${email}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
  const qrCode = await generateQRCode(otpauthUrl);
  const recoveryCodes = generateRecoveryCodes();

  // Store temporary secret until verified
  totpSettings[req.admin.email] = { secret, tempSecret: true, recoveryCodes };
  db.writeAll('totp_secrets', totpSettings);

  activity.log({ admin: req.admin, action: '2fa_setup_initiated', targetType: 'settings', targetId: '2fa', details: { email: req.admin.email }, ip: req.ip, userAgent: req.headers['user-agent'] });

  res.json({ secret, qrCode, recoveryCodes });
}));

// Verify TOTP setup code and enable 2FA
router.post('/2fa/verify', asyncWrap(async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Verification code required' });

  db.initCollection('totp_secrets', {});
  const totpSettings = db.readAll('totp_secrets');
  const adminTOTP = totpSettings[req.admin.email];

  if (!adminTOTP || !adminTOTP.tempSecret) {
    return res.status(400).json({ error: 'No pending 2FA setup. Start setup first.' });
  }

  if (adminTOTP.enabled) {
    return res.status(400).json({ error: '2FA is already enabled' });
  }

  const { generateTOTP } = require('../services/auth');
  const currentToken = generateTOTP(adminTOTP.secret, 0);
  const previousToken = generateTOTP(adminTOTP.secret, -1);
  const nextToken = generateTOTP(adminTOTP.secret, 1);

  if (code !== currentToken && code !== previousToken && code !== nextToken) {
    return res.status(401).json({ error: 'Invalid verification code' });
  }

  // Enable 2FA
  delete adminTOTP.tempSecret;
  adminTOTP.enabled = true;
  adminTOTP.setupDate = new Date().toISOString();
  totpSettings[req.admin.email] = adminTOTP;
  db.writeAll('totp_secrets', totpSettings);

  activity.log({ admin: req.admin, action: '2fa_enabled', targetType: 'settings', targetId: '2fa', details: { email: req.admin.email }, ip: req.ip, userAgent: req.headers['user-agent'] });

  res.json({ success: true, message: 'Two-factor authentication enabled' });
}));

// Disable 2FA
router.post('/2fa/disable', asyncWrap(async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Current password required to disable 2FA' });

  // Verify admin password
  const { comparePassword } = require('../services/auth');
  db.initCollection('admins', []);
  const admins = db.readAll('admins');
  const admin = admins.find(a => a.email === req.admin.email);
  if (admin) {
    const valid = await comparePassword(password, admin.password);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });
  } else {
    // Fallback admin - check env vars
    const adminPass = process.env.ADMIN_PASSWORD || 'Ahmed@122112';
    if (password !== adminPass) return res.status(401).json({ error: 'Invalid password' });
  }

  db.initCollection('totp_secrets', {});
  const totpSettings = db.readAll('totp_secrets');
  delete totpSettings[req.admin.email];
  db.writeAll('totp_secrets', totpSettings);

  activity.log({ admin: req.admin, action: '2fa_disabled', targetType: 'settings', targetId: '2fa', details: { email: req.admin.email }, ip: req.ip, userAgent: req.headers['user-agent'] });

  res.json({ success: true, message: 'Two-factor authentication disabled' });
}));

// Generate new recovery codes
router.post('/2fa/recovery-codes', asyncWrap(async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Current password required' });

  // Verify admin password
  const { comparePassword } = require('../services/auth');
  db.initCollection('admins', []);
  const admins = db.readAll('admins');
  const admin = admins.find(a => a.email === req.admin.email);
  if (admin) {
    const valid = await comparePassword(password, admin.password);
    if (!valid) return res.status(401).json({ error: 'Invalid password' });
  } else {
    const adminPass = process.env.ADMIN_PASSWORD || 'Ahmed@122112';
    if (password !== adminPass) return res.status(401).json({ error: 'Invalid password' });
  }

  db.initCollection('totp_secrets', {});
  const totpSettings = db.readAll('totp_secrets');
  const { generateRecoveryCodes } = require('../services/auth');
  const recoveryCodes = generateRecoveryCodes();

  if (totpSettings[req.admin.email]) {
    totpSettings[req.admin.email].recoveryCodes = recoveryCodes;
    db.writeAll('totp_secrets', totpSettings);
  }

  res.json({ success: true, recoveryCodes });
}));

module.exports = router;
