// Requests use middleware to extend its behaviour
import { isEncodeable, ObjectData } from "@simonbackx/simple-encoding";
import { SimpleErrors } from "@simonbackx/simple-errors";
export class RequestResult {
    constructor(data) {
        this.data = data;
    }
}
export class Request {
    constructor(server, request) {
        var _a, _b;
        /// Request specific middleware
        this.middlewares = [];
        this.errorDecoder = SimpleErrors;
        this.request = null;
        this.server = server;
        this.method = request.method;
        this.path = request.path;
        this.query = request.query;
        this.body = request.body;
        this.decoder = request.decoder;
        this.headers = (_a = request.headers) !== null && _a !== void 0 ? _a : {};
        this.version = request.version;
        this.timeout = request.timeout;
        (_b = request.signal) === null || _b === void 0 ? void 0 : _b.addEventListener('abort', () => {
            if (this.request === null) {
                return;
            }
            this.request.abort();
            this.request = null;
        });
    }
    get static() {
        return this.constructor;
    }
    getMiddlewares() {
        return Request.sharedMiddlewares.concat(this.middlewares);
    }
    async fetch(data) {
        return new Promise((resolve, reject) => {
            try {
                const request = new XMLHttpRequest();
                this.request = request;
                let finished = false;
                request.onreadystatechange = (e) => {
                    if (finished) {
                        // ignore duplicate events
                        return;
                    }
                    if (request.readyState == 4) {
                        if (request.status == 0) {
                            // should call handleError or handleTimeout
                            return;
                        }
                        finished = true;
                        resolve(request);
                    }
                };
                request.ontimeout = (e) => {
                    if (finished) {
                        // ignore duplicate events
                        return;
                    }
                    finished = true;
                    reject(new Error("Timeout"));
                };
                request.onerror = (e) => {
                    if (finished) {
                        // ignore duplicate events
                        return;
                    }
                    // Your request timed out
                    finished = true;
                    reject(e);
                };
                request.onabort = (e) => {
                    if (finished) {
                        // ignore duplicate events
                        return;
                    }
                    finished = true;
                    reject(e);
                };
                request.open(data.method, data.url);
                for (const key in data.headers) {
                    if (Object.prototype.hasOwnProperty.call(data.headers, key)) {
                        const value = data.headers[key];
                        request.setRequestHeader(key, value);
                    }
                }
                request.timeout = data.timeout;
                request.send(data.body);
            }
            catch (e) {
                reject(e);
            }
        });
    }
    async start() {
        // todo: check if already running or not
        var _a, _b, _c, _d, _e;
        // todo: add query parameters
        for (const middleware of this.getMiddlewares()) {
            if (middleware.onBeforeRequest)
                await middleware.onBeforeRequest(this);
        }
        let response;
        let timeout = (_a = this.timeout) !== null && _a !== void 0 ? _a : (this.method == "GET" ? 10 * 1000 : 15 * 10000);
        try {
            let body;
            // We only support application/json or FormData for now
            if (this.body === undefined) {
                body = undefined;
            }
            else {
                if (this.body instanceof FormData) {
                    body = this.body;
                    let size = 0;
                    for (const [prop, value] of this.body.entries()) {
                        if (typeof value === "string") {
                            size += value.length;
                        }
                        else {
                            size += value.size;
                        }
                    }
                    if (size > 1000 * 1000 * 1000) {
                        // > 1MB upload
                        timeout = Math.max(timeout, 60 * 1000);
                    }
                }
                else {
                    if (this.headers["Content-Type"] && this.headers["Content-Type"].startsWith("application/x-www-form-urlencoded")) {
                        body = Object.keys(this.body)
                            .filter((k) => this.body[k] !== undefined)
                            .map((k) => encodeURIComponent(k) + "=" + encodeURIComponent(this.body[k]))
                            .join("&");
                    }
                    else {
                        this.headers["Content-Type"] = "application/json;charset=utf-8";
                        if (Array.isArray(this.body)) {
                            body = JSON.stringify(this.body.map((e) => {
                                var _a;
                                if (isEncodeable(this.body)) {
                                    return e.encode({ version: (_a = this.version) !== null && _a !== void 0 ? _a : 0 });
                                }
                                else {
                                    return e;
                                }
                            }));
                        }
                        else {
                            if (isEncodeable(this.body)) {
                                body = JSON.stringify(this.body.encode({ version: (_b = this.version) !== null && _b !== void 0 ? _b : 0 }));
                            }
                            else {
                                body = JSON.stringify(this.body);
                            }
                        }
                    }
                }
            }
            let queryString = "";
            if (this.query) {
                let query = this.query;
                if (isEncodeable(this.query)) {
                    query = this.query.encode({ version: (_c = this.version) !== null && _c !== void 0 ? _c : 0 });
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
            });
        }
        catch (error) {
            // Todo: map the error in o
            if (error.message === 'Timeout') {
                // Increase next timeout (note: upload will stay 1 minute)
                this.timeout = Math.max(timeout, 30 * 1000);
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
                let err;
                try {
                    const json = JSON.parse(response.response);
                    if (this.errorDecoder) {
                        try {
                            err = this.errorDecoder.decode(new ObjectData(json, { version: 0 }));
                            if (this.static.verbose) {
                                console.error(err);
                            }
                        }
                        catch (e) {
                            // Failed to decode
                            if (this.static.verbose) {
                                console.error(json);
                            }
                            throw e;
                        }
                    }
                    else {
                        err = json;
                    }
                }
                catch (e) {
                    return await this.retryOrThrowServerError(response, e);
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
            return await this.retryOrThrowServerError(response, new Error(response.response));
        }
        if (response.getResponseHeader("Content-Type") === "application/json") {
            let json;
            try {
                json = JSON.parse(response.response);
            }
            catch (e) {
                // A non 200 status code without json header is always considered as a server error.
                return await this.retryOrThrowServerError(response, e);
            }
            // todo: add automatic decoding here, so we know we are receiving what we expected with typings
            if (this.decoder) {
                const decoded = (_d = this.decoder) === null || _d === void 0 ? void 0 : _d.decode(new ObjectData(json, { version: (_e = this.version) !== null && _e !== void 0 ? _e : 0 }));
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
            return await this.retryOrThrowServerError(response, new Error("Missing JSON response from server"));
        }
        return new RequestResult(await response.response);
    }
    async retryOrThrowServerError(response, e) {
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
/// Shared middlewares that allows dependency injection here
Request.sharedMiddlewares = [];
Request.verbose = false;
//# sourceMappingURL=Request.js.map