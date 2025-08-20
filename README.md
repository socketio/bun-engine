# @socket.io/bun-engine

## How to use

```js
import { Server as Engine } from "@socket.io/bun-engine";
import { Server } from "socket.io";

const io = new Server();

const engine = new Engine({
  path: "/socket.io/",
});

io.bind(engine);

Bun.serve({
  ...engine.handler(),
  port: 3000,
  idleTimeout: 30, // must be greater than the "pingInterval" option of the engine, which defaults to 25 seconds
});

io.on("connection", (socket) => {
  // ...
});
```

## License

[MIT](/LICENSE)
