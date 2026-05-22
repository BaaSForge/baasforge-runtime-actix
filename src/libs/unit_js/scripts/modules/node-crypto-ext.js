import { createHmac } from 'node:crypto';
export * from 'node:crypto';

export const subtle = globalThis.crypto?.subtle ?? null;

export function getHashes() {
    return ['md5','sha1','sha224','sha256','sha384','sha512','sha512-224','sha512-256',
            'sha3-224','sha3-256','sha3-384','sha3-512','blake2b512','blake2s256','ripemd160'];
}
export function getCiphers() {
    return ['aes-128-cbc','aes-192-cbc','aes-256-cbc','aes-128-ctr','aes-192-ctr','aes-256-ctr',
            'aes-128-ecb','aes-192-ecb','aes-256-ecb','aes-128-gcm','aes-192-gcm','aes-256-gcm',
            'aes-128-ccm','aes-192-ccm','aes-256-ccm','aes-128-ofb','aes-192-ofb','aes-256-ofb',
            'chacha20','chacha20-poly1305','des','des-ede','des-ede3','des-cbc','des-ede3-cbc'];
}

export function timingSafeEqual(a, b) {
    if (a.byteLength !== b.byteLength) throw new TypeError('Input buffers must have the same byte length');
    const av = new Uint8Array(ArrayBuffer.isView(a) ? a.buffer : a, a.byteOffset || 0, a.byteLength);
    const bv = new Uint8Array(ArrayBuffer.isView(b) ? b.buffer : b, b.byteOffset || 0, b.byteLength);
    let r = 0;
    for (let i = 0; i < av.length; i++) r |= av[i] ^ bv[i];
    return r === 0;
}

// ── AES core ──────────────────────────────────────────────────────────────────

const SBOX = new Uint8Array([
    0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
    0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
    0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
    0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
    0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
    0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
    0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
    0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
    0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
    0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
    0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
    0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
    0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
    0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
    0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
    0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]);
const RSBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) RSBOX[SBOX[i]] = i;
const RCON = new Uint8Array([0x01,0x02,0x04,0x08,0x10,0x20,0x40,0x80,0x1b,0x36]);

function xt(x) { return ((x << 1) ^ ((x >> 7) * 0x1b)) & 0xff; }
function gm(a, b) {
    let r = 0;
    while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; }
    return r;
}

function keyExpand(key) {
    const nk = key.length >> 2, nr = nk + 6;
    const w = new Uint32Array((nr + 1) * 4);
    for (let i = 0; i < nk; i++)
        w[i] = (key[4*i]<<24)|(key[4*i+1]<<16)|(key[4*i+2]<<8)|key[4*i+3];
    for (let i = nk; i < (nr+1)*4; i++) {
        let t = w[i-1];
        if (i % nk === 0) {
            t = ((SBOX[(t>>16)&255])<<24)|((SBOX[(t>>8)&255])<<16)|((SBOX[t&255])<<8)|SBOX[t>>>24];
            t ^= RCON[i/nk-1] << 24;
        } else if (nk > 6 && i % nk === 4) {
            t = ((SBOX[t>>>24])<<24)|((SBOX[(t>>16)&255])<<16)|((SBOX[(t>>8)&255])<<8)|SBOX[t&255];
        }
        w[i] = w[i-nk] ^ t;
    }
    return { w, nr };
}

