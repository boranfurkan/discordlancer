// A small fake of the parts of discord.js that Discordlancer uses, for journey tests:
// a server with channels, invites, roles and members; text channels with message
// history; and command and button interactions that record every reply.

import { ChannelType, Collection } from 'discord.js';

let nextId = 1_000_000_000_000_000n;
const snowflake = () => String(nextId++);

export interface Reply {
  kind: 'reply' | 'deferReply' | 'editReply' | 'followUp' | 'update';
  content: string;
  ephemeral: boolean;
  files: string[];
  embeds: Array<{ title?: string; fields?: Array<{ name: string; value: string }> }>;
  customIds: string[];
}

function toReply(kind: Reply['kind'], payload: unknown): Reply {
  if (typeof payload === 'string') return { kind, content: payload, ephemeral: false, files: [], embeds: [], customIds: [] };
  const p = (payload ?? {}) as {
    content?: string;
    flags?: number;
    files?: Array<{ name?: string }>;
    embeds?: Array<{ toJSON?: () => unknown; data?: unknown }>;
    components?: Array<{ components: Array<{ data: { custom_id?: string } }> }>;
  };
  return {
    kind,
    content: p.content ?? '',
    ephemeral: Boolean(p.flags && (p.flags & 64) === 64),
    files: (p.files ?? []).map((f) => f.name ?? ''),
    embeds: (p.embeds ?? []).map((e) => (e.toJSON ? e.toJSON() : (e.data ?? e)) as Reply['embeds'][number]),
    customIds: (p.components ?? []).flatMap((row) => row.components.map((c) => c.data.custom_id ?? '')),
  };
}

export interface FakeMessage {
  id: string;
  url: string;
  /** The message this one replies to, if any. */
  replyTo?: string | undefined;
  createdAt: Date;
  author: { id: string; bot: boolean; username: string };
  member: { displayName: string };
  content: string;
  attachments: Collection<string, never>;
  embeds: unknown[];
  system: boolean;
  files: string[];
  pinned: boolean;
  pin(): Promise<void>;
  /** discord.js: message.reply(payload), posted by the bot as a reply to this message. */
  reply(payload: unknown): Promise<FakeMessage>;
  /** discord.js: message.edit(payload); keeps the latest content and buttons. */
  edit(payload: unknown): Promise<FakeMessage>;
  delete(): Promise<void>;
  customIds: string[];
}

export interface Person {
  id: string;
  name: string;
}

export class FakeChannel {
  readonly history: FakeMessage[] = [];
  readonly overwrites = new Map<string, Record<string, boolean>>();

  constructor(
    readonly guild: FakeGuild,
    readonly id: string,
    readonly name: string,
    readonly type: ChannelType,
    readonly parentId: string | null,
    readonly topic?: string,
  ) {}

  /** discord.js: channel.messages.fetch({ limit, before }), newest first. */
  get messages() {
    return {
      fetch: async ({ limit, before }: { limit: number; before?: string }) => {
        const newestFirst = [...this.history].reverse();
        const start = before ? newestFirst.findIndex((m) => m.id === before) + 1 : 0;
        return new Collection(newestFirst.slice(start, start + limit).map((m) => [m.id, m]));
      },
    };
  }

  /** The `type` each overwrite edit gave (member 1, role 0), like discord.js needs for uncached ids. */
  readonly overwriteTypes = new Map<string, number | undefined>();

  get permissionOverwrites() {
    return {
      cache: new Map<string, unknown>(),
      edit: async (id: string, permissions: Record<string, boolean>, options?: { type?: number }) => {
        this.overwrites.set(id, { ...this.overwrites.get(id), ...permissions });
        this.overwriteTypes.set(id, options?.type);
      },
    };
  }

  /** Times the bot showed "is typing". */
  typing = 0;

  /** For a thread: who was added to it, and whether it is archived. */
  readonly threadMembers = new Set<string>();
  archived = false;

  get members() {
    return {
      add: async (id: string) => {
        this.threadMembers.add(id);
      },
    };
  }

  async setArchived(archived: boolean) {
    this.archived = archived;
  }

  /** discord.js: channel.threads, for threads under this channel. */
  get threads() {
    const mine = () => [...this.guild.channelsById.values()].filter((channel) => channel.type === ChannelType.PublicThread && channel.parentId === this.id);
    return {
      fetchActive: async () => ({ threads: new Collection(mine().filter((thread) => !thread.archived).map((thread) => [thread.id, thread])) }),
      fetchArchived: async () => ({ threads: new Collection(mine().filter((thread) => thread.archived).map((thread) => [thread.id, thread])) }),
      create: async (options: { name: string }) => this.guild.addChannel(options.name, ChannelType.PublicThread, this.id),
    };
  }

