const fs = require('fs');

const url     = process.env.SUPABASE_URL            || '';
const anon    = process.env.SUPABASE_ANON_KEY        || '';
const gplaces = process.env.GOOGLE_PLACES_API_KEY   || '';

const out = `window.ESUYO_CONFIG = {
  SUPABASE_URL:          '${url}',
  SUPABASE_ANON_KEY:     '${anon}',
  GOOGLE_PLACES_API_KEY: '${gplaces}',
};
`;

fs.writeFileSync('config.js', out);
console.log('config.js generated from environment variables.');
