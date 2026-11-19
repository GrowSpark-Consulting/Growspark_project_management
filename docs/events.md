# Events: Project Management

The events this app publishes and plans to consume, so the Sales & CRM and People & HR apps can integrate without reading each other's databases (GSC platform rules §7).

> **Status:** planned contract. **No events are emitted yet.** The delivery mechanism (direct API call or a transactional outbox) is decided by the three teams at integration time (AGREE item). Each event below is tied to a place in the code where the app already reacts today, usually by sending an in-app notification, so adding emission later is a small, local change.

## Conventions

- **Name:** `project.<entity>.<past_tense_verb>`, for example `project.task.approved`.
- **Envelope:**

  ```json
  {
    "id": "<uuid v7, unique per event>",
    "type": "project.task.approved",
    "version": 1,
    "occurredAt": "2026-11-20T09:30:00Z",
    "organizationId": "<GSC_ORGANIZATION_ID>",
    "actor": { "type": "user", "id": "<user uuid>", "email": "priya@example.com" },
    "data": { }
  }
  ```

- **IDs never change.** Consumers must be idempotent: the same `id` delivered twice is processed once.
- **People are identified by** lowercase, trimmed email next to the local user id, so other apps can match them before SSO exists.
- **Money** is a string decimal with two places plus an ISO currency, e.g. `{ "amount": "482000.00", "currency": "INR" }`.
- **Times** are UTC ISO-8601.
- **Breaking changes** bump `version`. The old version keeps being sent until all consumers have moved.

## Events this app will publish

### Projects

| Event | When | `data` | Emitted from |
|---|---|---|---|
| `project.project.created` | A project is created, directly or from a template | `projectId`, `name`, `accountId`, `accountName`, `startDate`, `endDate`, `projectManager {id,email}` | `POST /api/projects`, `POST /api/projects/from-template` |
| `project.project.completed` | Marked complete manually, or its workflow finishes | `projectId`, `completedAt` | `/api/projects/{id}/complete`, trigger `complete_project_when_workflow_completes` |
| `project.project.reopened` | A completed project is reopened | `projectId` | `/api/projects/{id}/reopen` |
| `project.project.archived` / `project.project.restored` | Archive or restore | `projectId` | `POST /api/projects/{id}/actions` |
| `project.project.shared_with_client` | Made visible in the client portal | `projectId`, `accountId` | `PATCH /api/projects/{id}` |
| `project.member.added` / `project.member.removed` | Someone joins or leaves a project team | `projectId`, `user {id,email}`, `roleInProject` | `/api/projects/{id}/assignments` |

### Tasks

| Event | When | `data` | Emitted from |
|---|---|---|---|
| `project.task.created` | A task or subtask is created | `taskId`, `projectId`, `parentTaskId`, `name`, `assignee {id,email}`, `dueDate`, `priority` | `POST /api/tasks` |
| `project.task.assigned` | Assignee changes | `taskId`, `projectId`, `from`, `to` | `lib/task-events.ts` |
| `project.task.submitted` | Submitted for review | `taskId`, `projectId`, `reviewer {id,email}` | `POST /api/tasks/{id}/status` (submit) |
| `project.task.approved` | Reviewer or manager approves (Done) | `taskId`, `projectId`, `approvedBy` | `lib/task-events.ts` |
| `project.task.changes_requested` | Reviewer asks for changes | `taskId`, `projectId`, `note` | `lib/task-events.ts` |
| `project.task.reopened` | A done task is reopened | `taskId`, `projectId` | `lib/task-events.ts` |

### Time

| Event | When | `data` | Emitted from |
|---|---|---|---|
| `project.timesheet.submitted` | An employee submits a week | `timesheetId`, `user {id,email}`, `weekStart`, `totalHours` | `POST /api/me/timesheets` |
| `project.timesheet.approved` / `project.timesheet.rejected` | An approver decides | `timesheetId`, `user {id,email}`, `weekStart`, `totalHours`, `reviewer`, `note` | `POST /api/timesheets/{id}/review` |

### Client work

| Event | When | `data` | Emitted from |
|---|---|---|---|
| `project.deliverable.shared` | A manager sends a deliverable to the client | `deliverableId`, `projectId`, `name`, `version` | `POST /api/deliverables/{id}/action` (share) |
| `project.deliverable.approved` / `project.deliverable.rejected` | The client decides | `deliverableId`, `projectId`, `decidedBy {email}`, `feedback` | `POST /api/client/portal/deliverables/{id}/decision` |
| `project.issue.reported` | A client reports an issue | `issueId`, `projectId`, `title`, `severity` | `POST /api/client/portal/projects/{id}/issues` |
| `project.feedback.submitted` | A client submits project feedback | `projectId`, `satisfactionScore` | `POST /api/client/portal/projects/{id}/feedback` |

`hr.employee.*` and `sales.*` events are owned by those apps and listed in their own `docs/events.md`.

## Events this app plans to consume

| Event (owner) | What Project Management would do |
|---|---|
| `sales.deal.won` (Sales & CRM) | Offer to create a project for the deal's account, storing `sales_deal_id` as a cross-app reference (UUID, no foreign key) |
| `sales.lead.converted` (Sales & CRM) | Create or link the client account |
| `hr.employee.created` (People & HR) | Pre-create an invitation for the employee's email |
| `hr.employee.deactivated` (People & HR) | Deactivate the matching user (by lowercase email) and flag their open tasks for reassignment |

Each of these needs the receiving endpoint, API-key authentication and the `Idempotency-Key` header agreed at integration time.
