const crypto = require('crypto');
const { getBoolEnv, getEnv, getRequiredEnv, loadLocalEnv } = require('./env');

loadLocalEnv();

function toSortedQueryString(params = {}) {
  const entries = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b));

  const search = new URLSearchParams();
  for (const [key, value] of entries) {
    search.append(key, String(value));
  }
  const s = search.toString();
  return s ? `?${s}` : '';
}

function sign(prehash, secret) {
  return crypto.createHmac('sha256', secret).update(prehash).digest('base64');
}

class BitgetClient {
  constructor() {
    this.baseUrl = getEnv('BITGET_API_BASE_URL', 'https://api.bitget.com').replace(/\/$/, '');
    this.apiKey = getRequiredEnv('BITGET_API_KEY');
    this.apiSecret = getRequiredEnv('BITGET_API_SECRET');
    this.passphrase = getRequiredEnv('BITGET_API_PASSPHRASE');
    this.locale = getEnv('BITGET_LOCALE', 'en-US');
    this.papTrading = getBoolEnv('BITGET_PAPTRADING', false);
  }

  async request(method, path, { query = undefined, body = undefined, auth = true } = {}) {
    const queryString = toSortedQueryString(query);
    const requestPath = `${path}${queryString}`;
    const url = `${this.baseUrl}${requestPath}`;
    const bodyString = body ? JSON.stringify(body) : '';

    const headers = {
      'Content-Type': 'application/json',
      'locale': this.locale,
    };

    if (this.papTrading) {
      headers.paptrading = '1';
    }

    if (auth) {
      const timestamp = Date.now().toString();
      const prehash = `${timestamp}${String(method).toUpperCase()}${requestPath}${bodyString}`;
      headers['ACCESS-KEY'] = this.apiKey;
      headers['ACCESS-SIGN'] = sign(prehash, this.apiSecret);
      headers['ACCESS-TIMESTAMP'] = timestamp;
      headers['ACCESS-PASSPHRASE'] = this.passphrase;
    }

    const response = await fetch(url, {
      method,
      headers,
      body: bodyString || undefined,
    });

    const text = await response.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { raw: text };
    }

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
    }

    if (parsed && typeof parsed === 'object' && 'code' in parsed && parsed.code !== '00000') {
      throw new Error(`Bitget error ${parsed.code}: ${parsed.msg || 'Unknown error'}`);
    }

    return parsed;
  }

  get(path, query) {
    return this.request('GET', path, { query, auth: true });
  }

  post(path, body) {
    return this.request('POST', path, { body, auth: true });
  }
}

function getDefaultTradingConfig() {
  return {
    env: getEnv('BITGET_ENV', 'demo').toLowerCase(),
    productType: getEnv('BITGET_PRODUCT_TYPE', 'USDT-FUTURES'),
    marginCoin: getEnv('BITGET_MARGIN_COIN', 'USDT'),
    defaultSymbol: getEnv('BITGET_DEFAULT_SYMBOL', 'BTCUSDT'),
    defaultMarginMode: getEnv('BITGET_DEFAULT_MARGIN_MODE', 'isolated'),
    defaultLeverage: getEnv('BITGET_DEFAULT_LEVERAGE', '3'),
    allowOrderPlacement: getBoolEnv('BITGET_ALLOW_ORDER_PLACEMENT', false),
    allowLiveTrading: getBoolEnv('BITGET_ALLOW_LIVE_TRADING', false),
    papTrading: getBoolEnv('BITGET_PAPTRADING', false),
  };
}

function assertPlacementAllowed({ send = false } = {}) {
  const cfg = getDefaultTradingConfig();
  if (!send) return cfg;
  if (!cfg.allowOrderPlacement) {
    throw new Error('Order placement blocked: set BITGET_ALLOW_ORDER_PLACEMENT=true in .env.local to send orders.');
  }
  if (cfg.env === 'live' && !cfg.allowLiveTrading) {
    throw new Error('Live order placement blocked: set BITGET_ALLOW_LIVE_TRADING=true only when you intentionally want live trading.');
  }
  return cfg;
}

module.exports = {
  BitgetClient,
  getDefaultTradingConfig,
  assertPlacementAllowed,
};
