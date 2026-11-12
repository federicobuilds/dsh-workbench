# User editing semantics

## Caller behavior

The editor passes the chosen user-message identity, its expected revision, replacement text, and either `save` or `fork`. It does not append a regeneration instruction.

- `save` cuts the selected user message and subsequent messages in-place within the exact same session using a surface replacement and command projection, optionally updates the session's model selection, and submits the revised user message directly. No fork or duplicate session is created.
- `fork` creates a new session from the prefix preceding the selected user message, optionally selects the chosen model, and submits the revised user message there while leaving the original conversation untouched.
- Assistant saves remain text projections over existing records. They do not regenerate or cut history.
- Queued editing reserves pending input outside the model-consumable queue and restores or re-queues it explicitly.

## Types and operation sequence

For `save`, the plugin appends a surface cut in the existing session. For `fork`, it creates a child from the earlier prefix and carries prior edits. It checkpoints the cut or child before clearing pending input, choosing the model, and submitting the replacement once. A second checkpoint confirms those later mutations. An error can report an in-memory commit separately from confirmed durability and identify any created child or accepted follow-up.

If follow-up submission throws and the replacement cannot be observed in the inbox, acceptance is unknown, not rejected. Check the session before retrying.

## Design decision

The in-place cut uses session events and a surface projection rather than rewriting the existing log. Original records remain in history even when the active surface no longer displays them. A fork is created only when explicitly selected.

The staged edit and cut parsers recognize `dsh-message-edit/v3:` and `dsh-message-edit-cut/v3:`. The queue parser recognizes `dsh-message-queue/v1:`. The staged 3.1.0 and 3.2.0 host artifacts also use the v3 edit receipt and v1 queue receipt. No v1 or v2 edit-receipt format is defined in these parsers; compatibility with such records is not claimed.

## Verification target

The regression must assert that model input contains the revised user message once, contains no old target text or later replies, contains no generated instruction bubble, and that the old conversation remains visible only when `fork` was selected. Queue tests must separately show that a held draft cannot be claimed by the driver.
