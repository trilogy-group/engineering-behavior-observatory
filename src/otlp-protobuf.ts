/**
 * Minimal OTLP/HTTP protobuf decoder for logs and metrics export requests.
 *
 * Devin CLI exports OTLP as `application/x-protobuf`, not JSON. This decoder
 * projects the binary payload into the OTLP/JSON field names so retained
 * telemetry records stay readable without a protobuf runtime dependency.
 * Unknown fields are retained under `unknownFields` by field number so the
 * projection never silently drops native data it does not model.
 */

type WireField = { field: number; wireType: 0 | 1 | 2 | 5; value: bigint | Uint8Array };

type MessageSchema = Record<number, { name: string; kind: "message" | "string" | "bytes" | "int" | "uint" | "fixed64" | "fixed32" | "double" | "bool" | "enum" | "packedFixed64" | "packedDouble"; schema?: MessageSchema; repeated?: boolean }>;

const ANY_VALUE: MessageSchema = {};
const KEY_VALUE: MessageSchema = {
  1: { name: "key", kind: "string" },
  2: { name: "value", kind: "message", schema: ANY_VALUE },
};
const ARRAY_VALUE: MessageSchema = { 1: { name: "values", kind: "message", schema: ANY_VALUE, repeated: true } };
const KEY_VALUE_LIST: MessageSchema = { 1: { name: "values", kind: "message", schema: KEY_VALUE, repeated: true } };
Object.assign(ANY_VALUE, {
  1: { name: "stringValue", kind: "string" },
  2: { name: "boolValue", kind: "bool" },
  3: { name: "intValue", kind: "int" },
  4: { name: "doubleValue", kind: "double" },
  5: { name: "arrayValue", kind: "message", schema: ARRAY_VALUE },
  6: { name: "kvlistValue", kind: "message", schema: KEY_VALUE_LIST },
  7: { name: "bytesValue", kind: "bytes" },
} satisfies MessageSchema);
const RESOURCE: MessageSchema = {
  1: { name: "attributes", kind: "message", schema: KEY_VALUE, repeated: true },
  2: { name: "droppedAttributesCount", kind: "uint" },
};
const SCOPE: MessageSchema = {
  1: { name: "name", kind: "string" },
  2: { name: "version", kind: "string" },
  3: { name: "attributes", kind: "message", schema: KEY_VALUE, repeated: true },
  4: { name: "droppedAttributesCount", kind: "uint" },
};
const LOG_RECORD: MessageSchema = {
  1: { name: "timeUnixNano", kind: "fixed64" },
  2: { name: "severityNumber", kind: "enum" },
  3: { name: "severityText", kind: "string" },
  5: { name: "body", kind: "message", schema: ANY_VALUE },
  6: { name: "attributes", kind: "message", schema: KEY_VALUE, repeated: true },
  7: { name: "droppedAttributesCount", kind: "uint" },
  8: { name: "flags", kind: "fixed32" },
  9: { name: "traceId", kind: "bytes" },
  10: { name: "spanId", kind: "bytes" },
  11: { name: "observedTimeUnixNano", kind: "fixed64" },
  12: { name: "eventName", kind: "string" },
};
const SCOPE_LOGS: MessageSchema = {
  1: { name: "scope", kind: "message", schema: SCOPE },
  2: { name: "logRecords", kind: "message", schema: LOG_RECORD, repeated: true },
  3: { name: "schemaUrl", kind: "string" },
};
const RESOURCE_LOGS: MessageSchema = {
  1: { name: "resource", kind: "message", schema: RESOURCE },
  2: { name: "scopeLogs", kind: "message", schema: SCOPE_LOGS, repeated: true },
  3: { name: "schemaUrl", kind: "string" },
};
const EXPORT_LOGS: MessageSchema = { 1: { name: "resourceLogs", kind: "message", schema: RESOURCE_LOGS, repeated: true } };

