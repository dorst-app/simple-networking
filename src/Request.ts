// Requests use middleware to extend its behaviour
import { Decoder, EncodableObject, encodeObject, ObjectData } from "@simonbackx/simple-encoding";
import { isSimpleError, isSimpleErrors, SimpleError, SimpleErrors } from "@simonbackx/simple-errors";

import { RequestBag } from "./RequestBag";
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
    body?: EncodableObject | FormData;
    headers?: any;
    decoder?: Decoder<T>;
    version?: number;
    timeout?: number; // optional (in ms). Defaults to 10 - 15 seconds
    shouldRetry?: boolean;
    allowErrorRetry?: boolean;

    /**
     * If you want to associate a request bag to this request (so you can cancel all requests for a given instance easily and fast)
     */
    bag?: RequestBag;
    
    /**
     * Shorthand for 'bag: RequestBag.getOrCreate(self)'
     */
    owner?: any;
}

export class Request<T> {
    /// Path, relative to API host
    server: Server;
    path: string;
    method: HTTPMethod;
    version?: number;
    headers: any;

    /**
     * Set to false to disable middleware retry logic entirely. When canceling a request, this will also
     * disable retries
     */
    shouldRetry = true;

    /**
     * Even when shouldRetry is false, still allow to retry normal valid errors
     * often needed to refresh a token etc
     */
    allowErrorRetry = true;

    /**
     * Data that will get encoded in the URL of the request.
     */
    query: any | undefined;

    /**
     * Content that will get encoded in the body of the request (only for non GET requests)
     * Should be FormData (use this for uploading files) or it will get encoded as JSON
     */
    body: EncodableObject | FormData | undefined;

    /// Shared middlewares that allows dependency injection here
    static sharedMiddlewares: RequestMiddleware[] = [];

    /// Request specific middleware
    middlewares: RequestMiddleware[] = [];

    decoder: Decoder<T> | undefined;
    errorDecoder: Decoder<SimpleErrors> | undefined = SimpleErrors

    /// Milliseconds for fetch to timeout
    timeout?: number

    bag?: RequestBag;

    static verbose = false;

    didFailNetwork = false

    private XMLHttpRequest: XMLHttpRequest | null = null

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
        this.shouldRetry = request.shouldRetry ?? this.shouldRetry
        this.allowErrorRetry = request.allowErrorRetry ?? this.allowErrorRetry
        this.bag = request.bag ?? (request.owner ? RequestBag.getOrCreate(request.owner) : undefined)

