const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false
});

export const COMPACT_SEARCH_TOOL = Object.freeze({
  name: "effectgate_search",
  title: "Search Admitted Capabilities",
  description:
    "Finds bounded metadata for read-only tools; reuse returned refs instead of repeating capability discovery.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["query"],
    properties: {
      query: { type: "string", minLength: 1, maxLength: 64 },
      limit: { type: "integer", minimum: 1, maximum: 20, default: 8 }
    }
  },
  annotations: READ_ONLY_ANNOTATIONS
});

export const COMPACT_DESCRIBE_TOOL = Object.freeze({
  name: "effectgate_describe",
  title: "Describe Admitted Capability",
  description:
    "Returns the exact input contract for one searched ref; reuse the schema for later calls.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ref"],
    properties: {
      ref: { type: "string", minLength: 1, maxLength: 128 }
    }
  },
  annotations: READ_ONLY_ANNOTATIONS
});

export const COMPACT_CALL_TOOL = Object.freeze({
  name: "effectgate_call",
  title: "Call Admitted Capability",
  description:
    "Calls one described read-only ref; continue Context Views with artifact or fetch tools without rediscovery.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["ref", "arguments"],
    properties: {
      ref: { type: "string", minLength: 1, maxLength: 128 },
      arguments: { type: "object" }
    }
  },
  annotations: READ_ONLY_ANNOTATIONS
});

export const COMPACT_MUX_TOOLS = Object.freeze([
  COMPACT_SEARCH_TOOL,
  COMPACT_DESCRIBE_TOOL,
  COMPACT_CALL_TOOL
]);

function exactKeys(value, allowed) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => allowed.has(key))
  );
}

function validRef(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/u.test(value)
  );
}

function boundedText(value, maximum) {
  return [...value].slice(0, maximum).join("");
}

export function searchCompactCapabilities(admitted, input, catalogComplete) {
  const queryLength =
    typeof input?.query === "string" ? [...input.query].length : 0;
  if (
    !(admitted instanceof Map) ||
    !exactKeys(input, new Set(["query", "limit"])) ||
    queryLength < 1 ||
    queryLength > 64 ||
    Buffer.byteLength(input.query ?? "", "utf8") > 256 ||
    (input.limit !== undefined &&
      (!Number.isSafeInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 20)) ||
    typeof catalogComplete !== "boolean"
  ) {
    throw new TypeError("invalid compact search arguments");
  }
  const query = input.query.toLocaleLowerCase("en-US");
  const matches = [...admitted.entries()]
    .filter(([, { contract }]) =>
      [
        contract.name,
        contract.title ?? "",
        contract.description ?? ""
      ].some((value) => value.toLocaleLowerCase("en-US").includes(query))
    )
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .slice(0, input.limit ?? 8)
    .map(([ref, { contract }]) => ({
      ref,
      name: contract.name,
      ...(contract.title === undefined
        ? {}
        : { title: boundedText(contract.title, 128) }),
      ...(contract.description === undefined
        ? {}
        : { description: boundedText(contract.description, 256) })
    }));
  return Object.freeze({
    matches: Object.freeze(matches.map((match) => Object.freeze(match))),
    catalog_complete: catalogComplete
  });
}

export function describeCompactCapability(admitted, input) {
  if (
    !(admitted instanceof Map) ||
    !exactKeys(input, new Set(["ref"])) ||
    !validRef(input.ref)
  ) {
    throw new TypeError("invalid compact describe arguments");
  }
  const contract = admitted.get(input.ref)?.contract;
  if (contract === undefined) throw new TypeError("unknown compact capability");
  return Object.freeze({
    ref: input.ref,
    name: contract.name,
    ...(contract.title === undefined ? {} : { title: contract.title }),
    ...(contract.description === undefined
      ? {}
      : { description: contract.description }),
    input_schema: contract.inputSchema,
    ...(contract.outputSchema === undefined
      ? {}
      : { output_schema: contract.outputSchema }),
    annotations: contract.annotations
  });
}

export function compactCallArguments(admitted, input) {
  if (
    !(admitted instanceof Map) ||
    !exactKeys(input, new Set(["ref", "arguments"])) ||
    !validRef(input.ref) ||
    input.arguments === null ||
    typeof input.arguments !== "object" ||
    Array.isArray(input.arguments)
  ) {
    throw new TypeError("invalid compact call arguments");
  }
  const capability = admitted.get(input.ref);
  if (capability === undefined) {
    throw new TypeError("unknown compact capability");
  }
  return Object.freeze({
    backendName: capability.backendName,
    contextViewEligible: capability.contextViewEligible,
    arguments: input.arguments
  });
}
