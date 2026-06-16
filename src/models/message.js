const db = require('../database/db');
const { v4: uuidv4 } = require('uuid');

db.initCollection('messages', []);

function createMessage({ userId, sessionId, to, message, template, status = 'queued', webhookUrl }) {
  const msg = {
    id: uuidv4(),
    userId,
    sessionId,
    to,
    message,
    template: template || message.substring(0, 50),
    status,
    error: null,
    webhookUrl: webhookUrl || null,
    webhookSent: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.insert('messages', msg);
  return msg;
}

function findById(id) {
  return db.findOne('messages', m => m.id === id);
}

function findByUser(userId, page = 1, limit = 50) {
  return db.paginate('messages', {
    page, limit,
    filter: m => m.userId === userId,
    sort: (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  });
}

function updateMessage(id, updates) {
  db.update('messages', m => m.id === id, updates);
  return findById(id);
}

function listAll(page = 1, limit = 50) {
  return db.paginate('messages', {
    page, limit,
    sort: (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  });
}

function getStats() {
  const all = db.readAll('messages');
  const counts = { queued: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const m of all) if (counts[m.status] !== undefined) counts[m.status]++;
  return { total: all.length, ...counts };
}

function getUserStats(userId) {
  const userMessages = db.find('messages', m => m.userId === userId);
  const counts = { sent: 0, delivered: 0, read: 0, failed: 0 };
  for (const m of userMessages) if (counts[m.status] !== undefined) counts[m.status]++;
  return { total: userMessages.length, ...counts };
}

function getDailyTrend(days = 30) {
  const all = db.readAll('messages');
  const map = {};
  const now = new Date();
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    map[key] = { date: key, total: 0, sent: 0, failed: 0 };
  }
  for (const m of all) {
    const key = m.createdAt.slice(0, 10);
    if (map[key]) {
      map[key].total++;
      if (m.status === 'sent' || m.status === 'delivered' || m.status === 'read') map[key].sent++;
      if (m.status === 'failed') map[key].failed++;
    }
  }
  return Object.values(map);
}

function getTopUsers(limit = 10) {
  const all = db.readAll('messages');
  const counts = {};
  for (const m of all) {
    counts[m.userId] = (counts[m.userId] || 0) + 1;
  }
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([userId, count]) => ({ userId, count }));
}

module.exports = { createMessage, findById, findByUser, updateMessage, listAll, getStats, getUserStats, getDailyTrend, getTopUsers };
