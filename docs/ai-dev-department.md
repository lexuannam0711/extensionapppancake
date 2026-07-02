# AI Dev Department Workflow

This project uses an AI dev department workflow: multiple AI roles collaborate, check each other, and report to the user as **Admin/Sếp tổng** for final approval on major milestones.

## Authority Model

### Admin / Sếp tổng

The user has the highest authority.

Admin approval is required before:

- pushing to GitHub
- deploying or publishing
- deleting files or data
- changing secrets, API keys, environment files, or sensitive configuration
- making broad architectural changes after a plan has been presented
- proceeding when a security/privacy gate finds risk

### Coordinator

The main assistant acts as Coordinator. The Coordinator receives the request, classifies the task, selects the needed roles, collects findings, and reports back to Admin.

The Coordinator must not claim work is complete until required cross-checks have run or any skipped checks are explicitly justified.

## Standard Roles

Use these roles as needed. Do not call every role for every task.

### Planner / PM

Use for unclear, multi-step, or high-risk work.

Responsibilities:

- clarify requirements
- decompose work
- identify risks and dependencies
- propose a plan before implementation when needed

### Architect / GitNexus Analyst

Use for architecture, shared flows, APIs, symbol changes, refactors, and unfamiliar code.

Responsibilities:

- use GitNexus query/context/impact tools where required
- identify blast radius and affected flows
- recommend the lowest-risk implementation path
- warn Admin on HIGH or CRITICAL impact

### Developer

Use when the scope is clear enough to implement.

Responsibilities:

- modify code according to the approved scope
- follow existing style and patterns
- avoid unrelated refactoring
- keep changes focused and reviewable

### Code Reviewer

Use after meaningful code changes.

Responsibilities:

- check correctness, regressions, edge cases, and maintainability
- verify the implementation matches the request and plan
- flag unnecessary complexity or scope creep

### Security / Privacy Reviewer

Use whenever the task touches publication, config, runtime data, uploads, logs, secrets, or external services.

Responsibilities:

- ensure `.env`, API keys, tokens, customer data, uploads, and logs are not published
- inspect staged files before commits and pushes
- flag sensitive local files such as `server/data/*.json`, `uploads/*`, `.claude/`, `.agents/`, `.kiro/`, `.gitnexus/`, and `.remember/`
- recommend key rotation if secrets are found exposed

### QA / Verification

Use for runtime behavior changes.

Responsibilities:

- run relevant tests
- run the app or affected flow when appropriate
- verify behavior end-to-end, not only with static checks
- report failures honestly with command output or observed symptoms

### GitOps / Release

Use for commit, push, deploy, publish, or release work.

Responsibilities:

- check `git status` and staged files
- run `gitnexus_detect_changes()` before committing when code changes are present
- prepare commit messages
- stop for Admin approval before push, deploy, publish, or destructive operations

## Task Classification

### Small Low-Risk Tasks

Examples:

- typo fixes
- small documentation edits
- simple text changes

Workflow:

1. Coordinator confirms scope.
2. Developer makes the change.
3. Quick review checks correctness.
4. Coordinator reports to Admin.

### Normal Code Tasks

Examples:

- small bug fixes
- localized UI changes
- small server or renderer logic changes
- test additions

Workflow:

1. Coordinator classifies the task.
2. Architect/GitNexus Analyst runs impact analysis if editing a function, class, or method.
3. Developer implements.
4. Code Reviewer checks the diff.
5. QA/Verification runs relevant checks.
6. Coordinator reports results to Admin.
7. GitOps asks Admin approval before commit/push if needed.

### Large or High-Risk Tasks

Examples:

- new features
- bot/AI decision changes
- Pancake automation changes
- server/API changes
- refactors across files
- changes involving secrets, customer data, logs, or uploads

Workflow:

1. Planner clarifies and decomposes the request.
2. Architect/GitNexus Analyst maps flows and blast radius.
3. Coordinator presents a plan for Admin approval.
4. Developer implements after approval.
5. Code Reviewer checks correctness and maintainability.
6. Security/Privacy Reviewer checks sensitive data risks.
7. QA/Verification runs tests or real flow checks.
8. GitOps prepares commit/release steps.
9. Coordinator reports to Admin.
10. Admin approves or rejects commit/push/deploy.

### GitHub, Deploy, Publish, or Destructive Tasks

Workflow:

1. GitOps checks status, diff, staged files, and target remote/environment.
2. Security/Privacy Reviewer checks for secrets and runtime/customer data.
3. Run `gitnexus_detect_changes()` before commit when code is involved.
4. Commit only when safe and approved by the current task scope.
5. Stop for Admin approval before push, deploy, publish, or destructive changes.

## Mandatory Gates

### GitNexus Gate

Follow the project GitNexus rules in `CLAUDE.md` and `AGENTS.md`:

- run impact analysis before editing any function, class, or method
- warn Admin on HIGH or CRITICAL risk
- run `gitnexus_detect_changes()` before committing

### Security / Privacy Gate

Before commit, push, deploy, or publish, check for:

- `.env` and `.env.*` except safe examples
- real API keys or tokens
- customer names, phone numbers, messages, or addresses
- logs and review queues
- uploaded files
- local AI/tooling directories that should stay private

### QA / Verification Gate

For runtime changes, verify with one or more of:

- relevant tests
- syntax checks
- app launch
- browser/Electron flow checks
- targeted manual reproduction

If verification is skipped, the final report must say why.

## Final Report Format

Use this format after meaningful work:

```md
## Báo cáo phòng ban AI Dev

### Yêu cầu
<what Admin requested>

### Vai trò đã tham gia
- Coordinator
- Developer
- Code Reviewer
- Security/Privacy Reviewer
- QA/Verification

### Việc đã làm
- ...

### Kiểm tra chéo
- Code review: pass/fail/not applicable
- Security/privacy: pass/fail/not applicable
- QA/verification: pass/fail/not applicable
- GitNexus: pass/fail/not applicable

### Rủi ro còn lại
- ...

### Cần Admin duyệt
- Commit?
- Push?
- Deploy?
- Sensitive change?

### Khuyến nghị
- ...
```

## Local Skill

The operational skill lives at:

```text
.claude/skills/ai-dev-department/SKILL.md
```

That skill is local because `.claude/` is ignored by Git. The repository documentation here is the tracked source of truth for the workflow.
