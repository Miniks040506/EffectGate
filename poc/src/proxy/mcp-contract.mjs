export const EFFECTGATE_VERSION = "0.17.0";
export const MAX_TOOL_RESULT_BYTES = 64 * 1024;
export const MCP_VERSION = "2025-11-25";

export function isValidToolContract(tool) {
  return tool !== null &&
    typeof tool === "object" &&
    !Array.isArray(tool) &&
    typeof tool.name === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/u.test(tool.name) &&
    (tool.title === undefined || typeof tool.title === "string") &&
    (tool.description === undefined ||
      typeof tool.description === "string") &&
    tool.inputSchema !== null &&
    typeof tool.inputSchema === "object" &&
    !Array.isArray(tool.inputSchema) &&
    (tool.outputSchema === undefined ||
      (tool.outputSchema !== null &&
        typeof tool.outputSchema === "object" &&
        !Array.isArray(tool.outputSchema)));
}

export function isSafeReadTool(tool) {
  return isValidToolContract(tool) &&
    tool.annotations?.readOnlyHint === true &&
    tool.annotations.destructiveHint === false &&
    tool.annotations.idempotentHint === true &&
    tool.annotations.openWorldHint === false;
}
