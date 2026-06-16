const db = require('../database/db');
const { v4: uuidv4 } = require('uuid');

db.initCollection('users', []);

function FREE_PLAN() {
  const plans = db.readAll('pricing');
  return plans.find(p => p.id === 'free') || { messages: 100, sessions: 1, days: 7 };
}

function createUser({ name, email, password, maxMessages, expiryDays, planId, createdBy }) {
  const existing = db.findOne('users', u => u.email === email);
  if (existing) throw new Error('Email already exists');

  if (!planId) planId = 'free';
  const plan = db.findOne('pricing', p => p.id === planId) || FREE_PLAN();
  if (!maxMessages) maxMessages = plan.messages || 100;
  if (!expiryDays) expiryDays = plan.days || 7;

  const now = new Date();
  const expiry = new Date(now.getTime() + expiryDays * 86400000);

  const user = {
    id: uuidv4(),
    name,
    email,
    password,
    apiKey: uuidv4().replace(/-/g, ''),
    planId: plan.id,
    maxMessages,
    usedMessages: 0,
    status: 'active',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    expiryDate: expiry.toISOString(),
    createdBy: createdBy || null
  };

  db.insert('users', user);
  return sanitize(user);
}

function sanitize(user) {
  if (!user) return null;
  const { password, ...safe } = user;
  return safe;
}

function findByApiKey(apiKey) {
  return db.findOne('users', u => u.apiKey === apiKey && u.status === 'active');
}

function findById(id) {
  return db.findOne('users', u => u.id === id);
}

function findByEmail(email) {
  return db.findOne('users', u => u.email === email);
}

function checkQuota(apiKey) {
  const user = findByApiKey(apiKey);
  if (!user) return { allowed: false, reason: 'Invalid API key' };
  if (new Date(user.expiryDate) < new Date()) {
    db.update('users', u => u.id === user.id, { status: 'expired' });
    return { allowed: false, reason: 'Subscription expired' };
  }
  if (user.usedMessages >= user.maxMessages) {
    return { allowed: false, reason: 'Quota exceeded' };
  }
  return { allowed: true, user };
}

function incrementUsed(userId) {
  const user = findById(userId);
  if (!user) return;
  db.update('users', u => u.id === userId, { usedMessages: user.usedMessages + 1 });
}

function listUsers(page = 1, limit = 50) {
  return db.paginate('users', {
    page, limit,
    sort: (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  });
}

function updateUser(id, updates, updatedBy) {
  if (updatedBy) updates.updatedBy = updatedBy;
  updates.updatedAt = new Date().toISOString();
  db.update('users', u => u.id === id, updates);
  return sanitize(findById(id));
}

function deleteUser(id) {
  return db.remove('users', u => u.id === id);
}

function getRegistrationTrend(days = 30) {
  const all = db.readAll('users');
  const map = {};
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    map[key] = { date: key, count: 0 };
  }
  for (const u of all) {
    const key = u.createdAt.slice(0, 10);
    if (map[key]) map[key].count++;
  }
  return Object.values(map);
}

function getPlanDistribution() {
  const all = db.readAll('users');
  const counts = {};
  for (const u of all) {
    const plan = u.planId || 'free';
    counts[plan] = (counts[plan] || 0) + 1;
  }
  return Object.entries(counts).map(([plan, count]) => ({ plan, count }));
}

module.exports = {
  createUser, findByApiKey, findById, findByEmail,
  checkQuota, incrementUsed, listUsers, updateUser, deleteUser, sanitize,
  getRegistrationTrend, getPlanDistribution
};
