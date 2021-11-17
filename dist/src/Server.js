import { Request } from './Request';
export class Server {
    constructor(host) {
        this.middlewares = [];
        this.host = host;
    }
    request(request) {
        const r = new Request(this, request);
        r.middlewares.push(...this.middlewares);
        return r.start();
    }
}
//# sourceMappingURL=Server.js.map