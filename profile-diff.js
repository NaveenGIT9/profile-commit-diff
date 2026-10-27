#!/usr/bin/env node
'use strict';

const { execFileSync } = require('child_process');

const PERMISSION_FILE = /\.(profile|permissionset)(-meta\.xml)?$/;

// The child element(s) that identify a block; anything else in the block is its value.
const KEY_FIELDS = {
    applicationVisibilities: ['application'],
    categoryGroupVisibilities: ['dataCategoryGroup'],
    classAccesses: ['apexClass'],
    customMetadataTypeAccesses: ['name'],
    customPermissions: ['name'],
    customSettingAccesses: ['name'],
    emailRoutingAddressAccesses: ['name'],
    externalCredentialPrincipalAccesses: ['externalCredentialPrincipal'],
    externalDataSourceAccesses: ['externalDataSource'],
    fieldPermissions: ['field'],
    flowAccesses: ['flow'],
    loginIpRanges: ['startAddress', 'endAddress'],
    objectPermissions: ['object'],
    pageAccesses: ['apexPage'],
    profileActionOverrides: ['actionName', 'pageOrSobjectType', 'formFactor', 'recordType', 'profile'],
    recordTypeVisibilities: ['recordType'],
    tabSettings: ['tab'],
    tabVisibilities: ['tab'],
    userPermissions: ['name']
};

function decode(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, entity) => {
        const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
        if (named) return named;
        const code = entity[1] === 'x' || entity[1] === 'X' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return String.fromCodePoint(code);
    });
}

