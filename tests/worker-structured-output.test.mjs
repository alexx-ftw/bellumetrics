import assert from "node:assert/strict";
import test from "node:test";

import { assertOpenAiStrictSchema } from "../lib/curation/openai-structured-output.mjs";

const VALID_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "detail"],
  properties: {
    status: { type: "string", enum: ["ok", "error"] },
    detail: {
      anyOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["message"],
          properties: { message: { type: "string" } },
        },
        { type: "null" },
      ],
    },
  },
};

test("offline Structured Outputs validator accepts a closed required root object", () => {
  assert.equal(assertOpenAiStrictSchema(VALID_SCHEMA), VALID_SCHEMA);
});

test("offline Structured Outputs validator rejects incompatible object shapes", async (t) => {
  const scenarios = [
    {
      name: "root union",
      schema: { anyOf: [VALID_SCHEMA, { type: "null" }] },
      error: /root.*object/i,
    },
    {
      name: "optional property",
      schema: {
        ...VALID_SCHEMA,
        required: ["status"],
      },
      error: /required.*detail/i,
    },
    {
      name: "open nested object",
      schema: {
        ...VALID_SCHEMA,
        properties: {
          ...VALID_SCHEMA.properties,
          detail: {
            type: "object",
            additionalProperties: true,
            required: ["message"],
            properties: { message: { type: "string" } },
          },
        },
      },
      error: /additionalProperties.*false/i,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, () => {
      assert.throws(() => assertOpenAiStrictSchema(scenario.schema), scenario.error);
    });
  }
});
