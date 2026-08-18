/**
 * In-process Redis replacement for local/desktop mode.
 *
 * When CUMORA_REDIS_MODE=local, this module replaces the real ioredis
 * client with an in-memory implementation. Single-process desktop use
 * doesn't need Redis's network layer — pub/sub becomes EventEmitter,
 * and key-value ops become Map operations with setTimeout-based TTL.
 *
 * Exports the same surface as redis.ts: `redis`, `sub`, `publish`, and
 * all CH_* channel constants, so the rest of the server imports them
 * unchanged.
 */
import { EventEmitter } from 'node:events'

/* === Channel keys === (mirrors redis.ts exactly) */
export const CH_MESSAGE_NEW = 'cumora:msg.new'
export const CH_MESSAGE_DELTA = 'cumora:msg.delta'
export const CH_TYPING = 'cumora:typing'
export const CH_STATUS = 'cumora:status'
export const CH_REACTIONS = 'cumora:reactions'
export const CH_POLLS = 'cumora:polls'
export const CH_GROUP_PULLED = 'cumora:group.pulled'
export const CH_CONVO_UPDATED = 'cumora:convo.updated'
export const CH_CONVENE = 'cumora:convene'
export const CH_BOARDS = 'cumora:boards'
export const CH_DOCS = 'cumora:docs'
export const CH_DOC_UPDATE = 'cumora:doc.update'
export const CH_DOC_AWARENESS = 'cumora:doc.awareness'
export const CH_DOC_MENTION = 'cumora:doc.mention'
export const CH_CALENDAR_REMINDER = 'cumora:calendar.reminder'
export const CH_CALENDAR_EVENTS = 'cumora:calendar.events'

/* Re-export event types for consumers that import from this module. */
export type {
  MessageNewEvent, MessageDeltaEvent, TypingEvent, StatusEvent,
  ComputerStatusEvent, AvatarEvent, ParticipantAddedEvent, ReactionsEvent,
  ConversationUpdatedEvent, GroupPulledEvent, ConveneEvent, BoardEvent,
  DocIndexEvent, DocUpdateEvent, DocAwarenessEvent, DocMentionEvent,
  CalendarReminderEvent, CalendarEventChangedEvent, PollUpdatedEvent,
} from './redis.js'

import type { BroadcastEvent } from './redis.js'

interface StoredValue {
  value: string
  expireAt?: number
}

interface HashValue {
  fields: Map<string, string>
  expireAt?: number
}

interface SortedSetValue {
  members: Map<string, number>
  expireAt?: number
}

/** Shared event bus for pub/sub. Both `redis` and `sub` route through this. */
const bus = new EventEmitter()
bus.setMaxListeners(0)

/** Key-value store shared by all LocalRedis instances. */
const kvStore = new Map<string, StoredValue>()
const hashStore = new Map<string, HashValue>()
const zsetStore = new Map<string, SortedSetValue>()

/** Pending TTL timers so we can cancel on explicit delete. */
const ttlTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTtl(key: string): void {
  const t = ttlTimers.get(key)
  if (t) { clearTimeout(t); ttlTimers.delete(key) }
}

function setTtl(key: string, seconds: number): void {
  clearTtl(key)
  const timer = setTimeout(() => {
    kvStore.delete(key)
    hashStore.delete(key)
    zsetStore.delete(key)
    ttlTimers.delete(key)
  }, seconds * 1000)
  timer.unref?.()
  ttlTimers.set(key, timer)
}

function isExpired(stored: { expireAt?: number }): boolean {
  return stored.expireAt !== undefined && Date.now() >= stored.expireAt
}

/** Multi/pipeline builder — collects commands and runs them sequentially. */
class LocalMulti {
  private ops: Array<() => unknown> = []

  zadd(key: string, ...args: unknown[]): this {
    // Support: zadd(key, score, member) and zadd(key, 'NX', score, member)
    let nx = false
    let score: number
    let member: string
    if (typeof args[0] === 'string' && (args[0] === 'NX' || args[0] === 'nx')) {
      nx = true
      score = Number(args[1])
      member = String(args[2])
    } else {
      score = Number(args[0])
      member = String(args[1])
    }
    this.ops.push(() => {
      let zset = zsetStore.get(key)
      if (!zset || isExpired(zset)) {
        zset = { members: new Map() }
        zsetStore.set(key, zset)
      }
      if (nx && zset.members.has(member)) return 0
      zset.members.set(member, score)
      return 1
    })
    return this
  }

  zrem(key: string, member: string): this {
    this.ops.push(() => {
      const zset = zsetStore.get(key)
      if (!zset || isExpired(zset)) return 0
      return zset.members.delete(member) ? 1 : 0
    })
    return this
  }

  expire(key: string, seconds: number): this {
    this.ops.push(() => {
      setTtl(key, seconds)
      return 1
    })
    return this
  }

  incr(key: string): this {
    this.ops.push(() => {
      const existing = kvStore.get(key)
      if (existing && isExpired(existing)) kvStore.delete(key)
      const cur = kvStore.has(key) ? Number(kvStore.get(key)!.value) : 0
      const next = cur + 1
      kvStore.set(key, { value: String(next) })
      return next
    })
    return this
  }

