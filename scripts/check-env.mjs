// Checks that every variable in .env is set and that each service accepts it.
//
// Run: node scripts/check-env.mjs
//
// It only reads. Nothing is created: the GitHub write checks send deliberately
// invalid requests that GitHub rejects after checking permissions. The one cost
// is a single tiny Gemini call (and one Tavily credit if the usage endpoint is
// missing).
//
// It prints names, pass or fail, and details that come back from the services.
// It never prints a value from .env, and every message is scrubbed of secrets.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));
process.loadEnvFile(ENV_PATH);

const NAMES = [
  'DISCORD_TOKEN', 'DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID', 'DISCORD_OWNER_ID',
  'GITHUB_TOKEN', 'GITHUB_OWNER',
  'GEMINI_API_KEY',
  'SURREAL_URL', 'SURREAL_NAMESPACE', 'SURREAL_DATABASE', 'SURREAL_USER', 'SURREAL_PASS',
  'MEMORY_URL', 'MEMORY_CONTEXT_ID', 'MEMORY_API_KEY',
  'SOLANA_WALLET_ADDRESS', 'SOLANA_RPC_URL',
  'TAVILY_API_KEY',
];
const SECRET_NAMES = [
  'DISCORD_TOKEN', 'GITHUB_TOKEN', 'GEMINI_API_KEY', 'SURREAL_USER', 'SURREAL_PASS',
  'MEMORY_API_KEY', 'SOLANA_RPC_URL', 'TAVILY_API_KEY',
];

const env = Object.fromEntries(NAMES.map((name) => [name, (process.env[name] ?? '').trim()]));

// Everything that must never reach the terminal, including the key inside the RPC URL.
const secrets = SECRET_NAMES.map((name) => env[name]).filter((value) => value.length >= 4);
try {
  for (const value of new URL(env.SOLANA_RPC_URL).searchParams.values()) {
    if (value.length >= 4) secrets.push(value);
  }
} catch { /* reported by the format check */ }
const scrub = (text) => secrets.reduce((out, value) => out.split(value).join('[hidden]'), String(text));

const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

async function call(url, init = {}) {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, ok: res.ok, body, headers: res.headers };
}

function brief(body) {
  if (typeof body === 'string') return body.slice(0, 160);
  const message = body?.message ?? body?.error?.message ?? body?.error ?? body?.detail ?? JSON.stringify(body);
  return String(message).slice(0, 160);
}

const results = [];
async function check(service, name, fn) {
  try {
    const detail = await fn();
    results.push(['PASS', service, name, detail ?? '']);
    return true;
  } catch (error) {
    const cause = error.cause ? ` (${error.cause.code ?? error.cause.message})` : '';
    results.push(['FAIL', service, name, `${error.message}${cause}`]);
    return false;
  }
}
const fail = (message) => { throw new Error(message); };

// 1. Every variable is set and looks right.

await check('.env', 'all 18 variables set', () => {
  const missing = NAMES.filter((name) => !env[name]);
  if (missing.length) fail(`missing: ${missing.join(', ')}`);
});

