export function redactLog(value: unknown): string {
  return String(value)
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ")
    .replace(/\b(?:sk-[\w-]+|gh[pousr]_[\w]+|github_pat_[\w]+)\b/g, "[credential]")
    .replace(/\bBearer\s+[\w.+/=-]+/gi, "Bearer [credential]")
    .replace(/((?:api[_-]?key|token|secret|password)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|\S+)/gi, "$1[credential]")
    .replace(/(?:[a-z]:[\\/]|\\\\).*/i, "[path]")
    .replace(/(^|[\s('"=])\/(?:[~\w.]|\/).*/, "$1[path]")
    .slice(0, 1000);
}

export function logDiagnostic(value: unknown): void {
  console.error(redactLog(value));
}
