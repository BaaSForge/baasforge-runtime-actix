import * as http from "node:http";
import { PORT } from "./config.js";
import { handleRequest } from "./index.js";

const server = http.createServer((req, res) => {
  void handleRequest(req, res);
});

server.listen(PORT, () => {
  console.log(`Listening on http://localhost:${PORT}/`);
});
