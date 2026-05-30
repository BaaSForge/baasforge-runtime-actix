function chunkToUint8Array(chunk) {
    if (typeof chunk === 'string') return new TextEncoder().encode(chunk);
    if (chunk instanceof Uint8Array) return chunk;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(chunk)) {
        return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    }
    return new Uint8Array(chunk);
}

function isNodeReadable(stream) {
    return stream != null
        && typeof stream.on === 'function'
        && typeof stream.getReader !== 'function';
}

function collectNodeReadable(stream) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        stream.on('error', (err) => reject(err));
        stream.on('end', () => resolve(chunks));
        stream.on('data', (chunk) => {
            chunks.push(chunkToUint8Array(chunk));
        });
    });
}

async function collectChunks(stream) {
    if (isNodeReadable(stream)) {
        return collectNodeReadable(stream);
    }
    if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        const chunks = [];
        for await (const chunk of stream) {
            chunks.push(chunkToUint8Array(chunk));
        }
        return chunks;
    }
    const reader = stream.getReader();
    const chunks = [];
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return chunks;
}

export async function buffer(stream) {
    const chunks = await collectChunks(stream);
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return Buffer.from(out.buffer);
}

export async function text(stream) {
    const chunks = await collectChunks(stream);
    let total = 0;
    for (let i = 0; i < chunks.length; i++) total += chunks[i].length;
    const combined = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < chunks.length; i++) { combined.set(chunks[i], offset); offset += chunks[i].length; }
    return new TextDecoder().decode(combined);
}

export async function json(stream) {
    return JSON.parse(await text(stream));
}

export async function arrayBuffer(stream) {
    const buf = await buffer(stream);
    return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

export async function blob(stream) {
    const buf = await buffer(stream);
    return new Blob([buf]);
}