function aesBlock(block, {w, nr}, enc) {
    const s = [
        [block[0],block[4],block[8],block[12]],
        [block[1],block[5],block[9],block[13]],
        [block[2],block[6],block[10],block[14]],
        [block[3],block[7],block[11],block[15]],
    ];
    const ark = (rnd) => {
        for (let c = 0; c < 4; c++) {
            const wk = w[rnd*4+c];
            s[0][c]^=(wk>>>24)&255; s[1][c]^=(wk>>>16)&255; s[2][c]^=(wk>>>8)&255; s[3][c]^=wk&255;
        }
    };
    const sub = (sb) => { for (let r=0;r<4;r++) for (let c=0;c<4;c++) s[r][c]=sb[s[r][c]]; };
    const shR = () => {
        let t;
        [s[1][0],s[1][1],s[1][2],s[1][3]]=[s[1][1],s[1][2],s[1][3],s[1][0]];
        [s[2][0],s[2][1],s[2][2],s[2][3]]=[s[2][2],s[2][3],s[2][0],s[2][1]];
        [s[3][0],s[3][1],s[3][2],s[3][3]]=[s[3][3],s[3][0],s[3][1],s[3][2]];
    };
    const iShR = () => {
        [s[1][0],s[1][1],s[1][2],s[1][3]]=[s[1][3],s[1][0],s[1][1],s[1][2]];
        [s[2][0],s[2][1],s[2][2],s[2][3]]=[s[2][2],s[2][3],s[2][0],s[2][1]];
        [s[3][0],s[3][1],s[3][2],s[3][3]]=[s[3][1],s[3][2],s[3][3],s[3][0]];
    };
    const mc = () => {
        for (let c=0;c<4;c++) {
            const [s0,s1,s2,s3]=[s[0][c],s[1][c],s[2][c],s[3][c]];
            s[0][c]=gm(2,s0)^gm(3,s1)^s2^s3; s[1][c]=s0^gm(2,s1)^gm(3,s2)^s3;
            s[2][c]=s0^s1^gm(2,s2)^gm(3,s3); s[3][c]=gm(3,s0)^s1^s2^gm(2,s3);
        }
    };
    const imc = () => {
        for (let c=0;c<4;c++) {
            const [s0,s1,s2,s3]=[s[0][c],s[1][c],s[2][c],s[3][c]];
            s[0][c]=gm(0xe,s0)^gm(0xb,s1)^gm(0xd,s2)^gm(0x9,s3);
            s[1][c]=gm(0x9,s0)^gm(0xe,s1)^gm(0xb,s2)^gm(0xd,s3);
            s[2][c]=gm(0xd,s0)^gm(0x9,s1)^gm(0xe,s2)^gm(0xb,s3);
            s[3][c]=gm(0xb,s0)^gm(0xd,s1)^gm(0x9,s2)^gm(0xe,s3);
        }
    };
    if (enc) {
        ark(0);
        for (let r=1;r<nr;r++) { sub(SBOX); shR(); mc(); ark(r); }
        sub(SBOX); shR(); ark(nr);
    } else {
        ark(nr);
        for (let r=nr-1;r>0;r--) { iShR(); sub(RSBOX); ark(r); imc(); }
        iShR(); sub(RSBOX); ark(0);
    }
    const out = new Uint8Array(16);
    for (let r=0;r<4;r++) for (let c=0;c<4;c++) out[c*4+r]=s[r][c];
    return out;
}

// ── AES-CTR ──────────────────────────────────────────────────────────────────

function ctrStream(ks, ctr16, data) {
    const out = new Uint8Array(data.length);
    const blk = new Uint8Array(16);
    for (let i = 0; i < data.length; i += 16) {
        blk.set(ctr16);
        const ks_block = aesBlock(blk, ks, true);
        const end = Math.min(i+16, data.length);
        for (let j = i; j < end; j++) out[j] = data[j] ^ ks_block[j-i];
        // increment last 4 bytes (big-endian counter)
        let carry = 1;
        for (let k = 15; k >= 12 && carry; k--) {
            const v = ctr16[k] + carry; ctr16[k] = v & 0xff; carry = v >> 8;
        }
    }
    return out;
}

// ── GCM GHASH ────────────────────────────────────────────────────────────────

