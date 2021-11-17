import { Decoder, Encodeable } from "@simonbackx/simple-encoding";
import { SimpleErrors } from "@simonbackx/simple-errors";
import { RequestMiddleware } from "./RequestMiddleware";
import { Server } from "./Server";
export declare type HTTPMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
export declare class RequestResult<T> {
    data: T;
    constructor(data: T);
}
export interface RequestInitializer<T> {
    method: HTTPMethod;
    path: string;
    query?: any;
    body?: any | Encodeable | Encodeable[] | FormData;
    headers?: any;
    decoder?: Decoder<T>;
    signal?: AbortSignal | null;
    version?: number;
    timeout?: number;
}
export declare class Request<T> {
    server: Server;
    path: string;
    method: HTTPMethod;
    version?: number;
    headers: any;
    /**
     * Data that will get encoded in the URL of the request.
     */
    query: any | undefined;
    /**
     * Content that will get encoded in the body of the request (only for non GET requests)
     * Should be FormData (use this for uploading files) or it will get encoded as JSON
     */
    body: any | Encodeable | Encodeable[] | FormData | undefined;
    static sharedMiddlewares: RequestMiddleware[];
    middlewares: RequestMiddleware[];
    decoder: Decoder<T> | undefined;
    errorDecoder: Decoder<SimpleErrors> | undefined;
    timeout?: number;
    private request;
    static verbose: boolean;
    constructor(server: Server, request: RequestInitializer<T>);
    get static(): typeof Request;
    getMiddlewares(): RequestMiddleware[];
    private fetch;
    start(): Promise<RequestResult<T>>;
    private retryOrThrowServerError;
}
//# sourceMappingURL=Request.d.ts.map