  del(key: string): this {
    this.ops.push(() => {
      clearTtl(key)
      const had = kvStore.has(key) || hashStore.has(key) || zsetStore.has(key)
      kvStore.delete(key)
      hashStore.delete(key)
      zsetStore.delete(key)
      return had ? 1 : 0
    })
    return this
  }

  async exec(): Promise<Array<[Error | null, unknown]>> {
    const results: Array<[Error | null, unknown]> = []
    for (const op of this.ops) {
      try { results.push([null, await op()]) }
      catch (err) { results.push([err as Error, null]) }
    }
    this.ops = []
    return results
  }
}

/** Minimal ioredis-compatible client backed by in-memory stores. */
class LocalRedis extends EventEmitter {
  readonly id = 'local'

  // ─── pub/sub ───
  publish(channel: string, message: string): Promise<number> {
    setImmediate(() => bus.emit(channel, message))
    return Promise.resolve(1)
  }

  subscribe(...channels: (string | ((err: Error | null) => void))[]): Promise<number> {
    // ioredis supports subscribe(channel, callback) or subscribe(channels...)
    // Filter out callback functions (last arg if it's a function).
    const chans = channels.filter((c): c is string => typeof c === 'string')
    // If a callback was passed, call it immediately (no error possible).
    const cb = channels.find((c) => typeof c === 'function') as ((err: Error | null) => void) | undefined
    if (cb) setImmediate(() => cb(null))
    return Promise.resolve(chans.length)
  }

  // ─── string commands ───
  async get(key: string): Promise<string | null> {
    const stored = kvStore.get(key)
    if (!stored || isExpired(stored)) {
      if (stored) kvStore.delete(key)
      return null
    }
    return stored.value
  }

  async set(key: string, value: string, ...opts: unknown[]): Promise<string | null> {
    // Supports: SET key value EX seconds NX
    let exSeconds: number | undefined
    let nx = false
    for (let i = 0; i < opts.length; i++) {
      const opt = String(opts[i]).toUpperCase()
      if (opt === 'EX') exSeconds = Number(opts[++i])
      else if (opt === 'NX') nx = true
      else if (opt === 'PX') exSeconds = Number(opts[++i]) / 1000
    }
    if (nx) {
      const existing = kvStore.get(key)
      if (existing && !isExpired(existing)) return null
    }
    kvStore.set(key, { value, expireAt: exSeconds ? Date.now() + exSeconds * 1000 : undefined })
    if (exSeconds) setTtl(key, exSeconds)
    return 'OK'
  }

  async getdel(key: string): Promise<string | null> {
    const val = await this.get(key)
    if (val !== null) {
      clearTtl(key)
      kvStore.delete(key)
    }
    return val
  }

  async del(key: string): Promise<number> {
    clearTtl(key)
    const had = kvStore.has(key) || hashStore.has(key) || zsetStore.has(key)
    kvStore.delete(key)
    hashStore.delete(key)
    zsetStore.delete(key)
    return had ? 1 : 0
  }

  async incr(key: string): Promise<number> {
    const existing = kvStore.get(key)
    if (existing && isExpired(existing)) kvStore.delete(key)
    const cur = kvStore.has(key) ? Number(kvStore.get(key)!.value) : 0
    const next = cur + 1
    kvStore.set(key, { value: String(next), expireAt: existing?.expireAt })
    return next
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (kvStore.has(key) || hashStore.has(key) || zsetStore.has(key)) {
      setTtl(key, seconds)
      return 1
    }
    return 0
  }

  // ─── hash commands ───
  async hset(key: string, field: string, value: string): Promise<number> {
    let hash = hashStore.get(key)
    if (!hash || isExpired(hash)) {
      hash = { fields: new Map() }
      hashStore.set(key, hash)
    }
    const isNew = !hash.fields.has(field)
    hash.fields.set(field, value)
    return isNew ? 1 : 0
  }

  async hsetnx(key: string, field: string, value: string): Promise<number> {
    const hash = hashStore.get(key)
    if (hash && !isExpired(hash) && hash.fields.has(field)) return 0
    return this.hset(key, field, value)
  }

  async hget(key: string, field: string): Promise<string | null> {
    const hash = hashStore.get(key)
    if (!hash || isExpired(hash)) return null
    return hash.fields.get(field) ?? null
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    const hash = hashStore.get(key)
    if (!hash || isExpired(hash)) return {}
    return Object.fromEntries(hash.fields)
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    const hash = hashStore.get(key)
    if (!hash || isExpired(hash)) return 0
    let removed = 0
    for (const field of fields) {
      if (hash.fields.delete(field)) removed++
    }
    return removed
  }