function gcmMul(X, H) {
    const Z = new Uint8Array(16);
    const V = new Uint8Array(H);
    for (let i = 0; i < 128; i++) {
        if ((X[i>>3] >> (7-(i&7))) & 1) for (let k=0;k<16;k++) Z[k]^=V[k];
        const lsb = V[15] & 1;
        for (let k = 15; k > 0; k--) V[k] = (V[k]>>1)|((V[k-1]&1)<<7);
        V[0] >>= 1;
        if (lsb) V[0] ^= 0xe1;
    }
    return Z;
}

function ghash(H, data) {
    const Y = new Uint8Array(16);
    for (let i = 0; i < data.length; i += 16) {
        for (let j = 0; j < 16; j++) Y[j] ^= data[i+j];
        Y.set(gcmMul(Y, H));
    }
    return Y;
}

function pad16(a) {
    const r = a.length % 16;
    if (r === 0) return a;
    const p = new Uint8Array(a.length + 16 - r);
    p.set(a); return p;
}

function gcmAuthTag(ks, H, J0, ciphertext, aad) {
    const aadPad = pad16(aad.length ? aad : new Uint8Array(0));
    const ctPad = pad16(ciphertext);
    const lenBlock = new Uint8Array(16);
    const dv = new DataView(lenBlock.buffer);
    dv.setUint32(4, (aadPad.length * 8) >>> 0, false);
    dv.setUint32(12, (ciphertext.length * 8) >>> 0, false);
    const S = new Uint8Array(aadPad.length + ctPad.length + 16);
    S.set(aadPad); S.set(ctPad, aadPad.length); S.set(lenBlock, aadPad.length + ctPad.length);
    const ghashResult = ghash(H, S);
    const eJ0 = aesBlock(J0, ks, true);
    for (let i = 0; i < 16; i++) ghashResult[i] ^= eJ0[i];
    return ghashResult;
}

// ── PKCS7 padding ─────────────────────────────────────────────────────────────

function pkcs7Pad(data) {
    const pad = 16 - (data.length % 16);
    const out = new Uint8Array(data.length + pad);
    out.set(data);
    out.fill(pad, data.length);
    return out;
}

function pkcs7Unpad(data) {
    const pad = data[data.length - 1];
    if (pad < 1 || pad > 16) throw new Error('invalid PKCS7 padding');
    for (let i = data.length - pad; i < data.length; i++)
        if (data[i] !== pad) throw new Error('invalid PKCS7 padding');
    return data.slice(0, data.length - pad);
}

// ── toBytes helper ───────────────────────────────────────────────────────────

const enc = new TextEncoder();
function toBytes(x) {
    if (typeof x === 'string') return enc.encode(x);
    if (x instanceof Uint8Array) return x;
    return new Uint8Array(x.buffer, x.byteOffset ?? 0, x.byteLength);
}
function toBuffer(u8) { return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength); }

// ── Cipher/Decipher classes ───────────────────────────────────────────────────

function decodeInput(data, inputEnc) {
    return typeof data === 'string' && inputEnc ? Buffer.from(data, inputEnc) : data;
}
function encodeOutput(buf, outputEnc) {
    return outputEnc ? buf.toString(outputEnc) : buf;
}

class CipherCBC {
    constructor(ks, iv) { this._ks = ks; this._prev = new Uint8Array(iv); this._buf = new Uint8Array(0); }
    update(data, inputEnc, outputEnc) {
        const bytes = toBytes(decodeInput(data, inputEnc));
        const combined = new Uint8Array(this._buf.length + bytes.length);
        combined.set(this._buf); combined.set(bytes, this._buf.length);
        const full = combined.length - (combined.length % 16);
        const out = new Uint8Array(full);
        for (let i = 0; i < full; i += 16) {
            const blk = new Uint8Array(16);
            for (let j = 0; j < 16; j++) blk[j] = combined[i+j] ^ this._prev[j];
            const enc = aesBlock(blk, this._ks, true);
            out.set(enc, i); this._prev = enc;
        }
        this._buf = combined.slice(full);
        return encodeOutput(toBuffer(out), outputEnc);
    }
    final(outputEnc) {
        const padded = pkcs7Pad(this._buf);
        for (let j = 0; j < 16; j++) padded[j] ^= this._prev[j];
        return encodeOutput(toBuffer(aesBlock(padded, this._ks, true)), outputEnc);
    }
}

