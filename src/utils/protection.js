const userModel = require('../models/user');

function antiBanDelay(index, total) {
  if (total <= 0) return 0;
  if (index === 0) return 3000 + Math.floor(Math.random() * 3000);
  const baseMin = 5000, baseMax = 15000;
  let baseDelay = baseMin + Math.floor(Math.random() * (baseMax - baseMin));
  const batchSize = 50;
  const batch = Math.floor(index / batchSize);
  const pauseAfterBatch = batch > 0 ? 60000 + Math.floor(Math.random() * 60000) : 0;
  return baseDelay + pauseAfterBatch;
}

function validateMessageContent(message) {
  const spamPatterns = [
    /https?:\/\/(?:[^\s]+)/gi,
    /@everyone|@all|@channel/gi,
    /(.)\1{20,}/g,
    /[A-Z]{15,}/g
  ];

  let score = 0;
  const urls = (message.match(/https?:\/\//g) || []).length;
  if (urls > 2) score += 2;
  if (urls > 5) score += 3;

  if ((message.match(/[A-Z]/g) || []).length > message.length * 0.7) score += 2;
  if (message.length < 10) score += 1;

  return score <= 3;
}

function enforceQuota(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) return next();

  const result = userModel.checkQuota(apiKey);
  if (!result.allowed) {
    return res.status(403).json({ error: result.reason });
  }

  req.apiUser = result.user;
  next();
}

module.exports = { antiBanDelay, validateMessageContent, enforceQuota };
