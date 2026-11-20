# Bedrock Spend Backstop (AWS Budget + Budget Action) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In AWS, stop the Slack review bot's Bedrock spend at 1.10 × the bot's own monthly cap. An AWS Budget, filtered to the bot by a cost-allocation tag, attaches a deny-invoke policy to the bot's engine role when it reaches 100%.

**Architecture:** One resource tag, `Project=slack-review-bot`, attributes both engines.

- **Claude** (bedrock-runtime) gets a tagged application inference profile.
- **Codex** (bedrock-mantle) is attributed by its Mantle project, which already carries the tag.
- **Budget and action.** A monthly cost Budget filters on that tag. At 100% of the Budget, a BudgetAction attaches `SlackReviewBotBedrockDeny` to `SlackReviewBotEngineRole`. It does so with automatic approval, through an execution role that can attach and detach only that policy, and only on that role.
- **Repos.** All of the infrastructure lives in trade-platform/pulumi. The bot only changes once the pulumi PR is deployed: it switches Claude's model setting to the profile ARN.

**Tech Stack:** Pulumi TypeScript (`@pulumi/aws` 7.15.0, `@pulumi/pulumi` 3.266.0), mocha + ts-node tests (`npm test` in trade-platform/pulumi), and AWS Budgets, Cost Explorer, IAM and Bedrock.

**Spec:** `docs/superpowers/specs/2026-11-19-bedrock-spend-cap-design.md`, section 10 (amended 2026-11-20 in the same PR as this plan) and section 11 step 3. Tracking: https://github.com/andrew-barnett/slack-review-bot/issues/84. Parent cap issue: https://github.com/andrew-barnett/slack-review-bot/issues/76.

## Findings this plan rests on

Each was checked on 2026-11-20 against AWS documentation or the live staging account (153538148884, us-east-2), as noted.

1. **Mantle spend is attributable by the project's tags.** "When you associate an inference request with a project, the project's tags are attached to the billing record for that request. Tags appear as AWS cost allocation tags in CUR and Cost Explorer, with the same behavior as tags on other AWS resources." (https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-projects.html).
   - Codex sends `OpenAI-Project: proj_e5ihwmxmoce7neqplby3` on every request.
   - Live `GET /v1/organization/projects/proj_e5ihwmxmoce7neqplby3` returns tags `Project=slack-review-bot` and `Issue=andrew-barnett/slack-review-bot/76`, with `data_retention.mode` `default`.
   - So the backstop covers Codex without a profile, a new tag, or any change to the bot.
