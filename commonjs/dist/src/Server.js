"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Server = void 0;
const Request_1 = require("./Request");
class Server {
    constructor(host) {
        this.middlewares = [];
        this.host = host;
    }
    request(request) {
        const r = new Request_1.Request(this, request);
        r.middlewares.push(...this.middlewares);
        return r.start();
    }
}
exports.Server = Server;
//# sourceMappingURL=Server.js.map