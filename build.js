const fs = require('fs');
const path = require('path');

// Load .env file manually
const envPath = path.join(__dirname, '.env');
const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
const envVars = {};

envContent.split('\n').forEach(line => {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith('#')) {
    const [key, ...valueParts] = trimmed.split('=');
    envVars[key.trim()] = valueParts.join('=').trim();
  }
});

const url       = process.env.SUPABASE_URL || envVars.SUPABASE_URL || '';
const anon      = process.env.SUPABASE_ANON_KEY || envVars.SUPABASE_ANON_KEY || '';
const gplaces   = process.env.GOOGLE_PLACES_API_KEY || envVars.GOOGLE_PLACES_API_KEY || '';
const maptiler  = process.env.MAPTILER_KEY || envVars.MAPTILER_KEY || '';

const out = `window.ESUYO_CONFIG = {
  SUPABASE_URL:          '${url}',
  SUPABASE_ANON_KEY:     '${anon}',
  GOOGLE_PLACES_API_KEY: '${gplaces}',
  MAPTILER_KEY:          '${maptiler}',
};
`;

fs.writeFileSync('config.js', out);
console.log('config.js generated from environment variables.');
