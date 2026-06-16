const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const QRCode = require('qrcode');

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret';

function generateToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: 'user' }, JWT_SECRET, { expiresIn: '7d' });
}

function generateAdminToken(admin) {
  return jwt.sign({ id: admin.id || 'admin', email: admin.email, role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
}

function verifyToken(token) {
  return jwt.verify(token, JWT_SECRET);
}

async function hashPassword(password) {
  return bcrypt.hash(password, 12);
}

async function comparePassword(password, hash) {
  return bcrypt.compare(password, hash);
}

// Two-Factor Authentication functions
function generateSecret() {
  const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let secret = '';
  const secretLength = 32;
  for (let i = 0; i < secretLength; i++) {
    const randomIndex = Math.floor(crypto.randomInt(0, charset.length));
    secret += charset[randomIndex];
  }
  return secret;
}

function generateTOTP(secret, window = 0) {
  const time = Math.floor(Date.now() / 1000 / 30) + window;
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigUInt64BE(BigInt(time), 0);
  
  const hmac = crypto.createHmac('sha1', Buffer.from(secret, 'base32'));
  hmac.update(timeBuffer);
  const digest = hmac.digest();
  
  const offset = digest[digest.length - 1] & 0x0f;
  const code = (
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  ) % 1000000;
  
  return code.toString().padStart(6, '0');
}

async function generateQRCode(url) {
  try {
    return await QRCode.toDataURL(url, { width: 200, margin: 2 });
  } catch (error) {
    console.error('Error generating QR code:', error);
    return null;
  }
}

function generateRecoveryCodes(count = 8) {
  const charset = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const codes = [];
  for (let i = 0; i < count; i++) {
    let code = '';
    for (let j = 0; j < 4; j++) {
      const randomIndex = Math.floor(crypto.randomInt(0, charset.length));
      code += charset[randomIndex];
    }
    code += '-' + Math.floor(crypto.randomInt(10000, 99999)).toString().padStart(5, '0');
    codes.push(code);
  }
  return codes;
}

module.exports = { 
  generateToken, 
  generateAdminToken, 
  verifyToken, 
  hashPassword, 
  comparePassword,
  generateSecret,
  generateTOTP,
  generateQRCode,
  generateRecoveryCodes
};
