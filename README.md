# Collab Editor

A real-time collaborative rich-text editor. Several people edit one document at once, see each other's cursors, keep working offline, and can save and restore versions. Conflicts are resolved with a CRDT ([Yjs](https://yjs.dev)), so there is no locking and no "last write wins".

**Stack:** TypeScript, React, TipTap (ProseMirror), Node, WebSockets, Yjs, PostgreSQL, Redis, Docker, nginx.

**Live demo:** https://collab-editor-1oj0.onrender.com. Create a document, then open its link in a second window. (Free hosting: the first visit after a quiet spell can take about a minute while the server wakes up.)

![Home page: the headline is co-written by two live cursors](docs/screenshot-home.png)

![Two people editing the same document, with a live cursor](docs/screenshot-editor.png)

## What it does

- **Concurrent editing** with automatic conflict resolution (CRDT), including rich text: headings, lists, quotes, code, marks.
- **Live presence:** remote cursors and selections with names and colours, and an avatar list.
- **Offline editing:** the client keeps a local copy in IndexedDB. Edits made offline (or after a reload) merge cleanly when the connection returns. A "Go offline" button demonstrates this.
- **Version history:** save named snapshots, preview them, and restore one into the live document. Connected clients see the restore instantly.
- **Horizontal scaling:** run any number of server instances; Redis pub/sub fans updates out between them.
- **Durable storage:** Postgres, with debounced writes and background compaction of the update log.
- **Safe to expose publicly:** documents can only be created through the API, writes are rate-limited per IP, each socket has a message budget, message size is capped, and the server doesn't list documents in production.

![Version history with preview and restore](docs/screenshot-history.png)

## Architecture

```
   Browser A                Browser B                Browser C
 TipTap + Yjs             TipTap + Yjs             TipTap + Yjs
 IndexedDB copy           IndexedDB copy           IndexedDB copy
      |  WebSocket             |  WebSocket             |  WebSocket
      +-----------+------------+------------+-----------+
                  |   nginx (round-robin, WS upgrade)    |
          +-------v--------+                    +--------v-------+
          |  Server  1     |                    |  Server  2     |
          |  Room: Y.Doc   |<--- Redis pub/sub -->  Room: Y.Doc  |
          |  + awareness   |   channel per doc  |  + awareness   |
          +-------+--------+                    +--------+-------+
                  |  debounced append / compaction       |
                  +-------------------+------------------+
                                      v
                               PostgreSQL
                  documents | doc_updates (log) | doc_versions
```

### How an edit travels

1. The browser applies the edit to its local Yjs doc (instant) and sends a small binary update over the WebSocket.
2. The server applies it to that document's in-memory `Y.Doc` (a **Room**) and forwards it to the other local sockets.
3. The same update is published to the document's Redis channel. Other instances apply it and forward it to *their* sockets. Updates that came from Redis are never re-published or re-persisted, so there are no loops and no duplicate writes.
4. The update is queued and written to Postgres after a short debounce.

### Key design decisions

| Decision | Why | Trade-off |
|---|---|---|
| **CRDT (Yjs) instead of operational transform** | Updates are commutative and idempotent, so ordering across instances, retries and offline merges are safe by construction. No central sequencer. | Documents carry some metadata overhead; history only grows (see restore below). |
| **Update log in Postgres, not a blob per document** | Appends are cheap and never contend with each other, so two instances can write the same document. | Needs compaction. |
| **Compaction deletes only the rows it merged**, under a row lock that does not block inserts | A concurrent append from another instance is never lost. Tested explicitly. | Slightly more complex than "replace everything". |
| **Debounced writes (400 ms, 2 s max wait)** | Typing produces many tiny updates; batching cuts writes by an order of magnitude. | A crash can lose up to the debounce window of edits. Clients still hold them locally and re-sync on reconnect, which limits real loss. |
| **Peers answer a new instance's state-vector request** (`sync1`/`sync2` on the bus) | An instance that opens a document must see edits other instances have not flushed yet, or a new collaborator would see stale text. | One extra bus round trip when a room opens. |
| **Restore = ordinary edit** (delete content, insert a copy of the snapshot) | A CRDT cannot rewind; replaying history backwards would break other clients. A restore propagates like any change and can itself be undone by restoring a newer version. | Restoring replaces the whole document body, so a collaborator's edit made at the same instant can be overwritten. |
| **Redis is for fan-out only** | Pub/sub is fire-and-forget, which is fine because Postgres is the source of truth and new rooms resync from peers and the log. | If Redis is down, instances stop seeing each other's live edits until it returns; each instance still works for its own clients. |
| **Full-state snapshots for versions** | Simple, and each version is self-contained. | Storage grows with the number of versions of large documents. |

### Reliability details

