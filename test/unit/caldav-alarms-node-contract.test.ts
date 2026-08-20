import { describe, expect, it } from 'vitest';

import {
	alarmCreateDescriptor,
	alarmMutationDescriptor,
	normalizeAlarmCreateParameter,
	normalizeAlarmMutationParameter,
} from '../../nodes/CalDav/CalDav.node';
import { CalDavCalendarAlarmError } from '../../nodes/CalDav/icalendar/alarms';

describe('CalDAV alarm n8n contract', () => {
	it('exposes repeatable create and mutation wrappers with dependent fields', () => {
		const create = alarmCreateDescriptor();
		const mutation = alarmMutationDescriptor();

		expect(create).toMatchObject({
			name: 'alarms',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			options: [{ name: 'alarm' }],
		});
		expect(mutation).toMatchObject({
			name: 'alarms',
			type: 'fixedCollection',
			typeOptions: { multipleValues: true },
			options: [{ name: 'change' }],
		});

		const mutationNames = mutation.options?.[0]?.values?.map(({ name }) => name);
		expect(mutationNames).toEqual([
			'kind',
			'selectorKind',
			'alarmUid',
			'position',
			'fingerprint',
			'action',
			'reference',
			'direction',
			'value',
			'unit',
			'description',
			'subject',
			'body',
			'recipients',
			'fields',
		]);
	});

	it('normalizes mixed create rows and defaults an omitted DISPLAY description from Summary', () => {
		expect(
			normalizeAlarmCreateParameter(
				{
					alarm: [
						{
							action: 'display',
							reference: 'start',
							direction: 'before',
							value: 15,
							unit: 'minute',
							description: '',
						},
						{ action: 'audio', reference: 'end', direction: 'at' },
						{
							action: 'email',
							reference: 'start',
							direction: 'after',
							value: 1,
							unit: 'hour',
							subject: 'Subject',
							body: 'Body',
							recipients: {
								recipient: [
									{ value: 'mailto:One@Example.test' },
									{ value: 'mailto:two@example.test' },
								],
							},
						},
					],
				},
				'Final summary',
			),
		).toEqual([
			{
				action: 'display',
				trigger: { reference: 'start', direction: 'before', value: 15, unit: 'minute' },
				description: 'Final summary',
			},
			{ action: 'audio', trigger: { reference: 'end', direction: 'at' } },
			{
				action: 'email',
				trigger: { reference: 'start', direction: 'after', value: 1, unit: 'hour' },
				subject: 'Subject',
				body: 'Body',
				recipients: ['mailto:One@Example.test', 'mailto:two@example.test'],
			},
		]);
	});

	it('normalizes Add, Edit and Remove rows without leaking workflow wrappers', () => {
		expect(
			normalizeAlarmMutationParameter({
				change: [
					{
						kind: 'add',
						action: 'audio',
						reference: 'start',
						direction: 'before',
						value: 5,
						unit: 'minute',
					},
					{
						kind: 'edit',
						selectorKind: 'uid',
						alarmUid: 'alarm-1',
						action: 'display',
						fields: {
							description: 'Changed',
							trigger: {
								change: [{ reference: 'end', direction: 'at' }],
							},
						},
					},
					{
						kind: 'remove',
						selectorKind: 'legacy',
						position: 2,
						fingerprint: 'a'.repeat(64),
					},
				],
			}),
		).toEqual([
			{
				kind: 'add',
				alarm: {
					action: 'audio',
					trigger: { reference: 'start', direction: 'before', value: 5, unit: 'minute' },
				},
			},
			{
				kind: 'edit',
				selector: { kind: 'uid', uid: 'alarm-1' },
				alarm: {
					action: 'display',
					trigger: { reference: 'end', direction: 'at' },
					description: 'Changed',
				},
			},
			{
				kind: 'remove',
				selector: { kind: 'legacy', position: 2, fingerprint: 'a'.repeat(64) },
			},
		]);
	});

	it('rejects malformed wrappers, unknown fields and missing selectors with fixed errors', () => {
		for (const invoke of [
			() => normalizeAlarmCreateParameter({ alarm: [], extra: true }, 'Summary'),
			() =>
				normalizeAlarmMutationParameter({
					change: [{ kind: 'remove', selectorKind: 'uid', alarmUid: '' }],
				}),
		]) {
			expect(invoke).toThrow(CalDavCalendarAlarmError);
		}
	});
});
