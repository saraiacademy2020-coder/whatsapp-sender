const db = require('../database/db');
const { v4: uuidv4 } = require('uuid');

db.initCollection('sessions', []);

function createSession(userId, { phone, name = '' }) {
  const session = {
    id: uuidv4(),
    userId,
    phone,
    name: name || phone,
    status: 'disconnected',
    qrCode: null,
    pairingCode: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  db.insert('sessions', session);
  return session;
}

function findByUser(userId) {
  return db.find('sessions', s => s.userId === userId);
}

function findById(id) {
  return db.findOne('sessions', s => s.id === id);
}

function findByUserIdAndId(userId, id) {
  return db.findOne('sessions', s => s.userId === userId && s.id === id);
}

function updateSession(id, updates) {
  db.update('sessions', s => s.id === id, updates);
  return findById(id);
}

function deleteSession(id) {
  return db.remove('sessions', s => s.id === id);
}

function deleteUserSessions(userId) {
  return db.remove('sessions', s => s.userId === userId);
}

function listAll(page = 1, limit = 50) {
  return db.paginate('sessions', {
    page, limit,
    sort: (a, b) => new Date(b.createdAt) - new Date(a.createdAt)
  });
}

function getSessionStatusDistribution() {
  const all = db.readAll('sessions');
  const counts = {};
  for (const s of all) {
    const status = s.status || 'disconnected';
    counts[status] = (counts[status] || 0) + 1;
  }
  return Object.entries(counts).map(([status, count]) => ({ status, count }));
}

module.exports = {
  createSession, findByUser, findById, findByUserIdAndId,
  updateSession, deleteSession, deleteUserSessions, listAll,
  getSessionStatusDistribution
};
