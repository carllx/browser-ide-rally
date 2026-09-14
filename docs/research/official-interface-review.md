# Official interface feasibility notes

Checked 2026-09-13. Scope: documented interfaces for the existing ChatGPT Browser + Antigravity GUI workflow. **Verified** below means verified official documentation, never verified on the user's installed runtime. **Inferred** means an architectural consequence. No runtime integration was installed or exercised.

## Antigravity: a materially shorter IDE route exists in current documentation

**Verified:** Official [Antigravity hooks](https://antigravity.google/docs/hooks/) and [Antigravity for IDEs hooks](https://antigravity.google/docs/ide/hooks/) document JSON stdin hooks. Common fields include `conversationId` (conversation UUID) and `workspacePaths`; `Stop` adds `executionNum`, `terminationReason`, and `fullyIdle`. Stop reasons include model stop, step exhaustion, and error. `fullyIdle` distinguishes an idle agent from outstanding background work. `PreInvocation` observes model invocation, not a complete user turn. Configuration uses `hooks.json`; the documented Stop output can continue execution, so observation must deliberately avoid continuation or message injection.

**Scope caveat:** These are separate product documentation branches; navigation currently labels Antigravity 2.0 v2.13.0 and Antigravity for IDEs v2.5.5. The user's exact GUI edition, version, hook support and field behavior remain unverified. Do not silently apply IDE-extension documentation to an older standalone GUI.

**Inferred:** Verify the installed GUI's hook capability before building an OS notification collector for the IDE. If supported, emit only allowlisted identity/lifecycle metadata, excluding transcript contents, tool arguments and error bodies. This preserves the user's GUI workflow without requiring CLI migration. A Stop event is evidence of execution termination, not successful delivery, workflow acceptance or permission to relay. Neither documentation page establishes crash recovery, lossless replay, global event ordering, or later `fullyIdle` notification after an earlier non-idle Stop; test these rather than assuming them.

## Notification APIs: creation does not imply global observation

**Verified:** [`chrome.notifications.getAll()`](https://developer.chrome.com/docs/extensions/reference/api/notifications#method-getAll) enumerates notifications belonging to the calling app/extension. It is not a listener for ChatGPT website or Antigravity notifications.

**Verified:** Apple's [`getDeliveredNotifications`](https://developer.apple.com/documentation/usernotifications/unusernotificationcenter/getdeliverednotifications(completionhandler:)) returns the caller app's delivered notifications still present in Notification Center. It is not a public cross-app completion feed.

**Verified:** The [Notifications standard](https://notifications.spec.whatwg.org/#dom-serviceworkerregistration-getnotifications) scopes service-worker `getNotifications()` to the matching origin and registration. It does not expose an OS-wide notification bus.

**Inferred:** A page-context probe may investigate ChatGPT's own accessible service-worker registration as a bounded experiment. That still requires proving ChatGPT uses it, permission/state behavior, retention and conversation identity. Replacing a page's `Notification` constructor alone does not establish visibility into notifications emitted by its worker. System-wide collection via accessibility, private databases or undocumented listeners would need separate feasibility and maintenance justification; no supported global macOS listener was established in this review. Merely seeing a banner is insufficient collector evidence.

## Browser transport APIs: better observation, not semantic completion

**Verified:** [Chrome webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest) observes request lifecycle with extension and host permissions. Its completion event is request completion. WebSocket observation covers the handshake, explicitly excluding individual frames and socket closure.

**Verified:** [CDP Network](https://chromedevtools.github.io/devtools-protocol/tot/Network/) exposes network loading and WebSocket frame/closure events. [`chrome.debugger`](https://developer.chrome.com/docs/extensions/reference/api/debugger) provides an extension transport for supported CDP domains and targets. These APIs describe browser activity; they do not define ChatGPT conversation IDs or successful assistant-turn semantics.

**Verified:** Since Chrome 136, [remote-debugging port/pipe switches require a non-default data directory](https://developer.chrome.com/blog/remote-debugging-port). This is a restriction on those launch switches, not a claim that the extension debugger API requires a separate profile.

**Inferred:** CDP may improve capture coverage but does not remove the private-protocol interpretation burden. Do not replace a small passive probe with a browser debugging architecture merely to obtain `loadingFinished`. DOM/accessibility may still provide inexpensive attention evidence, but their existence does not supply authoritative agent completion either.

## Decision consequence

The strongest new candidate is asymmetric: documented IDE lifecycle hooks when actually supported, plus the cheapest Browser attention signal that passes identity and usability checks. Run notification feasibility only after identifying an accessible collector on the actual platform. Public documentation warrants changing experiment priority, not declaring runtime feasibility or production readiness.