await check('.env', 'formats', () => {
  const problems = [];
  for (const name of ['DISCORD_APPLICATION_ID', 'DISCORD_GUILD_ID', 'DISCORD_OWNER_ID']) {
    if (!/^\d{17,20}$/.test(env[name])) problems.push(`${name} should be a 17-20 digit ID`);
  }
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(env.SOLANA_WALLET_ADDRESS)) {
    problems.push('SOLANA_WALLET_ADDRESS is not a Solana address');
  }
  if (!/^(wss?|https?):\/\//.test(env.SURREAL_URL)) problems.push('SURREAL_URL should start with wss://');
  if (!/^https:\/\//.test(env.MEMORY_URL)) problems.push('MEMORY_URL should start with https://');
  if (!/^https:\/\//.test(env.SOLANA_RPC_URL)) problems.push('SOLANA_RPC_URL should start with https://');
  if (problems.length) fail(problems.join('; '));
});

// Node treats an unquoted # as the start of a comment, which silently cuts a value short.
// Only the names are reported.
await check('.env', 'no values cut short by #', () => {
  const cut = readFileSync(ENV_PATH, 'utf8').split('\n').flatMap((line) => {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) return [];
    const [, name, raw] = match;
    return !/^["'`]/.test(raw) && raw.includes('#') ? [name] : [];
  });
  if (cut.length) fail(`wrap these in single quotes, because a # cuts them short: ${cut.join(', ')}`);
});

// 2. Discord

const discord = (path) => call(`https://discord.com/api/v10${path}`, {
  headers: { Authorization: `Bot ${env.DISCORD_TOKEN}` },
});
let botId;

const discordOk = await check('Discord', 'bot token', async () => {
  const me = await discord('/users/@me');
  if (me.status === 401) fail('token rejected; reset it on the Bot tab and copy it again');
  if (!me.ok) fail(`HTTP ${me.status}: ${brief(me.body)}`);
  botId = me.body.id;
  return `bot "${me.body.username}"`;
});

if (discordOk) {
  await check('Discord', 'application ID and intents', async () => {
    const app = await discord('/applications/@me');
    if (!app.ok) fail(`HTTP ${app.status}: ${brief(app.body)}`);
    if (app.body.id !== env.DISCORD_APPLICATION_ID) fail('DISCORD_APPLICATION_ID is not this bot\'s application');
    const flags = app.body.flags ?? 0;
    const missing = [];
    if (!(flags & ((1 << 14) | (1 << 15)))) missing.push('Server Members Intent');
    if (!(flags & ((1 << 18) | (1 << 19)))) missing.push('Message Content Intent');
    if (missing.length) fail(`turn on on the Bot tab: ${missing.join(', ')}`);
    return 'both privileged intents on';
  });

  const inGuild = await check('Discord', 'bot is in the server', async () => {
    const guild = await discord(`/guilds/${env.DISCORD_GUILD_ID}`);
    if (guild.status === 403 || guild.status === 404) fail('bot is not in this server, or DISCORD_GUILD_ID is wrong');
    if (!guild.ok) fail(`HTTP ${guild.status}: ${brief(guild.body)}`);
    return `server "${guild.body.name}"`;
  });

  if (inGuild) {
    await check('Discord', 'owner is in the server', async () => {
      const member = await discord(`/guilds/${env.DISCORD_GUILD_ID}/members/${env.DISCORD_OWNER_ID}`);
      if (member.status === 404) fail('DISCORD_OWNER_ID is not a member of this server');
      if (!member.ok) fail(`HTTP ${member.status}: ${brief(member.body)}`);
      return `"${member.body.user?.username}"`;
    });

    await check('Discord', 'bot permissions', async () => {
      const [roles, member] = await Promise.all([
        discord(`/guilds/${env.DISCORD_GUILD_ID}/roles`),
        discord(`/guilds/${env.DISCORD_GUILD_ID}/members/${botId}`),
      ]);
      if (!roles.ok || !member.ok) fail(`HTTP ${roles.status}/${member.status}`);
      const held = new Set([env.DISCORD_GUILD_ID, ...member.body.roles]);
      const perms = roles.body
        .filter((role) => held.has(role.id))
        .reduce((all, role) => all | BigInt(role.permissions), 0n);
      if (perms & (1n << 3n)) return 'Administrator (covers everything)';
      const needed = {
        'Create Instant Invite': 0n, 'Manage Channels': 4n, 'Manage Server': 5n, 'View Channels': 10n,
        'Send Messages': 11n, 'Manage Messages': 13n, 'Embed Links': 14n, 'Attach Files': 15n,
        'Read Message History': 16n, 'Manage Roles': 28n, 'Send Messages in Threads': 38n,
        // Discord split pinning out of Manage Messages; the bot pins each spec.
        'Pin Messages': 51n,
      };
      const missing = Object.entries(needed).filter(([, bit]) => !(perms & (1n << bit))).map(([label]) => label);
      if (missing.length) fail(`missing: ${missing.join(', ')}`);
      return `all ${Object.keys(needed).length} needed permissions`;
    });
  }
}

// 3. GitHub

const github = (path, init = {}) => call(`https://api.github.com${path}`, {
  ...init,
  headers: {
    Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'discordlancer-env-check',
    ...(init.body ? { 'Content-Type': 'application/json' } : {}),
  },
});

const githubOk = await check('GitHub', 'token and owner', async () => {
  const user = await github('/user');
  if (user.status === 401) fail('token rejected');
  if (!user.ok) fail(`HTTP ${user.status}: ${brief(user.body)}`);
  if (user.body.login.toLowerCase() !== env.GITHUB_OWNER.toLowerCase()) {
    fail(`token belongs to "${user.body.login}", not GITHUB_OWNER`);
  }
  const kind = env.GITHUB_TOKEN.startsWith('github_pat_') ? 'fine-grained' : 'classic';
  const expiry = user.headers.get('github-authentication-token-expiration');
  return `"${user.body.login}", ${kind} token${expiry ? `, expires ${expiry}` : ''}`;
});

if (githubOk) {
  const repo = `/repos/${env.GITHUB_OWNER}/discordlancer`;

  // An empty name is rejected with 422 after the permission check, so no repo is created.
  await check('GitHub', 'can create repos (Administration)', async () => {
    const res = await github('/user/repos', { method: 'POST', body: JSON.stringify({ name: '' }) });
    if (res.status === 422) return 'allowed';
    if (res.status === 403 || res.status === 404) fail('not allowed: give the token Administration read and write');
    fail(`unexpected HTTP ${res.status}: ${brief(res.body)}`);
  });

  // A made-up username: GitHub checks permissions first (403), then the user (404).
  // No invitation can be sent, because the user doesn't exist.
  await check('GitHub', 'can add collaborators (Administration write)', async () => {
    const res = await github(`${repo}/collaborators/dl-nonexistent-user-zq9x7`, {
      method: 'PUT',
      body: JSON.stringify({ permission: 'push' }),
    });
    if (res.status === 404 || res.status === 422) return 'allowed';
    if (res.status === 403) fail('not allowed: set Administration to "Read and write" on the token (Repository permissions)');
    fail(`unexpected HTTP ${res.status}: ${brief(res.body)}`);
  });

  // An empty title is rejected with 422 after the permission check, so no issue is created.
  await check('GitHub', 'can open issues (Issues)', async () => {
    const res = await github(`${repo}/issues`, { method: 'POST', body: JSON.stringify({ title: '' }) });
    if (res.status === 422) return 'allowed';
    if (res.status === 403 || res.status === 404) fail('not allowed: give the token Issues read and write on all repositories');
    if (res.status === 410) fail('issues are switched off on the discordlancer repo');
    fail(`unexpected HTTP ${res.status}: ${brief(res.body)}`);
  });

  await check('GitHub', 'can read code and pull requests', async () => {
    const [commits, pulls] = await Promise.all([
      github(`${repo}/commits?per_page=1`),
      github(`${repo}/pulls?per_page=1`),
    ]);
    const missing = [];
    if (!commits.ok) missing.push(`Contents (HTTP ${commits.status})`);
    if (!pulls.ok) missing.push(`Pull requests (HTTP ${pulls.status})`);
    if (missing.length) fail(`can't read: ${missing.join(', ')}`);
    return 'allowed (Contents write is checked by the first /new-project)';
  });
}

// 4. Gemini

let model;
const geminiOk = await check('Gemini', 'API key', async () => {
  const res = await call('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
    headers: { 'x-goog-api-key': env.GEMINI_API_KEY },
  });
  if (res.status === 400 || res.status === 403) fail(`key rejected: ${brief(res.body)}`);
  if (!res.ok) fail(`HTTP ${res.status}: ${brief(res.body)}`);
  const usable = res.body.models
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));
  const plain = usable.filter((name) => !/preview|exp|tts|image|live|audio|embed/.test(name));
  model = plain.find((name) => /flash-lite/.test(name)) ?? plain.find((name) => /flash/.test(name)) ?? usable[0];
  if (!model) fail('no model available for text generation');
  return `${usable.length} models available`;
});

