const SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*$/;
const HEX_PATTERN = /^[0-9A-Fa-f]$/;

function isUnreserved(character: string): boolean {
	return /^[A-Za-z0-9._~-]$/.test(character);
}

function isSubDelimiter(character: string): boolean {
	return "!$&'()*+,;=".includes(character);
}

function scanUriCharacters(
	value: string,
	allowsCharacter: (character: string) => boolean,
): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const character = value[index]!;
		if (character === '%') {
			if (
				index + 2 >= value.length ||
				!HEX_PATTERN.test(value[index + 1]!) ||
				!HEX_PATTERN.test(value[index + 2]!)
			) {
				return false;
			}
			index += 2;
			continue;
		}
		if (character.charCodeAt(0) > 0x7f || !allowsCharacter(character)) return false;
	}
	return true;
}

function isPchar(character: string): boolean {
	return (
		isUnreserved(character) || isSubDelimiter(character) || character === ':' || character === '@'
	);
}

function isValidIpv4(value: string): boolean {
	const parts = value.split('.');
	return (
		parts.length === 4 &&
		parts.every((part) => {
			if (!/^\d{1,3}$/.test(part) || (part.length > 1 && part.startsWith('0'))) return false;
			const octet = Number(part);
			return octet >= 0 && octet <= 255;
		})
	);
}

function ipv6GroupCount(groups: readonly string[]): number | undefined {
	let count = 0;
	for (let index = 0; index < groups.length; index += 1) {
		const group = groups[index]!;
		if (group.includes('.')) {
			if (index !== groups.length - 1 || !isValidIpv4(group)) return undefined;
			count += 2;
		} else {
			if (!/^[0-9A-Fa-f]{1,4}$/.test(group)) return undefined;
			count += 1;
		}
	}
	return count;
}

function isValidIpv6(value: string): boolean {
	const compressionIndex = value.indexOf('::');
	if (compressionIndex !== value.lastIndexOf('::')) return false;

	if (compressionIndex === -1) {
		const count = ipv6GroupCount(value.split(':'));
		return count === 8;
	}

	const left = value.slice(0, compressionIndex);
	const right = value.slice(compressionIndex + 2);
	const leftCount = ipv6GroupCount(left === '' ? [] : left.split(':'));
	const rightCount = ipv6GroupCount(right === '' ? [] : right.split(':'));
	return leftCount !== undefined && rightCount !== undefined && leftCount + rightCount < 8;
}

function isValidIpLiteral(value: string): boolean {
	if (value.startsWith('v') || value.startsWith('V')) {
		const dotIndex = value.indexOf('.');
		if (dotIndex < 2 || !/^[0-9A-Fa-f]+$/.test(value.slice(1, dotIndex))) return false;
		const address = value.slice(dotIndex + 1);
		return (
			address.length > 0 &&
			[...address].every(
				(character) => isUnreserved(character) || isSubDelimiter(character) || character === ':',
			)
		);
	}
	return isValidIpv6(value);
}

function isValidAuthority(authority: string): boolean {
	const firstAt = authority.indexOf('@');
	const lastAt = authority.lastIndexOf('@');
	if (firstAt !== lastAt) return false;

	let hostAndPort = authority;
	if (firstAt >= 0) {
		const userInfo = authority.slice(0, firstAt);
		if (
			!scanUriCharacters(
				userInfo,
				(character) => isUnreserved(character) || isSubDelimiter(character) || character === ':',
			)
		) {
			return false;
		}
		hostAndPort = authority.slice(firstAt + 1);
	}

	if (hostAndPort.startsWith('[')) {
		const closingIndex = hostAndPort.indexOf(']');
		if (closingIndex < 0 || !isValidIpLiteral(hostAndPort.slice(1, closingIndex))) return false;
		const suffix = hostAndPort.slice(closingIndex + 1);
		return suffix === '' || (suffix.startsWith(':') && /^\d*$/.test(suffix.slice(1)));
	}

	const colonIndex = hostAndPort.lastIndexOf(':');
	let host = hostAndPort;
	if (colonIndex >= 0) {
		if (!/^\d*$/.test(hostAndPort.slice(colonIndex + 1))) return false;
		host = hostAndPort.slice(0, colonIndex);
	}
	return scanUriCharacters(
		host,
		(character) => isUnreserved(character) || isSubDelimiter(character),
	);
}

export function isAbsoluteICalendarUri(value: string): boolean {
	if (value.includes('#')) return false;
	const colonIndex = value.indexOf(':');
	if (colonIndex <= 0 || !SCHEME_PATTERN.test(value.slice(0, colonIndex))) return false;

	const afterScheme = value.slice(colonIndex + 1);
	const queryIndex = afterScheme.indexOf('?');
	const hierarchy = queryIndex < 0 ? afterScheme : afterScheme.slice(0, queryIndex);
	const query = queryIndex < 0 ? undefined : afterScheme.slice(queryIndex + 1);

	if (
		query !== undefined &&
		!scanUriCharacters(
			query,
			(character) => isPchar(character) || character === '/' || character === '?',
		)
	) {
		return false;
	}

	let path = hierarchy;
	if (hierarchy.startsWith('//')) {
		const slashIndex = hierarchy.indexOf('/', 2);
		const authority = slashIndex < 0 ? hierarchy.slice(2) : hierarchy.slice(2, slashIndex);
		if (!isValidAuthority(authority)) return false;
		path = slashIndex < 0 ? '' : hierarchy.slice(slashIndex);
	}

	return scanUriCharacters(path, (character) => isPchar(character) || character === '/');
}
