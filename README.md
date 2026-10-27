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

Summary
┌─────────────────────────────────────────────────────┬────────────────┬──────────────┬───────┬─────────┬─────────┬────────────┐
│ File                                                │ Git diff lines │ Real changes │ Added │ Removed │ Changed │ Duplicates │
├─────────────────────────────────────────────────────┼────────────────┼──────────────┼───────┼─────────┼─────────┼────────────┤
│ Copado Integration - Rubrik API Integration.profile │ +156 -149      │ 15           │ 3     │ 0       │ 12      │ 0          │
│ Rubrik Backup API - Rubrik API Integration.profile  │ +13 -13        │ 11           │ 0     │ 0       │ 11      │ 0          │
└─────────────────────────────────────────────────────┴────────────────┴──────────────┴───────┴─────────┴─────────┴────────────┘
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

`<commit>` can be a SHA (full or short), a branch or a tag. If the commit was made in Copado or on GitHub, run `git fetch` first so it exists locally.

## Output

One table per file, grouped by type, then a summary table.

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

`fullName` is ignored, since Salesforce takes the name from the file name.

## Tests

```
npm test
```
