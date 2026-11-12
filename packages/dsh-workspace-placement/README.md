# Workspace Placement

Workspace Placement adds references to saved chats and tasks in named DSH workspaces. A reference opens the original chat. Placing or detaching a reference preserves the chat history and its original workspace. Task references preserve the origin and parent chat.

Use the reference action in the saved chat menu. Select the target workspace with the keyboard or drop the reference on a named workspace. Choose Detach from the reference menu to remove it. Only the owner UI can add, list or detach references. Active, archived and unavailable chats cannot be moved.

Requires DeepSeek Harness 0.2.2-rc.1. Run `npm test` from this package to exercise placement and persistence with synthetic chat records.
