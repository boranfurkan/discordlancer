// Sets up the Discord server's public face. Safe to run again: it finds channels by
// name, sets permissions, and edits the welcome message instead of posting a second.
//
// Run: node scripts/setup-server.mjs [--icon /path/to/icon.png]
//
// What it does:
// - server icon (with --icon), join notices to the private owner-desk channel,
//   notifications on @mentions only, verified email required;
// - a "Start here" category with read-only #welcome and #announcements;
// - the welcome message: how projects, payments and privacy work.
// It never deletes anything.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));
if (existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);
const TOKEN = process.env.DISCORD_TOKEN?.trim();
const GUILD = process.env.DISCORD_GUILD_ID?.trim();
const OWNER_NAME = 'Furkan';
if (!TOKEN || !GUILD) throw new Error('DISCORD_TOKEN and DISCORD_GUILD_ID must be set');

const iconArg = process.argv.indexOf('--icon');
const iconPath = iconArg > 0 ? process.argv[iconArg + 1] : undefined;

const YELLOW = 0xf6d776; // the logo's yellow
const P = { VIEW: 1n << 10n, SEND: 1n << 11n, HISTORY: 1n << 16n, REACT: 1n << 6n, THREADS_PUBLIC: 1n << 35n, THREADS_PRIVATE: 1n << 36n, SEND_IN_THREADS: 1n << 38n };