class DecipherCBC {
    constructor(ks, iv) { this._ks = ks; this._prev = new Uint8Array(iv); this._buf = new Uint8Array(0); }
    update(data, inputEnc, outputEnc) {
        const bytes = toBytes(decodeInput(data, inputEnc));
        const combined = new Uint8Array(this._buf.length + bytes.length);
        combined.set(this._buf); combined.set(bytes, this._buf.length);
        const keep = combined.length % 16 || 16;
        const full = combined.length - keep;
        const out = new Uint8Array(full);
        for (let i = 0; i < full; i += 16) {
            const blk = combined.slice(i, i+16);
            const dec = aesBlock(blk, this._ks, false);
            for (let j = 0; j < 16; j++) out[i+j] = dec[j] ^ this._prev[j];
            this._prev = blk;
        }
        this._buf = combined.slice(full);
        return encodeOutput(toBuffer(out), outputEnc);
    }
    final(outputEnc) {
        if (this._buf.length !== 16) throw new Error('invalid ciphertext length');
        const dec = aesBlock(this._buf, this._ks, false);
        for (let j = 0; j < 16; j++) dec[j] ^= this._prev[j];
        return encodeOutput(toBuffer(pkcs7Unpad(dec)), outputEnc);
    }
}

class CipherGCM {
    constructor(ks, iv) {
        this._ks = ks;
        this._H = aesBlock(new Uint8Array(16), ks, true);
        this._J0 = new Uint8Array(16);
        this._J0.set(iv.slice(0, 12));
        this._J0[15] = 1;
        const ctr = new Uint8Array(this._J0); ctr[15] = 2;
        this._ctr = ctr;
        this._ciphertext = [];
        this._authTag = null;
    }
    update(data, inputEnc, outputEnc) {
        const bytes = toBytes(decodeInput(data, inputEnc));
        const ct = ctrStream(this._ks, this._ctr, bytes);
        this._ciphertext.push(ct);
        return encodeOutput(toBuffer(ct), outputEnc);
    }
    final(outputEnc) {
        const allCt = new Uint8Array(this._ciphertext.reduce((a,b) => a+b.length, 0));
        let off = 0; for (const b of this._ciphertext) { allCt.set(b, off); off += b.length; }
        this._authTag = gcmAuthTag(this._ks, this._H, this._J0, allCt, new Uint8Array(0));
        return encodeOutput(Buffer.alloc(0), outputEnc);
    }
    getAuthTag() {
        if (!this._authTag) this.final();
        return Buffer.from(this._authTag);
    }
}

class DecipherGCM {
    constructor(ks, iv) {
        this._ks = ks;
        this._H = aesBlock(new Uint8Array(16), ks, true);
        this._J0 = new Uint8Array(16);
        this._J0.set(iv.slice(0, 12));
        this._J0[15] = 1;
        const ctr = new Uint8Array(this._J0); ctr[15] = 2;
        this._ctr = ctr;
        this._ctBuf = [];
        this._expectedTag = null;
    }
    setAuthTag(tag) { this._expectedTag = toBytes(tag); }
    update(data, inputEnc, outputEnc) {
        const bytes = toBytes(decodeInput(data, inputEnc));
        this._ctBuf.push(bytes);
        const pt = ctrStream(this._ks, this._ctr, bytes);
        return encodeOutput(toBuffer(pt), outputEnc);
    }
    final(outputEnc) {
        if (this._expectedTag) {
            const allCt = new Uint8Array(this._ctBuf.reduce((a,b) => a+b.length, 0));
            let off = 0; for (const b of this._ctBuf) { allCt.set(b, off); off += b.length; }
            const tag = gcmAuthTag(this._ks, this._H, this._J0, allCt, new Uint8Array(0));
            if (!timingSafeEqual(tag, this._expectedTag))
                throw new Error('Unsupported state or unable to authenticate data');
        }
        return encodeOutput(Buffer.alloc(0), outputEnc);
    }
}

