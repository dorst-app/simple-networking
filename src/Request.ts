// Requests use middleware to extend its behaviour
import { Decoder, Encodeable, isEncodeable, ObjectData } from "@simonbackx/simple-encoding";
import { EndpointErrors } from "@simonbackx/simple-endpoints/dist/src/EndpointErrors";

import { RequestMiddleware } from "./RequestMiddleware";
import { Server } from "./Server";

export type HTTPMethod = "GET" | "POST" | "PATCH" | "DELETE" | "PUT";

export class RequestResult<T> {
    data: T;

    constructor(data: T) {
        this.data = data;
    }
}

export interface RequestInitializer<T> {
    method: HTTPMethod;
    path: string;
    query?: any;
    body?: any | Encodeable | Encodeable[] | FormData;
    headers?: any;
    decoder?: Decoder<T>;
    version?: number;
}

function wrapTimeout<T>(promise: Promise<T>, timeout): Promise<T> {
    return new Promise((resolve, reject) => {
        let didTimeout = false;
        let didReject = false;

        const timer = setTimeout(() => {
            if (didReject) {
                return;
            }
            console.error("Fetch timeout");
            didTimeout = true;
            reject(new Error("Timeout"));
        }, timeout);
        promise.then(
            (d) => {
                if (didTimeout) {
                    console.error("Got response after timeout :/");
                    return;
                }
                didReject = true;
                clearTimeout(timer);
                resolve(d);
            },
            (e) => {
                if (didTimeout) {
                    console.error("Timeout fetch got fetch error:");
                    console.error(e);
                    return;
                }
                didReject = true;
                reject(e);
                clearTimeout(timer);
            }
        );
    });
}

export class Request<T> {
    /// Path, relative to API host
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

    /// Shared middlewares that allows dependency injection here
    static sharedMiddlewares: RequestMiddleware[] = [];

    /// Request specific middleware
    middlewares: RequestMiddleware[] = [];

    decoder: Decoder<T> | undefined;

    static verbose = false;

    constructor(server: Server, request: RequestInitializer<T>) {
        this.server = server;
        this.method = request.method;
        this.path = request.path;
        this.query = request.query;
        this.body = request.body;
        this.decoder = request.decoder;
        this.headers = request.headers ?? {};
        this.version = request.version;
    }

    get static(): typeof Request {
        return this.constructor as typeof Request;
    }

    getMiddlewares(): RequestMiddleware[] {
        return Request.sharedMiddlewares.concat(this.middlewares);
    }

    async start(): Promise<RequestResult<T>> {
        // todo: check if already running or not

        // todo: add query parameters
        for (const middleware of this.getMiddlewares()) {
            if (middleware.onBeforeRequest) await middleware.onBeforeRequest(this);
        }

        let response: Response;

        try {
            let body: any;

            // We only support application/json or FormData for now
            if (this.body === undefined) {
                body = undefined;
            } else {
                if (this.body instanceof FormData) {
                    body = this.body;
                } else {
                    this.headers["Content-Type"] = "application/json";

                    if (Array.isArray(this.body)) {
                        body = JSON.stringify(this.body.map((e) => e.encode({ version: this.version ?? 0 })));
                    } else {
                        if (isEncodeable(this.body)) {
                            body = JSON.stringify(this.body.encode({ version: this.version ?? 0 }));
                        } else {
                            body = JSON.stringify(this.body);
                        }
                    }
                }
            }

            let queryString = "";
            if (this.query && Object.keys(this.query).length > 0) {
                queryString =
                    "?" +
                    Object.keys(this.query)
                        .filter((k) => this.query[k] !== undefined)
                        .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(this.query[k]))
                        .join("&");
            }

            if (this.static.verbose) {
                console.log("Starting new reuest");
                console.log("New request", this.method, this.path, this.body, this.query, this.headers);
            }

            response = await wrapTimeout(
                fetch(this.server.host + "/v" + this.version + this.path + queryString, {
                    method: this.method,
                    headers: this.headers,
                    body: body,
                    credentials: "omit",
                }),
                10000
            );
        } catch (error) {
            // Todo: map the error in our own error types to make error handling easier
            // network error is encountered or CORS is misconfigured on the server-side

            // A middleware might decide here to interrupt the callback
            // He might for example fire a timer to retry the request because of a network failure
            // Or it might decide to fetch a new access token because the current one is expired
            // They return a promise with a boolean value indicating that the request should get retried
            let retry = false;
            for (const middleware of this.getMiddlewares()) {
                // Check if one of the middlewares decides to stop
                if (middleware.shouldRetryNetworkError) {
                    retry = retry || (await middleware.shouldRetryNetworkError(this, error));
                }
            }
            if (retry) {
                // Retry
                return await this.start();
            }

            // Failed and not caught
            throw error;
        }

        for (const middleware of this.getMiddlewares()) {
            // Update middleware of recovered network status
            if (middleware.onNetworkResponse) {
                middleware.onNetworkResponse(this, response);
            }
        }

        if (!response.ok) {
            if (response.headers.get("Content-Type") == "application/json") {
                const json = await response.json();
                let err: EndpointErrors;
                try {
                    err = EndpointErrors.decode(new ObjectData(json, { version: 0 }));
                    if (this.static.verbose) {
                        console.error(err);
                    }
                } catch (e) {
                    // Failed to decode
                    console.error(json);
                    console.error(e);
                    throw new Error("Bad request with invalid json error");
                }

                // A middleware might decide here to retry instead of passing the error to the caller
                let retry = false;
                for (const middleware of this.getMiddlewares()) {
                    // Check if one of the middlewares decides to stop
                    if (middleware.shouldRetryError) {
                        retry = retry || (await middleware.shouldRetryError(this, response, err));
                    }
                }

                if (retry) {
                    // Retry
                    return await this.start();
                }

                throw err;
            }

            // Todo: add retry handlers

            throw new Error("Bad request");
        }

        if (response.headers.get("Content-Type") == "application/json") {
            const json = await response.json();

            // todo: add automatic decoding here, so we know we are receiving what we expected with typings
            if (this.decoder) {
                const decoded = this.decoder?.decode(new ObjectData(json, { version: this.version ?? 0 }));
                if (this.static.verbose) {
                    console.info(decoded);
                }
                return new RequestResult(decoded);
            }

            return new RequestResult(json);
        }
        if (this.decoder) {
            // something went wrong
            throw new Error("Received no decodeable content, but expected content");
        }

        return new RequestResult(await response.text()) as any;
    }
}
