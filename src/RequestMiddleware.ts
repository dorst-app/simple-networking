import { SimpleErrors } from "@simonbackx/simple-errors";

import { Request } from "./Request";

export interface RequestMiddleware {
    onBeforeRequest?(request: Request<any>): Promise<void>;
    shouldRetryError?(request: Request<any>, response: Response, error: SimpleErrors): Promise<boolean>;
    shouldRetryNetworkError?(request: Request<any>, error: Error): Promise<boolean>;
    onNetworkResponse?(request: Request<any>, response: Response);
}
