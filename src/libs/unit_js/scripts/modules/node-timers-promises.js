export function setTimeout(delay, value, options) {
    return new Promise((resolve, reject) => {
        if (options?.signal?.aborted) {
            reject(options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
            return;
        }
        const id = globalThis.setTimeout(() => resolve(value), delay ?? 1);
        options?.signal?.addEventListener('abort', () => {
            globalThis.clearTimeout(id);
            reject(options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
    });
}

export function setImmediate(value, options) {
    return new Promise((resolve, reject) => {
        if (options?.signal?.aborted) {
            reject(options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
            return;
        }
        const id = globalThis.setImmediate ? globalThis.setImmediate(() => resolve(value)) : globalThis.setTimeout(() => resolve(value), 0);
        options?.signal?.addEventListener('abort', () => {
            if (globalThis.clearImmediate) globalThis.clearImmediate(id);
            else globalThis.clearTimeout(id);
            reject(options.signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
        }, { once: true });
    });
}

export async function* setInterval(delay, value, options) {
    while (true) {
        await setTimeout(delay, undefined, options);
        yield value;
    }
}
