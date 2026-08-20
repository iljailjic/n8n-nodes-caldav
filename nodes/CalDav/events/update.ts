/* eslint-disable @n8n/community-nodes/require-node-api-error -- The accepted application-service contract exposes sanitized domain failures outside the n8n UI boundary. */

import { randomUUID } from 'node:crypto';

import {
	CalDavCalendarEventResourceGetError,
	CalendarEventResourceGetFailureCode,
	getCalendarEventByResourceUrl,
} from './getByResourceUrl';
import {
	CalDavCalendarEventMutationError,
	CalendarEventMutationFailureCode,
	updateCalendarEventResource,
} from './mutations';
import {
	CalDavCalendarEventUidResolutionError,
	CalendarEventUidResolutionFailureCode,
	resolveCalendarEventByUid,
} from './resolveByUid';
import type { CalendarEventReadResult, CalendarEventWithRawIcs } from '../icalendar/eventReadModel';
import type { CalendarEventTimeZoneExecutionContext } from '../discovery/timeZoneReferences';
import type {
	ICalendarComponent,
	ICalendarEntry,
	ICalendarParameter,
	ICalendarProperty,
	ICalendarResource,
	ICalendarValue,
} from '../icalendar/parser';
import {
	applyCalendarEventPatch,
	CalDavCalendarEventPatchError,
	CalendarEventPatchErrorCode,
} from '../icalendar/patcher';
import type { CalendarEventPatch } from '../icalendar/patcher';
import { serializeICalendarResource } from '../icalendar/serializer';
import type { CalendarEventInstantProjector } from '../icalendar/serializer';
import { CalDavCalendarAlarmError, CalendarAlarmErrorCode } from '../icalendar/alarms';
import type { CalendarAlarmUidGenerator } from '../icalendar/alarms';
import {
	assertVTimeZoneCovers,
	canonicalizeIanaTimeZone,
	projectInstantInTimeZone,
} from '../icalendar/timeZones';
import { CalDavTransportError, CalDavTransportErrorCode } from '../transport/http';
import type { CalDavTransport } from '../transport/http';
import { normalizeCalendarCollectionUrl, validateAbsoluteHttpUrl } from '../transport/url';
import type { AbsoluteHttpUrl } from '../transport/url';
import {
	CalDavCalendarEventTimeZoneAuthoringError,
	resolveCalendarEventTimeZoneAuthoring,
} from './timeZoneAuthoring';

export type CalendarEventUpdateIdentifier =
	| { readonly kind: 'resourceUrl'; readonly resourceUrl: AbsoluteHttpUrl }
	| { readonly kind: 'uid'; readonly uid: string };

export interface CalendarEventUpdateInput {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly identifier: CalendarEventUpdateIdentifier;
	readonly patch: CalendarEventPatch;
	readonly etag?: string;
}

export type CalendarEventUpdateClock = () => Date;

export type UpdatedCalendarEvent = CalendarEventWithRawIcs & {
	readonly etag: string;
};

export const CalendarEventUpdateFailureCode = Object.freeze({
	INVALID_INPUT: 'INVALID_INPUT',
	INVALID_CLOCK: 'INVALID_CLOCK',
	READ_ONLY: 'READ_ONLY',
	CONFIRMATION_FAILED: 'CONFIRMATION_FAILED',
} as const);

export type CalendarEventUpdateFailureCode =
	(typeof CalendarEventUpdateFailureCode)[keyof typeof CalendarEventUpdateFailureCode];

const ERROR_MESSAGES: Readonly<Record<CalendarEventUpdateFailureCode, string>> = {
	INVALID_INPUT: 'The calendar event update input is invalid.',
	INVALID_CLOCK: 'The calendar event clock is invalid.',
	READ_ONLY: 'The calendar event is read-only because its time representation is unsupported.',
	CONFIRMATION_FAILED: 'The event was updated, but its current state could not be verified.',
};

export class CalDavCalendarEventUpdateError extends Error {
	readonly code: CalendarEventUpdateFailureCode;
	readonly statusCode?: number;

	constructor(code: CalendarEventUpdateFailureCode, statusCode?: number) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavCalendarEventUpdateError';
		this.code = code;
		if (
			code === CalendarEventUpdateFailureCode.CONFIRMATION_FAILED &&
			Number.isInteger(statusCode) &&
			(statusCode as number) >= 100 &&
			(statusCode as number) <= 599
		) {
			this.statusCode = statusCode;
		}
	}
}

