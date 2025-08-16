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
});

io.on("connection", (socket) => {
  // ...
});
```

## License

[MIT](/LICENSE)
