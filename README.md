# Profile Commit Diff

When a profile or permission set is committed from Copado, blocks such as `layoutAssignments` or `fieldPermissions` are often removed from one place and added back unchanged somewhere else. In git that looks like hundreds of changed lines, but nothing really changed: Salesforce doesn't care about the order.

Give this tool a commit and it shows only the real changes to the profiles and permission sets in it.

```
Commit 75957212ac  US-0029918 Tech Debt : Remove EDIT access FLS on ACV metric fields for business users

force-app/main/default/profiles/Copado Integration - Rubrik API Integration.profile-meta.xml
  git diff +156 -149 lines  ->  13 real changes
    ~ fieldPermissions  Opportunity.ACV_Amount__c   editable: true -> false
    ~ fieldPermissions  Opportunity.ARR_Amount__c   editable: true -> false
    + fieldPermissions  OpportunityLineItem.Renewal_ACV__c   editable=false  readable=false
    ...
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

| Mark | Meaning |
|---|---|
| `+` | Block added, e.g. a new field permission |
| `-` | Block removed |
| `~` | Same block with a different value, shown as `old -> new` |
| `!` | Duplicate block in the file: the same field, object, class, etc. listed more than once (can fail a deploy) |

A file that was only re-ordered shows `no real changes (only re-ordered)`. A new or deleted file shows its block count only.

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

Also ignored:
- `<tag xsi:nil="true"/>` (Copado writes empty values this way); it means the same as the tag not being there.
- `fullName`, since Salesforce takes the name from the file name.

## Tests

```
npm test
```
