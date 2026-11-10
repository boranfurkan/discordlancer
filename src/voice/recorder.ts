// Records the people in a call who agreed to it, each turn as its own segment. Discord
// sends every speaker's audio separately, so anyone who hasn't agreed is never
// subscribed to: their audio is not received, let alone kept.

import type { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { EndBehaviorType } from '@discordjs/voice';
import { log } from '../log.js';
import type { Segment } from './transcribe.js';

/** The part of @discordjs/voice's VoiceReceiver the recorder uses; tests use a fake. */
export interface ReceiverLike {
  speaking: EventEmitter & { users: Map<string, number> };
  subscribe(userId: string, options: { end: { behavior: EndBehaviorType; duration: number } }): Readable;
}

/** A turn ends after this much silence. */
export const SILENCE_MS = 1_000;
/** About 4 hours of one person talking: a guard against running out of memory. */
export const MAX_RECORDING_BYTES = 150 * 1024 * 1024;

export class CallRecorder {
  readonly startedAt: Date;
  private readonly allowed = new Set<string>();
  private readonly active = new Map<string, { segment: Segment; stream: Readable }>();
  private readonly finished: Segment[] = [];
  private bytes = 0;
  private stopped = false;
  private limitReported = false;

  constructor(
    private readonly receiver: ReceiverLike,
    private readonly options: { now?: () => Date; onLimit?: () => void } = {},
  ) {
    this.startedAt = this.now();
    receiver.speaking.on('start', this.onStart);
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  private readonly onStart = (userId: string) => this.listen(userId);

  /** From now on, record this person. Starts at once if they are already talking. */
  allow(userId: string): void {
    this.allowed.add(userId);
    if (this.receiver.speaking.users.has(userId)) this.listen(userId);
  }

  /** Stop recording this person and drop everything recorded from them. */
  forget(userId: string): void {
    this.allowed.delete(userId);
    const current = this.active.get(userId);
    this.active.delete(userId);
    current?.stream.destroy();
    for (let i = this.finished.length - 1; i >= 0; i--) if (this.finished[i]!.userId === userId) this.finished.splice(i, 1);
  }

  isAllowed(userId: string): boolean {
    return this.allowed.has(userId);
  }

  get recordedBytes(): number {
    return this.bytes;
  }

  private listen(userId: string): void {
    if (this.stopped || !this.allowed.has(userId) || this.active.has(userId)) return;
    const stream = this.receiver.subscribe(userId, { end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS } });
    const segment: Segment = { userId, startedAt: this.now(), packets: [] };
    this.active.set(userId, { segment, stream });
    stream.on('data', (packet: Buffer) => {
      if (!this.allowed.has(userId)) return;
      if (this.bytes + packet.length > MAX_RECORDING_BYTES) {
        if (!this.limitReported) {
          this.limitReported = true;
          this.options.onLimit?.();
        }
        return;
      }
      this.bytes += packet.length;
      segment.packets.push(packet);
    });
    const finish = () => {
      if (this.active.get(userId)?.segment !== segment) return;
      this.active.delete(userId);
      if (segment.packets.length && this.allowed.has(userId)) this.finished.push(segment);
    };
    stream.once('end', finish);
    stream.once('close', finish);
    stream.on('error', (error) => log.warn('a call audio stream failed', { error }));
  }

  /** Stops listening and returns every recorded turn, oldest first. Safe to call twice. */
  stop(): Segment[] {
    if (!this.stopped) {
      this.stopped = true;
      this.receiver.speaking.off('start', this.onStart);
      for (const [userId, { segment, stream }] of [...this.active]) {
        this.active.delete(userId);
        stream.destroy();
        if (segment.packets.length && this.allowed.has(userId)) this.finished.push(segment);
      }
    }
    return [...this.finished].sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime());
  }
}