function invalidInput(): never {
	throw new CalDavCalendarEventUpdateError(CalendarEventUpdateFailureCode.INVALID_INPUT);
}

function snapshotInput(input: CalendarEventUpdateInput): CalendarEventUpdateInput {
	try {
		if (typeof input !== 'object' || input === null || Array.isArray(input)) return invalidInput();
		const calendarUrl = input.calendarUrl;
		const identifier = input.identifier;
		const patch = input.patch;
		const etag = input.etag;
		if (
			typeof calendarUrl !== 'string' ||
			typeof identifier !== 'object' ||
			identifier === null ||
			Array.isArray(identifier) ||
			typeof patch !== 'object' ||
			patch === null ||
			Array.isArray(patch) ||
			(etag !== undefined && typeof etag !== 'string')
		) {
			return invalidInput();
		}
		if (Reflect.ownKeys(patch).length === 0) {
			throw new CalDavCalendarEventPatchError(CalendarEventPatchErrorCode.NO_CHANGES);
		}
		if (identifier.kind === 'resourceUrl') {
			if (typeof identifier.resourceUrl !== 'string') return invalidInput();
			return {
				calendarUrl,
				identifier: { kind: 'resourceUrl', resourceUrl: identifier.resourceUrl },
				patch,
				...(etag === undefined ? {} : { etag }),
			};
		}
		if (identifier.kind === 'uid') {
			if (typeof identifier.uid !== 'string') return invalidInput();
			return {
				calendarUrl,
				identifier: { kind: 'uid', uid: identifier.uid },
				patch,
				...(etag === undefined ? {} : { etag }),
			};
		}
		return invalidInput();
	} catch (error) {
		if (error instanceof CalDavCalendarEventPatchError) throw error;
		return invalidInput();
	}
}

function isDirectCalendarChild(
	calendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
): boolean {
	try {
		const calendar = new URL(normalizeCalendarCollectionUrl(calendarUrl));
		const resource = new URL(validateAbsoluteHttpUrl(resourceUrl));
		if (calendar.origin !== resource.origin || !resource.pathname.startsWith(calendar.pathname)) {
			return false;
		}
		const child = resource.pathname.slice(calendar.pathname.length);
		return child.length > 0 && !child.endsWith('/') && !child.includes('/');
	} catch {
		return false;
	}
}

function assertSnapshotResourceUrl(
	identifier: CalendarEventUpdateIdentifier,
	selectedCalendarUrl: AbsoluteHttpUrl,
	snapshotCalendarUrl: AbsoluteHttpUrl,
	resourceUrl: AbsoluteHttpUrl,
	uid: string,
): void {
	let selected: AbsoluteHttpUrl | undefined;
	let snapshot: AbsoluteHttpUrl | undefined;
	try {
		selected = normalizeCalendarCollectionUrl(selectedCalendarUrl);
		snapshot = normalizeCalendarCollectionUrl(snapshotCalendarUrl);
	} catch {
		// The resolver-specific invalid-response type below remains authoritative.
	}
	if (
		selected !== undefined &&
		selected === snapshot &&
		isDirectCalendarChild(selected, resourceUrl) &&
		(identifier.kind !== 'uid' || identifier.uid === uid)
	) {
		return;
	}
	if (identifier.kind === 'resourceUrl') {
		throw new CalDavCalendarEventResourceGetError(
			CalendarEventResourceGetFailureCode.INVALID_RESPONSE,
		);
	}
	throw new CalDavCalendarEventUidResolutionError(
		CalendarEventUidResolutionFailureCode.INVALID_RESPONSE,
	);
}

export function assertResolvedCalendarEventUidIdentity(
	selectedCalendarUrl: AbsoluteHttpUrl,
	expectedUid: string,
	current: CalendarEventReadResult,
): void {
	assertSnapshotResourceUrl(
		{ kind: 'uid', uid: expectedUid },
		selectedCalendarUrl,
		current.event.calendarUrl,
		current.event.resourceUrl,
		current.event.uid,
	);
}