  async sendTyping(): Promise<void> {
    this.typing++;
  }

  post(author: Person & { bot?: boolean }, content: string, files: string[] = [], replyTo?: string): FakeMessage {
    const id = snowflake();
    const channel = this;
    const message: FakeMessage = {
      id,
      url: `https://discord.com/channels/${this.guild.id}/${this.id}/${id}`,
      replyTo,
      createdAt: new Date(),
      author: { id: author.id, bot: author.bot ?? false, username: author.name },
      member: { displayName: author.name },
      content,
      attachments: new Collection(),
      embeds: [],
      system: false,
      files,
      pinned: false,
      async pin() {
        this.pinned = true;
      },
      async reply(payload: unknown) {
        const reply = toReply('reply', payload);
        return channel.post({ id: channel.guild.botId, bot: true, name: 'Freelance Manager Bot' }, reply.content, reply.files, id);
      },
      customIds: [],
      async delete() {
        channel.history.splice(channel.history.indexOf(message), 1);
      },
      async edit(payload: unknown) {
        const update = toReply('update', payload);
        const has = (key: string) => typeof payload === 'object' && payload !== null && key in payload;
        if (typeof payload === 'string' || has('content')) message.content = update.content;
        if (has('components')) message.customIds = update.customIds;
        if (has('embeds')) message.embeds = update.embeds;
        return message;
      },
    };
    this.history.push(message);
    return message;
  }

  async send(payload: unknown): Promise<FakeMessage> {
    const reply = toReply('reply', payload);
    const message = this.post({ id: this.guild.botId, bot: true, name: 'Freelance Manager Bot' }, reply.content, reply.files);
    message.customIds = reply.customIds;
    message.embeds = reply.embeds;
    return message;
  }

  async createInvite(): Promise<{ code: string; url: string }> {
    const code = `inv${snowflake().slice(-6)}`;
    this.guild.liveInvites.add(code);
    return { code, url: `https://discord.gg/${code}` };
  }

  /** What the bot posted here, oldest first. */
  botText(): string[] {
    return this.history.filter((m) => m.author.bot).map((m) => m.content);
  }
}

export class FakeGuild {
  readonly channelsById = new Map<string, FakeChannel>();
  readonly liveInvites = new Set<string>();
  readonly roleGrants: Array<{ user: string; role: string }> = [];
  readonly memberIds = new Set<string>();
  /** Every permission overwrite given when the bot created a channel. */
  readonly createdOverwrites: Array<{ id: string; type?: number }> = [];

  constructor(
    readonly id: string,
    readonly botId: string,
  ) {}

  get roles() {
    return {
      everyone: { id: this.id },
      fetch: async () => new Collection([['role-client', { id: 'role-client', name: 'Client' }]]),
    };
  }

  get members() {
    return {
      me: { id: this.botId },
      fetch: async (id: string) => {
        if (!this.memberIds.has(id)) throw new Error('Unknown Member');
        return { id };
      },
      addRole: async ({ user, role }: { user: string; role: string }) => {
        this.roleGrants.push({ user, role });
      },
    };
  }

  get invites() {
    return {
      fetch: async () => new Collection([...this.liveInvites].map((code) => [code, { code }])),
      delete: async (code: string) => {
        this.liveInvites.delete(code);
      },
    };
  }

  get channels() {
    return {
      fetch: async (id?: string) => (id ? (this.channelsById.get(id) ?? null) : new Collection([...this.channelsById])),
      create: async (options: { name: string; type: ChannelType; parent?: string; topic?: string; permissionOverwrites?: Array<{ id: string; type?: number }> }) => {
        this.createdOverwrites.push(...(options.permissionOverwrites ?? []));
        return this.addChannel(options.name, options.type, options.parent ?? null, options.topic);
      },
    };
  }

  addChannel(name: string, type: ChannelType = ChannelType.GuildText, parentId: string | null = null, topic?: string): FakeChannel {
    const channel = new FakeChannel(this, snowflake(), name, type, parentId, topic);
    this.channelsById.set(channel.id, channel);
    return channel;
  }

  channelNamed(name: string): FakeChannel {
    const channel = [...this.channelsById.values()].find((candidate) => candidate.name === name);
    if (!channel) throw new Error(`no channel #${name}`);
    return channel;
  }

  /** Someone uses an invite: Discord uses it up, then the member joins. */
  useInvite(code: string, memberId: string): void {
    this.liveInvites.delete(code);
    this.memberIds.add(memberId);
  }
}

