/**
 * `fast-xml-parser` npm package test runner (`test.runtime.api.fast-xml-parser`).
 * No public npm subpaths — root import only.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as fxpNs from "fast-xml-parser";

const { XMLParser, XMLBuilder } = (fxpNs as { default?: typeof fxpNs }).default ?? fxpNs;
import {
  handleSuiteRequest,
  runSuiteTests,
  type SuiteResponseBody,
  type SuiteTest,
} from "../../lib/suite-harness.js";

const TESTS: SuiteTest[] = [
  {
    name: "XMLParser: simple element",
    run: async () => {
      const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@" });
      const obj = parser.parse('<root id="1"><item>x</item></root>') as {
        root: { "@id": string; item: string };
      };
      if (obj.root["@id"] !== "1" || obj.root.item !== "x") {
        throw new Error(JSON.stringify(obj));
      }
    },
  },
  {
    name: "XMLBuilder: round-trip shape",
    run: async () => {
      const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: "@" });
      const xml = builder.build({ root: { "@id": "2", item: "y" } });
      if (!xml.includes("<item>y</item>")) throw new Error(xml);
    },
  },
];

export type RequestBody = never;
export type ResponseBody = SuiteResponseBody;
export type QueryParams = never;

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleSuiteRequest(req, res, "fast-xml-parser", () => runSuiteTests(TESTS));
}
