require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const path = require('path');

const whatsapp = require('./services/whatsapp');

const apiRoutes = require('./routes/api');
const adminRoutes = require('./routes/admin');

const sessionModel = require('./models/session');
const messageModel = require('./models/message');
const userModel = require('./models/user');
const activity = require('./models/activity');
const queue = require('./queue/sender');
const { authenticate, adminOnly } = require('./middleware/auth');
const { verifyToken } = require('./services/auth');
const db = require('./database/db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(morgan('dev'));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(express.static(path.join(__dirname, '..', 'admin')));
app.use('/client', express.static(path.join(__dirname, '..', 'client'), { index: 'index.html' }));

io.on('connection', (socket) => {
  const token = socket.handshake.auth?.token;
  if (token) {
    try {
      const decoded = verifyToken(token);
      socket.userId = decoded.id;
      socket.join(`user:${decoded.id}`);
      if (decoded.role === 'admin') {
        socket.join('admin');
      }
    } catch {}
  }

  socket.on('subscribe', (userId) => {
    socket.join(`user:${userId}`);
  });
});

whatsapp.on('qr', ({ sessionId, userId, qr }) => {
  sessionModel.updateSession(sessionId, { qrCode: qr, status: 'waiting_qr', updatedAt: new Date().toISOString() });
  io.to(`user:${userId}`).emit('qr', { sessionId, qr });
  io.to('admin').emit('qr', { sessionId, userId, qr });
  io.to('admin').emit('session-update', { sessionId, userId, event: 'qr' });
});

whatsapp.on('pairing-code', ({ sessionId, userId, code }) => {
  sessionModel.updateSession(sessionId, { pairingCode: code, status: 'waiting_code', updatedAt: new Date().toISOString() });
  io.to(`user:${userId}`).emit('pairing-code', { sessionId, code });
  io.to('admin').emit('pairing-code', { sessionId, userId, code });
  io.to('admin').emit('session-update', { sessionId, userId, event: 'pairing_code' });
});

whatsapp.on('ready', ({ sessionId, userId, info }) => {
  sessionModel.updateSession(sessionId, { status: 'connected', qrCode: null, updatedAt: new Date().toISOString() });
  io.to(`user:${userId}`).emit('session-ready', { sessionId, info: { wid: info.wid._serialized } });
  io.to('admin').emit('session-ready', { sessionId, userId, info: { wid: info.wid._serialized } });
  io.to('admin').emit('session-update', { sessionId, userId, event: 'ready' });
});

whatsapp.on('disconnected', ({ sessionId, userId, reason }) => {
  sessionModel.updateSession(sessionId, { status: 'disconnected', qrCode: null, updatedAt: new Date().toISOString() });
  io.to(`user:${userId}`).emit('session-disconnected', { sessionId, reason });
  io.to('admin').emit('session-disconnected', { sessionId, userId, reason });
  io.to('admin').emit('session-update', { sessionId, userId, event: 'disconnected' });
});

whatsapp.on('message_ack', ({ sessionId, userId, messageId, to, status }) => {
  messageModel.updateMessage(messageId, { status });
  io.to(`user:${userId}`).emit('message-status', { messageId, status, to });
});

app.get('/api/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'login.html'));
});

app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body;
  const { generateAdminToken, generateTOTP, comparePassword } = require('./services/auth');
  let adminEmail, adminId, adminName;

  // Check admins collection first
  db.initCollection('admins', []);
  const admins = db.readAll('admins');
  const found = admins.find(a => a.email === email);
  if (found && found.password) {
    const valid = await comparePassword(password, found.password);
    if (valid) {
      adminEmail = found.email;
      adminId = found.id;
      adminName = found.name;
    }
  }

  if (!adminEmail) {
    // Fallback to env vars
    const envEmail = process.env.ADMIN_EMAIL || 'admin@whatsapp.com';
    const envPass = process.env.ADMIN_PASSWORD || 'Ahmed@122112';
    if (email === envEmail && password === envPass) {
      adminEmail = envEmail;
      adminName = 'Super Admin';
    }
  }

  if (!adminEmail) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }

  // Check if 2FA is enabled for this admin
  db.initCollection('totp_secrets', {});
  const totpSettings = db.readAll('totp_secrets');
  const adminTOTP = totpSettings[adminEmail];

  // Log the login attempt
  activity.log({ admin: { email: adminEmail, name: adminName }, action: 'login', targetType: 'auth', targetId: adminEmail, details: { method: adminTOTP?.enabled ? 'password_2fa' : 'password' }, ip: req.ip, userAgent: req.headers['user-agent'] });

  if (adminTOTP && adminTOTP.enabled) {
    // 2FA is enabled - issue a temporary token that requires 2FA verification
    const jwt = require('jsonwebtoken');
    const tempToken = jwt.sign(
      { id: adminId || 'admin', email: adminEmail, role: 'admin', require2fa: true, twoFactorVerified: false },
      process.env.JWT_SECRET || 'change-this-secret',
      { expiresIn: '5m' }
    );
    return res.json({ token: tempToken, require2fa: true, admin: { id: adminId || 'admin', email: adminEmail, name: adminName } });
  }

  // No 2FA - issue full token
  const token = generateAdminToken({ id: adminId || 'admin', email: adminEmail });
  res.json({ token, admin: { id: adminId || 'admin', email: adminEmail, name: adminName }, require2fa: false });
});