if (geminiOk) {
  await check('Gemini', 'one tiny generation', async () => {
    const res = await call(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': env.GEMINI_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: 'Reply with the single word OK.' }] }] }),
    });
    if (!res.ok) fail(`HTTP ${res.status}: ${brief(res.body)}`);
    if (!res.body.candidates?.length) fail('no answer came back');
    return `model ${model} answered`;
  });
}

// 5. SurrealDB database

const surrealBase = env.SURREAL_URL
  .replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  .replace(/\/rpc\/?$/, '').replace(/\/+$/, '');

const surrealUp = await check('SurrealDB', 'instance is up', async () => {
  const health = await call(`${surrealBase}/health`);
  if (!health.ok) fail(`health check returned HTTP ${health.status}`);
  const version = await call(`${surrealBase}/version`);
  return version.ok && typeof version.body === 'string' ? version.body.trim() : 'healthy';
});

// The bot talks to SurrealDB over the WebSocket RPC. On SurrealDB 4 (Earth) the
// HTTP /signin endpoint refuses system users that the RPC accepts, so check the RPC.
function openSurreal(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, 'json');
    const pending = new Map();
    let nextId = 0;
    const connectTimer = setTimeout(() => { ws.close(); reject(new Error('timed out connecting')); }, 20_000);
    ws.onopen = () => {
      clearTimeout(connectTimer);
      resolve({
        call(method, params = []) {
          const id = String(++nextId);
          return new Promise((done, failed) => {
            const timer = setTimeout(() => { pending.delete(id); failed(new Error(`${method} timed out`)); }, 20_000);
            pending.set(id, { done, failed, timer });
            ws.send(JSON.stringify({ id, method, params }));
          });
        },
        close: () => ws.close(),
      });
    };
    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.failed(new Error(message.error.message ?? JSON.stringify(message.error)));
      else waiter.done(message.result);
    };
    ws.onerror = () => { clearTimeout(connectTimer); reject(new Error('could not open the WebSocket')); };
  });
}

