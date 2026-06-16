const { verifyToken } = require('../services/auth');
const userModel = require('../models/user');
const db = require('../database/db');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization header' });
  }

  const token = authHeader.split(' ')[1];
  try {
    const decoded = verifyToken(token);
    req.user = decoded;

    // Check if 2FA is required but not yet verified
    if (decoded.require2fa && !decoded.twoFactorVerified) {
      return res.status(403).json({ error: 'Two-factor authentication required', require2fa: true });
    }
    if (decoded.require2faPending) {
      return res.status(403).json({ error: '2FA requires verification', require2faPending: true });
    }

    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const email = req.user.email;
  const admin = db.findOne('admins', a => a.email === email);
  req.admin = {
    email,
    name: (admin && admin.name) || req.user.name || email
  };
  next();
}

async function apiKeyAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) {
    return res.status(401).json({ error: 'API key required' });
  }

  const user = userModel.findByApiKey(apiKey);
  if (!user) {
    return res.status(401).json({ error: 'Invalid API key' });
  }

  if (new Date(user.expiryDate) < new Date()) {
    userModel.updateUser(user.id, { status: 'expired' });
    return res.status(403).json({ error: 'Subscription expired' });
  }

  req.apiUser = user;
  next();
}

module.exports = { authenticate, adminOnly, apiKeyAuth };