const EXEMPLAR: MessageSchema = {
  2: { name: "timeUnixNano", kind: "fixed64" },
  3: { name: "asDouble", kind: "double" },
  4: { name: "spanId", kind: "bytes" },
  5: { name: "traceId", kind: "bytes" },
  6: { name: "asInt", kind: "fixed64" },
  7: { name: "filteredAttributes", kind: "message", schema: KEY_VALUE, repeated: true },
};
const NUMBER_DATA_POINT: MessageSchema = {
  2: { name: "startTimeUnixNano", kind: "fixed64" },
  3: { name: "timeUnixNano", kind: "fixed64" },
  4: { name: "asDouble", kind: "double" },
  5: { name: "exemplars", kind: "message", schema: EXEMPLAR, repeated: true },
  6: { name: "asInt", kind: "fixed64" },
  7: { name: "attributes", kind: "message", schema: KEY_VALUE, repeated: true },
  8: { name: "flags", kind: "uint" },
};
const HISTOGRAM_DATA_POINT: MessageSchema = {
  2: { name: "startTimeUnixNano", kind: "fixed64" },
  3: { name: "timeUnixNano", kind: "fixed64" },
  4: { name: "count", kind: "fixed64" },
  5: { name: "sum", kind: "double" },
  6: { name: "bucketCounts", kind: "packedFixed64" },
  7: { name: "explicitBounds", kind: "packedDouble" },
  8: { name: "exemplars", kind: "message", schema: EXEMPLAR, repeated: true },
  9: { name: "attributes", kind: "message", schema: KEY_VALUE, repeated: true },
  10: { name: "flags", kind: "uint" },
  11: { name: "min", kind: "double" },
  12: { name: "max", kind: "double" },
};
const GAUGE: MessageSchema = { 1: { name: "dataPoints", kind: "message", schema: NUMBER_DATA_POINT, repeated: true } };
const SUM: MessageSchema = {
  1: { name: "dataPoints", kind: "message", schema: NUMBER_DATA_POINT, repeated: true },
  2: { name: "aggregationTemporality", kind: "enum" },
  3: { name: "isMonotonic", kind: "bool" },
};
const HISTOGRAM: MessageSchema = {
  1: { name: "dataPoints", kind: "message", schema: HISTOGRAM_DATA_POINT, repeated: true },
  2: { name: "aggregationTemporality", kind: "enum" },
};
const METRIC: MessageSchema = {
  1: { name: "name", kind: "string" },
  2: { name: "description", kind: "string" },
  3: { name: "unit", kind: "string" },
  5: { name: "gauge", kind: "message", schema: GAUGE },
  7: { name: "sum", kind: "message", schema: SUM },
  9: { name: "histogram", kind: "message", schema: HISTOGRAM },
  12: { name: "metadata", kind: "message", schema: KEY_VALUE, repeated: true },
};
const SCOPE_METRICS: MessageSchema = {
  1: { name: "scope", kind: "message", schema: SCOPE },
  2: { name: "metrics", kind: "message", schema: METRIC, repeated: true },
  3: { name: "schemaUrl", kind: "string" },
};
const RESOURCE_METRICS: MessageSchema = {
  1: { name: "resource", kind: "message", schema: RESOURCE },
  2: { name: "scopeMetrics", kind: "message", schema: SCOPE_METRICS, repeated: true },
  3: { name: "schemaUrl", kind: "string" },
};
const EXPORT_METRICS: MessageSchema = { 1: { name: "resourceMetrics", kind: "message", schema: RESOURCE_METRICS, repeated: true } };

export type OtlpProtobufSignal = "logs" | "metrics";

/** Decode an OTLP export request body into its OTLP/JSON projection. Throws on malformed wire data. */
export function decodeOtlpProtobuf(signal: OtlpProtobufSignal, bytes: Uint8Array): Record<string, unknown> {
  return decodeMessage(bytes, signal === "logs" ? EXPORT_LOGS : EXPORT_METRICS, 0);
}

function decodeMessage(bytes: Uint8Array, schema: MessageSchema, depth: number): Record<string, unknown> {
  if (depth > 32) throw new Error("OTLP protobuf nesting exceeds the supported depth.");
  const output: Record<string, unknown> = {};
  const unknownFields: Record<string, unknown[]> = {};
  for (const { field, wireType, value } of readFields(bytes)) {
    const definition = schema[field];
    if (definition === undefined) {
      (unknownFields[String(field)] ??= []).push(wireType === 2 ? Buffer.from(value as Uint8Array).toString("base64") : (value as bigint).toString());
      continue;
    }
    const decoded = decodeField(definition, wireType, value, depth);
    if (decoded === undefined) continue;
    if (definition.repeated) (output[definition.name] as unknown[] | undefined ?? (output[definition.name] = [])).push(decoded);
    else if (Array.isArray(decoded) && (definition.kind === "packedFixed64" || definition.kind === "packedDouble")) {
      output[definition.name] = [...(output[definition.name] as unknown[] | undefined ?? []), ...decoded];
    } else output[definition.name] = decoded;
  }
  if (Object.keys(unknownFields).length > 0) output.unknownFields = unknownFields;
  return output;
}