// 2FA verification endpoint
app.post('/api/admin/login/verify-2fa', async (req, res) => {
  const { token: tempToken, code } = req.body;
  const { verifyToken, generateAdminToken } = require('./services/auth');
  const jwt = require('jsonwebtoken');

  if (!tempToken || !code) {
    return res.status(400).json({ error: 'Token and verification code required' });
  }

  try {
    const decoded = jwt.verify(tempToken, process.env.JWT_SECRET || 'change-this-secret');
    if (!decoded.require2fa) {
      return res.status(400).json({ error: 'Invalid token type' });
    }

    const email = decoded.email;
    db.initCollection('totp_secrets', {});
    const totpSettings = db.readAll('totp_secrets');
    const adminTOTP = totpSettings[email];

    if (!adminTOTP || !adminTOTP.enabled) {
      return res.status(400).json({ error: '2FA not enabled for this account' });
    }

    // Check if code is a recovery code
    if (adminTOTP.recoveryCodes && adminTOTP.recoveryCodes.includes(code)) {
      // Remove used recovery code
      adminTOTP.recoveryCodes = adminTOTP.recoveryCodes.filter(c => c !== code);
      totpSettings[email] = adminTOTP;
      db.writeAll('totp_secrets', totpSettings);
    } else {
      // Verify TOTP code
      const { generateTOTP } = require('./services/auth');
      const currentToken = generateTOTP(adminTOTP.secret, 0);
      const previousToken = generateTOTP(adminTOTP.secret, -1);
      const nextToken = generateTOTP(adminTOTP.secret, 1);
      if (code !== currentToken && code !== previousToken && code !== nextToken) {
        return res.status(401).json({ error: 'Invalid verification code' });
      }
    }

    // Log 2FA verification
    activity.log({ admin: { email, name: email }, action: 'login_2fa', targetType: 'auth', targetId: email, details: { method: adminTOTP.recoveryCodes && adminTOTP.recoveryCodes.includes(code) ? 'recovery_code' : 'totp' }, ip: req.ip, userAgent: req.headers['user-agent'] });

    // Issue full admin token
    const token = generateAdminToken({ id: decoded.id || 'admin', email });
    // Look up admin name
    db.initCollection('admins', []);
    const adminFound = db.readAll('admins').find(a => a.email === email);
    const adminName = adminFound ? adminFound.name : (process.env.ADMIN_EMAIL === email ? 'Super Admin' : email);
    res.json({ token, admin: { id: decoded.id || 'admin', email, name: adminName }, require2fa: true });
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
});

const ALL_PLANS = [
  { id: 'free', name: { ar: 'تجربة مجانية', en: 'Free Trial', de: 'Kostenlos testen', fr: 'Essai gratuit', es: 'Prueba gratis', tr: 'Ücretsiz Deneme' }, price: 0, currency: '$', discount: 0, discountActive: false, messages: 5, sessions: 1, days: 7, popular: false, features: { ar: ['5 رسائل تجربة', 'دعم عبر الإيميل'], en: ['5 trial messages', 'Email support'], de: ['5 Testnachrichten', 'E-Mail-Support'], fr: ['5 messages d\'essai', 'Support par e-mail'], es: ['5 mensajes de prueba', 'Soporte por correo'], tr: ['5 deneme mesajı', 'E-posta desteği'] } },
  { id: 'basic', name: { ar: 'الباقة الأساسية', en: 'Basic', de: 'Basis', fr: 'De base', es: 'Básico', tr: 'Temel' }, price: 29, currency: '$', discount: 0, discountActive: false, messages: 5000, sessions: 3, days: 30, features: { ar: ['حتى 5000 رسالة', 'دعم فني عبر الإيميل'], en: ['Up to 5,000 messages', 'Email support'], de: ['Bis zu 5.000 Nachrichten', 'E-Mail-Support'], fr: ["Jusqu'à 5 000 messages", 'Support par e-mail'], es: ['Hasta 5.000 mensajes', 'Soporte por correo'], tr: ['5.000 mesaja kadar', 'E-posta desteği'] }, popular: false },
  { id: 'pro', name: { ar: 'الباقة الاحترافية', en: 'Pro', de: 'Pro', fr: 'Pro', es: 'Pro', tr: 'Pro' }, price: 79, currency: '$', discount: 0, discountActive: false, messages: 25000, sessions: 10, days: 30, features: { ar: ['حتى 25000 رسالة', 'دعم فني عبر الواتساب', 'API Key مخصص'], en: ['Up to 25,000 messages', 'WhatsApp support', 'Dedicated API Key'], de: ['Bis zu 25.000 Nachrichten', 'WhatsApp-Support', 'Dedizierter API-Schlüssel'], fr: ['Jusqu\'à 25 000 messages', 'Support WhatsApp', 'Clé API dédiée'], es: ['Hasta 25.000 mensajes', 'Soporte por WhatsApp', 'Clave API dedicada'], tr: ['25.000 mesaja kadar', 'WhatsApp desteği', 'Özel API Anahtarı'] }, popular: true },
  { id: 'enterprise', name: { ar: 'الباقة المؤسسية', en: 'Enterprise', de: 'Unternehmen', fr: 'Entreprise', es: 'Empresarial', tr: 'Kurumsal' }, price: 199, currency: '$', discount: 0, discountActive: false, messages: 100000, sessions: 25, days: 30, features: { ar: ['حتى 100000 رسالة', 'دعم فني VIP', 'خادم مخصص'], en: ['Up to 100,000 messages', 'VIP support', 'Dedicated server'], de: ['Bis zu 100.000 Nachrichten', 'VIP-Support', 'Dedizierter Server'], fr: ['Jusqu\'à 100 000 messages', 'Support VIP', 'Serveur dédié'], es: ['Hasta 100.000 mensajes', 'Soporte VIP', 'Servidor dedicado'], tr: ['100.000 mesaja kadar', 'VIP desteği', 'Özel sunucu'] }, popular: false }
];

db.initCollection('pricing', ALL_PLANS);
// Ensure all plans exist in existing data and maintain order
const planOrder = ALL_PLANS.map(p => p.id);
let existingPlans = db.readAll('pricing');
for (const plan of ALL_PLANS) {
  if (!existingPlans.find(p => p.id === plan.id)) {
    db.insert('pricing', plan);
  }
}
// Reorder to match ALL_PLANS
existingPlans = db.readAll('pricing');
const reordered = planOrder.map(id => existingPlans.find(p => p.id === id)).filter(Boolean);
if (reordered.length !== existingPlans.length || reordered.some((p, i) => p.id !== existingPlans[i]?.id)) {
  db.writeAll('pricing', reordered);
}

// Settings / Branding
db.initCollection('settings', {});

// Admin management
db.initCollection('admins', []);

// Seed env var admin into collection so it appears in admin list
const envEmail = process.env.ADMIN_EMAIL || 'admin@whatsapp.com';
const envAdminName = process.env.ADMIN_NAME || 'Super Admin';
const existing = db.findOne('admins', a => a.email === envEmail);
if (!existing) {
  db.insert('admins', {
    id: 'env-admin',
    name: envAdminName,
    email: envEmail,
    password: '',
    createdAt: new Date().toISOString()
  });
}

const uuid = require('uuid');

app.get('/api/admin/admins', authenticate, adminOnly, asyncWrap(async (req, res) => {
  const admins = db.readAll('admins');
  res.json(admins.map(a => ({ id: a.id, name: a.name, email: a.email, createdAt: a.createdAt })));
}));

app.post('/api/admin/admins', authenticate, adminOnly, asyncWrap(async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'name, email, password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
  const { hashPassword } = require('./services/auth');
  const existing = db.findOne('admins', a => a.email === email);
  if (existing) return res.status(409).json({ error: 'Email already registered as admin' });
  const hashed = await hashPassword(password);
  const admin = { id: uuid.v4(), name, email, password: hashed, createdAt: new Date().toISOString() };
  db.insert('admins', admin);
  activity.log({ admin: req.admin, action: 'create', targetType: 'admin', targetId: admin.id, details: { name, email }, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.status(201).json({ id: admin.id, name: admin.name, email: admin.email, createdAt: admin.createdAt });
}));

app.put('/api/admin/admins/:id', authenticate, adminOnly, asyncWrap(async (req, res) => {
  const { name, email, password } = req.body;
  const admin = db.findOne('admins', a => a.id === req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  const updates = {};
  if (name) updates.name = name;
  if (email) updates.email = email;
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: 'Password must be 6+ characters' });
    const { hashPassword } = require('./services/auth');
    updates.password = await hashPassword(password);
  }
  db.update('admins', a => a.id === req.params.id, updates);
  activity.log({ admin: req.admin, action: 'update', targetType: 'admin', targetId: req.params.id, details: updates, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true });
}));

