/**
 * `bcryptjs` npm package test runner (`test.runtime.api.bcryptjs`).
 * No public npm subpaths — root import only.
 *
 * Coverage ported from https://github.com/dcodeIO/bcrypt.js/blob/main/tests/index.js
 * (minus native `bcrypt` cross-check and UMD require).
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import bcrypt from "bcryptjs";
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

function assertBytesEqual(actual: number[], expected: number[]): void {
  if (actual.length !== expected.length) {
    throw new Error(`length ${actual.length} !== ${expected.length}`);
  }
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(`byte[${i}]: ${actual[i]} !== ${expected[i]}`);
    }
  }
}

function cbGenSalt(rounds: number): Promise<string> {
  return new Promise((resolve, reject) => {
    bcrypt.genSalt(rounds, (err, salt) => {
      if (err) reject(err);
      else if (!salt) reject(new Error("no salt"));
      else resolve(salt);
    });
  });
}

function cbHash(
  password: string,
  salt: string,
  onProgress?: (n: number) => void,
): Promise<string> {
  return new Promise((resolve, reject) => {
    bcrypt.hash(password, salt, (err, hash) => {
      if (err) reject(err);
      else if (!hash) reject(new Error("no hash"));
      else resolve(hash);
    }, onProgress);
  });
}

function cbCompare(password: string, hash: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    bcrypt.compare(password, hash, (err, same) => {
      if (err) reject(err);
      else resolve(!!same);
    });
  });
}

const COMPAT_PASSWORDS = [
  "",
  " ",
  " a ",
  "a".repeat(72),
  "a".repeat(73),
  "Heizölrückstoßabdämpfung",
  "Ξεσκεπάζω τὴν ψυχοφθόρα βδελυγμία",
  "El pingüino Wenceslao hizo kilómetros bajo exhaustiva lluvia y ",
  "Où l'obèse jury mûr",
  "Úrmhac na hÓighe Beannaithe",
  "Árvíztűrő tükörfúrógép",
  "Sævör grét áðan því úlpan var ónýt",
  "わかよたれそつねならむ",
  "ケフコエテ アサキユメミシ",
  "דג סקרן שט בים מאוכזב ולפתע מצא לו חברה איך הקליטה",
  "Pchnąć w tę łódź jeża lub ośm skrzyń fig",
  "В чащах юга жил бы цитрус? Да, но фальшивый экземпляр!",
  "๏ เป็นมนุษย์สุดประเสริฐเลิศคุณค่า",
  "Pijamalı hasta, yağız şoföre çabucak güvendi.",
];

const TESTS: SuiteTest[] = [
  {
    name: "encodeBase64",
    run: async () => {
      const str = bcrypt.encodeBase64(
        [
          0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d,
          0x0e, 0x0f, 0x10,
        ],
        16,
      );
      if (str !== "..CA.uOD/eaGAOmJB.yMBu") throw new Error(str);
    },
  },
  {
    name: "decodeBase64",
    run: async () => {
      const bytes = bcrypt.decodeBase64("..CA.uOD/eaGAOmJB.yMBv.", 16);
      assertBytesEqual(bytes, [
        0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e,
        0x0f,
      ]);
    },
  },
  {
    name: "genSaltSync",
    run: async () => {
      const salt = bcrypt.genSaltSync(10);
      if (!salt || typeof salt !== "string" || salt.length === 0) {
        throw new Error(String(salt));
      }
    },
  },
  {
    name: "genSalt",
    run: async () => {
      const salt = await cbGenSalt(10);
      if (!salt || typeof salt !== "string" || salt.length === 0) {
        throw new Error(String(salt));
      }
    },
  },
  {
    name: "hashSync",
    run: async () => {
      bcrypt.hashSync("hello", 10);
      const a = bcrypt.hashSync("hello", 10);
      const b = bcrypt.hashSync("hello", 10);
      if (a === b) throw new Error("expected distinct salts/hashes");
    },
  },
  {
    name: "hash",
    run: async () => {
      const hash = await bcrypt.hash("hello", 10);
      if (!hash) throw new Error("no hash");
    },
  },
  {
    name: "compareSync",
    run: async () => {
      const salt1 = bcrypt.genSaltSync();
      const hash1 = bcrypt.hashSync("hello", salt1);
      const salt2 = bcrypt.genSaltSync().replace(/\$2b\$/, "$2y$");
      const hash2 = bcrypt.hashSync("world", salt2);
      const salt3 = bcrypt.genSaltSync().replace(/\$2b\$/, "$2a$");
      const hash3 = bcrypt.hashSync("hello world", salt3);

      if (hash1.substring(0, 4) !== "$2b$") throw new Error(hash1);
      if (!bcrypt.compareSync("hello", hash1)) throw new Error("hello vs hash1");
      if (bcrypt.compareSync("hello", hash2)) throw new Error("hello vs hash2");
      if (bcrypt.compareSync("hello", hash3)) throw new Error("hello vs hash3");

      if (hash2.substring(0, 4) !== "$2y$") throw new Error(hash2);
      if (!bcrypt.compareSync("world", hash2)) throw new Error("world vs hash2");
      if (bcrypt.compareSync("world", hash1)) throw new Error("world vs hash1");
      if (bcrypt.compareSync("world", hash3)) throw new Error("world vs hash3");

      if (hash3.substring(0, 4) !== "$2a$") throw new Error(hash3);
      if (!bcrypt.compareSync("hello world", hash3)) throw new Error("hello world vs hash3");
      if (bcrypt.compareSync("hello world", hash1)) throw new Error("hello world vs hash1");
      if (bcrypt.compareSync("hello world", hash2)) throw new Error("hello world vs hash2");
    },
  },
  {
    name: "compare",
    run: async () => {
      const salt1 = bcrypt.genSaltSync();
      const hash1 = bcrypt.hashSync("hello", salt1);
      let salt2 = bcrypt.genSaltSync();
      salt2 = salt2.substring(0, 2) + "y" + salt2.substring(3);
      const hash2 = bcrypt.hashSync("world", salt2);

      if (!(await cbCompare("hello", hash1))) throw new Error("hello vs hash1");
      if (await cbCompare("hello", hash2)) throw new Error("hello vs hash2");
      if (!(await cbCompare("world", hash2))) throw new Error("world vs hash2");
      if (await cbCompare("world", hash1)) throw new Error("world vs hash1");
    },
  },
  {
    name: "getSalt",
    run: async () => {
      const hash1 = bcrypt.hashSync("hello", bcrypt.genSaltSync());
      const salt = bcrypt.getSalt(hash1);
      const hash2 = bcrypt.hashSync("hello", salt);
      if (hash1 !== hash2) throw new Error("getSalt + rehash mismatch");
    },
  },
  {
    name: "getRounds",
    run: async () => {
      const hash1 = bcrypt.hashSync("hello", bcrypt.genSaltSync());
      if (bcrypt.getRounds(hash1) !== 10) throw new Error(String(bcrypt.getRounds(hash1)));
    },
  },
  {
    name: "truncates",
    run: async () => {
      if (bcrypt.truncates("")) throw new Error("empty should not truncate");
      if (bcrypt.truncates("a".repeat(72))) throw new Error("72 chars should not truncate");
      if (!bcrypt.truncates("a".repeat(73))) throw new Error("73 chars should truncate");
      if (!bcrypt.truncates("๏ เป็นมนุษย์สุดประเสริฐเลิศคุณค่า")) {
        throw new Error("thai sample should truncate");
      }
    },
  },
  {
    name: "progress",
    run: async () => {
      const salt = await cbGenSalt(12);
      const progress: number[] = [];
      const hash = await cbHash("hello world", salt, (n) => progress.push(n));
      if (typeof hash !== "string") throw new Error("no hash");
      if (progress.length < 2) throw new Error(`progress length ${progress.length}`);
      if (progress[0] !== 0) throw new Error(`first progress ${progress[0]}`);
      if (progress[progress.length - 1] !== 1) {
        throw new Error(`last progress ${progress[progress.length - 1]}`);
      }
    },
  },
  {
    name: "promise",
    run: async () => {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash("hello", salt);
      if (!hash) throw new Error("no hash");
      const result = await bcrypt.compare("hello", hash);
      if (!result) throw new Error("compare failed");
      const defaultSalt = await bcrypt.genSalt();
      if (!defaultSalt) throw new Error("no default salt");
    },
  },
  {
    name: "compat_hash",
    run: async () => {
      for (let i = 0; i < COMPAT_PASSWORDS.length; i++) {
        const pass = COMPAT_PASSWORDS[i]!;
        const salt = bcrypt.genSaltSync();
        const hash = bcrypt.hashSync(pass, salt);
        if (!bcrypt.compareSync(pass, hash)) {
          throw new Error(`round-trip failed at index ${i}`);
        }
      }
    },
  },
  {
    name: "compat_rounds",
    run: async () => {
      let salt = bcrypt.genSaltSync(0);
      if (salt.substring(0, 7) !== "$2b$10$") throw new Error(salt);

      salt = bcrypt.genSaltSync(3);
      if (salt.substring(0, 7) !== "$2b$04$") throw new Error(salt);

      salt = bcrypt.genSaltSync(32);
      if (salt.substring(0, 7) !== "$2b$31$") throw new Error(salt);
    },
  },
  {
    name: "hash + compare: password round-trip",
    run: async () => {
      const hash = await bcrypt.hash("secret-pass", 4);
      if (typeof hash !== "string" || hash.length < 10) throw new Error(hash);
      if (!(await bcrypt.compare("secret-pass", hash))) throw new Error("compare returned false");
      if (await bcrypt.compare("wrong", hash)) throw new Error("compare should reject wrong password");
    },
  },
  {
    name: "genSalt + hashSync + compareSync: sync API",
    run: async () => {
      const salt = bcrypt.genSaltSync(4);
      const hash = bcrypt.hashSync("sync-pass", salt);
      if (!bcrypt.compareSync("sync-pass", hash)) throw new Error("sync compare failed");
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "bcryptjs", () => runSuiteTests(TESTS));
}
