export type XmlBuildErrorCode =
	| 'INVALID_XML_VALUE'
	| 'INVALID_XML_CHARACTER'
	| 'INVALID_PROPERTY_SET'
	| 'UNKNOWN_PROPERTY'
	| 'INVALID_UID'
	| 'INVALID_DATE'
	| 'INVALID_TIME_RANGE';

export class XmlBuildError extends Error {
	readonly name = 'XmlBuildError' as const;

	constructor(
		readonly code: XmlBuildErrorCode,
		message: string,
		readonly field?: string,
	) {
		super(message);
	}
}
