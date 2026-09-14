# Windows notification acquisition: Phase 0 review

Reviewed 2026-09-13. Documentation verified; no Windows runtime, installation, permissions, or delivery tests performed. This note distinguishes documented capabilities from architectural inference.

## Documented contract

- **Verified:** Microsoft's supported listener reads other applications' notifications. Setup requires the User Notification Listener capability in the application package manifest and explicit permission requested on a UI thread. Permission can later be revoked; reads may then silently return an empty list. Check permission separately from notification count. [Microsoft notification listener](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener)
- **Verified:** The API returns current notifications, rather than a promised permanent event archive. Background changes require resynchronizing a snapshot; foreground `NotificationChanged` documents added/removed notifications. Neither this guidance nor the class reference establishes reliable delivery of every intermediate text update. [Listener guide](https://learn.microsoft.com/en-us/windows/apps/develop/notifications/app-notifications/notification-listener), [listener API](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.management.usernotificationlistener?view=winrt-26100)
- **Verified:** `UserNotification` contains `AppInfo`, creation time, numeric notification ID, and visual notification content. These identify a notification and its originating app; the contract does not provide a ChatGPT conversation ID or IDE task identity. The documentation does not establish numeric ID uniqueness across reboots or reinstalls. [UserNotification API](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.usernotification?view=winrt-26100)
- **Verified:** The documented listener methods retrieve/remove/clear notifications and manage access. There is no documented arbitrary original-toast activation method. Its notification representation exposes visual content; do not promise that copying text preserves a notification's original click action. [Listener API](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.management.usernotificationlistener?view=winrt-26100), [Notification API](https://learn.microsoft.com/en-us/uwp/api/windows.ui.notifications.notification?view=winrt-26100)

## Architectural consequences (inferred)

Notification acquisition is a credible Windows-specific attention mechanism, but it is not task-state reconstruction. Forward a source-machine label, app label, observed time, and locally normalized reason; label ambiguous events at app level. Keep raw notification text local by default; an optional preview requires a deliberate source-specific choice. A user-supplied task label can aid recognition but does not prove event-to-task binding when several tasks run together.

PowerShell can send HTTP requests, but a plain script is not yet a verified zero-install solution to listener consent and application identity. If a short spike cannot obtain a genuine third-party notification, use a minimal packaged C# host following Microsoft's documented setup. Do not turn a scripting preference into a WinRT interop project. Packaging, signing/install experience, and the actual Windows version remain runtime questions.

Use a local collector event ID and retain source notification ID as metadata. Resynchronize after restart; distinguish existing startup notifications from new arrivals. Do not interpret removal as task completion or as a user acknowledgement in Rally. Changed text under an existing ID must not automatically be discarded as a duplicate; measure actual producer behavior first.

## Cheapest useful experiment (proposed)

1. On the actual Windows machine, capture one genuine ChatGPT and one genuine Antigravity notification, including source app metadata and visible text. Record application versions, permission status, and whether the app was foreground/background.
2. Run two distinguishable tasks in one app. Determine whether the notification is useful without conversation identity. Accept app-level reminders only if this meets the user's stated workflow.
3. Dismiss a notification, restart the collector, revoke/re-enable permission, and inspect whether replay or silent empty reads are correctly recognized. Briefly test replacement/update behavior and Do Not Disturb; the docs alone cannot predict these applications' behavior.
4. Only then forward these events over the LAN and measure whether the receiving computer saves a manual check. Keep return-to-target manual until a real URL or supported activation mechanism is verified.

## Existing relay component

**Verified:** ntfy accepts HTTP PUT/POST, documents PowerShell examples, supports titles and publisher-specified click links, and provides self-hosting installation options. [Publishing](https://docs.ntfy.sh/publish/), [Installation](https://docs.ntfy.sh/install/)

**Inferred:** It can eliminate a custom relay server/viewer for an attention prototype. It does not collect Windows notifications, derive missing task identity, or recreate original toast actions. A local receiver endpoint is also reasonable if ntfy deployment adds more work than it removes. LAN transport configuration and actual receiver display behavior still need testing.
