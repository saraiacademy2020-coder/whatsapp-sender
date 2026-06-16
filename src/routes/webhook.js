const axios = require('axios');

async function sendWebhook(url, payload) {
  if (!url) return;
  try {
    await axios.post(url, payload, {
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    });
  } catch (err) {
    console.error(`Webhook ${url} failed:`, err.message);
  }
}

module.exports = { sendWebhook };
