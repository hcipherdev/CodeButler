import { AsyncLocalStorage } from "node:async_hooks";
export type RetrievalPhase = "startup" | "gateWait" | "query" | "quality" | "citations" | "serialization";
export type RetrievalMetrics = Record<RetrievalPhase | "total", number>;
const current = new AsyncLocalStorage<RetrievalMetrics>();
const frames = new AsyncLocalStorage<Array<{
    children: number;
}>>();
export function recordRetrievalDuration(phase: RetrievalPhase, milliseconds: number): void {
    const metrics = current.getStore();
    if (metrics)
        metrics[phase] += milliseconds;
}
export function measured<T>(phase: RetrievalPhase, work: () => T): T {
    const started = performance.now();
    const stack = frames.getStore() ?? [];
    const frame = { children: 0 };
    const parent = stack.at(-1);
    stack.push(frame);
    try {
        return frames.run(stack, work);
    }
    finally {
        stack.pop();
        const elapsed = performance.now() - started;
        if (parent)
            parent.children += elapsed;
        const metrics = current.getStore();
        if (metrics)
            metrics[phase] += elapsed - frame.children;
    }
}
export async function measureRetrieval<T>(work: () => T | Promise<T>): Promise<{
    value: T;
    metrics: RetrievalMetrics;
}> {
    const metrics: RetrievalMetrics = { startup: 0, gateWait: 0, query: 0, quality: 0, citations: 0, serialization: 0, total: 0 };
    const started = performance.now();
    const value = await current.run(metrics, work);
    metrics.total = performance.now() - started;
    return { value, metrics };
}
