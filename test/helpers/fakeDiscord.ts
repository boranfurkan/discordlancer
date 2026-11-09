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

  get permissionOverwrites() {
    return {
      edit: async (id: string, permissions: Record<string, boolean>) => {
        this.overwrites.set(id, { ...this.overwrites.get(id), ...permissions });
      },
    };
  }

  post(author: Person & { bot?: boolean }, content: string, files: string[] = []): FakeMessage {
    const message: FakeMessage = {
      id: snowflake(),
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
    };
    this.history.push(message);
    return message;
  }

  async send(payload: unknown): Promise<FakeMessage> {
    const reply = toReply('reply', payload);
    return this.post({ id: this.guild.botId, bot: true, name: 'Freelance Manager Bot' }, reply.content, reply.files);
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
      create: async (options: { name: string; type: ChannelType; parent?: string; topic?: string }) =>
        this.addChannel(options.name, options.type, options.parent ?? null, options.topic),
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

type Options = Record<string, string | boolean | Person | undefined>;

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
    inCachedGuild: () => true,
    options: {
      getString: (name: string) => (typeof options[name] === 'string' ? (options[name] as string) : null),
      getBoolean: (name: string) => (typeof options[name] === 'boolean' ? (options[name] as boolean) : null),
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

/** Every reply's text, joined, for simple "contains" checks. */
export function said(interaction: { replies: Reply[] }): string {
  return interaction.replies.map((reply) => reply.content).join('\n');
}