async function api(method, path, body) {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${TOKEN}`,
      'Content-Type': 'application/json',
      'X-Audit-Log-Reason': 'Discordlancer server setup',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 204) return null;
  const json = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${method} ${path} → HTTP ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

const say = (line) => console.log(line);

// --- Server settings --------------------------------------------------------

let channels = await api('GET', `/guilds/${GUILD}/channels`);
const byName = (name, type) => channels.find((c) => c.name === name && (type === undefined || c.type === type));
const ownerDesk = byName('owner-desk', 0);

const guildPatch = {
  default_message_notifications: 1, // only @mentions
  verification_level: 1, // verified email
  ...(ownerDesk ? { system_channel_id: ownerDesk.id } : {}),
};
if (iconPath) {
  guildPatch.icon = `data:image/png;base64,${readFileSync(iconPath).toString('base64')}`;
}
const guild = await api('PATCH', `/guilds/${GUILD}`, guildPatch);
say(`server: icon ${iconPath ? 'updated' : 'unchanged'}, notifications on @mentions, verified email, join notices → #${ownerDesk ? 'owner-desk' : '(unchanged)'}`);

// --- Roles --------------------------------------------------------------------
// Owner (Boran) and Client are labels: listed separately, coloured, no extra
// permissions. Channel access comes from the per-project overwrites, never from roles.
// The bot's own role stays on top, so it can give the Client role.

const bit = (n) => 1n << BigInt(n);
const EVERYONE = [
  10, // View Channels
  11, // Send Messages
  38, // Send Messages in Threads
  16, // Read Message History
  14, // Embed Links
  15, // Attach Files
  6, // Add Reactions
  18, // Use External Emojis
  37, // Use External Stickers
  31, // Use Application Commands (the bot's slash commands)
  26, // Change Nickname
  20, // Connect (voice)
  21, // Speak
  25, // Use Voice Activity
  9, // Video / screen share
  46, // Send Voice Messages
].reduce((all, n) => all | bit(n), 0n);
// Left out on purpose: Create Invite, Mention @everyone, Create Events, Create
// Expressions, Create Threads, Soundboard, Activities, Polls, External Apps.
await api('PATCH', `/guilds/${GUILD}/roles/${GUILD}`, { permissions: String(EVERYONE) });
say('@everyone: trimmed to what a client needs (no invites, no @everyone mentions, no events or outside apps)');

const ROLE_SPECS = [
  { name: 'Owner', color: YELLOW, hoist: true, mentionable: true },
  { name: 'Client', color: 0x5dade2, hoist: true, mentionable: false },
];
let roles = await api('GET', `/guilds/${GUILD}/roles`);
for (const spec of ROLE_SPECS) {
  const found = roles.find((role) => role.name === spec.name && !role.managed);
  if (found) await api('PATCH', `/guilds/${GUILD}/roles/${found.id}`, { ...spec, permissions: '0' });
  else await api('POST', `/guilds/${GUILD}/roles`, { ...spec, permissions: '0' });
}
roles = await api('GET', `/guilds/${GUILD}/roles`);
const ownerRole = roles.find((role) => role.name === 'Owner' && !role.managed);
const clientRole = roles.find((role) => role.name === 'Client' && !role.managed);
await api('PATCH', `/guilds/${GUILD}/roles`, [
  { id: clientRole.id, position: 1 },
  { id: ownerRole.id, position: 2 },
]);
const OWNER_ID = process.env.DISCORD_OWNER_ID?.trim();
if (OWNER_ID) await api('PUT', `/guilds/${GUILD}/members/${OWNER_ID}/roles/${ownerRole.id}`);
say('roles: Owner (you) and Client, under the bot role; the bot gives Client to each client who joins');

// --- "Start here" category ---------------------------------------------------

let start = byName('Start here', 4) ?? byName('Information', 4);
if (!start) start = await api('POST', `/guilds/${GUILD}/channels`, { name: 'Start here', type: 4, position: 0 });
else if (start.name !== 'Start here') start = await api('PATCH', `/channels/${start.id}`, { name: 'Start here' });
say('category: Start here');

/** A text channel everyone can read but only the bot (and admins) can post in. */
async function readOnlyChannel(names, name, topic) {
  let channel = names.map((n) => byName(n, 0) ?? byName(n, 5)).find(Boolean);
  if (!channel) channel = await api('POST', `/guilds/${GUILD}/channels`, { name, type: 0, parent_id: start.id, topic });
  else channel = await api('PATCH', `/channels/${channel.id}`, { name, topic, parent_id: start.id });
  await api('PUT', `/channels/${channel.id}/permissions/${GUILD}`, {
    type: 0,
    allow: String(P.VIEW | P.HISTORY | P.REACT),
    deny: String(P.SEND | P.SEND_IN_THREADS | P.THREADS_PUBLIC | P.THREADS_PRIVATE),
  });
  say(`#${name}: read-only for members`);
  return channel;
}

const welcome = await readOnlyChannel(['welcome', 'welcome-and-rules'], 'welcome', 'How projects work here. Start here.');
await readOnlyChannel(['announcements'], 'announcements', `Updates from ${OWNER_NAME}.`);
await api('PATCH', `/channels/${welcome.id}`, { position: 0 });

// --- The welcome message -----------------------------------------------------

const iconUrl = guild.icon ? `https://cdn.discordapp.com/icons/${GUILD}/${guild.icon}.png?size=256` : undefined;
const embed = {
  title: `Welcome to ${guild.name}`,
  color: YELLOW,
  ...(iconUrl ? { thumbnail: { url: iconUrl } } : {}),
  description: [
    `This is where ${OWNER_NAME} runs client software projects, from the first conversation to delivery and support.`,
    '',
    `Every client gets a **private project channel** that only they, ${OWNER_NAME} and the Discordlancer bot can see. It opens for you a moment after you join with your invite link.`,
  ].join('\n'),
  fields: [
    {
      name: 'How a project works',
      value: [
        '**1. Talk it through.** Describe what you need in your channel. Screenshots, links and files all help.',
        `**2. Specs.** ${OWNER_NAME} turns the conversation into written specs (/create-specs). You both agree them with /agree-specs.`,
        `**3. Quote.** ${OWNER_NAME} posts a fixed price in USDC and a delivery date. You accept with /accept-quote.`,
        '**4. Payment.** Declare your wallet with /set-payment-wallet, then pay with /pay. The bot confirms on the blockchain by itself.',
        '**5. Build and delivery.** Check progress with /progress. When it is done, you confirm the delivery.',
        '**6. After delivery.** Ask for small changes with /request-update.',
      ].join('\n'),
    },
    {
      name: 'Payments',
      value: [
        '- **USDC on Solana only**, through the /pay QR code in your own project channel.',
        `- Nobody from this server will ever DM you asking for payment. If someone does, it isn't ${OWNER_NAME}.`,
        '- Use /receipt in your channel any time for a receipt.',
      ].join('\n'),
    },
    {
      name: 'Privacy',
      value: [
        '- Only you and the people working on your project can see your project channel.',
        '- The bot keeps a record of your project (messages used for the specs, commands, payments) so you both have a clear history.',
        `- Specs and progress estimates are drafted with AI (Google Gemini) and checked by ${OWNER_NAME}. Gemini does not keep them.`,
        '- Other members can see your Discord name in this channel and the member list.',
      ].join('\n'),
    },
    { name: 'Help', value: `Type **/help** in your project channel to see what you can do at each step, or just write to ${OWNER_NAME} there.` },
  ],
};

const existing = (await api('GET', `/channels/${welcome.id}/messages?limit=50`)) ?? [];
const me = await api('GET', '/users/@me');
const previous = existing.find((m) => m.author?.id === me.id && m.embeds?.[0]?.title?.startsWith('Welcome to'));
let message;
if (previous) {
  message = await api('PATCH', `/channels/${welcome.id}/messages/${previous.id}`, { embeds: [embed] });
  say('welcome message: updated');
} else {
  message = await api('POST', `/channels/${welcome.id}/messages`, { embeds: [embed] });
  say('welcome message: posted');
}
await api('PUT', `/channels/${welcome.id}/messages/pins/${message.id}`).catch(() => api('PUT', `/channels/${welcome.id}/pins/${message.id}`));
say('welcome message: pinned');

// --- Order: Start here at the top --------------------------------------------

channels = await api('GET', `/guilds/${GUILD}/channels`);
const categories = channels.filter((c) => c.type === 4).sort((a, b) => a.position - b.position);
const order = [start.id, ...categories.map((c) => c.id).filter((id) => id !== start.id)];
await api('PATCH', `/guilds/${GUILD}/channels`, order.map((id, position) => ({ id, position })));
say('categories: Start here first');