2. **bedrock-runtime spend is billed to the inference target.** The default project "is never the billing anchor: usage on `bedrock-runtime` is attributed to the inference target" (https://docs.aws.amazon.com/bedrock/latest/userguide/projects.html). So Claude needs a tagged application inference profile, as the spec said. Live: `us.anthropic.claude-opus-5-5` is `ACTIVE` in us-east-2 and routes to us-east-1, us-east-2 and us-west-2.
3. **Tag key choice: `Project`, not `app`.**
   - The Mantle project already carries `Project=slack-review-bot`. Tagging it with `app` would need a hand-made Mantle API call outside Pulumi.
   - Live, the only resource tagged `Project=slack-review-bot` (resourcegroupstaggingapi, us-east-2 and us-east-1) is that Mantle project.
   - `Project` is already listed as a cost-allocation tag key (`UserDefined`, `Inactive`).
   - The org's Pulumi code already uses `Project` this way (`bedrock/guardrails.ts`: `Project: 'atlas-support-bot'`).
4. **A deny on `bedrock-mantle:CreateInference` is required in the budget-action policy.** Mantle has its own IAM namespace, and the engine role's Mantle grant (`InvokeViaMantleProject`) is `bedrock-mantle:CreateInference`. A `bedrock:InvokeModel*` deny does not reach it. The deny policy therefore lists `bedrock-mantle:*` beside `bedrock:InvokeModel*`.
5. **The deny is reversed automatically at the next budget period.**
   - "IAM and SCP action types reset at the beginning of each budgeted period (e.g., monthly)" (AWS What's New, https://aws.amazon.com/about-aws/whats-new/2020/10/announcing-aws-budgets-actions/). Only EC2 and RDS instance actions do not reset.
   - Lifting it mid-month is manual. A "Reversed" action is one where AWS Budgets "will no longer evaluate the action for the remaining budgeted period", and "If you want AWS Budgets to re-evaluate the reversed action during the same period, you can choose **Reset**" (https://docs.aws.amazon.com/cost-management/latest/userguide/budgets-action-review.html).
   - So the runbook raises the limit and then resets, which keeps the backstop armed.
6. **IAM principal attribution was considered and not chosen.** It works on both endpoints (https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-iam-principal-tracking.html) and would need no profile. Three things count against it:
   - Its tags (`iamPrincipal/…`) appear for activation only after the principal's first Bedrock call, and take up to 24 h more to activate (https://docs.aws.amazon.com/awsaccountbilling/latest/aboutv2/iam-principal-cost-allocation.html). That cannot be done in one Pulumi deploy.
   - AWS documents no Budgets filter syntax for them.
   - Live `ce list-cost-allocation-tags` shows no IAM-principal tags in the account.
   - The resource-tag route uses only documented, standard Budgets filtering.
7. **`aws:ResourceTag` works on application inference profiles.** The Service Authorization Reference (https://docs.aws.amazon.com/service-authorization/latest/reference/list_amazonbedrock.html) lists `aws:ResourceTag/${TagKey}` on the `application-inference-profile` resource, and that resource for `InvokeModel`.
8. **Credits must be excluded.** A Budget's default cost types include credits. A credit balance would net the spend to zero and the Budget would never fire. So `includeCredit` and `includeRefund` are `false`.
9. **Pulumi will not undo the deny.** `createRole` (`iam/iam-resources/index.ts`) sets no `managedPolicyArns`, and the engine role's grant is a separate `RolePolicyAttachment`. So `pulumi up` and `refresh` do not detach a policy that Budgets attached.

## Global Constraints

- Account `153538148884`, region `us-east-2`. Budgets and Cost Explorer are global APIs; Pulumi's default provider handles them.
- Tag: key `Project`, value `slack-review-bot`. Budget filter value: `user:Project$slack-review-bot`.
- Budget limit: 1.10 × `BEDROCK_MONTHLY_CAP_USD`, which is `1100` for the default cap of `1000`. Pulumi config: `slack-review-bot:bedrockBudgetLimitUsd`.
- Budget name: `slack-review-bot-bedrock`.
- Budget action: `APPLY_IAM_POLICY`, `AUTOMATIC` approval, `ACTUAL`, `PERCENTAGE` 100.
- Deny policy: `SlackReviewBotBedrockDeny`, actions `bedrock:InvokeModel*` and `bedrock-mantle:*` on `*`. Pulumi never attaches it.
- Execution role: trusts only `budgets.amazonaws.com`, conditioned on `aws:SourceAccount` `153538148884` and `aws:SourceArn` `arn:aws:budgets::153538148884:budget/slack-review-bot-bedrock*`. Its only actions are `iam:AttachRolePolicy` and `iam:DetachRolePolicy`, on the engine role ARN, with `iam:PolicyARN` equal to the deny policy ARN.
- trade-platform/pulumi style: Prettier, 4-space indent, single quotes, semicolons, no trailing commas, 120 columns. Commits are `feat(iam)` / `feat(bedrock)` with `(refs andrew-barnett/slack-review-bot#84)`.
- Do not run `pulumi up`; the CodeBuild pipeline deploys after a second person approves in `#aix-deployments`. `pulumi preview` only with `--suppress-outputs`. Never read secret config values.
- No malicious-PR threat model. The guarded failures are bugs and misconfiguration.

## Review Focus

1. **The deny falls behind the grant.** If a later PR adds an allow action, such as a new Mantle action, `bedrock:Converse` or a new runtime action, the deny must still cover it. Otherwise the backstop silently stops stopping that path. Task 2's test checks that every allowed action is matched by a deny pattern.
2. **A tagged-profile grant without its tag condition.** That would let the engine role invoke any application inference profile in the account, including other teams' untagged ones. Task 1's test pins the condition.
3. **A limit that is missing, zero, negative or not a number.** Any of these must fail the deploy rather than create a $0 Budget, which would deny on the first charge, or a NaN one. Task 3 validates the value and throws at `pulumi preview`. Task 3 Step 3 runs a preview to confirm.
4. **A Budget that hides spend behind credits or refunds.** Task 3 sets `includeCredit` and `includeRefund` to `false`, and Task 3 Step 3 checks them in the preview diff.
5. **An execution role that is broader than one policy on one role.** A Budgets bug, or a wrong `policyArn` in the action, must not be able to attach other policies or touch other roles. Task 3 pins `iam:PolicyARN` and the resource ARN. Task 4's post-deploy check reads the live role policy.

---

## Task 1: Claude attribution (tagged application inference profile + invoke grant)

**Repo:** trade-platform/pulumi.

**Files:**
- Modify: `iam/policies/SlackReviewBotBedrockInvoke.ts` (add one statement and a header-comment paragraph)
- Modify: `iam/policies/SlackReviewBotBedrockInvoke.test.ts` (add a test)
- Create: `bedrock/slackReviewBotSpend.ts` (the profile here; Task 3 adds the rest)
- Modify: `bedrock/index.ts`, `index.ts` (export the module and the profile ARN)

**Interfaces:**
- Produces: `slackReviewBotClaudeProfile: aws.bedrock.InferenceProfile`. Also `SLACK_REVIEW_BOT_TAG = { Project: 'slack-review-bot' }` and `SLACK_REVIEW_BOT_ISSUE_TAG = { Issue: 'andrew-barnett/slack-review-bot/84' }`, both exported from `bedrock/slackReviewBotSpend.ts`. Finally, the stack output `slackReviewBotClaudeProfileArn`.

- [ ] **Step 1: Write the failing test** in `iam/policies/SlackReviewBotBedrockInvoke.test.ts`, inside the existing `describe`:

```ts
    it('grants application inference profiles only when tagged for this bot', () => {
        // An untagged grant would let the engine invoke any team's application profile in the account,
        // and that spend would escape the bot's Budget, which filters on Project=slack-review-bot.
        const statement = document.Statement.find((s: any) => s.Sid === 'InvokeTaggedProfiles');
        assert.ok(statement, 'the tagged application inference profile grant is missing');
        assert.deepStrictEqual(statement.Resource, [
            'arn:aws:bedrock:us-east-2:153538148884:application-inference-profile/*'
        ]);
        assert.deepStrictEqual(statement.Condition, {
            StringEquals: { 'aws:ResourceTag/Project': 'slack-review-bot' }
        });
    });
```

- [ ] **Step 2: Run it and confirm it fails.** Run `npm test`. Expected: FAIL with `the tagged application inference profile grant is missing`.

- [ ] **Step 3: Add the statement** to the policy document in `iam/policies/SlackReviewBotBedrockInvoke.ts`, after `InvokeReviewModels`:

```json
        {
            "Sid": "InvokeTaggedProfiles",
            "Effect": "Allow",
            "Action": [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream"
            ],
            "Resource": [
                "arn:aws:bedrock:us-east-2:153538148884:application-inference-profile/*"
            ],
            "Condition": {
                "StringEquals": {
                    "aws:ResourceTag/Project": "slack-review-bot"
                }
            }
        },
```

Then add this paragraph to the header comment:

```ts
// - Spend backstop (andrew-barnett/slack-review-bot#84): bedrock-runtime bills usage to the inference target,
//   so Claude is attributed to the bot through an application inference profile tagged Project=slack-review-bot
//   (bedrock/slackReviewBotSpend.ts), which this grant is limited to by aws:ResourceTag. The foundation-model
//   grants above still apply to the models the profile routes to. Codex is attributed by its Mantle project's
//   own Project=slack-review-bot tag.
```

- [ ] **Step 4: Create `bedrock/slackReviewBotSpend.ts`** with the profile:

```ts
import * as aws from '@pulumi/aws';

// Bedrock spend backstop for the Slack Review Bot (andrew-barnett/slack-review-bot#84, design section 10).
// One resource tag, Project=slack-review-bot, attributes both review engines in billing:
// - Claude (bedrock-runtime) through the application inference profile below. bedrock-runtime bills usage to
//   the inference target, so calls through the untagged `us.` system profile are not attributed.
// - Codex (bedrock-mantle) through its Mantle project, proj_e5ihwmxmoce7neqplby3, which already carries
//   Project=slack-review-bot. Project tags reach Cost Explorer and Budgets like other resource tags. The project
//   was made through the Mantle API and has no Pulumi resource (see iam/policies/SlackReviewBotBedrockInvoke.ts).

export const SLACK_REVIEW_BOT_TAG = { Project: 'slack-review-bot' };
export const SLACK_REVIEW_BOT_ISSUE_TAG = { Issue: 'andrew-barnett/slack-review-bot/84' };

// One profile per configured Claude model (the bot's CLAUDE_BEDROCK_MODEL). A model change in the bot's
// refresh-bot-runtime skill adds a profile here first.
export const slackReviewBotClaudeProfile = new aws.bedrock.InferenceProfile('slack-review-bot-claude-opus-5-5', {
    name: 'slack-review-bot-claude-opus-5-5',
    description: 'Slack Review Bot: Claude Opus 5.5, tagged for the bot Bedrock Budget.',
    modelSource: {
        copyFrom: 'arn:aws:bedrock:us-east-2:153538148884:inference-profile/us.anthropic.claude-opus-5-5'
    },
    tags: { ...SLACK_REVIEW_BOT_TAG, ...SLACK_REVIEW_BOT_ISSUE_TAG }
});
```

Append `export * as slackReviewBotSpend from './slackReviewBotSpend';` to `bedrock/index.ts`. In `index.ts`, import `slackReviewBotClaudeProfile` from `./bedrock/slackReviewBotSpend` and add:

```ts
// The Slack Review Bot sets CLAUDE_BEDROCK_MODEL to this ARN so its Claude spend is attributed to its Budget
// (andrew-barnett/slack-review-bot#84).
export const slackReviewBotClaudeProfileArn = slackReviewBotClaudeProfile.arn;
```

- [ ] **Step 5: Run the tests and the type check.** Run `npm test && npx tsc --noEmit --pretty false -p .`. Expected: all tests pass. The only type errors are the two that already exist on `master`, in `iam/roles/EventServiceClusterAdmin.ts`, for missing `EksAllAccess` and `IamLimitedAccess`.

- [ ] **Step 6: Commit.**

```bash
git add iam/policies/SlackReviewBotBedrockInvoke.ts iam/policies/SlackReviewBotBedrockInvoke.test.ts bedrock/slackReviewBotSpend.ts bedrock/index.ts index.ts
git commit -F msg   # feat(bedrock): attribute slack review bot Claude spend through a tagged inference profile (refs andrew-barnett/slack-review-bot#84)
```

## Task 2: The deny policy

**Repo:** trade-platform/pulumi.

**Files:**
- Create: `iam/policies/SlackReviewBotBedrockDeny.ts`
- Create: `iam/policies/SlackReviewBotBedrockDeny.test.ts`
- Modify: `package.json` (add the test file to the `test` script's mocha file list)

**Interfaces:**
- Produces: `SlackReviewBotBedrockDeny: aws.iam.Policy`, named `SlackReviewBotBedrockDeny`, with path `/service-role/`.

- [ ] **Step 1: Write the failing test** `iam/policies/SlackReviewBotBedrockDeny.test.ts`:

```ts
import * as assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Read the literal documents without initializing the Pulumi stack or its providers.
function policyDocument(file: string) {
    const source = readFileSync(join(__dirname, file), 'utf8');
    return JSON.parse(source.match(/policy:\s*`([^`]+)`/)![1]);
}

const asList = (value: string | string[]) => (Array.isArray(value) ? value : [value]);
const matches = (pattern: string, action: string) =>
    new RegExp(
        '^' +
            pattern
                .split('*')
                .map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
                .join('.*') +
            '$',
        'i'
    ).test(action);

describe('SlackReviewBotBedrockDeny', () => {
    const deny = policyDocument('SlackReviewBotBedrockDeny.ts');
    const invoke = policyDocument('SlackReviewBotBedrockInvoke.ts');

    it('denies every action the engine role is allowed', () => {
        // The backstop fails silently if a new invoke path (a Mantle action, a runtime action) is granted
        // without a matching deny: the Budget fires, the policy attaches, and that engine keeps spending.
        const denied = deny.Statement.filter((s: any) => s.Effect === 'Deny').flatMap((s: any) => asList(s.Action));
        const allowed = invoke.Statement.filter((s: any) => s.Effect === 'Allow').flatMap((s: any) => asList(s.Action));
        assert.ok(allowed.length > 0, 'the invoke policy grants nothing; the cross-check is not checking');
        for (const action of allowed) {
            assert.ok(
                denied.some((pattern: string) => matches(pattern, action)),
                `${action} is allowed but not denied`
            );
        }
    });

    it('denies on every resource, unconditionally', () => {
        // A resource or condition scope would leave some route (another region, an untagged profile) open.
        for (const statement of deny.Statement) {
            assert.strictEqual(statement.Effect, 'Deny');
            assert.deepStrictEqual(asList(statement.Resource), ['*']);
            assert.strictEqual(statement.Condition, undefined);
        }
    });
});
```

Then add `iam/policies/SlackReviewBotBedrockDeny.test.ts` to the end of the `test` script's file list in `package.json`.

- [ ] **Step 2: Run it and confirm it fails.** Run `npm test`. Expected: the run aborts, because `SlackReviewBotBedrockDeny.ts` does not exist yet. Under this mocha/ts-node setup, the missing file surfaces as `ReferenceError: __dirname is not defined in ES module scope`.

- [ ] **Step 3: Create `iam/policies/SlackReviewBotBedrockDeny.ts`:**

```ts
import * as aws from '@pulumi/aws';

// Spend backstop for the Slack Review Bot (andrew-barnett/slack-review-bot#84). AWS Budgets attaches this policy
// to SlackReviewBotEngineRole when the bot's Bedrock Budget reaches 100% (bedrock/slackReviewBotSpend.ts), and
// detaches it when the next budget period starts. Pulumi never attaches it. The explicit deny overrides the
// grants in SlackReviewBotBedrockInvoke. Because IAM evaluates the role's policies on every request, it also
// stops reviews already running on issued sessions.
// - bedrock:InvokeModel* covers Claude Code on bedrock-runtime: InvokeModel, the streaming variants, and Converse,
//   which is authorized as InvokeModel.
// - bedrock-mantle:* covers Codex on the Mantle endpoint (bedrock-mantle:CreateInference). The bedrock: deny does
//   not reach that namespace.
export const SlackReviewBotBedrockDeny = new aws.iam.Policy('SlackReviewBotBedrockDeny', {
    description: 'Slack Review Bot spend backstop: deny Bedrock model invocation (attached by AWS Budgets).',
    name: 'SlackReviewBotBedrockDeny',
    path: '/service-role/',
    policy: `{
    "Version": "2012-10-17",
    "Statement": [
        {
            "Sid": "DenyBedrockInvocation",
            "Effect": "Deny",
            "Action": [
                "bedrock:InvokeModel*",
                "bedrock-mantle:*"
            ],
            "Resource": "*"
        }
    ]
}`
});
```

- [ ] **Step 4: Run the tests and confirm they pass.** Run `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** with `feat(iam): add slack review bot Bedrock spend deny policy (refs andrew-barnett/slack-review-bot#84)`.

## Task 3: Cost-allocation tag, Budget, execution role and Budget action

**Repo:** trade-platform/pulumi.

**Files:**
- Modify: `bedrock/slackReviewBotSpend.ts`
- Modify: `Pulumi.staging-uat.yaml`. Append two plain (non-secret) keys under `config:`. Do not touch or read any `secure:` value.

**Interfaces:**
- Consumes: `SlackReviewBotBedrockDeny` (Task 2), `SlackReviewBotEngineRole` (`iam/roles/SlackReviewBotRoles.ts`), `createRole` (`iam/iam-resources`), and `SLACK_REVIEW_BOT_TAG` / `SLACK_REVIEW_BOT_ISSUE_TAG` (Task 1).
- Produces: `slackReviewBotBedrockBudget`, `slackReviewBotBudgetsActionRole`, and `slackReviewBotBedrockDenyAction`.

- [ ] **Step 1: Add the config.** Append to `Pulumi.staging-uat.yaml`, at the `config:` indentation:

```yaml
  slack-review-bot:bedrockBudgetLimitUsd: "1100"
  slack-review-bot:bedrockBudgetAlertEmail: devops@aixplatform.com
```

`devops@aixplatform.com` is the team address this stack already uses for Bedrock alarms (`bedrock:guardrailAlarmEmail`).

- [ ] **Step 2: Append the resources** to `bedrock/slackReviewBotSpend.ts`, and add the imports at the top:

```ts
import * as pulumi from '@pulumi/pulumi';
import * as iam from '../iam/iam-resources';
import { SlackReviewBotBedrockDeny } from '../iam/policies/SlackReviewBotBedrockDeny';
import { SlackReviewBotEngineRole } from '../iam/roles/SlackReviewBotRoles';
```

```ts
const config = new pulumi.Config('slack-review-bot');

// 1.10 x the bot's BEDROCK_MONTHLY_CAP_USD (design section 10). The bot stops new reviews at its own cap; this
// is the AWS-side backstop for when the bot's ledger undercounts. Change it whenever the bot's cap changes.
const budgetLimitUsd = config.requireNumber('bedrockBudgetLimitUsd');
if (!Number.isFinite(budgetLimitUsd) || budgetLimitUsd <= 0) {
    throw new Error('slack-review-bot:bedrockBudgetLimitUsd must be a positive number of USD');
}
const alertEmail = config.require('bedrockBudgetAlertEmail');

const budgetName = 'slack-review-bot-bedrock';

// Cost Explorer and Budgets only see the tag once it is active. Activation is account-wide, takes up to
// 24 hours, and is not retroactive.
export const projectCostAllocationTag = new aws.costexplorer.CostAllocationTag('cost-allocation-tag-Project', {
    tagKey: 'Project',
    status: 'Active'
});

export const slackReviewBotBedrockBudget = new aws.budgets.Budget(
    budgetName,
    {
        name: budgetName,
        budgetType: 'COST',
        timeUnit: 'MONTHLY',
        limitAmount: String(budgetLimitUsd),
        limitUnit: 'USD',
        // Tag only, with no service filter, so Mantle spend counts whatever billing service it lands under.
        costFilters: [{ name: 'TagKeyValue', values: ['user:Project$slack-review-bot'] }],
        // Credits or refunds would net the spend down, and the backstop would never fire.
        costTypes: { includeCredit: false, includeRefund: false },
        // Just above the bot's own cap (100 / 110 = 90.9%): AWS has seen more spend than the bot's ledger allowed.
        notifications: [
            {
                comparisonOperator: 'GREATER_THAN',
                notificationType: 'ACTUAL',
                threshold: 91,
                thresholdType: 'PERCENTAGE',
                subscriberEmailAddresses: [alertEmail]
            }
        ],
        tags: { ...SLACK_REVIEW_BOT_TAG, ...SLACK_REVIEW_BOT_ISSUE_TAG }
    },
    { dependsOn: [projectCostAllocationTag] }
);

// Assumed by AWS Budgets to run the action below. It can attach or detach only the deny policy, and only on the
// engine role.
export const slackReviewBotBudgetsActionRole = iam.createRole({
    name: 'SlackReviewBotBudgetsActionRole',
    title: 'SlackReviewBotBudgetsActionRole',
    policy: JSON.stringify({
        Version: '2012-10-17',
        Statement: [
            {
                Effect: 'Allow',
                Principal: { Service: 'budgets.amazonaws.com' },
                Action: 'sts:AssumeRole',
                Condition: {
                    StringEquals: { 'aws:SourceAccount': '153538148884' },
                    ArnLike: { 'aws:SourceArn': `arn:aws:budgets::153538148884:budget/${budgetName}*` }
                }
            }
        ]
    }),
    description: 'AWS Budgets: attach or detach the Slack Review Bot Bedrock deny policy on its engine role.',
    path: '/service-role/',
    tags: { ...SLACK_REVIEW_BOT_TAG, ...SLACK_REVIEW_BOT_ISSUE_TAG }
});

const slackReviewBotBudgetsActionPolicy = new aws.iam.RolePolicy('SlackReviewBotBudgetsActionPolicy', {
    name: 'SlackReviewBotBudgetsActionPolicy',
    role: slackReviewBotBudgetsActionRole.name,
    policy: pulumi.jsonStringify({
        Version: '2012-10-17',
        Statement: [
            {
                Sid: 'ApplyBedrockDenyToEngineRole',
                Effect: 'Allow',
                Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
                Resource: SlackReviewBotEngineRole.arn,
                Condition: { ArnEquals: { 'iam:PolicyARN': SlackReviewBotBedrockDeny.arn } }
            }
        ]
    })
});

// At 100% of actual spend, attach the deny with no human approval. AWS resets IAM-policy actions when the next
// budget period starts, so the deny is detached on the 1st of the month (UTC). To lift it mid-month, raise
// bedrockBudgetLimitUsd and deploy, then reset the action (the runbook is in andrew-barnett/slack-review-bot's
// plan docs/superpowers/plans/2026-11-20-bedrock-spend-backstop.md).
export const slackReviewBotBedrockDenyAction = new aws.budgets.BudgetAction(
    'slack-review-bot-bedrock-deny',
    {
        budgetName: slackReviewBotBedrockBudget.name,
        actionType: 'APPLY_IAM_POLICY',
        approvalModel: 'AUTOMATIC',
        notificationType: 'ACTUAL',
        actionThreshold: { actionThresholdType: 'PERCENTAGE', actionThresholdValue: 100 },
        definition: {
            iamActionDefinition: {
                policyArn: SlackReviewBotBedrockDeny.arn,
                roles: [SlackReviewBotEngineRole.name]
            }
        },
        executionRoleArn: slackReviewBotBudgetsActionRole.arn,
        subscribers: [{ address: alertEmail, subscriptionType: 'EMAIL' }],
        tags: { ...SLACK_REVIEW_BOT_TAG, ...SLACK_REVIEW_BOT_ISSUE_TAG }
    },
    { dependsOn: [slackReviewBotBudgetsActionPolicy] }
);
```

- [ ] **Step 3: Type-check, test, format and preview.**
  1. Run `npm test && npx tsc --noEmit --pretty false -p . && npx prettier --check bedrock/slackReviewBotSpend.ts iam/policies/SlackReviewBotBedrockDeny.ts iam/policies/SlackReviewBotBedrockDeny.test.ts iam/policies/SlackReviewBotBedrockInvoke.ts iam/policies/SlackReviewBotBedrockInvoke.test.ts`. Expected: all pass, apart from the two existing `EventServiceClusterAdmin.ts` type errors.
  2. If the local Pulumi login works (`AWS_PROFILE=staging pulumi login s3://pulumi.staging.aixplatform.com`, stack `staging-uat`), run `pulumi preview --suppress-outputs --diff`. Expected: it creates the inference profile, the cost-allocation tag, the Budget (with `includeCredit: false` and `includeRefund: false`), the deny policy, the execution role and its inline policy, and the Budget action. It also updates `SlackReviewBotBedrockInvoke`. It replaces and deletes nothing.
  3. If the preview cannot run locally, say so in the PR. The PR's CodeBuild preview is the check.
  4. Commit first. Then run `pulumi preview --suppress-outputs --non-interactive --config slack-review-bot:bedrockBudgetLimitUsd=0`. Expected: the run fails with `slack-review-bot:bedrockBudgetLimitUsd must be a positive number of USD`. `--config` writes the value into `Pulumi.staging-uat.yaml`, so restore the file with `git checkout Pulumi.staging-uat.yaml` afterwards.

- [ ] **Step 4: Commit (before Step 3.4)** with `feat(bedrock): add slack review bot Bedrock Budget and deny action (refs andrew-barnett/slack-review-bot#84)`. Open one draft PR for Tasks 1-3, whose body has `Refs https://github.com/andrew-barnett/slack-review-bot/issues/84`. Run the review loop until it is clean, then `gh pr ready`, then `gh pr merge --auto --merge`. The PR needs a second person's approval, and the deploy needs another person's approval in `#aix-deployments`.

## Task 4: Post-deploy verification and runbook (operator, after the pulumi deploy)

Nothing here can run before the deploy.

- [ ] **Step 1: Confirm the deny is wired.** Run `aws --profile staging budgets describe-budget-actions-for-budget --account-id 153538148884 --budget-name slack-review-bot-bedrock`. Expected: one action, `Status` `STANDBY`, `ApprovalModel` `AUTOMATIC`, a `PolicyArn` ending in `/service-role/SlackReviewBotBedrockDeny`, and `Roles` `["SlackReviewBotEngineRole"]`.
- [ ] **Step 2: Confirm the execution role's scope.** Run `aws --profile staging iam get-role-policy --role-name SlackReviewBotBudgetsActionRole --policy-name SlackReviewBotBudgetsActionPolicy`. Expected: exactly `iam:AttachRolePolicy` and `iam:DetachRolePolicy`, on the engine role ARN, with `iam:PolicyARN` set to the deny policy ARN.
- [ ] **Step 3: Confirm the tag is active.** Run `aws --profile staging ce list-cost-allocation-tags --tag-keys Project`. Expected: `Status` `Active`. Activation can take up to 24 h; the data counts only from then on.
- [ ] **Step 4: Confirm attribution, at least 24 h after the tag is active and after a Codex review.** Run `aws --profile staging ce get-cost-and-usage --time-period Start=<YYYY-MM-01>,End=<tomorrow> --granularity MONTHLY --metrics UnblendedCost --filter '{"Tags":{"Key":"Project","Values":["slack-review-bot"]}}' --group-by Type=DIMENSION,Key=SERVICE`. Expected: a non-zero Bedrock line. No line means attribution is unverified, not working. Re-check after Task 5 for Claude.
- [ ] **Runbook: the deny fired mid-month and the cap was raised on purpose.**
  1. Raise `slack-review-bot:bedrockBudgetLimitUsd` to 1.10 × the new cap, by PR, and get the deploy approved.
  2. Run `aws --profile staging budgets describe-budget-actions-for-budget --account-id 153538148884 --budget-name slack-review-bot-bedrock` and note the `ActionId`.
  3. Run `aws --profile staging budgets execute-budget-action --account-id 153538148884 --budget-name slack-review-bot-bedrock --action-id <ActionId> --execution-type REVERSE_BUDGET_ACTION`. This detaches the deny.
  4. Run the same command with `--execution-type RESET_BUDGET_ACTION`, so that Budgets evaluates the action again this period against the new limit. A reversed action without a reset leaves the bot unprotected until the 1st.
  5. Confirm with `aws --profile staging iam list-attached-role-policies --role-name SlackReviewBotEngineRole`. Expected: `SlackReviewBotBedrockInvoke` only.
- [ ] **Runbook: the deny fired and the month rolled over.** No step is needed. AWS resets IAM-policy actions at the start of each budget period. On the 1st, confirm with the `list-attached-role-policies` command above.

## Task 5: Bot follow-up, switching Claude to the profile ARN (separate slack-review-bot PR, after the deploy)

This is omitted from the plan PR on purpose. It cannot be verified until the profile exists, and it must not merge before the pulumi deploy. Until it ships, the Budget sees Codex spend only, though the deny stops both engines once it fires.

**Files:** `src/config.ts`, `src/config.test.ts`, `src/bedrock-auth.ts`, `src/bedrock-auth.test.ts`, `pricing/bedrock-prices.json`, `README.md`, `.claude/skills/refresh-bot-runtime/SKILL.md`, and `launcher.conf` (operator-local, not committed).

- [ ] **Step 1: Verify live, as the engine role, before any code.**
  1. Get the ARN with `pulumi stack output slackReviewBotClaudeProfileArn` (stack `staging-uat`).
  2. Run one Claude Code review with `CLAUDE_BEDROCK_MODEL=<arn>`. It must succeed, and its usage must still be read.
- [ ] **Step 2: Validation.** `CLAUDE_BEDROCK_MODEL` accepts either a `TOML_SAFE_ID` or an ARN matching `^arn:aws:bedrock:[a-z0-9-]+:\d{12}:application-inference-profile/[a-z0-9]+$`. `CODEX_BEDROCK_MODEL` keeps the strict `TOML_SAFE_ID` check, because it is interpolated into Codex's `-c` TOML override. Tests:
  - the ARN is accepted for Claude;
  - the same ARN is still rejected for Codex;
  - an ARN-shaped value carrying `"`, `]` or a newline is rejected for Claude.
- [ ] **Step 3: Background model.** In `bedrockClaudeEnv` (`src/bedrock-auth.ts`), also set `ANTHROPIC_DEFAULT_HAIKU_MODEL` to the same value. Claude Code's background calls would otherwise go to an untagged `us.anthropic.*` system profile. First confirm the variable name against the Claude Code docs for the pinned `claude` version. The test asserts that both variables equal the configured model.
- [ ] **Step 4: Prices, docs and the skill.**
  - Re-key the Claude entry in `pricing/bedrock-prices.json` to the ARN, with the same prices as `us.anthropic.claude-opus-5-5`.
  - Add a README note to the settings table: change `BEDROCK_MONTHLY_CAP_USD` and `slack-review-bot:bedrockBudgetLimitUsd` (trade-platform/pulumi) together.
  - Add a step to the `refresh-bot-runtime` skill: a new Claude model needs a new tagged profile in trade-platform/pulumi `bedrock/slackReviewBotSpend.ts`, deployed first, and then its ARN and price.
- [ ] **Step 5 (optional, after Step 4 has run for a month):** drop the `us.anthropic.*` inference-profile grants from `SlackReviewBotBedrockInvoke`, so that an untagged Claude call fails instead of escaping the Budget.