app.delete('/api/admin/admins/:id', authenticate, adminOnly, asyncWrap(async (req, res) => {
  const admin = db.findOne('admins', a => a.id === req.params.id);
  if (!admin) return res.status(404).json({ error: 'Admin not found' });
  db.remove('admins', a => a.id === req.params.id);
  activity.log({ admin: req.admin, action: 'delete', targetType: 'admin', targetId: req.params.id, details: { email: admin.email }, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true });
}));

app.get('/api/admin/sessions/:id/qr', authenticate, adminOnly, asyncWrap(async (req, res) => {
  const session = sessionModel.findById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  res.json({ sessionId: session.id, qrCode: session.qrCode, status: session.status });
}));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
});

app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'admin', 'index.html'));
});

app.use('/api', apiRoutes);
app.use('/api/admin', authenticate, adminOnly, adminRoutes);

const externalRoutes = require('./routes/external');
app.use('/v1', externalRoutes);

// Admin session management (bypass user ownership)
app.post('/api/admin/sessions', authenticate, adminOnly, asyncWrap(async (req, res) => {
  const { userId, phone, name } = req.body;
  if (!userId || !phone) return res.status(400).json({ error: 'userId and phone required' });
  const user = userModel.findById(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const session = sessionModel.createSession(userId, { phone, name });
  whatsapp.createClient(session.id, userId).catch(err => {
    console.error(`Session ${session.id} init error:`, err.message);
  });
  activity.log({ admin: req.admin, action: 'create', targetType: 'session', targetId: session.id, details: { userId, phone }, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.status(201).json(session);
}));

app.post('/api/admin/sessions/:id/send', authenticate, adminOnly, asyncWrap(async (req, res) => {
  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message required' });
  const session = sessionModel.findById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const status = whatsapp.getStatus(session.id);
  if (status !== 'connected') return res.status(400).json({ error: 'WhatsApp session not connected' });
  const msg = messageModel.createMessage({ userId: session.userId, sessionId: session.id, to, message });
  await queue.addToQueue({ userId: session.userId, sessionId: session.id, to, message, messageId: msg.id, delay: 0 });
  res.status(202).json({ messageId: msg.id, status: 'queued' });
}));

app.delete('/api/admin/sessions/:id', authenticate, adminOnly, asyncWrap(async (req, res) => {
  const session = sessionModel.findById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  await whatsapp.destroyClient(session.id);
  sessionModel.deleteSession(session.id);
  activity.log({ admin: req.admin, action: 'delete', targetType: 'session', targetId: req.params.id, details: { userId: session.userId, phone: session.phone }, ip: req.ip, userAgent: req.headers['user-agent'] });
  res.json({ success: true });
}));

app.post('/api/admin/sessions/:id/request-code', authenticate, adminOnly, asyncWrap(async (req, res) => {
  const { phone } = req.body;
  if (!phone) return res.status(400).json({ error: 'Phone required' });
  const session = sessionModel.findById(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const client = whatsapp.getClient(session.id);
  if (!client) return res.status(400).json({ error: 'Session not initialized' });
  const code = await client.requestPairingCode(phone);
  res.json({ code });
}));

function asyncWrap(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

async function start() {
  const PORT = parseInt(process.env.PORT || '3000');

  // Clear stale QR codes on startup
  const allSessions = db.readAll('sessions') || [];
  allSessions.forEach(s => {
    if (s.qrCode || s.status === 'waiting_qr' || s.status === 'waiting_code') {
      sessionModel.updateSession(s.id, { qrCode: null, status: 'disconnected' });
    }
  });

  try {
    await queue.startWorker(io);
  } catch (err) {
    console.error('  Queue init error:', err?.message || err);
  }

  server.listen(PORT, () => {
    console.log('');
    console.log(`  WhatsApp Sender running on http://localhost:${PORT}`);
    console.log(`  Admin: http://localhost:${PORT}/admin`);
    console.log('');
  });

  server.on('error', (err) => {
    console.error(`  Server error: ${err.message}`);
    if (err.code === 'EADDRINUSE') {
      console.error(`  Port ${PORT} is already in use. Close the other process or change PORT in .env`);
    }
  });
}

start().catch((err) => {
  console.error('  Failed to start server:', err?.message || err);
  process.exit(1);
});

process.on('unhandledRejection', (err) => {
  console.error('  Unhandled rejection:', err?.message || err);
});

process.on('uncaughtException', (err) => {
  console.error('  Uncaught exception:', err?.message || err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await queue.closeQueue();
  await whatsapp.destroyAll();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await queue.closeQueue();
  await whatsapp.destroyAll();
  process.exit(0);
});

module.exports = { app, server, io };