function parseXml(text) {
    const doc = { name: '#document', children: [], text: '', error: null };
    const stack = [doc];
    const token = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<(\/?)([^\s/>!?]+)([^>]*?)(\/?)>|([^<]+)/g;
    const fail = (index, message) => {
        if (!doc.error) doc.error = `line ${text.slice(0, index).split('\n').length}: ${message}`;
    };
    let m;
    while ((m = token.exec(text))) {
        const top = stack[stack.length - 1];
        if (m[1] !== undefined) {
            top.text += m[1];
        } else if (m[3]) {
            if (m[2]) {
                if (top.name !== m[3]) fail(m.index, `</${m[3]}> does not match the open <${top.name}> tag`);
                if (stack.length > 1) stack.pop();
            } else {
                if (m[4].includes('<')) fail(m.index, `<${m[3]}> tag is missing its closing ">"`);
                // Copado writes <tag xsi:nil="true"/>; it deploys as a blank value, so it is a change, shown as (empty).
                const nil = /(^|\s)[\w.-]+:nil\s*=\s*["']true["']/.test(m[4]);
                const node = { name: m[3], children: [], text: '', nil, attrs: m[4] };
                top.children.push(node);
                if (!m[5]) stack.push(node);
            }
        } else if (m[6] !== undefined) {
            top.text += decode(m[6]);
        }
    }
    if (stack.length > 1) fail(text.length, `<${stack[stack.length - 1].name}> is never closed`);
    return doc;
}

const EMPTY = '(empty)';

function canonical(node) {
    if (node.nil) return EMPTY;
    const children = node.children;
    if (!children.length) return node.text.trim();
    return '{' + children.map((c) => c.name + '=' + canonical(c)).sort().join(';') + '}';
}

// fullName is ignored: Salesforce takes the name from the file name, and Copado often drops the line.
const IGNORED = new Set(['fullName']);

function namespaces(root) {
    const found = new Map();
    for (const m of (root?.attrs || '').matchAll(/xmlns(?::([\w.-]+))?\s*=\s*["']([^"']*)["']/g)) found.set(m[1] ? `xmlns:${m[1]}` : 'xmlns', m[2]);
    return found;
}

// Lines git shows that don't change anything in the org: namespace declarations and fullName.
function formattingNotes(beforeXml, afterXml) {
    if (beforeXml == null || afterXml == null) return [];
    const [before, after] = [beforeXml, afterXml].map((xml) => parseXml(xml).children[0]);
    const notes = [];
    const [nsBefore, nsAfter] = [namespaces(before), namespaces(after)];
    for (const [name, uri] of nsAfter) if (nsBefore.get(name) !== uri) notes.push(`${name}="${uri}" namespace declaration added`);
    for (const [name, uri] of nsBefore) if (!nsAfter.has(name)) notes.push(`${name}="${uri}" namespace declaration removed`);
    const fullName = (root) => root?.children.find((c) => c.name === 'fullName')?.text.trim();
    const [fnBefore, fnAfter] = [fullName(before), fullName(after)];
    if (fnBefore !== fnAfter) {
        if (fnBefore && !fnAfter) notes.push(`<fullName>${fnBefore}</fullName> line removed`);
        else if (!fnBefore) notes.push(`<fullName>${fnAfter}</fullName> line added`);
        else notes.push(`fullName changed: ${fnBefore} -> ${fnAfter}`);
    }
    return notes;
}

function readBlocks(xml) {
    if (xml == null) return [];
    const root = parseXml(xml).children[0];
    if (!root) return [];
    return root.children.filter((node) => !IGNORED.has(node.name)).map((node) => {
        const fields = new Map();
        for (const child of node.children) {
            const value = canonical(child);
            fields.set(child.name, fields.has(child.name) ? fields.get(child.name) + ', ' + value : value);
        }
        return { type: node.name, fields, canon: canonical(node) };
    });
}

function keyFieldNames(block) {
    if (block.type === 'layoutAssignments') return ['recordType'];
    return KEY_FIELDS[block.type] || [];
}

function blockKey(block, repeatedTypes) {
    if (block.type === 'layoutAssignments') {
        // A record type can have one layout per layout object, e.g. Case and CaseClose for Case.Support.
        const layoutObject = (block.fields.get('layout') || '').split('-')[0];
        const recordType = block.fields.get('recordType');
        return recordType ? `${layoutObject} layout for record type ${recordType}` : `${layoutObject} default layout`;
    }
    const names = KEY_FIELDS[block.type];
    if (names) {
        if (names.length === 1) return block.fields.get(names[0]) || '';
        return names.filter((n) => block.fields.has(n)).map((n) => n + '=' + block.fields.get(n)).join(', ');
    }
    // Elements that occur once (userLicense, custom, loginHours, description...) are identified by their tag.
    return repeatedTypes.has(block.type) ? block.canon : block.type;
}

function repeated(blocks, into) {
    const seen = new Set();
    for (const b of blocks) {
        if (seen.has(b.type)) into.add(b.type);
        seen.add(b.type);
    }
    return into;
}

function groupByKey(blocks) {
    const groups = new Map();
    for (const b of blocks) {
        const id = b.type + '\0' + b.key;
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(b);
    }
    return groups;
}

function fieldDiffs(before, after) {
    if (!before.fields.size && !after.fields.size) return [{ name: 'value', from: before.canon, to: after.canon }];
    const names = [...new Set([...after.fields.keys(), ...before.fields.keys()])];
    return names
        .filter((n) => before.fields.get(n) !== after.fields.get(n))
        .map((n) => ({ name: n, from: before.fields.get(n) ?? '(none)', to: after.fields.get(n) ?? '(none)' }));
}

function compareXml(beforeXml, afterXml) {
    // Broken XML would show as thousands of fake removals, so report the error instead of comparing.
    const errorIn = (xml) => (xml == null ? null : parseXml(xml).error);
    const invalid = { before: errorIn(beforeXml), after: errorIn(afterXml) };
    if (invalid.before || invalid.after) return { invalid, changes: [], duplicates: [], notes: [], beforeCount: 0, afterCount: 0 };
    const beforeBlocks = readBlocks(beforeXml);
    const afterBlocks = readBlocks(afterXml);
    const repeatedTypes = repeated(afterBlocks, repeated(beforeBlocks, new Set()));
    for (const b of beforeBlocks.concat(afterBlocks)) b.key = blockKey(b, repeatedTypes);

    const before = groupByKey(beforeBlocks);
    const after = groupByKey(afterBlocks);
    const changes = [];
    for (const [id, list] of after) {
        const block = list[0];
        const old = before.get(id);
        if (!old) changes.push({ kind: 'added', block });
        else if (!old.some((o) => o.canon === block.canon)) changes.push({ kind: 'changed', block, diffs: fieldDiffs(old[0], block) });
    }
    for (const [id, list] of before) {
        if (!after.has(id)) changes.push({ kind: 'removed', block: list[0] });
    }
    changes.sort((a, b) => a.block.type.localeCompare(b.block.type) || a.block.key.localeCompare(b.block.key));

    const duplicates = [];
    for (const [id, list] of after) {
        if (list.length < 2) continue;
        duplicates.push({
            block: list[0],
            count: list.length,
            identical: list.every((b) => b.canon === list[0].canon),
            existedBefore: (before.get(id) || []).length > 1
        });
    }
    for (const [id, list] of before) {
        if (list.length > 1 && (after.get(id) || []).length < 2) duplicates.push({ block: list[0], count: list.length, fixed: true });
    }

    return { changes, duplicates, notes: formattingNotes(beforeXml, afterXml), beforeCount: beforeBlocks.length, afterCount: afterBlocks.length };
}

// ---------- git ----------

function git(repo, args, input) {
    return execFileSync('git', args, {
        cwd: repo,
        encoding: 'utf8',
        input,
        maxBuffer: 1024 * 1024 * 1024,
        stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']
    });
}

function tryGit(repo, args) {
    try {
        return git(repo, args).trim();
    } catch {
        return null;
    }
}

function changedPermissionFiles(repo, parent, commit) {
    const parts = git(repo, ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-commit-id', parent, commit]).split('\0');
    const files = [];
    for (let i = 0; i < parts.length && parts[i]; ) {
        const status = parts[i++];
        const oldPath = parts[i++];
        const newPath = status[0] === 'R' || status[0] === 'C' ? parts[i++] : oldPath;
        if (PERMISSION_FILE.test(newPath) || PERMISSION_FILE.test(oldPath)) files.push({ status: status[0], oldPath, newPath });
    }
    return files;
}

function lineStat(repo, parent, commit, file) {
    const paths = file.oldPath === file.newPath ? [file.newPath] : [file.oldPath, file.newPath];
    const line = git(repo, ['diff', '--numstat', '-M', parent, commit, '--', ...paths]).split('\n')[0] || '';
    const [added, removed] = line.split('\t');
    return { added: added || '0', removed: removed || '0' };
}

// ---------- output ----------

let slackMode = false;
let useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const output = [];
const say = (line = '') => output.push(line);
const paint = (code) => (text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
const green = paint(32);
const red = paint(31);
const yellow = paint(33);
const magenta = paint(35);
const bold = paint(1);
const dim = paint(2);

const LABELS = {
    applicationVisibilities: 'App visibility',
    categoryGroupVisibilities: 'Data category',
    classAccesses: 'Apex class',
    custom: 'Custom profile',
    customMetadataTypeAccesses: 'Custom metadata',
    customPermissions: 'Custom permission',
    customSettingAccesses: 'Custom setting',
    description: 'Description',
    emailRoutingAddressAccesses: 'Email routing address',
    externalCredentialPrincipalAccesses: 'External credential',
    externalDataSourceAccesses: 'External data source',
    fieldPermissions: 'Field access',
    flowAccesses: 'Flow',
    hasActivationRequired: 'Session activation',
    label: 'Label',
    layoutAssignments: 'Page layout',
    license: 'License',
    loginHours: 'Login hours',
    loginIpRanges: 'Login IP range',
    objectPermissions: 'Object access',
    pageAccesses: 'Visualforce page',
    profileActionOverrides: 'Action override',
    recordTypeVisibilities: 'Record type',
    tabSettings: 'Tab',
    tabVisibilities: 'Tab',
    userLicense: 'User license',
    userPermissions: 'User permission'
};

const label = (type) => LABELS[type] || type;
const component = (block) => (block.key === block.type ? '' : block.key);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

function details(block) {
    const skip = new Set(keyFieldNames(block));
    if (!block.fields.size) return block.key === block.canon ? '' : block.canon;
    return [...block.fields].filter(([name]) => !skip.has(name)).map(([name, value]) => `${name}=${value}`).join(', ');
}

function wrap(text, width) {
    const lines = [];
    for (const paragraph of String(text).split('\n')) {
        let rest = paragraph;
        while (rest.length > width) {
            let cut = rest.lastIndexOf(' ', width);
            if (cut <= 0) cut = width;
            lines.push(rest.slice(0, cut).trimEnd());
            rest = rest.slice(cut).trimStart();
        }
        lines.push(rest);
    }
    return lines;
}

// columns: [{ title, max }]; rows: [{ cells: [text], colors: [fn], group }] -- a line is drawn where group changes.
function renderTable(columns, rows) {
    const longest = (text) => Math.max(...String(text).split('\n').map((l) => l.length));
    const widths = columns.map((c, i) => Math.min(c.wraps ? c.max || Infinity : Infinity, Math.max(c.title.length, ...rows.map((r) => longest(r.cells[i] ?? '')))));
    // Slack wraps code blocks at roughly 120 characters on a normal-width window.
    const limit = slackMode ? 120 : (process.stdout.columns || 200) - 1;
    const border = 3 * columns.length + 1;
    // Only columns holding sentences (Before/After) are narrowed; names like Account.Field__c can't wrap cleanly.
    const shrinkable = columns.map((c, i) => (c.wraps ? i : -1)).filter((i) => i >= 0);
    while (shrinkable.length && widths.reduce((a, b) => a + b, 0) + border > limit) {
        const i = shrinkable.reduce((best, j) => (widths[j] > widths[best] ? j : best), shrinkable[0]);
        if (widths[i] <= 14) break;
        widths[i]--;
    }

    // Slack's code font draws box-drawing characters at uneven widths, so use plain ASCII there.
    const box = slackMode
        ? { h: '-', v: '|', top: ['+', '+', '+'], mid: ['+', '+', '+'], bottom: ['+', '+', '+'] }
        : { h: '─', v: '│', top: ['┌', '┬', '┐'], mid: ['├', '┼', '┤'], bottom: ['└', '┴', '┘'] };
    const rule = ([left, mid, right]) => dim(left + widths.map((w) => box.h.repeat(w + 2)).join(mid) + right);
    const out = [rule(box.top)];
    const addRow = (cells, colors = []) => {
        const wrapped = cells.map((c, i) => wrap(c ?? '', columns[i].wraps ? widths[i] : Infinity));
        const height = Math.max(...wrapped.map((w) => w.length));
        for (let k = 0; k < height; k++) {
            const parts = wrapped.map((w, i) => ' ' + (colors[i] || String)((w[k] || '').padEnd(widths[i])) + ' ');
            out.push(dim(box.v) + parts.join(dim(box.v)) + dim(box.v));
        }
    };
    addRow(columns.map((c) => c.title), columns.map(() => bold));
    out.push(rule(box.mid));
    rows.forEach((r, i) => {
        if (i > 0 && r.group !== rows[i - 1].group) out.push(rule(box.mid));
        addRow(r.cells, r.colors);
    });
    out.push(rule(box.bottom));
    return out.join('\n');
}

const heading = bold;

function changeRows(changes) {
    const rows = [];
    for (const c of changes) {
        const group = c.block.type;
        const what = [label(c.block.type), component(c.block)];
        if (c.kind === 'added') {
            rows.push({ group, cells: ['+ Added', ...what, '', '', details(c.block)], colors: [green, null, null, null, null, green] });
        } else if (c.kind === 'removed') {
            rows.push({ group, cells: ['- Removed', ...what, '', details(c.block), ''], colors: [red, null, null, null, red, null] });
        } else {
            c.diffs.forEach((d, i) => {
                const lead = i === 0 ? ['~ Changed', ...what] : ['', '', ''];
                rows.push({ group, cells: [...lead, d.name === 'value' ? '' : d.name, d.from, d.to], colors: [yellow, null, null, null, red, green] });
            });
        }
    }
    return rows;
}

const CHANGE_COLUMNS = [
    { title: 'Change' },
    { title: 'Type' },
    { title: 'Component' },
    { title: 'Setting' },
    { title: 'Before', wraps: true, max: 40 },
    { title: 'After', wraps: true, max: 40 }
];

function countKinds(changes) {
    const counts = { added: 0, removed: 0, changed: 0 };
    for (const c of changes) counts[c.kind]++;
    return counts;
}

function printFile(file, stat, result) {
    say(heading(file.newPath) + (file.status === 'R' ? dim(`  (renamed from ${file.oldPath})`) : ''));
    const statText = dim(`git diff +${stat.added} -${stat.removed} lines`);
    if (result.invalid) {
        say(statText);
        if (result.invalid.after) say(red(bold(`! Not valid XML after this commit (${result.invalid.after}). This file will fail to deploy.`)));
        if (result.invalid.before) say(red(`! Not valid XML before this commit (${result.invalid.before}).`));
        say(dim('Real changes can\'t be worked out until the XML is fixed.'));
        say('');
        return;
    }
    if (file.status === 'A') say(`${statText}  ->  ${green('new file')} with ${result.afterCount} blocks`);
    else if (file.status === 'D') say(`${statText}  ->  ${red('file deleted')} (${result.beforeCount} blocks)`);
    else if (!result.changes.length) say(`${statText}  ->  ${green('no real changes (only re-ordered)')}`);
    else {
        const k = countKinds(result.changes);
        const parts = [k.added && green(`${k.added} added`), k.removed && red(`${k.removed} removed`), k.changed && yellow(`${k.changed} changed`)].filter(Boolean);
        say(`${statText}  ->  ${bold(plural(result.changes.length, 'real change'))} (${parts.join(', ')})`);
        say(renderTable(CHANGE_COLUMNS, changeRows(result.changes)));
    }

    const duplicates = result.duplicates.filter((d) => !d.fixed);
    const fixed = result.duplicates.filter((d) => d.fixed);
    if (duplicates.length) {
        say(magenta(`! ${plural(duplicates.length, 'duplicate block')} in this file (same component listed more than once)`));
        const rows = duplicates.map((d) => ({
            group: 0,
            cells: [label(d.block.type), component(d.block), String(d.count), d.identical ? 'identical' : 'DIFFERENT values', d.existedBefore ? 'before this commit' : 'this commit'],
            colors: [null, null, null, d.identical ? null : magenta, d.existedBefore ? dim : magenta]
        }));
        say(renderTable([{ title: 'Type' }, { title: 'Component' }, { title: 'Copies' }, { title: 'Values' }, { title: 'Introduced in' }], rows));
    }
    for (const d of fixed) say(dim(`Duplicate removed: ${label(d.block.type)} ${component(d.block)} (had ${d.count} copies)`));
    for (const note of result.notes) say(dim(`Formatting only, no effect on deploy: ${note}`));
    say('');
}

function copyToClipboard(text) {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    if (process.platform === 'win32') {
        // clip.exe garbles UTF-8 (box-drawing characters), so go through a UTF-8 file and PowerShell.
        const file = path.join(os.tmpdir(), `profile-diff-${process.pid}.txt`);
        fs.writeFileSync(file, text, 'utf8');
        try {
            execFileSync('powershell', ['-NoProfile', '-Command', `Get-Content -Raw -Encoding UTF8 -LiteralPath '${file}' | Set-Clipboard`], { stdio: 'ignore' });
        } finally {
            fs.unlinkSync(file);
        }
    } else if (process.platform === 'darwin') {
        execFileSync('pbcopy', [], { input: text });
    } else {
        execFileSync('xclip', ['-selection', 'clipboard'], { input: text });
    }
}


function main(argv) {
    const args = { repo: process.cwd() };
    const rest = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--repo') args.repo = argv[++i];
        else if (argv[i] === '--slack') args.slack = true;
        else if (argv[i] === '-h' || argv[i] === '--help') args.help = true;
        else rest.push(argv[i]);
    }
    if (args.help || rest.length !== 1) {
        console.log('Usage: node profile-diff.js <commit> [--repo <path to git repo>] [--slack]');
        console.log('Shows the real changes to profiles and permission sets in a commit, ignoring blocks that only moved.');
        console.log('--slack  formats the result for Slack (tables in code blocks) and copies it to the clipboard.');
        return args.help ? 0 : 1;
    }
    if (args.slack) {
        slackMode = true;
        useColor = false;
    }

    const commit = tryGit(args.repo, ['rev-parse', '--verify', '--quiet', rest[0] + '^{commit}']);
    if (!commit) {
        console.error(`Commit not found: ${rest[0]} (in ${args.repo}). Run "git fetch" if it was made on GitHub or in Copado.`);
        return 1;
    }
    const parent = tryGit(args.repo, ['rev-parse', '--verify', '--quiet', commit + '^1']) || git(args.repo, ['hash-object', '-t', 'tree', '--stdin'], '').trim();
    const subject = git(args.repo, ['log', '-1', '--format=%s', commit]).trim();
    const isMerge = !!tryGit(args.repo, ['rev-parse', '--verify', '--quiet', commit + '^2']);

    say(heading(`Commit ${commit.slice(0, 10)}`) + `  ${subject}`);
    say(dim(`Compared with ${isMerge ? 'first parent' : 'parent'} ${parent.slice(0, 10)}`));
    say('');

    const files = changedPermissionFiles(args.repo, parent, commit);
    if (!files.length) {
        say('No profile or permission set files changed in this commit.');
    } else {
        let total = 0;
        for (const file of files) {
            const before = file.status === 'A' ? null : git(args.repo, ['show', `${parent}:${file.oldPath}`]);
            const after = file.status === 'D' ? null : git(args.repo, ['show', `${commit}:${file.newPath}`]);
            const result = compareXml(before, after);
            if (file.status !== 'A' && file.status !== 'D') total += result.changes.length;
            printFile(file, lineStat(args.repo, parent, commit, file), result);
        }
        say(heading(`${plural(files.length, 'file')} checked, ${plural(total, 'real change')}.`));
    }

    const text = output.join('\n');
    console.log(text);
    if (args.slack) {
        copyToClipboard(text);
        // Slack only keeps columns aligned in a code block, and pasted ``` is not turned into one.
        console.log('\nCopied to the clipboard. To paste into Slack so the table stays aligned:');
        if (text.length > 40000) {
            console.log(`  It is ${text.length} characters (over Slack's 40000 limit for a message), so send it as a snippet:`);
            console.log('  Ctrl+Shift+Enter in the message box, paste with Ctrl+V, then Create Snippet.');
        } else {
            console.log('  1. Click the code block button (</>) in the message box, or press Ctrl+Alt+Shift+C.');
            console.log('  2. Paste with Ctrl+V and send.');
            console.log('  Or send it as a snippet: Ctrl+Shift+Enter, paste, Create Snippet.');
        }
    }
    return 0;
}

module.exports = { compareXml };

if (require.main === module) {
    try {
        process.exitCode = main(process.argv.slice(2));
    } catch (e) {
        console.error((e.stderr && e.stderr.toString()) || e.message);
        process.exitCode = 1;
    }
}
