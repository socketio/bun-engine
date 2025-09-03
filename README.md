# @socket.io/bun-engine

A highly efficient, Bun-powered engine for Socket.IO, designed to enhance real-time communication performance.

This package provides a custom engine for Socket.IO that leverages the speed and scalability of Bun to handle WebSocket
connections seamlessly.

Reference: https://socket.io/

**Table of contents**

<!-- TOC -->
  * [How to use](#how-to-use)
    * [With Bun's HTTP server](#with-buns-http-server)
    * [With Hono](#with-hono)
    * [With Elysia](#with-elysia)
  * [Options](#options)
    * [`path`](#path)
    * [`pingTimeout`](#pingtimeout)
    * [`pingInterval`](#pinginterval)
    * [`upgradeTimeout`](#upgradetimeout)
    * [`maxHttpBufferSize`](#maxhttpbuffersize)
    * [`allowRequest`](#allowrequest)
    * [`cors`](#cors)
    * [`editHandshakeHeaders`](#edithandshakeheaders)
    * [`editResponseHeaders`](#editresponseheaders)
  * [License](#license)
<!-- TOC -->

## How to use

### With Bun's HTTP server

```js
import { Server as Engine } from "@socket.io/bun-engine";
import { Server } from "socket.io";

const io = new Server();

const engine = new Engine({
  path: "/socket.io/",
});

io.bind(engine);

io.on("connection", (socket) => {
  // ...
});

export default {
  port: 3000,
  ...engine.handler(),
};
```

### With Hono

```js
import { Server as Engine } from "@socket.io/bun-engine";
import { Server } from "socket.io";
import { Hono } from "hono";

const io = new Server();
const engine = new Engine();

io.bind(engine);

io.on("connection", (socket) => {
  // ...
});

const app = new Hono();

app.all("/socket.io/", (c) => {
  const request = c.req.raw;
  const server = c.env;
  return engine.handleRequest(request, server);
});

export default {
  port: 3000,
  ...engine.handler(),
  fetch: app.fetch,
}
```

Reference: https://hono.dev/docs/

### With Elysia

Requires [`elysia@>=1.3.21`](https://github.com/elysiajs/elysia/pull/1358).

```js
import { Server as Engine } from "@socket.io/bun-engine";
import { Server } from "socket.io";
import { Elysia } from "elysia";

const io = new Server();
const engine = new Engine();

io.bind(engine);

io.on("connection", (socket) => {
  // ...
});

const app = new Elysia()
  .all("/socket.io/", ({ request, server }) => engine.handleRequest(request, server))
  .listen({
    port: 3000,
    ...engine.handler(),
  });
```

Reference: https://elysiajs.com/at-glance.html

## Options

### `path`

Default value: `/engine.io/`

It is the name of the path that is captured on the server side.

Caution! The server and the client values must match (unless you are using a
path-rewriting proxy in between).

Example:

```ts
const engine = new Server(httpServer, {
  path: "/my-custom-path/",
});
```

### `pingTimeout`

Default value: `20000`

This value is used in the heartbeat mechanism, which periodically checks if the
connection is still alive between the server and the client.

The server sends a ping, and if the client does not answer with a pong within
`pingTimeout` ms, the server considers that the connection is closed.

Similarly, if the client does not receive a ping from the server within
`pingInterval + pingTimeout` ms, the client also considers that the connection
is closed.

### `pingInterval`

Default value: `25000`

See [`pingTimeout`](#pingtimeout) for more explanation.

### `upgradeTimeout`

Default value: `10000`

This is the delay in milliseconds before an uncompleted transport upgrade is
cancelled.

### `maxHttpBufferSize`

Default value: `1e6` (1 MB)

This defines how many bytes a single message can be, before closing the socket.
You may increase or decrease this value depending on your needs.

### `allowRequest`

Default value: `-`

A function that receives a given handshake or upgrade request as its first
parameter, and can decide whether to continue or not.

Example:

```ts
const engine = new Server({
  allowRequest: (req, server) => {
    return Promise.reject("thou shall not pass");
  },
});
```

### `cors`

Default value: `-`

A set of options related to
[Cross-Origin Resource Sharing](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS)
(CORS).

Example:

```ts
const engine = new Server({
  cors: {
    origin: ["https://example.com"],
    allowedHeaders: ["my-header"],
    credentials: true,
  },
});
```

### `editHandshakeHeaders`

Default value: `-`

A function that allows to edit the response headers of the handshake request.

Example:

```ts
const engine = new Server({
  editHandshakeHeaders: (responseHeaders, req, server) => {
    responseHeaders.set("set-cookie", "sid=1234");
  },
});
```

### `editResponseHeaders`

Default value: `-`

A function that allows to edit the response headers of all requests.

Example:

```ts
const engine = new Server({
  editResponseHeaders: (responseHeaders, req, server) => {
    responseHeaders.set("my-header", "abcd");
  },
});
```

## License

[MIT](/LICENSE)