        this.bag?.addRequest(this)
    }

    get static(): typeof Request {
        return this.constructor as typeof Request;
    }

    getMiddlewares(): RequestMiddleware[] {
        return Request.sharedMiddlewares.concat(this.middlewares);
    }

    /**
     * Cancels any pending requests and also disables retries
     */
    cancel() {
        this.shouldRetry = false
        this.allowErrorRetry = false

        if (this.XMLHttpRequest) {
            this.XMLHttpRequest.abort()
            this.XMLHttpRequest = null
        } else {
            // Probably a middleware that is running a timeout to retry it later on
            // Immediately call all middlewares to notify them faster of this abort
            // Notify middleware that we stop retrying
            if (!this.didFailNetwork) {
                this.didFailNetwork = true
                for (const middleware of this.getMiddlewares()) {
                    // Check if one of the middlewares decides to stop
                    if (middleware.onFatalNetworkError) {
                        middleware.onFatalNetworkError(this, new SimpleError({
                            code: "network_abort",
                            message: "Network abort"
                        }));
                    }
                }
            }
        }
        
    }

    /**
     * Cancel all requests with a given owner
     * Shorthand to avoid RequestBag syntax.
     */
    static cancelAll(owner: any) {
        RequestBag.get(owner)?.cancel()
    }

    static isNetworkError(e: Error): e is SimpleError | SimpleErrors {
        return !!((isSimpleError(e) || isSimpleErrors(e)) && (e.hasCode("network_error") || e.hasCode("network_timeout") || e.hasCode("network_abort")))
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
                        this.XMLHttpRequest = null
                        resolve(request)
                    }
                };
        
                request.ontimeout = () => {
                    if (finished) {
                        // ignore duplicate events
                        return
                    }
                    finished = true
                    this.XMLHttpRequest = null
                    reject(new SimpleError({
                        code: "network_timeout",
                        message: "Timeout"
                    }))
                };
        
                request.onerror = (e: ProgressEvent) => {
                    if (finished) {
                        // ignore duplicate events
                        return
                    }
                    // Your request timed out
                    finished = true
                    this.XMLHttpRequest = null
                    reject(new SimpleError({
                        code: "network_error",
                        message: "Network error"
                    }))
                };

                request.onabort = () => {
                    if (finished) {
                        // ignore duplicate events
                        return
                    }
                    finished = true
                    this.XMLHttpRequest = null

                    // Disable retries
                    this.shouldRetry = false
                    reject(new SimpleError({
                        code: "network_abort",
                        message: "Network abort"
                    }))
                };
                
                request.open(data.method, data.url)

                for (const key in data.headers) {
                    if (Object.prototype.hasOwnProperty.call(data.headers, key)) {
                        const value = data.headers[key];
                        request.setRequestHeader(key, value);
                    }
                }

                request.timeout = data.timeout

                this.XMLHttpRequest = request
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
                        const typeCopy = encodeObject(this.body, { version: this.version ?? 0 })
                        if (typeCopy === null || typeCopy === undefined) {
                            throw new Error("Invalid body, got null/undefined, which is not encodeable to a querystring")
                        }
                        body = Object.keys(typeCopy)
                            .filter((k) => typeCopy[k] !== undefined)
                            .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(typeCopy[k]))
                            .join("&");
                    } else {
                        this.headers["Content-Type"] = "application/json;charset=utf-8";
                        body = JSON.stringify(encodeObject(this.body, { version: this.version ?? 0 }))
                    }
                    
                }
            }

            let queryString = "";
            if (this.query ) {
                const query = encodeObject(this.query, { version: this.version ?? 0 })

                if (query !== undefined && query !== null && Object.keys(query).length > 0) {
                    queryString =
                    "?" +
                    Object.keys(query)
                        .filter((k) => query[k] !== undefined)
                        .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(query[k]))
                        .join("&");
                }
            }

            if (this.static.verbose) {
                console.log("Starting new request");
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
            if ((isSimpleError(error) || isSimpleErrors(error)) && error.hasCode('network_timeout')) {
                // Increase next timeout (note: upload will stay 1 minute)
                this.timeout = Math.max(timeout, 30*1000);
            }
            // network error is encountered or CORS is misconfigured on the server-side

            // A middleware might decide here to interrupt the callback
            // He might for example fire a timer to retry the request because of a network failure
            // Or it might decide to fetch a new access token because the current one is expired
            // They return a promise with a boolean value indicating that the request should get retried

            if (this.shouldRetry && !this.didFailNetwork) {
                let retry = false;
                for (const middleware of this.getMiddlewares()) {
                    // Check if one of the middlewares decides to stop
                    if (middleware.shouldRetryNetworkError) {
                        retry = retry || (await middleware.shouldRetryNetworkError(this, error));
                    }

                    if (!this.shouldRetry || this.didFailNetwork) {
                        // Stop the loop faster
                        break
                    }
                }

                // Sometimes, in the meantime, shouldRetry might have become false, so check again
                if (retry && this.shouldRetry && !this.didFailNetwork) {
                    // Retry
                    return await this.start();
                }
            }

            // Notify middleware that we stop retrying
            if (!this.didFailNetwork) {
                // On abort we call this faster if needed (e.g. when middleware is hanging)
                this.didFailNetwork = true
                for (const middleware of this.getMiddlewares()) {
                    // Check if one of the middlewares decides to stop
                    if (middleware.onFatalNetworkError) {
                        middleware.onFatalNetworkError(this, error);
                    }
                }
            }

            // Failed and not caught
            this.bag?.removeRequest(this)
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
                if (this.shouldRetry || this.allowErrorRetry) {
                    let retry = false;
                    for (const middleware of this.getMiddlewares()) {
                        // Check if one of the middlewares decides to stop
                        if (middleware.shouldRetryError) {
                            retry = retry || (await middleware.shouldRetryError(this, response, err));
                        }
                    }

                    // Sometimes, in the meantime, shouldRetry might have become false, so check again
                    if (retry && (this.shouldRetry || this.allowErrorRetry)) {
                        // Retry
                        return await this.start();
                    }
                }

                this.bag?.removeRequest(this)
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
                // A 200 status code with invalid JSON is considered a server error
                return await this.retryOrThrowServerError(response, e)
            }

            if (this.decoder) {
                const decoded = this.decoder?.decode(new ObjectData(json, { version: this.version ?? 0 }));
                if (this.static.verbose) {
                    console.info(decoded);
                }
                this.bag?.removeRequest(this)
                return new RequestResult(decoded);
            }

            this.bag?.removeRequest(this)
            return new RequestResult(json);
        }

        if (this.decoder) {
            // Expected content, but the server didn't respond with content
            if (this.static.verbose) {
                console.error(response.response);
            }
            return await this.retryOrThrowServerError(response, new Error("Missing JSON response from server"))
        }

        this.bag?.removeRequest(this)
        return new RequestResult(await response.response) as any;
    }

    private async retryOrThrowServerError(response: XMLHttpRequest, e: Error) {
        // Invalid json is considered as a server error
        if (this.static.verbose) {
            console.error(e);
        }

        if (this.shouldRetry) {
            // A middleware might decide here to retry instead of passing the error to the caller
            let retry = false;
            for (const middleware of this.getMiddlewares()) {
                // Check if one of the middlewares decides to stop
                if (middleware.shouldRetryServerError) {
                    retry = retry || (await middleware.shouldRetryServerError(this, response, e));
                }
            }

            // Sometimes, in the meantime, shouldRetry might have become false, so check again
            if (retry && this.shouldRetry) {
                // Retry
                return await this.start();
            }
        }
        this.bag?.removeRequest(this)
        throw e;
    }
}
