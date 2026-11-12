// Safety revision: no runtime services, file deletion, or directory changes.
export const name = 'session-tools';

export async function deleteSession() {
  const error = new Error(
    'Permanent chat deletion is unavailable: this DSH version has no supported deletion API. Nothing was deleted.',
  );
  error.code = 'session-tools/delete-unavailable';
  throw error;
}

export async function moveSession() {
  const error = new Error(
    'Moving chats between workspaces is unavailable: changing the command directory does not change sidebar membership. Nothing was moved.',
  );
  error.code = 'session-tools/move-unavailable';
  throw error;
}

// Even if manually enabled, this revision registers no UI or remote operations.
export function apply() {}