function decodeField(definition: MessageSchema[number], wireType: number, value: bigint | Uint8Array, depth: number): unknown {
  const expectLength = (): Uint8Array => {
    if (wireType !== 2) throw new Error(`OTLP field ${definition.name} expected length-delimited data.`);
    return value as Uint8Array;
  };
  const expectVarint = (): bigint => {
    if (wireType !== 0) throw new Error(`OTLP field ${definition.name} expected a varint.`);
    return value as bigint;
  };
  switch (definition.kind) {
    case "message": return decodeMessage(expectLength(), definition.schema!, depth + 1);
    case "string": return new TextDecoder("utf-8", { fatal: true }).decode(expectLength());
    case "bytes": return Buffer.from(expectLength()).toString("base64");
    case "bool": return expectVarint() !== 0n;
    case "enum": return Number(expectVarint());
    case "uint": return int64Text(expectVarint(), false);
    case "int": return int64Text(expectVarint(), true);
    case "fixed64": {
      if (wireType !== 1) throw new Error(`OTLP field ${definition.name} expected fixed64 data.`);
      return (value as bigint).toString();
    }
    case "fixed32": {
      if (wireType !== 5) throw new Error(`OTLP field ${definition.name} expected fixed32 data.`);
      return Number(value as bigint);
    }
    case "double": {
      if (wireType !== 1) throw new Error(`OTLP field ${definition.name} expected a double.`);
      return doubleFromBits(value as bigint);
    }
    case "packedFixed64": {
      if (wireType === 1) return [(value as bigint).toString()];
      return packed(expectLength(), 8).map((bits) => bits.toString());
    }
    case "packedDouble": {
      if (wireType === 1) return [doubleFromBits(value as bigint)];
      return packed(expectLength(), 8).map(doubleFromBits);
    }
    default: return undefined;
  }
}

function* readFields(bytes: Uint8Array): Generator<WireField> {
  let offset = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (offset >= bytes.length) throw new Error("OTLP protobuf varint is truncated.");
      const byte = bytes[offset++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if (byte < 0x80) return result;
      shift += 7n;
      if (shift > 63n) throw new Error("OTLP protobuf varint exceeds 64 bits.");
    }
  };
  const fixed = (width: number): bigint => {
    if (offset + width > bytes.length) throw new Error("OTLP protobuf fixed field is truncated.");
    let result = 0n;
    for (let index = width - 1; index >= 0; index -= 1) result = (result << 8n) | BigInt(bytes[offset + index]!);
    offset += width;
    return result;
  };
  while (offset < bytes.length) {
    const key = varint();
    const field = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (field === 0) throw new Error("OTLP protobuf field number zero is invalid.");
    if (wireType === 0) yield { field, wireType, value: varint() };
    else if (wireType === 1) yield { field, wireType, value: fixed(8) };
    else if (wireType === 5) yield { field, wireType, value: fixed(4) };
    else if (wireType === 2) {
      const length = Number(varint());
      if (offset + length > bytes.length) throw new Error("OTLP protobuf length-delimited field is truncated.");
      yield { field, wireType, value: bytes.subarray(offset, offset + length) };
      offset += length;
    } else throw new Error(`OTLP protobuf wire type ${wireType} is unsupported.`);
  }
}

function packed(bytes: Uint8Array, width: number): bigint[] {
  if (bytes.length % width !== 0) throw new Error("OTLP protobuf packed field has a partial element.");
  const values: bigint[] = [];
  for (let offset = 0; offset < bytes.length; offset += width) {
    let result = 0n;
    for (let index = width - 1; index >= 0; index -= 1) result = (result << 8n) | BigInt(bytes[offset + index]!);
    values.push(result);
  }
  return values;
}

function doubleFromBits(bits: bigint): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt.asUintN(64, bits), true);
  return view.getFloat64(0, true);
}

/** OTLP/JSON encodes 64-bit integers as decimal strings. */
function int64Text(value: bigint, signed: boolean): string {
  return (signed ? BigInt.asIntN(64, value) : BigInt.asUintN(64, value)).toString();
}