- **No edit is lost when an instance dies before saving.** Edits that reach an instance over Redis are saved by the instance that received them from the browser. If that instance crashes first, every other instance holding the document compares its memory with the database when it closes the room, and writes whatever is missing. Writing a CRDT update twice is harmless; writing it zero times is not. (Tested by making one instance's writes fail.)
- Rooms load lazily, are evicted after a configurable idle period, and flush and compact on the way out. Reopening a room waits for any in-flight teardown so it never reads stale data.
- Messages that arrive while a room is still loading are buffered, not dropped.
- A malformed message, or a client that floods messages, closes only that client's socket.
- The document title lives in the shared Yjs document, so renames sync live; the server mirrors it to Postgres.
- Server pings detect dead connections; the client reconnects with backoff automatically.
- Persistence failures are retried and counted in `/api/metrics`.
- Graceful shutdown flushes every open room.

## Running it

### Docker, single container

```bash
docker build -t collab-editor .
docker run -p 4000:4000 collab-editor      # http://localhost:4000 (in-memory store)
```

### Docker Compose (two instances, Postgres, Redis, nginx)

```bash
docker compose up --build
# open http://localhost:8080 in two browser windows
```

nginx round-robins connections across `app1` and `app2`, so two windows on the same document usually land on different instances and every edit crosses Redis.

### Local development

```bash
npm install
# Postgres + Redis (or skip them: the server falls back to in-memory storage and a single instance)
docker run -d -p 5432:5432 -e POSTGRES_USER=collab -e POSTGRES_PASSWORD=collab -e POSTGRES_DB=collab postgres:16-alpine
docker run -d -p 6379:6379 redis:7-alpine

DATABASE_URL=postgres://collab:collab@localhost:5432/collab REDIS_URL=redis://localhost:6379 npm run dev:server
npm run dev:client      # http://localhost:5173, proxies /api and /ws to :4000
```

Configuration is by environment variable; see [`.env.example`](.env.example).

## Deploy

The free path that keeps working long-term is **Render** (app) + **Neon** (Postgres):

1. Create a free Postgres database at [neon.tech](https://neon.tech) and copy its connection string (it ends in `?sslmode=require`).
2. On [render.com](https://render.com), choose **New → Blueprint**, pick this repository, and paste the Neon string into `DATABASE_URL` when asked. `render.yaml` sets up the rest.
3. Render gives you a URL like `https://collab-editor-xxxx.onrender.com`.

Free-tier caveats: the Render instance sleeps after 15 minutes without traffic and takes about a minute to wake, and the free plan runs a single instance, so Redis isn't needed there. Render's own free Postgres is deleted after 30 days, which is why this uses Neon.

## Tests

```bash
npm test                                    # 45 tests, no external services needed
DATABASE_URL=postgres://collab:collab@localhost:5432/collab \
REDIS_URL=redis://localhost:6379 npm test   # 54 tests, adds the Postgres and Redis contract suites
npm run build && npm run test:e2e           # end-to-end in two real Chromium browsers
```

CI (GitHub Actions) runs all three on every push, against real Postgres and Redis, and also builds and smoke-tests the Docker image.

The end-to-end test opens the production build in two separate browser profiles and checks: typing syncs both ways, remote cursors show names, formatting syncs, renames sync live, edits made offline in one browser merge with concurrent edits in the other, a saved version restores for both, content survives a reload, and an unknown link shows "not found".

Highlights:

- Concurrent edits converge; late joiners get existing state; offline edits merge on reconnect.
- Persistence survives a server restart; unsaved edits are flushed when the last client leaves; rapid typing is batched.
- **Two instances** share a document: edits and presence cross instances, each edit is persisted exactly once, a freshly opened instance catches up on another instance's *unflushed* edits, and a compaction racing with a concurrent write loses nothing.
- Version save / preview / restore, including restore-then-undo and snapshots that include unflushed edits.
- The same contract tests run against the in-memory and Postgres stores, and the local and Redis buses.

## Load test

```bash
# start the server(s) with API_WRITES_PER_MIN=100000 so the test can create its documents
npm run loadtest -- --urls ws://localhost:4001,ws://localhost:4002 --clients 500 --docs 25 --duration 20 --rate 5
```

Headless clients are spread across the instances. One client per document writes at a fixed rate; every other client records how long each edit took to arrive (client → server → Redis → other server → client). The script also reports the share of edits delivered.

Measured against two production builds backed by Postgres and Redis, on a 2 vCPU machine that also ran the load generator, Redis and Postgres (so these numbers are conservative):

| Clients | Docs | Instances | Edits/s per doc | Delivered | p50 | p95 | p99 |
|---|---|---|---|---|---|---|---|
| 500 | 25 | 2 | 5 | 47,025 / 47,025 (100%) | 1.6 ms | 14.3 ms | 28.2 ms |
| 2,000 | 100 | 2 | 5 | 186,200 / 186,200 (100%) | 3.4 ms | 31.4 ms | 74.7 ms |

"Delivered" counts every edit that every reader should have received, so 100% means nothing was dropped.

## Limitations and next steps

- **No accounts.** Access works like an unlisted link: anyone with a document's URL can read and edit it. Real use would need auth (for example a JWT checked on the WebSocket upgrade) and per-document permissions. A multi-tenant layer is the natural next project on top of this one.
- A version snapshot taken on an instance that has *just* opened a document can miss edits another instance hasn't saved yet (it catches up within milliseconds over Redis, but the snapshot doesn't wait).
- Presence names are self-chosen and unverified.
- Versions are manual; there is no automatic snapshotting.
- Client components have no unit tests; the client is covered by the end-to-end test.

## Project layout

```
server/src
  app.ts          HTTP API + WebSocket upgrade, heartbeat, shutdown
  rooms.ts        room lifecycle: lazy load, buffering, idle eviction
  room.ts         one open document: sync, presence, persistence, bus
  content.ts      version preview and restore
  store/          Store interface, Postgres and in-memory implementations
  bus/            Bus interface, Redis and in-process implementations
  sync-client.ts  headless client used by tests and the load test
  loadtest.ts
server/test       integration + contract tests
client/src        React app: home page, editor, toolbar, version panel
e2e/              two-browser end-to-end test (Playwright)
deploy/           nginx config for the scaled-out Compose setup
Dockerfile        single image: server + built client
render.yaml       one-click Render deploy
```