  // ─── sorted set commands ───
  async zadd(key: string, ...args: unknown[]): Promise<number> {
    let zset = zsetStore.get(key)
    if (!zset || isExpired(zset)) {
      zset = { members: new Map() }
      zsetStore.set(key, zset)
    }
    // Parse: zadd(key, score, member) or zadd(key, 'NX', score, member)
    let nx = false
    let i = 0
    if (typeof args[0] === 'string' && (args[0] === 'NX' || args[0] === 'nx')) {
      nx = true
      i = 1
    }
    const score = Number(args[i])
    const member = String(args[i + 1])
    if (nx && zset.members.has(member)) return 0
    const isNew = !zset.members.has(member)
    zset.members.set(member, score)
    return isNew ? 1 : 0
  }

  async zrange(key: string, start: number, stop: number): Promise<string[]> {
    const zset = zsetStore.get(key)
    if (!zset || isExpired(zset)) return []
    const sorted = [...zset.members.entries()].sort((a, b) => a[1] - b[1])
    const len = sorted.length
    const s = start < 0 ? Math.max(0, len + start) : start
    const e = stop < 0 ? len + stop : stop
    return sorted.slice(s, e + 1).map(([, member]) => member as string)
  }

  async zrangebyscore(key: string, min: string | number, max: string | number, ...opts: unknown[]): Promise<string[]> {
    const zset = zsetStore.get(key)
    if (!zset || isExpired(zset)) return []
    let minVal = Number(min)
    let maxVal = Number(max)
    if (typeof min === 'string' && min.startsWith('(')) minVal = Number(min.slice(1)) + 0.001
    if (typeof max === 'string' && max.startsWith('(')) maxVal = Number(max.slice(1)) - 0.001
    let limitOffset = 0
    let limitCount = Infinity
    for (let i = 0; i < opts.length; i++) {
      if (String(opts[i]).toUpperCase() === 'LIMIT') {
        limitOffset = Number(opts[++i])
        limitCount = Number(opts[++i])
      }
    }
    const sorted = [...zset.members.entries()]
      .filter(([, score]) => score >= minVal && score <= maxVal)
      .sort((a, b) => a[1] - b[1])
    return sorted.slice(limitOffset, limitOffset + limitCount).map(([, member]) => member as string)
  }

  async zrem(key: string, member: string): Promise<number> {
    const zset = zsetStore.get(key)
    if (!zset || isExpired(zset)) return 0
    return zset.members.delete(member) ? 1 : 0
  }

  // ─── scripting ───
  async eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    // We handle the two specific Lua scripts used by seen-boundary.ts:
    // 1. MONOTONIC_SET_SCRIPT: cur = GET key; if tonumber(ARGV[1]) > cur then SET key ARGV[1] EX ARGV[2]; return 1 else return 0
    // 2. CONSUME_SCRIPT: v = GET key; if v then DEL key; return v else return false
    // Rather than parse Lua, we pattern-match on the script content.
    const key = String(args[0])

    if (script.includes('tonumber(ARGV') && script.includes('redis.call(\'SET\'')) {
      // Monotonic set: only update if new value > current
      const newVal = Number(args[1])
      const ttl = Number(args[2])
      const existing = kvStore.get(key)
      const curVal = existing && !isExpired(existing) ? Number(existing.value) : 0
      if (newVal > curVal) {
        kvStore.set(key, { value: String(newVal), expireAt: Date.now() + ttl * 1000 })
        setTtl(key, ttl)
        return 1
      }
      return 0
    }

    if (script.includes('redis.call(\'DEL\'') && script.includes('redis.call(\'GET\'')) {
    // Consume: GET then DEL
      const val = await this.get(key)
      if (val !== null) {
        clearTtl(key)
        kvStore.delete(key)
        return val
      }
      return false
    }

    // Unknown script — fail-open
    return null
  }

  call(..._args: unknown[]): unknown {
    // Used inside Lua scripts via redis.call — not called directly from TS.
    // If someone calls it directly, return null (fail-open).
    return null
  }

  // ─── scan ───
  scanStream(): NodeJS.ReadableStream {
    // The only caller (og.ts) uses it for cache enumeration. Return empty stream.
    const { Readable } = require('node:stream')
    return Readable.from([])
  }

  // ─── pipeline / multi ───
  multi(): LocalMulti { return new LocalMulti() }

  // ─── lifecycle ───
  disconnect(): void { /* no-op */ }
  quit(): Promise<void> { return Promise.resolve() }
}

export const redis = new LocalRedis()
export const sub = new LocalRedis()

// Wire bus → 'message' events so callers using sub.on('message', cb) work.
for (const channel of [
  CH_MESSAGE_NEW, CH_MESSAGE_DELTA, CH_TYPING, CH_STATUS, CH_REACTIONS,
  CH_POLLS, CH_GROUP_PULLED, CH_CONVO_UPDATED, CH_CONVENE, CH_BOARDS,
  CH_DOCS, CH_DOC_UPDATE, CH_DOC_AWARENESS, CH_DOC_MENTION,
  CH_CALENDAR_REMINDER, CH_CALENDAR_EVENTS,
]) {
  bus.on(channel, (message: string) => {
    sub.emit('message', channel, message)
  })
}

export async function publish(channel: string, event: BroadcastEvent): Promise<void> {
  await redis.publish(channel, JSON.stringify(event))
}
