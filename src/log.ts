// Strips ANSI escape sequences and C0 control characters so values
// interpolated from package names can never inject terminal control codes
// into the log stream.
export function sanitize(value: string): string {
  return value
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

export function log(message: string): void {
  console.error(`[opencode-skill-autodiscovery] ${sanitize(message)}`);
}
