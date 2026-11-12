/**
 * Message edit — Host half.
 *
 * The editing capability is client-composed over existing public remotes
 * (session fork and prompt), so the Host side contributes only the bundle
 * row; it registers nothing and mutates no session state.
 */

export const name = 'message-edit'

export function apply() {}
