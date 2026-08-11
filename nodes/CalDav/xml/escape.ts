import { XmlBuildError } from './errors';

const XML_METACHARACTER_ENTITIES: Readonly<Record<string, string>> = Object.freeze({
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&apos;',
});

function isValidXmlCodePoint(codePoint: number): boolean {
	return (
		codePoint === 0x9 ||
		codePoint === 0xa ||
		codePoint === 0xd ||
		(codePoint >= 0x20 && codePoint <= 0xd7ff) ||
		(codePoint >= 0xe000 && codePoint <= 0xfffd) ||
		(codePoint >= 0x10000 && codePoint <= 0x10ffff)
	);
}

function validateXmlValue(value: unknown): asserts value is string {
	if (typeof value !== 'string') {
		throw new XmlBuildError('INVALID_XML_VALUE', 'XML values must be strings');
	}

	for (const character of value) {
		const codePoint = character.codePointAt(0);

		if (codePoint === undefined || !isValidXmlCodePoint(codePoint)) {
			throw new XmlBuildError(
				'INVALID_XML_CHARACTER',
				'XML values must contain only XML 1.0 characters',
			);
		}
	}
}

function escapeXmlValue(value: unknown): string {
	validateXmlValue(value);

	return value.replace(/[&<>"']/g, (character) => XML_METACHARACTER_ENTITIES[character]);
}

export function escapeXmlText(value: string): string {
	return escapeXmlValue(value);
}

export function escapeXmlAttribute(value: string): string {
	return escapeXmlValue(value);
}
