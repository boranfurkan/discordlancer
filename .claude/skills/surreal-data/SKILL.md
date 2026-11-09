---
name: surreal-data
description: Discordlancer's SurrealDB conventions - the schema, the append-only history tables, record IDs, money, transactions, connecting and testing. Use whenever work touches src/db/, schema.surql, queries, tables, fields, indexes, events, stages stored in the database, or database tests, even if the user only says "save this", "record it", "add a field" or "the database".
---

# SurrealDB in Discordlancer

Our database is SurrealDB 4 on SurrealDB Cloud ("Earth"): namespace `freelance`, database `bot`. Read the vendor skills `surrealdb-js` and `surrealql` for the general API; this skill covers how we use it and what we learned the hard way. The schema is `src/db/schema.surql`, and the data model is described in `PLAN.md`.

## Connecting

- Use `connectDatabase(env)` from `src/db/client.ts`: one long-lived WebSocket connection. The SDK signs in again and reconnects by itself.
- **SurrealDB 4 refuses system users on HTTP `/signin`.** The same user signs in fine over the WebSocket RPC, which the SDK uses. Don't build anything on the HTTP endpoints.
- **`db.close()` hangs against SurrealDB 4,** because the WebSocket close handshake never finishes. Always use `closeDatabase(db)`, which gives up after 3 seconds. A script calls `process.exit()` after it.
- The SDK must be 2.2.1 or later for SurrealDB 4, and the test engine `@surrealdb/node` 3.2.0 or later. Both are pinned on purpose; see `PLAN.md`.

## Schema

- **Every definition uses `OVERWRITE`,** so `applySchema()` is safe to run again. The bot applies it at startup, and `npm run db:migrate` does it by hand.
- **Every table is `SCHEMAFULL`.**
- **`FLEXIBLE` comes after `TYPE`:** `TYPE option<object> FLEXIBLE`. Before it is a parse error in SurrealDB 4, and one bad statement rejects the whole schema.
- **Optional fields are `option<...>`.** When writing, leave an absent field out of the object rather than sending `undefined`.
- **Times are set by the database:**
  - mutable tables have `created_at ... DEFAULT time::now() READONLY` and `updated_at ... VALUE time::now()`;
  - history tables have `VALUE time::now() READONLY`, so the bot can't backdate them.
- **The stage list in the schema must match `STAGES` in `src/domain/stages.ts`.** A test checks this.
- **Adding a table or field:**
  1. Change `schema.surql`.
  2. Add a test in `test/db/schema.test.ts`.
  3. Update the data model in `PLAN.md`.

## Append-only history

`event`, `spec`, `quote`, `agreement` and `payment` are history. Code only ever creates them.

- **Table permissions don't bind system users,** and the bot signs in as one. So each history table has:
  `DEFINE EVENT OVERWRITE append_only ON <table> WHEN $event IN ["UPDATE", "DELETE"] THEN { THROW "..." }`.
  This was proven on 9 Nov, both in memory and on the cloud server. `UPDATE`, `UPSERT` and `DELETE` are refused, and the record is left unchanged.
- **An update that changes nothing doesn't fire the event.** Setting a field to the value it already has succeeds quietly, but nothing changes. A test of the guard must change a real value.
- **Write events only with `recordEvent()`** in `src/db/events.ts`. Correct a mistake with a new event, never an edit.
- **Commands that must never break use `safeRecord()`** in `src/discord/client.ts`. It logs a failed write instead of throwing.

## Records and values

- **Projects use their name as the record ID:** `new RecordId('project', name)`.
- **Results come back as SDK classes,** not plain JS values: `RecordId`, `DateTime`. Compare them with `toString()` or `JSON.stringify`, not `===`. Parse them with Zod before trusting them.
- **Money is an `int` of micro-USDC** (6 decimals). Convert with `src/domain/money.ts`, never with floats.
- **Unique indexes:**
  - project name and channel;
  - spec, quote and agreement versions;
  - payment request reference;
  - payment signature.

  A duplicate throws an error whose message contains "already". That's how a retry is made safe.

## Queries

- **Always bind values as parameters** (`$name`), never build SurrealQL from strings. A field name in a query must come from our code, never from a user.
- **`db.query()` returns one array per statement,** and throws when a statement fails.
- **A stage change and its event go in one transaction** (`BEGIN TRANSACTION; ... COMMIT TRANSACTION;`), through one function in `src/db/projects.ts`, which is added in phase 2.

## Tests

- `test/helpers/db.ts` gives `memoryDb()`: an in-memory SurrealDB 4 with the real schema applied. It needs no network and no keys.
- Vitest runs test files in separate processes (`pool: 'forks'`), because the engine is a native module.
- Test against the cloud only for behaviour the in-memory engine can't show. Do it inside a transaction that ends with `CANCEL TRANSACTION`, so nothing is left behind.
