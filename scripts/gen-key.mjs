// Prints new random secrets for your settings. Run: npm run gen-key
import crypto from 'node:crypto';

console.log(`APP_ENCRYPTION_KEY=${crypto.randomBytes(32).toString('base64')}`);
console.log(`CRON_SECRET=${crypto.randomBytes(24).toString('base64url')}`);
console.log(`OWNER_SETUP_SECRET=${crypto.randomBytes(24).toString('base64url')}`);
