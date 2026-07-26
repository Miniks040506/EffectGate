const MAX_TABULAR_COLUMNS = 256;
const MAX_TABULAR_FIELD_BYTES = 64 * 1024;
const MAX_TABULAR_RECORD_BYTES = 256 * 1024;
const SENSITIVE_COLUMN =
  /^(?:api[_ -]?key|access[_ -]?token|password|secret|authorization|token)$/iu;
const REDACTION_MARKER = "[REDACTED]";

export class InvalidDocumentProjectionError extends Error {
  constructor() {
    super("invalid document projection source");
    this.name = "InvalidDocumentProjectionError";
  }
}

function parseDelimited(text, delimiter, offsets) {
  const records = [];
  let record = [];
  let field = "";
  let fieldBytes = 0;
  let recordStart = 0;
  let inQuotes = false;
  let closedQuote = false;

  const append = (value, bytes) => {
    field += value;
    fieldBytes += bytes;
    if (fieldBytes > MAX_TABULAR_FIELD_BYTES) {
      throw new InvalidDocumentProjectionError();
    }
  };
  const finishField = () => {
    record.push(field);
    if (record.length > MAX_TABULAR_COLUMNS) {
      throw new InvalidDocumentProjectionError();
    }
    field = "";
    fieldBytes = 0;
    closedQuote = false;
  };
  const finishRecord = (afterRecord) => {
    finishField();
    if (
      Buffer.byteLength(text.slice(recordStart, afterRecord), "utf8") >
      MAX_TABULAR_RECORD_BYTES
    ) {
      throw new InvalidDocumentProjectionError();
    }
    records.push({
      fields: record,
      byteStart: offsets?.[recordStart] ?? 0,
      byteEnd: offsets?.[afterRecord] ?? 0
    });
    record = [];
    recordStart = afterRecord;
  };

  for (let index = 0; index < text.length;) {
    const character = text[index];
    const codePoint = text.codePointAt(index);
    const width = codePoint > 0xffff ? 2 : 1;
    const bytes = Buffer.byteLength(text.slice(index, index + width), "utf8");

    if (inQuotes) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          append('"', 1);
          index += 2;
          continue;
        }
        inQuotes = false;
        closedQuote = true;
        index += 1;
        continue;
      }
      append(text.slice(index, index + width), bytes);
      index += width;
      continue;
    }

    if (closedQuote && character !== delimiter && character !== "\r" &&
        character !== "\n") {
      throw new InvalidDocumentProjectionError();
    }
    if (character === delimiter) {
      finishField();
      index += 1;
    } else if (character === "\r" || character === "\n") {
      const afterRecord =
        character === "\r" && text[index + 1] === "\n"
          ? index + 2
          : index + 1;
      finishRecord(afterRecord);
      index = afterRecord;
    } else if (character === '"') {
      if (field.length > 0) throw new InvalidDocumentProjectionError();
      inQuotes = true;
      index += 1;
    } else {
      append(text.slice(index, index + width), bytes);
      index += width;
    }
  }

  if (inQuotes) throw new InvalidDocumentProjectionError();
  if (
    recordStart < text.length ||
    record.length > 0 ||
    field.length > 0 ||
    closedQuote
  ) {
    finishRecord(text.length);
  }
  return records;
}

function canonicalColumn(value) {
  return value.trim().normalize("NFC");
}

export function buildTabularEntries({
  artifact,
  text,
  format,
  columns,
  filter,
  offsets,
  render
}) {
  const rendered = render(0, artifact.byteLength);
  const delimiter = format === "csv" ? "," : "\t";
  const source = parseDelimited(text, delimiter, offsets);
  const visible =
    rendered.redactions.length === 0
      ? source
      : parseDelimited(rendered.content, delimiter);
  if (
    source.length === 0 ||
    source.length !== visible.length ||
    source.some(
      (record, index) => record.fields.length !== visible[index].fields.length
    )
  ) {
    throw new InvalidDocumentProjectionError();
  }

  const header = source[0].fields.map(canonicalColumn);
  const visibleHeader = visible[0].fields;
  if (
    header.some((name) => name.length === 0) ||
    new Set(header).size !== header.length ||
    visibleHeader.some((name) => name.trim().length === 0) ||
    new Set(visibleHeader).size !== visibleHeader.length
  ) {
    throw new InvalidDocumentProjectionError();
  }
  const headerIndexes = new Map(
    header.map((name, index) => [name, index])
  );
  const selectedNames =
    columns.length === 0 ? header : columns.map(canonicalColumn);
  if (new Set(selectedNames).size !== selectedNames.length) {
    throw new TypeError("projection options are invalid");
  }
  const selectedIndexes = selectedNames.map((name) => headerIndexes.get(name));
  const filterIndex = filter
    ? headerIndexes.get(canonicalColumn(filter.column))
    : undefined;
  if (
    selectedIndexes.some((index) => index === undefined) ||
    (filter && filterIndex === undefined)
  ) {
    throw new TypeError("projection options are invalid");
  }

  const entries = [];
  for (let row = 1; row < source.length; row += 1) {
    const raw = source[row];
    const redacted = visible[row];
    if (raw.fields.length !== header.length) {
      throw new InvalidDocumentProjectionError();
    }
    if (filter && raw.fields[filterIndex] !== filter.equals) continue;
    const redactions = [];
    const value = Object.fromEntries(selectedIndexes.flatMap((index) => {
      if (index >= redacted.fields.length) return [];
      const sensitive = SENSITIVE_COLUMN.test(header[index]);
      if (sensitive && raw.fields[index].length > 0) {
        redactions.push({
          class: /authorization|token/iu.test(header[index])
            ? "credential"
            : "secret",
          count: 1,
          rule_id: "csv-sensitive-column-v1"
        });
      }
      return [[
        visibleHeader[index],
        sensitive && raw.fields[index].length > 0
          ? REDACTION_MARKER
          : redacted.fields[index]
      ]];
    }));
    entries.push({
      value,
      redactions,
      citation: {
        artifact_id: artifact.artifactId,
        source_digest: artifact.sourceDigest,
        byte_start: raw.byteStart,
        byte_end: raw.byteEnd
      }
    });
  }
  return {
    entries,
    commonRedactions: rendered.redactions,
    mediaType: "application/x-ndjson",
    diagnostic: {
      code: "EG-PROJECT-TABLE-001",
      message:
        "Deterministic column, scalar equality, and row slice projection v1 was applied."
    }
  };
}