export function createCipheriv(algorithm, key, iv) {
    const alg = algorithm.toLowerCase().replace(/-/g,'');
    const keyBytes = toBytes(key), ivBytes = toBytes(iv);
    const ks = keyExpand(keyBytes);
    if (alg === 'aes128cbc' || alg === 'aes192cbc' || alg === 'aes256cbc') return new CipherCBC(ks, ivBytes);
    if (alg === 'aes128gcm' || alg === 'aes192gcm' || alg === 'aes256gcm') return new CipherGCM(ks, ivBytes);
    throw new Error(`unsupported algorithm: ${algorithm}`);
}

export function createDecipheriv(algorithm, key, iv) {
    const alg = algorithm.toLowerCase().replace(/-/g,'');
    const keyBytes = toBytes(key), ivBytes = toBytes(iv);
    const ks = keyExpand(keyBytes);
    if (alg === 'aes128cbc' || alg === 'aes192cbc' || alg === 'aes256cbc') return new DecipherCBC(ks, ivBytes);
    if (alg === 'aes128gcm' || alg === 'aes192gcm' || alg === 'aes256gcm') return new DecipherGCM(ks, ivBytes);
    throw new Error(`unsupported algorithm: ${algorithm}`);
}

// ── pbkdf2Sync (uses LLRT's createHmac via export *) ─────────────────────────

export function pbkdf2Sync(password, salt, iterations, keylen, digest) {
    const pw = Buffer.isBuffer(password) ? password : (typeof password === 'string' ? Buffer.from(password) : Buffer.from(toBytes(password)));
    const s = Buffer.isBuffer(salt) ? salt : (typeof salt === 'string' ? Buffer.from(salt) : Buffer.from(toBytes(salt)));
    const digestAlg = digest.toLowerCase().replace(/-/g,'');
    const hlen = {sha1:20,sha224:28,sha256:32,sha384:48,sha512:64,sha512224:28,sha512256:32}[digestAlg] ?? 32;
    const out = new Uint8Array(keylen);
    for (let b = 1; b <= Math.ceil(keylen / hlen); b++) {
        const bi = new Uint8Array(4);
        new DataView(bi.buffer).setUint32(0, b, false);
        const u1_hmac = createHmac(digestAlg, pw);
        u1_hmac.update(s); u1_hmac.update(Buffer.from(bi));
        let U = u1_hmac.digest();
        const T = Buffer.from(U);
        for (let i = 1; i < iterations; i++) {
            const h = createHmac(digestAlg, pw); h.update(U);
            U = h.digest();
            for (let j = 0; j < T.length; j++) T[j] ^= U[j];
        }
        const offset = (b-1) * hlen;
        out.set(new Uint8Array(T.buffer, T.byteOffset, Math.min(hlen, keylen-offset)), offset);
    }
    return Buffer.from(out.buffer);
}

// ── scryptSync (pure JS) ──────────────────────────────────────────────────────