function updateClockValue(clock: CalendarEventUpdateClock): Date {
	try {
		const value = clock();
		if (!(value instanceof Date)) return new Date(Number.NaN);
		const timestamp = Date.prototype.getTime.call(value);
		if (!Number.isFinite(timestamp)) return new Date(Number.NaN);
		const copy = new Date(Math.floor(timestamp / 1000) * 1000);
		const year = copy.getUTCFullYear();
		return year >= 1 && year <= 9999 ? copy : new Date(Number.NaN);
	} catch {
		return new Date(Number.NaN);
	}
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameParameterValue(
	left: ICalendarParameter['values'][number],
	right: ICalendarParameter['values'][number],
): boolean {
	return left.kind === right.kind && left.value === right.value;
}

function sameParameter(left: ICalendarParameter, right: ICalendarParameter): boolean {
	return (
		left.kind === right.kind &&
		left.name === right.name &&
		left.values.length === right.values.length &&
		left.values.every((value, index) => sameParameterValue(value, right.values[index]!))
	);
}

function sameValue(left: ICalendarValue, right: ICalendarValue): boolean {
	if (left.kind !== right.kind || left.valueType !== right.valueType) return false;
	if (left.textValues === null || right.textValues === null) {
		return left.textValues === null && right.textValues === null && left.raw === right.raw;
	}
	return sameStrings(left.textValues, right.textValues);
}

function sameProperty(left: ICalendarProperty, right: ICalendarProperty): boolean {
	return (
		left.kind === right.kind &&
		left.name === right.name &&
		left.parameters.length === right.parameters.length &&
		left.parameters.every((parameter, index) =>
			sameParameter(parameter, right.parameters[index]!),
		) &&
		sameValue(left.value, right.value)
	);
}

function sameEntry(left: ICalendarEntry, right: ICalendarEntry): boolean {
	if (left.kind !== right.kind) return false;
	return left.kind === 'property'
		? sameProperty(left, right as ICalendarProperty)
		: sameComponent(left, right as ICalendarComponent);
}

function componentEntryOrderIsInsignificant(component: ICalendarComponent): boolean {
	return ['VTIMEZONE', 'STANDARD', 'DAYLIGHT', 'VALARM'].includes(component.name.toUpperCase());
}

function semanticKey(parts: readonly string[]): string {
	return parts.map((part) => `${part.length}:${part}`).join('');
}

function semanticEntryKey(entry: ICalendarEntry): string {
	if (entry.kind === 'property') {
		return semanticKey([
			entry.kind,
			entry.name,
			...entry.parameters.map((parameter) =>
				semanticKey([
					parameter.kind,
					parameter.name,
					...parameter.values.map(({ value }) => value),
				]),
			),
			entry.value.kind,
			entry.value.valueType,
			entry.value.textValues === null
				? semanticKey(['raw', entry.value.raw])
				: semanticKey(['text', ...entry.value.textValues]),
		]);
	}
	const entryKeys = entry.entries.map(semanticEntryKey);
	if (componentEntryOrderIsInsignificant(entry)) entryKeys.sort();
	return semanticKey([entry.kind, entry.name, ...entryKeys]);
}

function sameUnorderedEntries(
	left: readonly ICalendarEntry[],
	right: readonly ICalendarEntry[],
): boolean {
	if (left.length !== right.length) return false;
	const leftKeys = left.map(semanticEntryKey).sort();
	const rightKeys = right.map(semanticEntryKey).sort();
	return sameStrings(leftKeys, rightKeys);
}

function sameComponent(left: ICalendarComponent, right: ICalendarComponent): boolean {
	return (
		left.kind === right.kind &&
		left.name === right.name &&
		left.entries.length === right.entries.length &&
		(componentEntryOrderIsInsignificant(left)
			? sameUnorderedEntries(left.entries, right.entries)
			: left.entries.every((entry, index) => sameEntry(entry, right.entries[index]!)))
	);
}

function semanticallyEquivalent(left: ICalendarResource, right: ICalendarResource): boolean {
	return left.kind === right.kind && sameComponent(left.calendar, right.calendar);
}

const RELOCATABLE_METADATA_NAMES = new Set(['CATEGORIES', 'STATUS', 'TRANSP']);

function sameComponentAllowingMetadataPlacement(
	left: ICalendarComponent,
	right: ICalendarComponent,
): boolean {
	if (left.kind !== right.kind || left.name !== right.name) return false;
	if (componentEntryOrderIsInsignificant(left)) return sameComponent(left, right);
	if (left.name.toUpperCase() !== 'VEVENT') {
		return (
			left.entries.length === right.entries.length &&
			left.entries.every((entry, index) => {
				const candidate = right.entries[index]!;
				return entry.kind === 'component' && candidate.kind === 'component'
					? sameComponentAllowingMetadataPlacement(entry, candidate)
					: sameEntry(entry, candidate);
			})
		);
	}

	const metadata = (component: ICalendarComponent, name: string): readonly ICalendarProperty[] =>
		component.entries.filter(
			(entry): entry is ICalendarProperty =>
				entry.kind === 'property' && entry.name.toUpperCase() === name,
		);
	for (const name of RELOCATABLE_METADATA_NAMES) {
		const leftProperties = metadata(left, name);
		const rightProperties = metadata(right, name);
		if (
			leftProperties.length !== rightProperties.length ||
			!leftProperties.every((property, index) => sameProperty(property, rightProperties[index]!))
		) {
			return false;
		}
	}

	const withoutMetadata = (component: ICalendarComponent): readonly ICalendarEntry[] =>
		component.entries.filter(
			(entry) =>
				entry.kind !== 'property' || !RELOCATABLE_METADATA_NAMES.has(entry.name.toUpperCase()),
		);
	const leftEntries = withoutMetadata(left);
	const rightEntries = withoutMetadata(right);
	return (
		leftEntries.length === rightEntries.length &&
		leftEntries.every((entry, index) => {
			const candidate = rightEntries[index]!;
			return entry.kind === 'component' && candidate.kind === 'component'
				? sameComponentAllowingMetadataPlacement(entry, candidate)
				: sameEntry(entry, candidate);
		})
	);
}

function semanticallyEquivalentAllowingMetadataPlacement(
	left: ICalendarResource,
	right: ICalendarResource,
): boolean {
	return (
		left.kind === right.kind &&
		sameComponentAllowingMetadataPlacement(left.calendar, right.calendar)
	);
}

function sameComponentIgnoringRevisionMetadata(
	left: ICalendarComponent,
	right: ICalendarComponent,
): boolean {
	if (left.kind !== right.kind || left.name !== right.name) return false;
	if (componentEntryOrderIsInsignificant(left)) return sameComponent(left, right);
	const withoutRevision = (component: ICalendarComponent): readonly ICalendarEntry[] =>
		component.entries.filter(
			(entry) =>
				component.name.toUpperCase() !== 'VEVENT' ||
				entry.kind !== 'property' ||
				!['DTSTAMP', 'LAST-MODIFIED'].includes(entry.name.toUpperCase()),
		);
	const leftEntries = withoutRevision(left);
	const rightEntries = withoutRevision(right);
	return (
		leftEntries.length === rightEntries.length &&
		leftEntries.every((entry, index) => {
			const candidate = rightEntries[index]!;
			return entry.kind === 'component' && candidate.kind === 'component'
				? sameComponentIgnoringRevisionMetadata(entry, candidate)
				: sameEntry(entry, candidate);
		})
	);
}

function semanticallyEquivalentIgnoringRevisionMetadata(
	left: ICalendarResource,
	right: ICalendarResource,
): boolean {
	return (
		left.kind === right.kind && sameComponentIgnoringRevisionMetadata(left.calendar, right.calendar)
	);
}

function safeStatusCode(error: unknown): number | undefined {
	return error instanceof CalDavTransportError ? error.statusCode : undefined;
}

function confirmationFailed(error?: unknown): never {
	throw new CalDavCalendarEventUpdateError(
		CalendarEventUpdateFailureCode.CONFIRMATION_FAILED,
		safeStatusCode(error),
	);
}

function isPostPutMetadataFailure(error: unknown): boolean {
	if (error instanceof CalDavCalendarEventMutationError) {
		return (
			error.code === CalendarEventMutationFailureCode.OUTSIDE_CALENDAR ||
			error.code === CalendarEventMutationFailureCode.INVALID_LOCATION ||
			error.code === CalendarEventMutationFailureCode.INVALID_RESPONSE
		);
	}
	return (
		error instanceof CalDavTransportError &&
		(error.statusCode === 200 ||
			error.statusCode === 204 ||
			error.code === CalDavTransportErrorCode.RESPONSE_LIMIT_EXCEEDED)
	);
}

function directProperties(
	component: ICalendarComponent,
	name: string,
): readonly ICalendarProperty[] {
	const expected = name.toUpperCase();
	return component.entries.filter(
		(entry): entry is ICalendarProperty =>
			entry.kind === 'property' && entry.name.toUpperCase() === expected,
	);
}

function sourceTimeZoneId(master: ICalendarComponent): string | undefined {
	const starts = directProperties(master, 'DTSTART');
	const ends = directProperties(master, 'DTEND');
	if (starts.length !== 1 || ends.length !== 1) return undefined;
	const value = (property: ICalendarProperty): string | undefined => {
		const parameters = property.parameters.filter(
			(parameter) => parameter.name.toUpperCase() === 'TZID',
		);
		return parameters.length === 1 && parameters[0]!.values.length === 1
			? parameters[0]!.values[0]!.value
			: undefined;
	};
	const start = value(starts[0]!);
	const end = value(ends[0]!);
	return start !== undefined && start === end ? start : undefined;
}

function embeddedTimeZoneDefinition(
	resource: ICalendarResource,
	timeZoneId: string,
): ICalendarComponent | undefined {
	const matches = resource.calendar.entries.filter((entry): entry is ICalendarComponent => {
		if (entry.kind !== 'component' || entry.name.toUpperCase() !== 'VTIMEZONE') return false;
		const identifiers = directProperties(entry, 'TZID');
		return (
			identifiers.length === 1 &&
			identifiers[0]!.value.textValues?.length === 1 &&
			identifiers[0]!.value.textValues[0] === timeZoneId
		);
	});
	return matches.length === 1 ? matches[0] : undefined;
}

type RetainedTimeZoneOwnership = 'clear' | 'referenced' | 'unsafe';

function propertyTargetOwnership(
	property: ICalendarProperty,
	timeZone: string,
): RetainedTimeZoneOwnership {
	const parameters = property.parameters.filter(
		(parameter) => parameter.name.toUpperCase() === 'TZID',
	);
	if (parameters.length === 0) return 'clear';
	if (parameters.length !== 1 || parameters[0]!.values.length !== 1) return 'unsafe';
	try {
		return canonicalizeIanaTimeZone(parameters[0]!.values[0]!.value) === timeZone
			? 'referenced'
			: 'clear';
	} catch {
		return 'unsafe';
	}
}

function retainedTargetOwnership(
	resource: ICalendarResource,
	master: ICalendarComponent,
	definition: ICalendarComponent,
	timeZone: string,
): RetainedTimeZoneOwnership {
	const inspect = (
		component: ICalendarComponent,
		skipMasterBounds: boolean,
	): RetainedTimeZoneOwnership => {
		let result: RetainedTimeZoneOwnership = 'clear';
		for (const entry of component.entries) {
			if (
				skipMasterBounds &&
				entry.kind === 'property' &&
				['DTSTART', 'DTEND'].includes(entry.name.toUpperCase())
			) {
				continue;
			}
			const ownership =
				entry.kind === 'property'
					? propertyTargetOwnership(entry, timeZone)
					: inspect(entry, false);
			if (ownership === 'unsafe') return ownership;
			if (ownership === 'referenced') result = ownership;
		}
		return result;
	};

	let result: RetainedTimeZoneOwnership = 'clear';
	for (const entry of resource.calendar.entries) {
		if (entry === definition) continue;
		const ownership =
			entry.kind === 'property'
				? propertyTargetOwnership(entry, timeZone)
				: inspect(entry, entry === master);
		if (ownership === 'unsafe') return ownership;
		if (ownership === 'referenced') result = ownership;
	}
	return result;
}

async function updateCalendarEventInternal(
	transport: CalDavTransport,
	input: CalendarEventUpdateInput,
	clock: CalendarEventUpdateClock,
	timeZoneContext?: CalendarEventTimeZoneExecutionContext,
	resolvedCurrent?: CalendarEventReadResult,
	alarmUidFactory: CalendarAlarmUidGenerator = randomUUID,
): Promise<UpdatedCalendarEvent> {
	const snapshot = snapshotInput(input);
	const current =
		resolvedCurrent ??
		(snapshot.identifier.kind === 'resourceUrl'
			? await getCalendarEventByResourceUrl(
					transport,
					snapshot.calendarUrl,
					snapshot.identifier.resourceUrl,
					{
						allowMissingEtag: true,
						...(timeZoneContext === undefined ? {} : { timeZoneContext }),
					},
				)
			: await resolveCalendarEventByUid(transport, snapshot.calendarUrl, snapshot.identifier.uid, {
					allowMissingEtag: true,
					timeZoneContext,
				}));
	if (snapshot.identifier.kind === 'uid') {
		assertResolvedCalendarEventUidIdentity(snapshot.calendarUrl, snapshot.identifier.uid, current);
	} else {
		assertSnapshotResourceUrl(
			snapshot.identifier,
			snapshot.calendarUrl,
			current.event.calendarUrl,
			current.event.resourceUrl,
			current.event.uid,
		);
	}
	if (current.event.accessMode === 'readOnly') {
		throw new CalDavCalendarEventUpdateError(CalendarEventUpdateFailureCode.READ_ONLY);
	}
	const timedCurrent = current.event.timeMode === 'timed' ? current.event : undefined;
	const patchTimeMode = snapshot.patch.timeMode ?? current.event.timeMode;
	const requestedTimeZone =
		patchTimeMode === 'timed' && 'timeZone' in snapshot.patch
			? snapshot.patch.timeZone?.value
			: undefined;
	const requestedStart = 'start' in snapshot.patch ? snapshot.patch.start : undefined;
	const requestedEnd = 'end' in snapshot.patch ? snapshot.patch.end : undefined;
	const hasTimePatch =
		patchTimeMode === 'timed' && (requestedStart !== undefined || requestedEnd !== undefined);
	const currentIanaTimeZone =
		timedCurrent?.timeZoneMode === 'iana' && timedCurrent.timeZone !== undefined
			? timedCurrent.timeZone
			: undefined;
	const implicitCurrentTimeZone =
		requestedTimeZone === undefined && hasTimePatch && currentIanaTimeZone !== undefined
			? ({ timeZoneMode: 'iana', timeZone: currentIanaTimeZone } as const)
			: undefined;
	const effectiveTimeZone = requestedTimeZone ?? implicitCurrentTimeZone;
	const originalTimeZoneId =
		currentIanaTimeZone !== undefined ? sourceTimeZoneId(current.context.master) : undefined;
	const embeddedDefinition =
		currentIanaTimeZone !== undefined && originalTimeZoneId !== undefined
			? embeddedTimeZoneDefinition(current.context.resource, originalTimeZoneId)
			: undefined;
	let projectInstant: CalendarEventInstantProjector | undefined;
	let authoredTimeZoneDefinition: ICalendarComponent | undefined;
	let removedTimeZoneDefinition: ICalendarComponent | undefined;
	let renderedAuthoredTimeZone: string | undefined;
	if (effectiveTimeZone?.timeZoneMode === 'iana') {
		if (timedCurrent === undefined) {
			throw new CalDavCalendarEventPatchError(
				CalendarEventPatchErrorCode.UNSUPPORTED_TIME,
				'timeZone',
			);
		}
		const interval = {
			start: requestedStart?.value ?? new Date(timedCurrent.start),
			end: requestedEnd?.value ?? new Date(timedCurrent.end),
		};
		const canUseEmbedded =
			embeddedDefinition !== undefined &&
			currentIanaTimeZone !== undefined &&
			effectiveTimeZone.timeZone === currentIanaTimeZone &&
			(requestedTimeZone === undefined || originalTimeZoneId === effectiveTimeZone.timeZone);
		if (canUseEmbedded) {
			const definition = embeddedDefinition;
			try {
				assertVTimeZoneCovers(definition, effectiveTimeZone.timeZone, interval);
			} catch {
				throw new CalDavCalendarEventTimeZoneAuthoringError('UNREPRESENTABLE_TIME_ZONE');
			}
			projectInstant = (instant, selectedTimeZone) =>
				projectInstantInTimeZone(instant, selectedTimeZone, definition);
		} else {
			const reusableDefinitions = current.context.resource.calendar.entries.filter(
				(entry): entry is ICalendarComponent => {
					if (entry.kind !== 'component' || entry.name.toUpperCase() !== 'VTIMEZONE') {
						return false;
					}
					const identifiers = directProperties(entry, 'TZID');
					if (identifiers.length !== 1 || identifiers[0]!.value.textValues?.length !== 1) {
						return false;
					}
					try {
						return (
							canonicalizeIanaTimeZone(identifiers[0]!.value.textValues[0]!) ===
							effectiveTimeZone.timeZone
						);
					} catch {
						return false;
					}
				},
			);
			if (reusableDefinitions.length > 1) {
				throw new CalDavCalendarEventTimeZoneAuthoringError('UNREPRESENTABLE_TIME_ZONE');
			}
			if (reusableDefinitions[0] !== undefined) {
				try {
					assertVTimeZoneCovers(reusableDefinitions[0], effectiveTimeZone.timeZone, interval);
				} catch {
					throw new CalDavCalendarEventTimeZoneAuthoringError('UNREPRESENTABLE_TIME_ZONE');
				}
			}
			const authoringInput = {
				calendarUrl: snapshot.calendarUrl,
				timeZone: effectiveTimeZone.timeZone,
				coverage: { kind: 'finite' as const, interval },
				...(timeZoneContext === undefined ? {} : { referenceContext: timeZoneContext }),
				...(reusableDefinitions[0] === undefined
					? {}
					: { reusableDefinition: reusableDefinitions[0] }),
			};
			const selection = await resolveCalendarEventTimeZoneAuthoring(authoringInput);
			const definition = selection.definition;
			if (selection.embed) {
				authoredTimeZoneDefinition = definition;
				if (definition === reusableDefinitions[0]) {
					renderedAuthoredTimeZone = directProperties(definition, 'TZID')[0]!.value.textValues![0];
				}
			} else if (reusableDefinitions[0] !== undefined) {
				if (
					retainedTargetOwnership(
						current.context.resource,
						current.context.master,
						reusableDefinitions[0],
						effectiveTimeZone.timeZone,
					) !== 'clear'
				) {
					throw new CalDavCalendarEventTimeZoneAuthoringError('UNREPRESENTABLE_TIME_ZONE');
				}
				removedTimeZoneDefinition = reusableDefinitions[0];
			}
			projectInstant = (instant, selectedTimeZone) =>
				projectInstantInTimeZone(instant, selectedTimeZone, definition);
		}
	}
	if (implicitCurrentTimeZone !== undefined && originalTimeZoneId === undefined) {
		throw new CalDavCalendarEventPatchError(
			CalendarEventPatchErrorCode.UNSUPPORTED_TIME,
			'timeZone',
		);
	}

	const etag =
		snapshot.etag !== undefined && snapshot.etag.length > 0 ? snapshot.etag : current.event.etag;
	if (etag === undefined) {
		throw new CalDavCalendarEventMutationError(CalendarEventMutationFailureCode.MISSING_ETAG);
	}

	const zoneChanges =
		requestedTimeZone !== undefined &&
		timedCurrent !== undefined &&
		(requestedTimeZone.timeZoneMode !== timedCurrent.timeZoneMode ||
			(requestedTimeZone.timeZoneMode === 'iana' &&
				(requestedTimeZone.timeZone !== timedCurrent.timeZone ||
					originalTimeZoneId !== requestedTimeZone.timeZone)));
	const needsAtomicBounds = zoneChanges || (effectiveTimeZone !== undefined && hasTimePatch);
	const effectivePatch: CalendarEventPatch = needsAtomicBounds
		? {
				...snapshot.patch,
				timeMode: 'timed',
				...(!('timeZone' in snapshot.patch) && implicitCurrentTimeZone !== undefined
					? { timeZone: { kind: 'set' as const, value: implicitCurrentTimeZone } }
					: {}),
				...(patchTimeMode === 'timed' && requestedStart === undefined
					? { start: { kind: 'set' as const, value: new Date(timedCurrent!.start) } }
					: {}),
				...(patchTimeMode === 'timed' && requestedEnd === undefined
					? { end: { kind: 'set' as const, value: new Date(timedCurrent!.end) } }
					: {}),
			}
		: (snapshot.patch as CalendarEventPatch);
	const applyPatch = (modifiedAt: Date): ICalendarResource =>
		applyCalendarEventPatch(
			current.context,
			effectivePatch,
			modifiedAt,
			projectInstant,
			implicitCurrentTimeZone === undefined ? renderedAuthoredTimeZone : originalTimeZoneId,
			authoredTimeZoneDefinition,
			removedTimeZoneDefinition,
			alarmUidFactory,
		);
	let patchedResource: ICalendarResource;
	try {
		// Resolved-resource Upsert probes for a semantic no-op before reading the mutation clock.
		// The public Update path retains its established single clock read before patching.
		const probeTime =
			resolvedCurrent === undefined ? updateClockValue(clock) : new Date('2040-01-01T00:00:00Z');
		applyPatch(probeTime);
		patchedResource =
			resolvedCurrent === undefined ? applyPatch(probeTime) : applyPatch(updateClockValue(clock));
	} catch (error) {
		if (
			error instanceof CalDavCalendarEventPatchError &&
			error.code === CalendarEventPatchErrorCode.INVALID_DATE &&
			error.field === undefined
		) {
			throw new CalDavCalendarEventUpdateError(CalendarEventUpdateFailureCode.INVALID_CLOCK);
		}
		throw error;
	}
	const calendarData = serializeICalendarResource(patchedResource);

	let updatedResourceUrl: AbsoluteHttpUrl;
	try {
		const mutation = await updateCalendarEventResource(
			transport,
			current.event.calendarUrl,
			current.event.resourceUrl,
			calendarData,
			etag,
		);
		updatedResourceUrl = mutation.resourceUrl;
	} catch (error) {
		if (isPostPutMetadataFailure(error)) return confirmationFailed(error);
		throw error;
	}

	try {
		const confirmed =
			timeZoneContext === undefined
				? await getCalendarEventByResourceUrl(
						transport,
						current.event.calendarUrl,
						updatedResourceUrl,
					)
				: await getCalendarEventByResourceUrl(
						transport,
						current.event.calendarUrl,
						updatedResourceUrl,
						{ timeZoneContext },
					);
		if (
			confirmed.event.etag === undefined ||
			normalizeCalendarCollectionUrl(confirmed.event.calendarUrl) !==
				normalizeCalendarCollectionUrl(current.event.calendarUrl) ||
			!isDirectCalendarChild(current.event.calendarUrl, confirmed.event.resourceUrl) ||
			confirmed.event.uid !== current.event.uid ||
			(confirmed.event.accessMode === 'editable' &&
				!semanticallyEquivalent(patchedResource, confirmed.context.resource) &&
				!semanticallyEquivalentAllowingMetadataPlacement(
					patchedResource,
					confirmed.context.resource,
				) &&
				(resolvedCurrent === undefined ||
					!semanticallyEquivalentIgnoringRevisionMetadata(
						patchedResource,
						confirmed.context.resource,
					)))
		) {
			return confirmationFailed();
		}
		return Object.freeze({
			...confirmed.event,
			rawIcs: confirmed.rawIcs,
			etag: confirmed.event.etag,
		});
	} catch (error) {
		if (error instanceof CalDavCalendarEventUpdateError) throw error;
		return confirmationFailed(error);
	}
}

export interface CalendarEventResolvedUpdateInput {
	readonly calendarUrl: AbsoluteHttpUrl;
	readonly current: CalendarEventReadResult;
	readonly patch: CalendarEventPatch;
	readonly etag: string;
}

export type CalendarEventResolvedUpdateResult =
	| { readonly kind: 'noChange'; readonly event: UpdatedCalendarEvent }
	| { readonly kind: 'updated'; readonly event: UpdatedCalendarEvent };

export async function updateResolvedCalendarEvent(
	transport: CalDavTransport,
	input: CalendarEventResolvedUpdateInput,
	clock: CalendarEventUpdateClock,
	timeZoneContext?: CalendarEventTimeZoneExecutionContext,
	alarmUidFactory: CalendarAlarmUidGenerator = randomUUID,
): Promise<CalendarEventResolvedUpdateResult> {
	try {
		const event = await updateCalendarEventInternal(
			transport,
			{
				calendarUrl: input.calendarUrl,
				identifier: { kind: 'uid', uid: input.current.event.uid },
				patch: input.patch,
				etag: input.etag,
			},
			clock,
			timeZoneContext,
			input.current,
			alarmUidFactory,
		);
		return Object.freeze({ kind: 'updated', event });
	} catch (error) {
		if (
			(error instanceof CalDavCalendarEventPatchError &&
				error.code === CalendarEventPatchErrorCode.NO_CHANGES) ||
			(error instanceof CalDavCalendarAlarmError &&
				error.code === CalendarAlarmErrorCode.NO_CHANGES)
		) {
			return Object.freeze({
				kind: 'noChange',
				event: Object.freeze({
					...input.current.event,
					rawIcs: input.current.rawIcs,
					etag: input.etag,
				}),
			});
		}
		throw error;
	}
}

export async function updateCalendarEvent(
	transport: CalDavTransport,
	input: CalendarEventUpdateInput,
	clock: CalendarEventUpdateClock,
	timeZoneContext?: CalendarEventTimeZoneExecutionContext,
): Promise<UpdatedCalendarEvent> {
	return await updateCalendarEventInternal(transport, input, clock, timeZoneContext);
}
