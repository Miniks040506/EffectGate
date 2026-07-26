import {
  CONTEXT_PROJECT_MAX_FIELDS,
  CONTEXT_PROJECT_MAX_POINTER_LENGTH,
  isUnicodeScalarText,
  isValidJsonPointer,
  isValidProjectionScalar
} from "./json-project.mjs";
import {
  buildTabularEntries,
  InvalidDocumentProjectionError
} from "./tabular-project.mjs";
import { buildMarkdownEntries } from "./markdown-project.mjs";

export { InvalidDocumentProjectionError };

function isBoundedText(value, requireNonBlank = false) {
  return (
    typeof value === "string" &&
    value.length <= CONTEXT_PROJECT_MAX_POINTER_LENGTH * 2 &&
    isUnicodeScalarText(value) &&
    [...value].length <= CONTEXT_PROJECT_MAX_POINTER_LENGTH &&
    Buffer.byteLength(value, "utf8") <=
      CONTEXT_PROJECT_MAX_POINTER_LENGTH * 4 &&
    (!requireNonBlank || value.trim().length > 0)
  );
}

function exactObject(value, required, allowed) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.includes(key))
  );
}

export function isValidProjectionOptions({
  format,
  fields,
  columns,
  filter,
  heading
}) {
  if (
    !Array.isArray(fields) ||
    !Array.isArray(columns) ||
    fields.length > CONTEXT_PROJECT_MAX_FIELDS ||
    columns.length > CONTEXT_PROJECT_MAX_FIELDS ||
    new Set(fields).size !== fields.length ||
    new Set(columns).size !== columns.length
  ) {
    return false;
  }

  if (format === "json" || format === "jsonl") {
    return (
      columns.length === 0 &&
      heading === undefined &&
      fields.every(isValidJsonPointer) &&
      (filter === undefined ||
        (exactObject(filter, ["pointer", "equals"], ["pointer", "equals"]) &&
          isValidJsonPointer(filter.pointer) &&
          isValidProjectionScalar(filter.equals)))
    );
  }

  if (format === "csv" || format === "tsv") {
    return (
      fields.length === 0 &&
      heading === undefined &&
      columns.every((column) => isBoundedText(column, true)) &&
      (filter === undefined ||
        (exactObject(filter, ["column", "equals"], ["column", "equals"]) &&
          isBoundedText(filter.column, true) &&
          isBoundedText(filter.equals)))
    );
  }

  return (
    format === "markdown" &&
    fields.length === 0 &&
    columns.length === 0 &&
    filter === undefined &&
    (heading === undefined || isBoundedText(heading, true))
  );
}

export function buildDocumentProjectionEntries(options) {
  if (options.format === "csv" || options.format === "tsv") {
    return buildTabularEntries(options);
  }
  return buildMarkdownEntries(options);
}
