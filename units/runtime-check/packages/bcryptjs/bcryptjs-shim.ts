import {
  decodeBase64,
  encodeBase64,
  genSalt,
  genSaltSync,
  getRounds,
  getSalt,
  hash,
  hashSync,
  setRandomFallback,
  truncates,
} from "bcryptjs";

export {
  decodeBase64,
  encodeBase64,
  genSalt,
  genSaltSync,
  getRounds,
  getSalt,
  hash,
  hashSync,
  setRandomFallback,
  truncates,
};

type BcryptCompareHost = (password: string, hash: string) => boolean;

function hostCompareSync(password: string, hash: string): boolean {
  const host = (globalThis as { __baal_bcrypt_compare_sync?: BcryptCompareHost })
    .__baal_bcrypt_compare_sync;
  if (typeof host !== "function") {
    throw new Error("__baal_bcrypt_compare_sync is not available");
  }
  return host(password, hash);
}

export function compareSync(password: string, hash: string): boolean {
  return hostCompareSync(password, hash);
}

export function compare(
  password: string,
  hash: string,
  callback?: (err: Error | null, result?: boolean) => void,
): Promise<boolean> | void {
  if (callback) {
    try {
      callback(null, hostCompareSync(password, hash));
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
    return;
  }
  return Promise.resolve(hostCompareSync(password, hash));
}

export default {
  setRandomFallback,
  genSaltSync,
  genSalt,
  hashSync,
  hash,
  compareSync,
  compare,
  getRounds,
  getSalt,
  truncates,
  encodeBase64,
  decodeBase64,
};