function salsa20_8(B) {
    const x = new Int32Array(16);
    for (let i = 0; i < 16; i++)
        x[i] = (B[4*i]|(B[4*i+1]<<8)|(B[4*i+2]<<16)|(B[4*i+3]<<24));
    const R = (a,b) => (a<<b)|(a>>>(32-b));
    const o = new Int32Array(x);
    for (let i = 0; i < 4; i++) {
        o[ 4]^=R(o[ 0]+o[12], 7); o[ 8]^=R(o[ 4]+o[ 0],9); o[12]^=R(o[ 8]+o[ 4],13); o[ 0]^=R(o[12]+o[ 8],18);
        o[ 9]^=R(o[ 5]+o[ 1], 7); o[13]^=R(o[ 9]+o[ 5],9); o[ 1]^=R(o[13]+o[ 9],13); o[ 5]^=R(o[ 1]+o[13],18);
        o[14]^=R(o[10]+o[ 6], 7); o[ 2]^=R(o[14]+o[10],9); o[ 6]^=R(o[ 2]+o[14],13); o[10]^=R(o[ 6]+o[ 2],18);
        o[ 3]^=R(o[15]+o[11], 7); o[ 7]^=R(o[ 3]+o[15],9); o[11]^=R(o[ 7]+o[ 3],13); o[15]^=R(o[11]+o[ 7],18);
        o[ 1]^=R(o[ 0]+o[ 3], 7); o[ 2]^=R(o[ 1]+o[ 0],9); o[ 3]^=R(o[ 2]+o[ 1],13); o[ 0]^=R(o[ 3]+o[ 2],18);
        o[ 6]^=R(o[ 5]+o[ 4], 7); o[ 7]^=R(o[ 6]+o[ 5],9); o[ 4]^=R(o[ 7]+o[ 6],13); o[ 5]^=R(o[ 4]+o[ 7],18);
        o[11]^=R(o[10]+o[ 9], 7); o[ 8]^=R(o[11]+o[10],9); o[ 9]^=R(o[ 8]+o[11],13); o[10]^=R(o[ 9]+o[ 8],18);
        o[12]^=R(o[15]+o[14], 7); o[13]^=R(o[12]+o[15],9); o[14]^=R(o[13]+o[12],13); o[15]^=R(o[14]+o[13],18);
    }
    for (let i = 0; i < 16; i++) { const v = (x[i]+o[i])|0; B[4*i]=v&255;B[4*i+1]=(v>>8)&255;B[4*i+2]=(v>>16)&255;B[4*i+3]=(v>>24)&255; }
}

function blockMix(B, r) {
    const len = 64; const count = 2*r;
    let X = B.slice((count-1)*len, count*len);
    const Y = new Uint8Array(count * len);
    for (let i = 0; i < count; i++) {
        for (let j = 0; j < len; j++) X[j] ^= B[i*len+j];
        salsa20_8(X);
        Y.set(X, i*len);
    }
    for (let i = 0; i < r; i++) B.set(Y.slice(i*2*len, (i*2+1)*len), i*len);
    for (let i = 0; i < r; i++) B.set(Y.slice((i*2+1)*len, (i*2+2)*len), (r+i)*len);
}

function integerify(B, r) {
    const off = (2*r-1)*64;
    return (B[off]|(B[off+1]<<8)|(B[off+2]<<16)|(B[off+3]<<24)) >>> 0;
}

export function scryptSync(password, salt, keylen, options = {}) {
    const N = options.N ?? 16384, r = options.r ?? 8, p = options.p ?? 1;
    const blockLen = 128 * r;
    const B = pbkdf2Sync(password, salt, 1, p * blockLen, 'sha256');
    const Bview = new Uint8Array(B.buffer, B.byteOffset, B.byteLength);
    for (let i = 0; i < p; i++) {
        const block = Bview.slice(i * blockLen, (i+1) * blockLen);
        const V = new Uint8Array(N * blockLen);
        for (let j = 0; j < N; j++) { V.set(block, j*blockLen); blockMix(block, r); }
        for (let j = 0; j < N; j++) {
            const idx = integerify(block, r) % N;
            for (let k = 0; k < blockLen; k++) block[k] ^= V[idx*blockLen+k];
            blockMix(block, r);
        }
        Bview.set(block, i * blockLen);
    }
    return pbkdf2Sync(password, Bview, 1, keylen, 'sha256');
}
