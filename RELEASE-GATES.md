# Release verification

Run the commands in the README from a clean checkout and review the generated archives. The CI workflow covers dependency installation, Message Edit compilation, source validation, plugin tests, packed installation, and the Judge Python bridge. The macOS job includes both macOS-only plugins.

Before tagging a release, run the opt-in workflows that match the advertised integrations. Use a disposable DSH profile, synthetic chats and local services. Verify message editing and permanent deletion, placement with keyboard input and drag-and-drop, model-provider disclosure, and native macOS permissions. For video guidance, use a scratch timeline with a reversible edit and a temporary export.

Publish the repository source and its notices with any release archives. Keep local profile state and credentials outside the repository. Review Git history before making an existing repository public.
