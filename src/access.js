const ACCESS_APP_SLUG = 'kas-kecil';

const enabled = String(process.env.ACCESS_HANDOFF_ENABLED || 'false').toLowerCase() === 'true';
const localSuperUserEnabled = String(process.env.LOCAL_SUPER_USER_LOGIN_ENABLED || 'true').toLowerCase() === 'true';
const publicAppUrl = String(process.env.PUBLIC_APP_URL || 'https://kaskecil.axindo.my.id').replace(/\/$/, '');
const portalUrl = String(process.env.ACCESS_PORTAL_URL || 'https://akses.axindo.my.id').replace(/\/$/, '');
const internalUrl = String(process.env.ACCESS_PORTAL_INTERNAL_URL || portalUrl).replace(/\/$/, '');

const GROUPS = Object.freeze({
  SUPER_USER: 'AXINDO - KAS KECIL - SUPER USER',
  SPV: 'AXINDO - KAS KECIL - SPV',
  STAFF: 'AXINDO - KAS KECIL - STAFF'
});

const CODE_PATTERN = /^[a-zA-Z0-9_-]{40,200}$/;
const VERIFIER_PATTERN = /^[a-zA-Z0-9_-]{43,128}$/;

function roleForGroups(groups) {
  const actual = new Set((Array.isArray(groups) ? groups : []).map(value => String(value).trim().toLowerCase()));
  return ['SUPER_USER', 'SPV', 'STAFF'].find(role => actual.has(GROUPS[role].toLowerCase())) || null;
}

function manifest() {
  return {
    schemaVersion: 1,
    id: ACCESS_APP_SLUG,
    name: 'AXINDO Kas Kecil',
    description: 'Transaksi kas kecil, mutasi, UMO, approval, laporan, dan audit PT Axindo Infinitas Network.',
    url: publicAppUrl,
    roles: [
      { code: 'SUPER_USER', label: 'Super User', assignment: 'OIDC', group: GROUPS.SUPER_USER },
      { code: 'SPV', label: 'Supervisor', assignment: 'OIDC', group: GROUPS.SPV },
      { code: 'STAFF', label: 'Staff', assignment: 'OIDC', group: GROUPS.STAFF }
    ]
  };
}

function publicAuth() {
  let accessPortalOrigin = 'https://akses.axindo.my.id';
  try { accessPortalOrigin = new URL(portalUrl).origin; } catch {}
  return {
    accessHandoffEnabled: enabled,
    accessHandoffReady: enabled,
    accessPortalUrl: portalUrl,
    accessPortalOrigin,
    accessPortalPopupUrl: `${portalUrl}/handoff?handoff=${ACCESS_APP_SLUG}`,
    localLoginEnabled: localSuperUserEnabled,
    localSuperUserOnly: enabled
  };
}

function logoutUrl() {
  const returnTo = new URL(publicAppUrl);
  returnTo.searchParams.set('logout', 'axindo');
  const target = new URL('/logout', portalUrl);
  target.searchParams.set('return_to', returnTo.href);
  return target.href;
}

function allowLocalUser(user) {
  if (!enabled) return true;
  return Boolean(localSuperUserEnabled && user && (user.auth_source || 'LOCAL') === 'LOCAL' && user.role === 'SUPER_USER');
}

async function exchangeHandoff(code, verifier, fetchImpl = fetch) {
  if (!CODE_PATTERN.test(String(code || '')) || !VERIFIER_PATTERN.test(String(verifier || ''))) {
    const error = new Error('Kode login AXINDO Access tidak valid.');
    error.status = 401;
    throw error;
  }

  let upstream;
  try {
    upstream = await fetchImpl(`${internalUrl}/api/auth/handoff/exchange`, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-axindo-handoff': '1' },
      body: JSON.stringify({ code, verifier, audience: ACCESS_APP_SLUG }),
      signal: AbortSignal.timeout(8000)
    });
  } catch (error) {
    console.error('Pertukaran AXINDO Access gagal:', error.message);
    throw Object.assign(new Error('AXINDO Access belum dapat dihubungi.'), { status: 502 });
  }

  const payload = await upstream.json().catch(() => ({}));
  if (!upstream.ok) {
    throw Object.assign(new Error(payload.error || 'Kode login AXINDO Access tidak berlaku.'), {
      status: upstream.status === 403 ? 403 : 401
    });
  }
  if (payload.audience !== ACCESS_APP_SLUG || !payload.identity?.subject) {
    throw Object.assign(new Error('Respons AXINDO Access tidak valid.'), { status: 502 });
  }

  const role = roleForGroups(payload.groups);
  if (!role) throw Object.assign(new Error('Akun belum memiliki role Kas Kecil di AXINDO Access.'), { status: 403 });
  return { identity: payload.identity, groups: payload.groups, role };
}

function register(app, { rateLimit, completeLogin }) {
  const sendManifest = (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=300, must-revalidate');
    res.json(manifest());
  };
  app.get('/.well-known/axindo-access.json', sendManifest);
  app.get('/api/public/axindo-access.json', sendManifest);

  app.post('/api/auth/access/complete', rateLimit({
    windowMs: 10 * 60 * 1000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Terlalu banyak percobaan login AXINDO ID.' }
  }), async (req, res, next) => {
    try {
      if (!enabled) throw Object.assign(new Error('Login AXINDO ID belum diaktifkan.'), { status: 404 });
      const result = await exchangeHandoff(String(req.body?.code || ''), String(req.body?.verifier || ''));
      res.json(await completeLogin(result, req, res));
    } catch (error) { next(error); }
  });
}

module.exports = {
  ACCESS_APP_SLUG,
  GROUPS,
  enabled,
  manifest,
  publicAuth,
  logoutUrl,
  allowLocalUser,
  roleForGroups,
  exchangeHandoff,
  register
};
