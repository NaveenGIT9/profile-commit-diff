# Profile Commit Diff

When a profile or permission set is committed from Copado, blocks such as `layoutAssignments` or `fieldPermissions` are often removed from one place and added back unchanged somewhere else. In git that looks like hundreds of changed lines, but nothing really changed: Salesforce doesn't care about the order.

Give this tool a commit and it shows only the real changes to the profiles and permission sets in it.

```
force-app/main/default/profiles/Copado Integration - Rubrik API Integration.profile-meta.xml
git diff +156 -149 lines  →  15 real changes (3 added, 12 changed)
┌───────────┬──────────────┬─────────────────────────────────────────────┬──────────┬────────┬────────────────────────────────┐
│ Change    │ Type         │ Component                                   │ Setting  │ Before │ After                          │
├───────────┼──────────────┼─────────────────────────────────────────────┼──────────┼────────┼────────────────────────────────┤
│ + Added   │ Description  │                                             │          │        │ (empty)                        │
├───────────┼──────────────┼─────────────────────────────────────────────┼──────────┼────────┼────────────────────────────────┤
│ ~ Changed │ Field access │ Opportunity.ACV_Amount__c                   │ editable │ true   │ false                          │
│ + Added   │ Field access │ OpportunityLineItem.Renewal_ACV__c          │          │        │ editable=false, readable=false │
│ ...       │              │                                             │          │        │                                │
└───────────┴──────────────┴─────────────────────────────────────────────┴──────────┴────────┴────────────────────────────────┘
```

## Usage

Needs Node 18 or later and git. No `npm install` needed.

From inside the Salesforce repo:

```
node <path to this folder>/profile-diff.js <commit>
```

Or from anywhere:

```
node profile-diff.js <commit> --repo <path to the Salesforce repo>
```

### Sharing in Slack

```
node profile-diff.js <commit> --slack
```

This copies the result to the clipboard as plain text: tables drawn with `| - +` characters, at most 120 characters wide.

Slack only lines the columns up in a code block, and pasting text with ``` in it does not make one, so:

1. In the Slack message box, click the code block button (`</>`) or press Ctrl+Alt+Shift+C.
2. Paste with Ctrl+V and send.

For a long result (over Slack's 40,000-character limit for a message), send it as a snippet instead: Ctrl+Shift+Enter, paste, Create Snippet.

Colours don't carry over to Slack; the `+ Added` / `- Removed` / `~ Changed` labels still show what happened.

`<commit>` can be a SHA (full or short), a branch or a tag. If the commit was made in Copado or on GitHub, run `git fetch` first so it exists locally.

## Output

One table per file, grouped by type.

| Change | Colour | Meaning |
|---|---|---|
| `+ Added` | green | Block added, e.g. a new field permission; its settings are in **After** |
| `- Removed` | red | Block removed; its settings are in **Before** |
| `~ Changed` | yellow | Same block with a different value: one row per changed **Setting**, old value in **Before** (red), new value in **After** (green) |
| `!` duplicates | magenta | The same field, object, class etc. listed more than once in the file (can fail a deploy), with whether the copies differ and whether this commit introduced them |

A file that was only re-ordered shows `no real changes (only re-ordered)`. A new or deleted file shows its block count only. Colours are switched off when the output is piped to a file or `NO_COLOR` is set.

## How it works

1. Lists the `.profile-meta.xml` and `.permissionset-meta.xml` files changed in the commit. For a merge commit it compares with the first parent (the branch merged into).
2. Reads each file before and after the commit and splits it into blocks.
3. Identifies every block by what it controls:

   | Block | Identified by |
   |---|---|
   | `fieldPermissions` | `field` |
   | `objectPermissions` | `object` |
   | `layoutAssignments` | layout object + `recordType` (e.g. Case and CaseClose layouts for the same record type are separate) |
   | `recordTypeVisibilities` | `recordType` |
   | `classAccesses` / `pageAccesses` / `flowAccesses` | `apexClass` / `apexPage` / `flow` |
   | `tabVisibilities` / `tabSettings` | `tab` |
   | `userPermissions`, `customPermissions`, `customMetadataTypeAccesses`, `customSettingAccesses` | `name` |
   | `applicationVisibilities` | `application` |
   | `loginIpRanges` | `startAddress` + `endAddress` |
   | single elements (`userLicense`, `custom`, `description`, `loginHours`, `label`...) | the element name |

4. Compares the two sets by that identity, so position, indentation and the order of tags inside a block don't matter.

`<tag n1:nil="true" />` (how Copado writes an empty value) is shown as `(empty)`, for example `+ description (empty)`, because it deploys as a blank value.

Lines git shows that don't change anything in the org are listed under the table as `Formatting only, no effect on deploy`, not as changes:

- namespace declarations added to or removed from the root tag, e.g. `xmlns:n1="http://www.w3.org/2001/XMLSchema-instance"` (it only declares the `n1:` prefix used by `n1:nil`)
- the `<fullName>` line added or removed (Salesforce takes the name from the file name)

## Tests

```
npm test
```
