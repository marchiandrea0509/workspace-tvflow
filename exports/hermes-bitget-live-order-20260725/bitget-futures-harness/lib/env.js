const fs = require('fs');
const path = require('path');

function parseEnvFile(filePath) {
  const out = {};
  if (!fs.existsSync(filePath)) return out;
  const raw = fs.readFileSync(filePath, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function loadLocalEnv() {
  const envPath = path.resolve(__dirname, '..', '.env.local');
  const fileValues = parseEnvFile(envPath);
  for (const [key, value] of Object.entries(fileValues)) {
    if (process.env[key] == null || process.env[key] === '') {
      process.env[key] = value;
    }
  }
  return { envPath, values: { ...fileValues } };
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value || /^PASTE_/i.test(value)) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

function getBoolEnv(name, fallback = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).trim().toLowerCase());
}

function getEnv(name, fallback = '') {
  const raw = process.env[name];
  return raw == null || raw === '' ? fallback : raw;
}

module.exports = {
  loadLocalEnv,
  getRequiredEnv,
  getBoolEnv,
  getEnv,
};