if (surrealUp) {
  const { SURREAL_NAMESPACE: ns, SURREAL_DATABASE: db, SURREAL_USER: user, SURREAL_PASS: pass } = env;
  const rpcUrl = /\/rpc\/?$/.test(env.SURREAL_URL) ? env.SURREAL_URL : `${env.SURREAL_URL.replace(/\/+$/, '')}/rpc`;
  // Try the user at database, namespace and root level, to say where it actually lives.
  const levels = [
    ['database', { ns, db, user, pass }],
    ['namespace', { ns, user, pass }],
    ['root', { user, pass }],
  ];
  let surreal;
  let level;

  const signedIn = await check('SurrealDB', 'sign in', async () => {
    surreal = await openSurreal(rpcUrl);
    for (const [name, credentials] of levels) {
      try {
        await surreal.call('signin', [credentials]);
        level = name;
        return `user signs in at ${name} level`;
      } catch { /* try the next level */ }
    }
    surreal.close();
    fail('refused at database, namespace and root level: check the user name and password');
  });

  if (signedIn) {
    await check('SurrealDB', 'query in namespace and database', async () => {
      try {
        await surreal.call('use', [ns, db]);
        const result = await surreal.call('query', ['RETURN 1;']);
        const first = Array.isArray(result) ? result[0] : undefined;
        if (first?.status && first.status !== 'OK') fail(`query failed: ${brief(first.result)}`);
      } finally {
        surreal.close();
      }
      const note = level === 'database' ? '' : ` (the user is ${level}-level; a database-level user would be safer)`;
      return `ran a query in ${ns}/${db}${note}`;
    });
  }
}

// 6. SurrealDB Agent Memory

