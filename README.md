# Yahoo WebSocket Proxy Server
## Service Name: Lateral (lateral.leaguesync.dev)

A TypeScript Node.js proxy server that enables web applications to connect to Yahoo Fantasy Sports WebSocket servers without Origin header restrictions.

## Features

- **League-based rooms**: Clients are grouped by `leagueId` only - all users in the same league share one Yahoo connection
- **Multi-user support**: Multiple users with different draft positions can connect to the same league room
- **Automatic Yahoo join**: Proxy automatically sends Yahoo join message upon connection using provided parameters
- **No Origin header**: Connects to Yahoo without browser restrictions
- **Message relay**: Bidirectional message passing between clients and Yahoo
- **Auto-reconnection**: Handles Yahoo disconnections with exponential backoff
- **Resource cleanup**: Automatically disconnects from Yahoo when no clients remain
- **Health monitoring**: Built-in health check and room status endpoints
- **TypeScript**: Fully typed for better development experience

## Room Architecture

### How Rooms Work
- **Room ID**: Based on `leagueId` only (e.g., `"12345"`)
- **Shared Connection**: All users in the same league share one Yahoo WebSocket connection
- **Message Isolation**: Users only receive messages for their specific league
- **Multi-Position Support**: Users with different draft positions can join the same league room

### Example Scenario
```
User A connects to League 12345 with Draft Position 1:
├── 🏠 Room "12345" created
├── 🔗 Yahoo WebSocket connection established  
├── 📤 Auto-send: "8|12345|1|YahooFantasyProxy/1.0 (user-a)|"
└── 📨 Start receiving Yahoo messages

User B connects to same League 12345 with Draft Position 3:
├── 🏠 Join existing room "12345"
├── 🔗 Share same Yahoo connection (no new join message needed)
└── 📨 Receive all Yahoo messages for League 12345

League 67890:
├── User D (Draft Position 2) ──┐
└── User E (Draft Position 5) ──┼── Room "67890" ──── Yahoo WebSocket
                                 │   📤 Auto-send: "8|67890|2|YahooFantasyProxy/1.0 (user-d)|"
                                 ┘
```

Users in League 12345 will NOT see messages from League 67890 and vice versa.

## Quick Start

### Installation

```bash
npm install
```

### Development

```bash
# Start development server with hot reload
npm run dev

# Or use ts-node-dev (recommended)
npm run dev:watch
```

### Production

```bash
# Build TypeScript to JavaScript
npm run build

# Start production server
npm start
```

## Project Structure

```
yahoo-websocket-proxy/
├── src/
│   ├── index.ts          # Main entry point
│   ├── app.ts            # Application logic
│   ├── config.ts         # Configuration management
│   ├── logging.ts        # Logging implementation
│   └── telemetry.ts      # Telemetry (stub)
├── types/
│   └── index.d.ts        # Type declarations
├── dist/                 # Compiled JavaScript (generated)
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## API Endpoints

### WebSocket Connection
- **Endpoint**: `ws://localhost:3001/yahoo/websocket/proxy`
- **Query Parameters**:
  - `leagueId`: Yahoo Fantasy league ID (determines room)
  - `draftPosition`: Client's draft position (1-based)
  - `websocketUrl`: Yahoo WebSocket URL to connect to
  - `platformUserId`: Optional user identifier

### REST Endpoints

#### Health Check
```http
GET /health
```
Returns server status and room count.

#### Room Status
```http
GET /rooms/:roomId/status
```
Returns status for a specific league room, including all connected draft positions.

#### All Rooms
```http
GET /rooms
```
Returns status for all active league rooms.

#### Force Room Cleanup (Admin)
```http
DELETE /rooms/:roomId
```
Forcefully cleans up a room, disconnecting all clients and Yahoo connection.

## Usage Example

### Multiple Users in Same League
```typescript
// User A (Draft Position 1) connecting to League 12345
const wsUserA = new WebSocket('ws://localhost:3001/yahoo/websocket/proxy?' + new URLSearchParams({
    leagueId: '12345',
    draftPosition: '1',
    websocketUrl: 'wss://yahoo-websocket-url',
    platformUserId: 'user-a'
}));

// User B (Draft Position 3) connecting to Same League 12345
const wsUserB = new WebSocket('ws://localhost:3001/yahoo/websocket/proxy?' + new URLSearchParams({
    leagueId: '12345',
    draftPosition: '3',
    websocketUrl: 'wss://yahoo-websocket-url',
    platformUserId: 'user-b'
}));

// Both users will:
// 1. Join the same room ("12345")
// 2. Share the same Yahoo WebSocket connection
// 3. Automatically send Yahoo join message (first user only)
// 4. Receive all Yahoo messages for League 12345
// 5. NOT see messages from other leagues

// Note: You don't need to manually send the join message!
// The proxy automatically sends: "8|12345|1|YahooFantasyProxy/1.0 (user-a)|"

// Send other messages to Yahoo
wsUserA.send(JSON.stringify({
    type: 'yahoo_message',
    data: 'c'  // Heartbeat or other Yahoo protocol messages
}));

// Receive messages
wsUserA.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'yahoo_message') {
        console.log('Yahoo message for League 12345:', message.data);
    }
};
```

