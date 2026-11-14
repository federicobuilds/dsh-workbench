# Side Chats

Select text in a settled assistant message or a user message, choose **Start side chat**, and enter a question. Side Chats creates a native DSH fork through that message, queues your question in the fork, and opens it. Work in the parent can continue during the branch.

The new question includes the selection and the source session and event. The fork retains the native inherited event prefix. **Open parent chat** returns to the parent and loads history through the source row when available. The link is stored on the DSH host after verifying the fork's inherited boundary, so it remains available when a different client connects to that host. Retries reuse the same fork and prompt request ID while the action is open.

The same package provides the destination action used by Task Organization. That action opens an existing chat or creates one in a selected workspace, then prepares or sends the confirmed prompt.

## Compatibility

DeepSeek Harness 0.2.2-rc.1. Enable the bundle in the Desktop or Web profile. Uses native conversation slots, session forks, workspace navigation, and DSH storage.
