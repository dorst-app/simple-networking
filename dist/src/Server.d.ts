import { RequestInitializer, RequestResult } from './Request';
import { RequestMiddleware } from './RequestMiddleware';
export declare class Server {
    /**
     * Hostname, including http(s) and port
     */
    host: string;
    middlewares: RequestMiddleware[];
    constructor(host: string);
    request<T>(request: RequestInitializer<T>): Promise<RequestResult<T>>;
}
//# sourceMappingURL=Server.d.ts.map