let memoryOrigin = '';
try { memoryOrigin = new URL(env.MEMORY_URL).origin; } catch { /* reported by the format check */ }

const memoryUp = await check('Agent Memory', 'service is up', async () => {
  if (!memoryOrigin) fail('MEMORY_URL is not a URL');
  const res = await call(`${memoryOrigin}/api/v1/health`);
  if (!res.ok) fail(`health check returned HTTP ${res.status}`);
  return 'healthy';
});

if (memoryUp) {
  await check('Agent Memory', 'API key and context', async () => {
    const res = await call(`${memoryOrigin}/api/v1/${encodeURIComponent(env.MEMORY_CONTEXT_ID)}/me`, {
      headers: { Authorization: `Bearer ${env.MEMORY_API_KEY}` },
    });
    if (res.status === 401) fail('API key rejected');
    if (res.status === 403) fail('this key has no access to that context');
    if (res.status === 404 || res.status === 422) fail('context not found: check MEMORY_CONTEXT_ID');
    if (!res.ok) fail(`HTTP ${res.status}: ${brief(res.body)}`);
    return 'key accepted for this context';
  });
}

// 7. Solana

const rpc = async (method, params = []) => {
  const res = await call(env.SOLANA_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (res.status === 401 || res.status === 403) fail('RPC refused the request: check the API key in SOLANA_RPC_URL');
  if (!res.ok) fail(`HTTP ${res.status}: ${brief(res.body)}`);
  if (res.body.error) fail(`${method}: ${brief(res.body.error)}`);
  return res.body.result;
};

const rpcOk = await check('Solana', 'RPC is mainnet', async () => {
  const genesis = await rpc('getGenesisHash');
  if (genesis !== MAINNET_GENESIS) fail('this RPC is not Solana mainnet (devnet or testnet?)');
  const health = await rpc('getHealth');
  return `mainnet, node ${health}`;
});

if (rpcOk) {
  await check('Solana', 'receiving wallet', async () => {
    const info = await rpc('getAccountInfo', [env.SOLANA_WALLET_ADDRESS, { encoding: 'base64' }]);
    if (info.value && info.value.owner !== SYSTEM_PROGRAM) {
      fail('this address is not a normal wallet (it looks like a token account or program); use your wallet\'s main address');
    }
    const tokens = await rpc('getTokenAccountsByOwner', [
      env.SOLANA_WALLET_ADDRESS, { mint: USDC_MINT }, { encoding: 'jsonParsed' },
    ]);
    const usdc = tokens.value.length
      ? 'has a USDC account'
      : 'no USDC account yet (the first payer\'s wallet creates it, for about 0.002 SOL)';
    return `valid wallet, ${usdc}`;
  });
}

// 8. Tavily

await check('Tavily', 'API key', async () => {
  // The usage endpoint is free; if it's missing or slow, fall back to one search.
  const usage = await call('https://api.tavily.com/usage', {
    headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}` },
  }).catch(() => undefined);
  if (usage?.status === 401 || usage?.status === 403) fail('key rejected');
  if (usage?.ok) {
    const key = usage.body?.key ?? {};
    return key.limit != null ? `key accepted, ${key.usage ?? 0} of ${key.limit} credits used` : 'key accepted';
  }
  const search = await call('https://api.tavily.com/search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.TAVILY_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'Solana USDC mint address', max_results: 1 }),
  });
  if (search.status === 401 || search.status === 403) fail('key rejected');
  if (!search.ok) fail(`HTTP ${search.status}: ${brief(search.body)}`);
  return 'key accepted (used 1 search credit)';
});

// Report

const width = Math.max(...results.map(([, service, name]) => `${service} · ${name}`.length));
for (const [status, service, name, detail] of results) {
  console.log(scrub(`${status}  ${`${service} · ${name}`.padEnd(width)}  ${detail}`));
}
const failed = results.filter(([status]) => status === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
// Exit explicitly: a closing WebSocket can otherwise keep Node waiting.
process.exit(failed ? 1 : 0);