type FakeAttachment = { name: string; size: number; url: string; contentType: string | null };
type Options = Record<string, string | number | boolean | Person | FakeAttachment | undefined>;

/** A slash command, run by a person in a channel. */
export function commandInteraction(guild: FakeGuild, channel: FakeChannel, person: Person, commandName: string, options: Options = {}) {
  const replies: Reply[] = [];
  const interaction = {
    replies,
    commandName,
    user: { id: person.id, username: person.name, bot: false },
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    deferred: false,
    replied: false,
    isChatInputCommand: () => true,
    isButton: () => false,
    isMessageContextMenuCommand: () => false,
    inCachedGuild: () => true,
    options: {
      getString: (name: string) => (typeof options[name] === 'string' ? (options[name] as string) : null),
      getSubcommand: () => String(options.subcommand ?? ''),
      getInteger: (name: string) => (typeof options[name] === 'number' ? (options[name] as number) : null),
      getBoolean: (name: string) => (typeof options[name] === 'boolean' ? (options[name] as boolean) : null),
      getAttachment: (name: string) => {
        const value = options[name];
        return value && typeof value === 'object' && 'url' in value ? value : null;
      },
      getUser: (name: string) => {
        const user = options[name] as Person | undefined;
        return user ? { id: user.id, bot: false, username: user.name } : null;
      },
    },
    async reply(payload: unknown) {
      interaction.replied = true;
      replies.push(toReply('reply', payload));
    },
    async deferReply(payload?: unknown) {
      interaction.deferred = true;
      replies.push(toReply('deferReply', payload ?? {}));
    },
    async editReply(payload: unknown) {
      const reply = toReply('editReply', payload);
      replies.push(reply);
      return channel.post({ id: guild.botId, bot: true, name: 'Freelance Manager Bot' }, reply.content, reply.files);
    },
    async followUp(payload: unknown) {
      replies.push(toReply('followUp', payload));
    },
  };
  return interaction;
}

/** A button click, by a person, on a message in a channel. */
export function buttonInteraction(guild: FakeGuild, channel: FakeChannel, person: Person, customId: string) {
  const replies: Reply[] = [];
  const interaction = {
    replies,
    customId,
    user: { id: person.id, username: person.name, bot: false },
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    isButton: () => true,
    isMessageContextMenuCommand: () => false,
    inCachedGuild: () => true,
    async reply(payload: unknown) {
      interaction.replied = true;
      replies.push(toReply('reply', payload));
    },
    async update(payload: unknown) {
      interaction.replied = true;
      replies.push(toReply('update', payload));
    },
    async deferUpdate() {
      interaction.deferred = true;
    },
    async editReply(payload: unknown) {
      replies.push(toReply('editReply', payload));
    },
    async followUp(payload: unknown) {
      replies.push(toReply('followUp', payload));
    },
  };
  return interaction;
}

/** Right-click on a message, Apps, then a message menu command. */
export function menuInteraction(guild: FakeGuild, channel: FakeChannel, person: Person, commandName: string, target: FakeMessage) {
  const replies: Reply[] = [];
  const interaction = {
    replies,
    commandName,
    targetMessage: target,
    user: { id: person.id, username: person.name, bot: false },
    guild,
    guildId: guild.id,
    channel,
    channelId: channel.id,
    deferred: false,
    replied: false,
    isChatInputCommand: () => false,
    isButton: () => false,
    isMessageContextMenuCommand: () => true,
    inCachedGuild: () => true,
    async reply(payload: unknown) {
      interaction.replied = true;
      replies.push(toReply('reply', payload));
    },
    async deferReply(payload?: unknown) {
      interaction.deferred = true;
      replies.push(toReply('deferReply', payload ?? {}));
    },
    async editReply(payload: unknown) {
      replies.push(toReply('editReply', payload));
    },
  };
  return interaction;
}

/** A person's message, as the bot receives it: with mentions resolved and its reply target. */
export function incomingMessage(guild: FakeGuild, channel: FakeChannel, person: Person, content: string, replyTo?: FakeMessage) {
  const posted = channel.post(person, content, [], replyTo?.id);
  return Object.assign(posted, {
    guildId: guild.id,
    guild,
    channel,
    channelId: channel.id,
    inGuild: () => true,
    reference: replyTo ? { messageId: replyTo.id } : null,
    fetchReference: async () => {
      if (!replyTo) throw new Error('not a reply');
      return replyTo;
    },
  });
}

/** Every reply's text, joined, for simple "contains" checks. */
export function said(interaction: { replies: Reply[] }): string {
  return interaction.replies.map((reply) => reply.content).join('\n');
}
