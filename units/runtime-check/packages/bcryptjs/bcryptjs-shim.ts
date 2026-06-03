/**
 * QuickJS runtime shim for `bcryptjs`: lightweight helpers stay in the bundled JS;
 * hash and compare paths delegate to native Rust (`__baal_bcrypt_*` host bridges) because
 * bcrypt hashing and comparing are very slow in QuickJS.
 */
import {
  decodeBase64,
  encodeBase64,
  genSalt,
  genSaltSync,
  getRounds,
  getSalt,
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
  setRandomFallback,
  truncates,
};

type BcryptCompareHost = (password: string, hash: string) => boolean;
type BcryptHashHost = (
  password: string,
  saltOrRounds?: string | number | null,
) => string;

function bcryptHostGlobals(): {
  __baal_bcrypt_compare_sync?: BcryptCompareHost;
  __baal_bcrypt_hash_sync?: BcryptHashHost;
} {
  return globalThis as {
    __baal_bcrypt_compare_sync?: BcryptCompareHost;
    __baal_bcrypt_hash_sync?: BcryptHashHost;
  };
}

function hostCompareSync(password: string, hash: string): boolean {
  const host = bcryptHostGlobals().__baal_bcrypt_compare_sync;
  if (typeof host !== "function") {
    throw new Error("__baal_bcrypt_compare_sync is not available");
  }
  return host(password, hash);
}

function hostHashSync(password: string, salt?: number | string): string {
  const host = bcryptHostGlobals().__baal_bcrypt_hash_sync;
  if (typeof host !== "function") {
    throw new Error("__baal_bcrypt_hash_sync is not available");
  }
  return host(password, salt ?? null);
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

export function hashSync(password: string, salt?: number | string): string {
  return hostHashSync(password, salt);
}

export function hash(
  password: string,
  salt: number | string,
  callback?: (err: Error | null, result?: string) => void,
  progressCallback?: (percentage: number) => void,
): Promise<string> | void {
  const run = (): string => hostHashSync(password, salt);

  if (callback) {
    try {
      progressCallback?.(0);
      const result = run();
      progressCallback?.(1);
      callback(null, result);
    } catch (err) {
      callback(err instanceof Error ? err : new Error(String(err)));
    }
    return;
  }

  return Promise.resolve().then(() => {
    progressCallback?.(0);
    const result = run();
    progressCallback?.(1);
    return result;
  });
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
