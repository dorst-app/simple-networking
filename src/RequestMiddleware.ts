import { SimpleErrors } from "@simonbackx/simple-errors";

import { Request } from "./Request";

export interface RequestMiddleware {
    onBeforeRequest?(request: Request<any>): Promise<void>;
    shouldRetryError?(request: Request<any>, response: XMLHttpRequest, error: SimpleErrors): Promise<boolean>;
    shouldRetryServerError?(request: Request<any>, response: XMLHttpRequest, error: Error): Promise<boolean>; // e.g. invalid json
    shouldRetryNetworkError?(request: Request<any>, error: Error): Promise<boolean>;

    /**
     * Called when a network request is not retried
     */
    onFatalNetworkError?(request: Request<any>, error: Error);
    onNetworkResponse?(request: Request<any>, response: XMLHttpRequest);
}
