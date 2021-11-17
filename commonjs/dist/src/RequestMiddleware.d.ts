import { SimpleErrors } from "@simonbackx/simple-errors";
import { Request } from "./Request";
export interface RequestMiddleware {
    onBeforeRequest?(request: Request<any>): Promise<void>;
    shouldRetryError?(request: Request<any>, response: XMLHttpRequest, error: SimpleErrors): Promise<boolean>;
    shouldRetryServerError?(request: Request<any>, response: XMLHttpRequest, error: Error): Promise<boolean>;
    shouldRetryNetworkError?(request: Request<any>, error: Error): Promise<boolean>;
    onNetworkResponse?(request: Request<any>, response: XMLHttpRequest): any;
}
//# sourceMappingURL=RequestMiddleware.d.ts.map