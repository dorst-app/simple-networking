import { Request, RequestInitializer,RequestResult } from './Request';
import { RequestMiddleware } from './RequestMiddleware';

export class Server {
    /**
     * Hostname, including http(s) and port
     */
    host: string
    middlewares: RequestMiddleware[] = []

    constructor(host: string) {
        this.host = host
    }

    /**
     * Build an internal request. Start it manually.
     * Usefull if you need the reference to the request object in order to cancel it later.
     */
    build<T>(request: RequestInitializer<T>): Request<T>  {
        const r = new Request(this, request)
        r.middlewares.push(...this.middlewares)
        return r
    }

    /**
     * Build an internal request and start it immediately
     */
    request<T>(request: RequestInitializer<T>): Promise<RequestResult<T>>  {
        return this.build(request).start()
    }
}