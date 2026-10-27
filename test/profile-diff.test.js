'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { compareXml } = require('../profile-diff');

const profile = (body) => `<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n${body}\n</Profile>\n`;

const layout = (layoutName, recordType) =>
    `    <layoutAssignments>\n        <layout>${layoutName}</layout>\n${recordType ? `        <recordType>${recordType}</recordType>\n` : ''}    </layoutAssignments>`;

const field = (name, editable, readable) =>
    `    <fieldPermissions>\n        <editable>${editable}</editable>\n        <field>${name}</field>\n        <readable>${readable}</readable>\n    </fieldPermissions>`;

test('blocks that only moved are not changes', () => {
    const before = profile([layout('Booking__c-Booking Adjustment Layout', 'Booking__c.Booking_Adjustment'), layout('Booking__c-Booking Layout'), field('Account.A__c', false, true)].join('\n'));
    const after = profile([field('Account.A__c', false, true), layout('Booking__c-Booking Layout'), layout('Booking__c-Booking Adjustment Layout', 'Booking__c.Booking_Adjustment')].join('\n'));
    const result = compareXml(before, after);
    assert.strictEqual(result.changes.length, 0);
    assert.strictEqual(result.duplicates.length, 0);
});

test('added, removed and changed blocks are reported by what they control', () => {
    const before = profile([field('Account.A__c', false, true), field('Account.B__c', true, true), layout('Case-Case Layout', 'Case.Support'), '    <userLicense>Salesforce</userLicense>'].join('\n'));
    const after = profile(['    <userLicense>Salesforce Platform</userLicense>', layout('Case-Support Layout', 'Case.Support'), field('Account.C__c', true, true), field('Account.A__c', true, true)].join('\n'));
    const { changes } = compareXml(before, after);
    const summary = changes.map((c) => `${c.kind} ${c.block.type} ${c.block.key}`);
    assert.deepStrictEqual(summary, [
        'changed fieldPermissions Account.A__c',
        'removed fieldPermissions Account.B__c',
        'added fieldPermissions Account.C__c',
        'changed layoutAssignments Case layout for record type Case.Support',
        'changed userLicense userLicense'
    ]);
    const a = changes.find((c) => c.block.key === 'Account.A__c');
    assert.deepStrictEqual(a.diffs, [{ name: 'editable', from: 'false', to: 'true' }]);
    const rt = changes.find((c) => c.block.type === 'layoutAssignments');
    assert.deepStrictEqual(rt.diffs, [{ name: 'layout', from: 'Case-Case Layout', to: 'Case-Support Layout' }]);
});

test('whitespace and child order inside a block are ignored', () => {
    const before = profile(field('Account.A__c', false, true));
    const after = profile('<fieldPermissions><readable>true</readable><field>Account.A__c</field><editable>false</editable></fieldPermissions>');
    assert.strictEqual(compareXml(before, after).changes.length, 0);
});

test('nil elements are shown as (empty); fullName is ignored', () => {
    const before = `<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>Admin</fullName>\n${field('Account.A__c', false, true)}\n    <userLicense>Salesforce</userLicense>\n</Profile>`;
    const after = `<Profile xmlns="http://soap.sforce.com/2006/04/metadata" xmlns:n1="http://www.w3.org/2001/XMLSchema-instance">\n    <description n1:nil="true" />\n${field('Account.A__c', false, true)}\n    <loginHours n1:nil="true" />\n    <userLicense n1:nil="true" />\n</Profile>`;
    const { changes } = compareXml(before, after);
    assert.deepStrictEqual(changes.map((c) => `${c.kind} ${c.block.type} ${c.block.canon}`), [
        'added description (empty)',
        'added loginHours (empty)',
        'changed userLicense (empty)'
    ]);
    assert.deepStrictEqual(changes[2].diffs, [{ name: 'value', from: 'Salesforce', to: '(empty)' }]);
});

test('namespace and fullName lines are reported as formatting notes', () => {
    const before = `<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n    <fullName>Admin</fullName>\n${field('Account.A__c', false, true)}\n</Profile>`;
    const after = `<Profile xmlns="http://soap.sforce.com/2006/04/metadata"\n      xmlns:n1="http://www.w3.org/2001/XMLSchema-instance">\n${field('Account.A__c', false, true)}\n</Profile>`;
    const result = compareXml(before, after);
    assert.strictEqual(result.changes.length, 0);
    assert.deepStrictEqual(result.notes, [
        'xmlns:n1="http://www.w3.org/2001/XMLSchema-instance" namespace declaration added',
        '<fullName>Admin</fullName> line removed'
    ]);
    assert.deepStrictEqual(compareXml(before, before).notes, []);
});

test('broken XML is reported instead of compared', () => {
    const before = profile(field('Account.A__c', false, true));
    const after = before.replace('metadata">', 'metadata"');
    const result = compareXml(before, after);
    assert.strictEqual(result.changes.length, 0);
    assert.strictEqual(result.invalid.before, null);
    assert.strictEqual(result.invalid.after, 'line 2: <Profile> tag is missing its closing ">"');
    assert.strictEqual(compareXml(before, before).invalid, undefined);
});

test('duplicates are flagged', () => {
    const before = profile(field('Account.A__c', false, true));
    const after = profile(
        [
            field('Account.A__c', false, true),
            field('Account.A__c', false, true),
            layout('Case-Case Layout', 'Case.Support'),
            layout('Case-Other Layout', 'Case.Support'),
            layout('CaseClose-Close Case Layout', 'Case.Support')
        ].join('\n')
    );
    const { changes, duplicates } = compareXml(before, after);
    assert.deepStrictEqual(changes.map((c) => c.kind), ['added', 'added']);
    assert.deepStrictEqual(
        duplicates.map((d) => [d.block.key, d.count, d.identical, d.existedBefore]),
        [
            ['Account.A__c', 2, true, false],
            ['Case layout for record type Case.Support', 2, false, false]
        ]
    );
});