## Message Protocol

### Client to Proxy
```typescript
{
    type: 'yahoo_message',
    data: string  // Raw Yahoo protocol message
}
```

### Proxy to Client
```typescript
// Yahoo message relay
{
    type: 'yahoo_message',
    data: string  // Raw Yahoo protocol message
}

// Connection status
{
    type: 'room_joined' | 'yahoo_connected' | 'yahoo_disconnected' | 'yahoo_error',
    roomId?: string,
    draftPosition?: number,  // Client's draft position
    message?: string,
    error?: string,
    code?: number,
    reason?: string
}
```

## Environment Variables

Copy `.env.example` to `.env` and configure:

```bash
PORT=3001
NODE_ENV=development
MAX_RECONNECT_ATTEMPTS=5
HEARTBEAT_INTERVAL=30000
CONNECTION_TIMEOUT=10000
```

## Room Management

- **Room ID**: Generated as `{leagueId}` (e.g., "12345")
- **Auto-cleanup**: Rooms are automatically destroyed when the last client disconnects
- **Yahoo connection**: Established when the first client joins a league room
- **Yahoo disconnection**: Automatically disconnects from Yahoo when no clients remain (does NOT reconnect)
- **Reconnection**: Automatic with exponential backoff ONLY when clients are present and disconnection was unexpected
- **Multi-user**: Multiple users with different draft positions can share the same league room

### Automatic Cleanup Behavior

```
┌─ Last client disconnects from room
├─ 🔌 Immediately disconnect from Yahoo (intentional disconnect)
├─ 🧹 Clean up room resources
├─ 🗑️ Remove room from memory
└─ ❌ NO reconnection attempts (room is gone)
```

### Reconnection Logic

Yahoo reconnection only happens when:
- ✅ Room has active clients (`clients.size > 0`)
- ✅ Disconnect was unexpected (not intentional cleanup)
- ✅ Close code is not normal (not `1000`)
- ✅ Haven't exceeded max reconnection attempts

Yahoo reconnection will NOT happen when:
- ❌ Room is empty (no clients)
- ❌ Room cleanup was triggered
- ❌ Server shutdown initiated
- ❌ Force cleanup was requested

## Development

### Prerequisites
- Node.js 16+
- TypeScript 5+

### Scripts
- `npm run build`: Compile TypeScript
- `npm run dev`: Development with ts-node-dev
- `npm run clean`: Remove dist directory
- `npm start`: Run compiled JavaScript

### Project Features
- Full TypeScript typing
- League-based room isolation
- Automatic reconnection handling
- Resource cleanup on shutdown
- Comprehensive logging
- Health monitoring endpoints

# `template-node-express`

A minimal production-ready node HTTP server with [`Express`](https://expressjs.com/) and Typescript.

✅ Typescript \
✅ Graceful shutdown \
✅ Optional Tracing with OpenTelemetry (configurable via environment variables) \
✅ Properly configured request payload size limiting to help prevent Denial of Service attack vectors \
✅ `AbortSignal` propagation to prevent unnecessary work (includes example and test)  \
✅ Validation with [`express-validator`](https://express-validator.github.io/docs) \
✅ Async error forwarding to default error handler with [`express-async-errors`](https://github.com/davidbanham/express-async-errors) \
✅ Structured logging with [`pino`](https://github.com/pinojs/pino) \
✅ Rich request logging middleware including request id, trace id, context propagation, and more \
✅ Testing with [`jest`](https://github.com/jestjs/jest), [`supertest`](https://github.com/ladjs/supertest), and [`fetch-mock`](https://github.com/wheresrhys/fetch-mock) \
✅ [`helmet`](https://github.com/helmetjs/helmet) & [`compression`](https://github.com/expressjs/compression)

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/KwYYFA?referralCode=ToZEjF)

## Installation

```sh
git clone https://github.com/dillonstreator/template-node-express

cd template-node-express

yarn install

yarn dev
```

## Configuration

See all example configuration via environment variables in [`.env-example`](./.env-example)

### Open Telemetry

Open Telemetry is disabled by default but can be enabled by setting the `OTEL_ENABLED` environment to `true`.

By default, the trace exporter is set to standard output. This can be overridden by setting `OTEL_EXPORTER_OTLP_ENDPOINT`.

Start the `jaegertracing/all-in-one` container with `docker-compose up` and set `OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318` to collect logs in jaeger. Docker compose will expose jaeger at http://localhost:16686