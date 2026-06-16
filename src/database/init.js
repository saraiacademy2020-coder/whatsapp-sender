require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
const db = require('./db');
const { hashPassword } = require('../services/auth');

async function init() {
  console.log('Initializing database...\n');

  db.initCollection('users', []);
  db.initCollection('sessions', []);
  db.initCollection('messages', []);
  db.initCollection('pricing', [
    {
      id: 'basic', price: 29, currency: '$', discount: 0, discountActive: false, messages: 5000, popular: false,
      name: { ar: 'الباقة الأساسية', en: 'Basic', de: 'Basis', fr: 'De base', es: 'Básico', tr: 'Temel' },
      features: {
        ar: ['حتى 5000 رسالة', 'دعم فني عبر الإيميل'],
        en: ['Up to 5,000 messages', 'Email support'],
        de: ['Bis zu 5.000 Nachrichten', 'E-Mail-Support'],
        fr: ["Jusqu'à 5 000 messages", 'Support par e-mail'],
        es: ['Hasta 5.000 mensajes', 'Soporte por correo'],
        tr: ['5.000 mesaja kadar', 'E-posta desteği']
      }
    },
    {
      id: 'pro', price: 79, currency: '$', discount: 0, discountActive: false, messages: 25000, popular: true,
      name: { ar: 'الباقة الاحترافية', en: 'Pro', de: 'Pro', fr: 'Pro', es: 'Pro', tr: 'Pro' },
      features: {
        ar: ['حتى 25000 رسالة', 'دعم فني عبر الواتساب', 'API Key مخصص'],
        en: ['Up to 25,000 messages', 'WhatsApp support', 'Dedicated API Key'],
        de: ['Bis zu 25.000 Nachrichten', 'WhatsApp-Support', 'Dedizierter API-Schlüssel'],
        fr: ['Jusqu\'à 25 000 messages', 'Support WhatsApp', 'Clé API dédiée'],
        es: ['Hasta 25.000 mensajes', 'Soporte por WhatsApp', 'Clave API dedicada'],
        tr: ['25.000 mesaja kadar', 'WhatsApp desteği', 'Özel API Anahtarı']
      }
    },
    {
      id: 'enterprise', price: 199, currency: '$', discount: 0, discountActive: false, messages: 100000, popular: false,
      name: { ar: 'الباقة المؤسسية', en: 'Enterprise', de: 'Unternehmen', fr: 'Entreprise', es: 'Empresarial', tr: 'Kurumsal' },
      features: {
        ar: ['حتى 100000 رسالة', 'دعم فني VIP', 'خادم مخصص'],
        en: ['Up to 100,000 messages', 'VIP support', 'Dedicated server'],
        de: ['Bis zu 100.000 Nachrichten', 'VIP-Support', 'Dedizierter Server'],
        fr: ['Jusqu\'à 100 000 messages', 'Support VIP', 'Serveur dédié'],
        es: ['Hasta 100.000 mensajes', 'Soporte VIP', 'Servidor dedicado'],
        tr: ['100.000 mesaja kadar', 'VIP desteği', 'Özel sunucu']
      }
    }
  ]);

  const count = db.readAll('users').length;
  if (count === 0) {
    const adminEmail = process.env.ADMIN_EMAIL || 'admin@whatsapp.com';
    const adminPass = process.env.ADMIN_PASSWORD || 'Ahmed@122112';
    const hashed = await hashPassword(adminPass);
    db.insert('users', {
      id: 'admin-default',
      name: 'Admin',
      email: adminEmail,
      password: hashed,
      role: 'admin',
      status: 'active',
      maxMessages: Infinity,
      usedMessages: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiryDate: '2099-12-31'
    });
    console.log('  Created default admin user');
  }

  console.log(`\n  Users: ${db.readAll('users').length}`);
  console.log(`  Sessions: ${db.readAll('sessions').length}`);
  console.log(`  Messages: ${db.readAll('messages').length}`);
  console.log(`  Pricing plans: ${db.readAll('pricing').length}`);
  console.log('\nDatabase initialization complete.');
}

init().catch(err => {
  console.error('Init failed:', err);
  process.exit(1);
});