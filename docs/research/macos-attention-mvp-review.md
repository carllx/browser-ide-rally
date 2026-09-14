# macOS attention MVP: bounded interface review

Checked 2026-09-13. No installation, configuration changes or runtime tests. **Verified** means official documentation verified; **Inferred** means a proposed design or consequence. This supplements the [official interface review](./official-interface-review.md), without repeating the Antigravity hooks survey.

## Six primary references and what they establish

| Source | Verified capability | Boundary relevant to Rally |
| --- | --- | --- |
| [Hammerspoon application watcher](https://www.hammerspoon.org/docs/hs.application.watcher.html) | Application launch, termination, activation, deactivation and visibility events; callback receives app name, event and application object. | App lifecycle and focus are not agent-turn lifecycle. |
| [Hammerspoon window filter](https://www.hammerspoon.org/docs/hs.window.filter.html) | Filters windows by app/title/visibility/role and subscribes to changes. Includes an explicit Notification Center example using `AXNotificationCenterAlert`. Documentation calls this module somewhat experimental. | The example warrants testing banner observation; it does not guarantee current macOS banner visibility, retained notifications, background coverage or conversation IDs. |
| [Hammerspoon AX observer](https://www.hammerspoon.org/docs/hs.axuielement.observer.html) | Observes supported accessibility element notifications for an application. Documentation explicitly warns that support varies by app and element; callback detail may be empty. | AX notifications are UI change events, not a universal desktop-notification feed. A generic UI change cannot establish completion. |
| [Hammerspoon notify](https://www.hammerspoon.org/docs/hs.notify.html) | Emits/schedules notifications and registers interaction callbacks. `deliveredNotifications()` returns Hammerspoon's own retained notifications. | It cannot enumerate ChatGPT or Antigravity notifications. Documentation also describes callback limitations when Hammerspoon is not running. |
| [Apple NSWorkspace](https://developer.apple.com/documentation/appkit/nsworkspace) | Workspace notification center exposes app/environment events such as app activation, termination, sleep and wake. | Despite the name, this is not the visible Notification Center's app-banner stream. |
| [Apple DistributedNotificationCenter](https://developer.apple.com/documentation/foundation/distributednotificationcenter) | Cross-process dispatch of explicitly posted notifications to observers. Documentation allows unbounded delivery latency and dropped notifications when its queue fills. | Requires a participating publisher. No verified ChatGPT/Antigravity completion publisher was established; subscribing does not turn desktop banners into distributed events. |

## Cheapest useful product hypothesis

**Inferred:** “Arm this task” plus a persistent attention inbox is a better first product hypothesis than a universal collector, provided arming is a single easy action and the resulting signals save more checks than arming costs. Capture a user label, endpoint locator, local binding ID and a fresh run generation. Keep `Watching`, `Worth checking`, `Unknown/stale` and `Acknowledged` distinct. A notification is an optional output; the inbox retains attention until explicit acknowledgement.

Arming establishes which task the user wants tracked; it does **not** magically attribute later app-wide notifications. With two tasks in the same app, an uncorrelated banner must remain app-level attention. Never assign it to the most recently armed task. Likewise, app/window titles are display hints, not durable conversation identity. Recheck the endpoint before jumping; missing or changed targets become stale rather than silently selecting a replacement.

Manual acknowledgement is useful for deduplication, but focusing a window does not prove the user read the response. A timer may offer “check this task” reminders, never claim completion. A purely manual inbox validates navigation/organization value only; it does not solve automated discovery. A worthwhile completion MVP still needs at least one real signal with measured coverage.

## Next three macOS routes, in order of experiment value

1. **Existing automation host, explicit binding, narrow signal.** Use Hammerspoon as a disposable host for a small inbox and endpoint navigation, consuming a supported IDE lifecycle signal and/or a bounded browser signal already under test. Start with two simultaneous tasks. This avoids building a new desktop shell before proving benefit. The host reduces application scaffolding; it does not strengthen the event semantics.
2. **Hammerspoon AX banner / UI attention experiment.** Spend a fixed short session testing the documented Notification Center window-filter example and one specific target-app AX state change. Measure foreground/background, same-app concurrent tasks, suppression and sleep/wake. Retain only allowlisted metadata. If the event is inaccessible, ephemeral or lacks attribution, keep it as optional app-level attention or stop; do not escalate into a general UI scraper by default.
3. **Small native Swift/AppKit helper, only after a successful probe exposes a host limitation.** Reuse the proven signal and binding contract. Native packaging can improve integration and control over persistence/lifecycle, but NSWorkspace and distributed notifications confer no extra agent-completion knowledge. Do not build a native global collector to work around an API scope restriction that also applies to native code.

These are experiment priorities, not verified estimates of build effort. If Hammerspoon is absent and permission/setup cost exceeds a browser-only experiment, take the browser experiment first. No recommendation to install it has been executed.

## Consequences for the packaging comparison

**Inferred:** Separate four choices: signal source, identity mechanism, local storage/transport, and interface shell. Browser extension, platform script, native helper, Electron/Tauri and local web UI are not competing completion signals. An extension can address browser context while needing an IDE bridge; a local web inbox still needs a producer; Electron/Tauri still need platform adapters for OS observations. Choose the shell after one end-to-end attention event reaches the correct task and the user can return to it. A new cross-platform shell cannot repair an unavailable macOS listener or missing conversation identity.

## Stop conditions

- Stop universal-notification collection if the only proven path reads transient UI without adequate coverage or attribution.
- Stop completion labeling for AX/focus/title events unless actual endpoint behavior establishes that meaning; downgrade to attention.
- Stop adding tooling if arming, repair and acknowledgement cost more effort than the manual checks saved.
- Advance packaging only after two concurrent tasks produce correctly attributed attention and stale bindings fail visibly.
