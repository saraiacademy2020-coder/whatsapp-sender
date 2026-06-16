const db = require('../database/db');
const uuid = require('uuid');

db.initCollection('activity_log', []);

function log({ admin, action, targetType, targetId, details, ip, userAgent }) {
  const entry = {
    id: uuid.v4(),
    timestamp: new Date().toISOString(),
    adminEmail: admin.email,
    adminName: admin.name || admin.email,
    action,
    targetType,
    targetId,
    details: details || {},
    ip: ip || '',
    userAgent: userAgent || ''
  };
  db.insert('activity_log', entry);
  return entry;
}

function listLogs(page = 1, limit = 50, search = '') {
  let all = db.readAll('activity_log');
  if (search) {
    const q = search.toLowerCase();
    all = all.filter(e =>
      (e.adminEmail && e.adminEmail.toLowerCase().includes(q)) ||
      (e.adminName && e.adminName.toLowerCase().includes(q)) ||
      (e.action && e.action.toLowerCase().includes(q)) ||
      (e.targetType && e.targetType.toLowerCase().includes(q)) ||
      (e.targetId && e.targetId.toLowerCase().includes(q)) ||
      (e.ip && e.ip.includes(q)) ||
      (e.details && JSON.stringify(e.details).toLowerCase().includes(q))
    );
  }
  const sorted = all.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const total = sorted.length;
  const start = (page - 1) * limit;
  const items = sorted.slice(start, start + limit);
  return { items, total, page, limit, totalPages: Math.ceil(total / limit) };
}

module.exports = { log, listLogs };
