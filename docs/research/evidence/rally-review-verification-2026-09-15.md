# Rally architecture review — local verification record

Date: 2026-09-15 (Asia/Shanghai). Source baseline: `be4f02ca94bf2753836187fca34b7d8a77530275`. Node: `v24.3.0`.

This record distinguishes local synthetic reproduction from a real ChatGPT runtime test. No candidate was installed into ChatGPT and no browser messages were sent. Application source, package files, tests and generated bundle were not changed by the review. The build was rerun and produced no tracked diff. Only the report and its evidence attachments were added; nothing was committed, pushed or posted to GitHub.

## 1. Repository and remote

- Initial working tree: clean.
- Local HEAD and successful GitHub REST branch response: `be4f02ca94bf2753836187fca34b7d8a77530275`.
- Branch: `probe/issue-1-browser-network`.
- Successful REST issue listing: #1, #2, #3 open.
- Successful #1 comments response includes Phase 3 implementation report for this SHA and earlier probe/Attention-first review decisions.
- Successful #3 response still defines Attention Inbox, with automatic Browser ↔ IDE relay explicitly out of scope.
- REST contents query for `dist/chatgpt-runtime-detector.user.js?ref=main`: HTTP 404. Local `origin/main` tree also has no `dist/` entry.
- `gh issue view` GraphQL request returned 401; some subsequent REST retries had connectivity errors. No failed request was treated as evidence of the requested content.

## 2. Build

Command, from repository root:

```sh
npm run build
```

Observed exit code: 0. Output: version 0.3.0, `dist/chatgpt-runtime-detector.user.js`, 25.83 KB. `git status --short` showed no modified tracked files after build.

The generated bundle was evaluated in a minimal `node:vm` context with stubbed DOM observer and no network:

```text
BUILT_RUNTIME_VERSION=__RALLY_VERSION__
```

The runtime version default is a quoted string, so esbuild's identifier `define` does not replace it. Header version is 0.3.0; these are distinct checks.

## 3. Original test command versus diagnostic execution

```sh
npm test
```

All 18 assertion results printed as passing, but the process remained alive. A second execution was run under an eight-second subprocess timeout and terminated as an isolated process group:

```text
TEST_PROCESS_TIMEOUT_AFTER_8S
```

For diagnosis only, the following command made Node BroadcastChannel instances unreferenced. This did not edit the repository or represent a fix:

```sh
node --import 'data:text/javascript,const B=globalThis.BroadcastChannel;globalThis.BroadcastChannel=class extends B{constructor(...args){super(...args);this.unref()}}' scripts/run-tests.mjs
```

Observed result:

```text
tests 18
pass 18
fail 0
cancelled 0
skipped 0
todo 0
duration_ms 1196.183875
exit code 0
```

Conclusion: assertions pass, but the original command does not complete in this environment. The successful diagnostic run supports open BroadcastChannel handles as the cause. These tests do not exercise the complete detector integration or real browser behavior.

## 4. Synthetic cross-module counterexamples

Run the accompanying audit script from any directory:

```sh
node /Users/yamlam/Documents/GitHub/browser-ide-rally/docs/research/evidence/rally-review-repro-2026-09-15.mjs
```

It imports the repository source, uses Node Response streams, and stubs only the DOM selector where relevant. It performs no network calls, browser writes, shell task execution or repository mutation. It closes its own BroadcastChannel instances. The assertions describe the defects at the reviewed SHA, so repaired code is expected to invalidate these assertions; this is not a future acceptance test suite.

Observed successful reproduction output (exit 0):

```text
REPRO 1: late DOM ignored; second distinct generation swallowed; stored identity=conv-A/assistant-A
REPRO 2: conversation_id from earlier chunk lost at primary admission
REPRO 3: tool patch accepted as assistant ID; arbitrary v strings can admit PRIMARY_GENERATION
REPRO 4: six unverified synthetic completions PASS gate; emitted interruption self-validates
REPRO 5: Stop + DOM disappearance >400ms before reader closure becomes completed
REPRO 6: unsupported compact/handoff stream silently counted as auxiliary
```

The same counterexamples were first executed from a temporary file and then from the delivered evidence attachment. They establish reachable implementation failures under supplied inputs. They do not establish the frequency or exact wire shape of current ChatGPT production traffic.

## 5. Installed product metadata

Read-only `/Applications` inspection found Antigravity, Antigravity IDE and Antigravity Tools apps. Antigravity.app's Info.plist reports `CFBundleShortVersionString = 2.13.0` and `CFBundleVersion = 2.13.0`.

`command -v agy` and `command -v antigravity` returned no path. This does not prove the binaries are absent elsewhere. No hook configuration, permissions, application state or credentials were changed. GUI/CLI interoperability remains unverified.

## 6. Validation boundary

Not performed: live userscript installation, live normal/Stop generation trials, account-specific MCP availability tests, Antigravity hook execution, GUI conversation resume, persistent relay, delivery ACK or restart reconciliation.

The historical 14 normal and 2 Stop samples remain reported evidence. No new live sample was claimed. The architecture verdict rests on reviewed requirements, current source and documentation, plus the synthetic counterexamples above.
