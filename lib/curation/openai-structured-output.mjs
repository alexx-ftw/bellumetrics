function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateSchemaNode(schema, path, { root = false } = {}) {
  if (!isPlainObject(schema)) {
    throw new TypeError(`${path} must be a JSON Schema object`);
  }
  if (root && schema.type !== "object") {
    throw new TypeError("Structured Outputs root must be an object");
  }
  if (root && (schema.anyOf !== undefined || schema.oneOf !== undefined)) {
    throw new TypeError("Structured Outputs root must be an object, not a union");
  }
  if (schema.oneOf !== undefined) {
    throw new TypeError(`${path}.oneOf is not supported; use a nested anyOf`);
  }
  if (schema.anyOf !== undefined) {
    if (!Array.isArray(schema.anyOf) || schema.anyOf.length === 0) {
      throw new TypeError(`${path}.anyOf must contain schemas`);
    }
    schema.anyOf.forEach((variant, index) => {
      validateSchemaNode(variant, `${path}.anyOf[${index}]`);
    });
  }

  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.includes("object")) {
    if (schema.additionalProperties !== false) {
      throw new TypeError(`${path}.additionalProperties must be false`);
    }
    if (!isPlainObject(schema.properties)) {
      throw new TypeError(`${path}.properties must be an object`);
    }
    if (!Array.isArray(schema.required)) {
      throw new TypeError(`${path}.required must list every property`);
    }
    const required = new Set(schema.required);
    for (const propertyName of Object.keys(schema.properties)) {
      if (!required.has(propertyName)) {
        throw new TypeError(`${path}.required is missing ${propertyName}`);
      }
      validateSchemaNode(
        schema.properties[propertyName],
        `${path}.properties.${propertyName}`,
      );
    }
    for (const propertyName of required) {
      if (!Object.hasOwn(schema.properties, propertyName)) {
        throw new TypeError(`${path}.required contains unknown property ${propertyName}`);
      }
    }
  }
  if (types.includes("array")) {
    validateSchemaNode(schema.items, `${path}.items`);
  }
}

export function assertOpenAiStrictSchema(schema) {
  validateSchemaNode(schema, "$", { root: true });
  return schema;
}
