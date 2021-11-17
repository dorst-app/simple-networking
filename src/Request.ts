// Requests use middleware to extend its behaviour
import { Decoder, Encodeable, isEncodeable, ObjectData } from "@simonbackx/simple-encoding";
import { SimpleErrors } from "@simonbackx/simple-errors";

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
    timeout?: number; // optional (in ms). Defaults to 10 - 15 seconds
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
    errorDecoder: Decoder<SimpleErrors> | undefined = SimpleErrors

    /// Milliseconds for fetch to timeout
    timeout?: number

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
        this.timeout = request.timeout;
    }

    get static(): typeof Request {
        return this.constructor as typeof Request;
    }

    getMiddlewares(): RequestMiddleware[] {
        return Request.sharedMiddlewares.concat(this.middlewares);
    }

    private async fetch(data: {
        method: HTTPMethod;
        url: string;
        body: string | Document | Blob | ArrayBufferView | ArrayBuffer | FormData | URLSearchParams | ReadableStream<Uint8Array> | null | undefined;
        headers: any;
        timeout: number;
    }): Promise<XMLHttpRequest> {
        return new Promise((resolve, reject) => {
            try {
                const request = new XMLHttpRequest();
                let finished = false

                request.onreadystatechange = (e: Event) => {
                    if (finished) {
                        // ignore duplicate events
                        return
                    }
                    if (request.readyState == 4) {
                        if (request.status == 0) {
                            // should call handleError or handleTimeout
                            return;
                        }

                        finished = true
                        resolve(request)
                    }
                };

                request.ontimeout = (e: ProgressEvent) => {
                    if (finished) {
                        // ignore duplicate events
                        return
                    }
                    finished = true
                    reject(new Error("Timeout"))
                };

                request.onerror = (e: ProgressEvent) => {
                    if (finished) {
                        // ignore duplicate events
                        return
                    }
                    // Your request timed out
                    finished = true
                    reject(e)
                };

                request.open(data.method, data.url)

                for (const key in data.headers) {
                    if (Object.prototype.hasOwnProperty.call(data.headers, key)) {
                        const value = data.headers[key];
                        request.setRequestHeader(key, value);
                    }
                }

                request.timeout = data.timeout

                request.send(data.body)
            } catch (e) {
                reject(e)
            }
        })
    }

    async start(): Promise<RequestResult<T>> {
        // todo: check if already running or not

        // todo: add query parameters
        for (const middleware of this.getMiddlewares()) {
            if (middleware.onBeforeRequest) await middleware.onBeforeRequest(this);
        }

        let response: XMLHttpRequest;
        let timeout = this.timeout ?? (this.method == "GET" ? 10 * 1000 : 15 * 10000)

        try {
            let body: any;

            // We only support application/json or FormData for now
            if (this.body === undefined) {
                body = undefined;
            } else {
                if (this.body instanceof FormData) {
                    body = this.body;
                    let size = 0
                    for (const [prop, value] of this.body.entries()) {
                        if (typeof value === "string") {
                            size += value.length
                        } else {
                            size += value.size
                        }
                    }

                    if (size > 1000 * 1000 * 1000) {
                        // > 1MB upload
                        timeout = Math.max(timeout, 60*1000)
                    }
                } else {
                    if (this.headers["Content-Type"] && (this.headers["Content-Type"] as string).startsWith("application/x-www-form-urlencoded")) {
                        body = Object.keys(this.body)
                            .filter((k) => this.body[k] !== undefined)
                            .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(this.body[k]))
                            .join("&");
                    } else {
                        this.headers["Content-Type"] = "application/json;charset=utf-8";

                        if (Array.isArray(this.body)) {
                            body = JSON.stringify(this.body.map((e) => {
                                if (isEncodeable(this.body)) {
                                    return e.encode({ version: this.version ?? 0 })
                                } else {
                                    return e
                                }
                            }));
                        } else {
                            if (isEncodeable(this.body)) {
                                body = JSON.stringify(this.body.encode({ version: this.version ?? 0 }));
                            } else {
                                body = JSON.stringify(this.body);
                            }
                        }
                    }

                }
            }

            let queryString = "";
            if (this.query ) {
                let query = this.query

                if (isEncodeable(this.query)) {
                    query = this.query.encode({ version: this.version ?? 0 })
                }

                if (Object.keys(query).length > 0) {
                    queryString =
                    "?" +
                    Object.keys(query)
                        .filter((k) => query[k] !== undefined)
                        .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(query[k]))
                        .join("&");
                }
            }

            if (this.static.verbose) {
                console.log("Starting new reuest");
                console.log("New request", this.method, this.path, this.body, this.query, this.headers);
            }

            response = await this.fetch({
                url: this.server.host + (this.version !== undefined ? ("/v" + this.version) : "") + this.path + queryString,
                method: this.method,
                headers: this.headers,
                body,
                timeout
            })

        } catch (error) {
            // Todo: map the error in o
            if (error.message === 'Timeout') {
                // Increase next timeout (note: upload will stay 1 minute)
                this.timeout = Math.max(timeout, 30*1000);
            }
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

        if (response.status < 200 || response.status >= 300) {
            if (response.getResponseHeader("Content-Type") === "application/json") {
                let err: SimpleErrors | any;

                try {
                    const json = JSON.parse(response.response)

                    if (this.errorDecoder) {
                        try {
                            err = this.errorDecoder.decode(new ObjectData(json, { version: 0 }));
                            if (this.static.verbose) {
                                console.error(err);
                            }
                        } catch (e) {
                            // Failed to decode
                            if (this.static.verbose) {
                                console.error(json);
                            }
                            throw e
                        }
                    } else {
                        err = json
                    }
                } catch (e) {
                    return await this.retryOrThrowServerError(response, e)
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

            // A non 200 status code without json header is always considered as a server error.
            return await this.retryOrThrowServerError(response, new Error(response.response))
        }

        if (response.getResponseHeader("Content-Type") === "application/json") {
            let json: any
            try {
                 json = JSON.parse(response.response)
            } catch (e) {
                // A non 200 status code without json header is always considered as a server error.
                return await this.retryOrThrowServerError(response, e)
            }

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
            // Expected content, but the server didn't respond with content
            if (this.static.verbose) {
                console.error(response.response);
            }
            return await this.retryOrThrowServerError(response, new Error("Missing JSON response from server"))
        }

        return new RequestResult(await response.response) as any;
    }

    private async retryOrThrowServerError(response: XMLHttpRequest, e: Error) {
        // Invalid json is considered as a server error
        if (this.static.verbose) {
            console.error(e);
        }

        // A middleware might decide here to retry instead of passing the error to the caller
        let retry = false;
        for (const middleware of this.getMiddlewares()) {
            // Check if one of the middlewares decides to stop
            if (middleware.shouldRetryServerError) {
                retry = retry || (await middleware.shouldRetryServerError(this, response, e));
            }
        }

        if (retry) {
            // Retry
            return await this.start();
        }
        throw e;
    }
}
