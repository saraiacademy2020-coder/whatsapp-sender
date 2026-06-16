const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SESSIONS_DIR = path.join(__dirname, '..', '..', 'data', 'sessions');
if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });

class WhatsAppManager extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map();
    this.statuses = new Map();
    this._msgIdMap = new Map();
  }

  async _initBaileys() {
    if (!this._baileys) {
      this._baileys = await import('@whiskeysockets/baileys');
    }
    return this._baileys;
  }

  async _getLatestVersion() {
    try {
      const { fetchLatestWaWebVersion } = await this._initBaileys();
      const { version } = await fetchLatestWaWebVersion();
      return version;
    } catch {
      return [2, 3000, 1041279790];
    }
  }

  async _buildClient(sessionId, userId) {
    const sessionDir = path.join(SESSIONS_DIR, `session-${sessionId}`);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers } = await this._initBaileys();

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
    this.statuses.set(sessionId, 'connecting');

    const version = await this._getLatestVersion();

    const sock = makeWASocket({
      version,
      auth: state,
      browser: Browsers.windows('Chrome'),
      syncFullHistory: false,
      markOnlineOnConnect: true,
      connectTimeoutMs: 60000,
      keepAliveIntervalMs: 25000,
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr);
          this.emit('qr', { sessionId, userId, qr: qrDataUrl });
        } catch {
          this.emit('qr', { sessionId, userId, qr });
        }
        this.statuses.set(sessionId, 'connecting');
      }

      if (connection === 'open') {
        this.statuses.set(sessionId, 'connected');
        this.emit('ready', {
          sessionId,
          userId,
          info: { wid: sock.user?.id || sessionId },
        });
      }

      if (connection === 'close') {
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;

        this.statuses.set(sessionId, 'disconnected');
        this.emit('disconnected', {
          sessionId,
          userId,
          reason: isLoggedOut ? 'Logged out' : 'Connection closed',
        });

        this.clients.delete(sessionId);

        if (!isLoggedOut) {
          setTimeout(() => {
            if (!this.clients.has(sessionId)) {
              this.createClient(sessionId, userId).catch(() => {});
            }
          }, 3000);
        }
      }
    });

    sock.ev.on('messages.update', (updates) => {
      for (const { key, update: msgUpdate } of updates) {
        if (msgUpdate.status !== null && msgUpdate.status !== undefined) {
          const statusMap = { 1: 'sent', 2: 'delivered', 3: 'read' };
          const status = statusMap[msgUpdate.status] || 'unknown';
          const ourMsgId = this._msgIdMap.get(key.id) || key.id;
          this.emit('message_ack', {
            sessionId,
            userId,
            messageId: ourMsgId,
            to: key.remoteJid,
            status,
          });
        }
      }
    });

    return sock;
  }

  async createClient(sessionId, userId) {
    if (this.clients.has(sessionId)) {
      return this.clients.get(sessionId);
    }

    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const sock = await this._buildClient(sessionId, userId);
        this.clients.set(sessionId, sock);
        return sock;
      } catch (err) {
        console.error(`[whatsapp] attempt ${attempt}/${MAX_ATTEMPTS} failed: ${err.message}`);
        this.clients.delete(sessionId);
        this.statuses.set(sessionId, 'disconnected');
        if (attempt >= MAX_ATTEMPTS) throw err;
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  getClient(sessionId) {
    return this.clients.get(sessionId) || null;
  }

  async sendMessage(sessionId, to, text, ourMsgId) {
    const sock = this.getClient(sessionId);
    if (!sock) throw new Error('Session not connected');
    const cleanNum = to.replace(/[^0-9]/g, '');
    const jid = `${cleanNum}@s.whatsapp.net`;
    const sent = await sock.sendMessage(jid, { text });
    if (ourMsgId) this._msgIdMap.set(sent.key.id, ourMsgId);
    return { id: ourMsgId || sent.key.id };
  }

  async isRegistered(sessionId, number) {
    const sock = this.getClient(sessionId);
    if (!sock) throw new Error('Session not connected');
    const cleanNum = number.replace(/[^0-9]/g, '');
    const [result] = await sock.onWhatsApp(`${cleanNum}@s.whatsapp.net`);
    return result?.exists || false;
  }

  async destroyClient(sessionId) {
    const sock = this.getClient(sessionId);
    if (sock) {
      try { sock.end(undefined); } catch { try { sock.ws?.close(); } catch {} }
      this.clients.delete(sessionId);
    }
    this.statuses.delete(sessionId);
    const sessionDir = path.join(SESSIONS_DIR, `session-${sessionId}`);
    if (fs.existsSync(sessionDir)) {
      try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }
  }

  async destroyAll() {
    for (const [id] of this.clients) {
      await this.destroyClient(id);
    }
  }

  getStatus(sessionId) {
    return this.statuses.get(sessionId) || 'disconnected';
  }

  async requestPairingCode(sessionId, phone) {
    const sock = this.getClient(sessionId);
    if (!sock) throw new Error('Session not initialized');
    const code = await sock.requestPairingCode(phone);
    return code;
  }
}

module.exports = new WhatsAppManager();
