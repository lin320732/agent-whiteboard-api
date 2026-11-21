// Single source of truth for unauthenticated capability R2 file paths.
// Keep this module dependency-free so src/board.js can import it without
// pulling API or D1 modules into the dashboard proxy Worker.
export const PUBLIC_FILE_PATH_RE = /^\/api\/files\/(f_[A-Za-z0-9_-]{16,})(?:\/([^/]+))?$/;

export function parsePublicFilePath(pathname) {
  const match = PUBLIC_FILE_PATH_RE.exec(String(pathname || ''));
  if (!match) return null;
  let requestedName = null;
  if (match[2]) {
    try {
      requestedName = decodeURIComponent(match[2]);
    } catch {
      return { id: match[1], requestedName: null, invalidEncoding: true };
    }
  }
  return { id: match[1], requestedName, invalidEncoding: false };
}
