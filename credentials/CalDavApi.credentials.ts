import type {
	IAuthenticateGeneric,
	ICredentialType,
	INodeProperties,
	ValidationResult,
} from 'n8n-workflow';

const INVALID_SERVER_URL_MESSAGE =
	'Server URL must be an absolute HTTP(S) URL without user information';

export function validateAndNormalizeServerUrl(serverUrl: unknown): ValidationResult<'url'> {
	if (typeof serverUrl !== 'string') {
		return { valid: false, errorMessage: INVALID_SERVER_URL_MESSAGE };
	}

	const normalizedServerUrl = serverUrl.trim();
	if (!/^https?:\/\//i.test(normalizedServerUrl) || /\s/.test(normalizedServerUrl)) {
		return { valid: false, errorMessage: INVALID_SERVER_URL_MESSAGE };
	}

	const rawAuthority = /^https?:\/\/([^/?#]*)/i.exec(normalizedServerUrl)?.[1];
	if (rawAuthority?.includes('@')) {
		return { valid: false, errorMessage: INVALID_SERVER_URL_MESSAGE };
	}

	try {
		const parsedServerUrl = new URL(normalizedServerUrl);
		if (
			!['http:', 'https:'].includes(parsedServerUrl.protocol) ||
			parsedServerUrl.hostname.length === 0 ||
			parsedServerUrl.username.length > 0 ||
			parsedServerUrl.password.length > 0
		) {
			return { valid: false, errorMessage: INVALID_SERVER_URL_MESSAGE };
		}
	} catch {
		return { valid: false, errorMessage: INVALID_SERVER_URL_MESSAGE };
	}

	return { valid: true, newValue: normalizedServerUrl };
}

// The accepted issue contract explicitly defers a live credential test to the discovery work.
// eslint-disable-next-line @n8n/community-nodes/credential-test-required
export class CalDavApi implements ICredentialType {
	name = 'calDavApi';
	// The accepted public display name is provider-neutral and intentionally omits the generic "API" suffix.
	// eslint-disable-next-line n8n-nodes-base/cred-class-field-display-name-missing-api
	displayName = 'CalDAV';
	icon = {
		light: 'file:../nodes/CalDav/caldav.svg',
		dark: 'file:../nodes/CalDav/caldav.dark.svg',
	} as const;
	documentationUrl =
		'https://github.com/iljailjic/n8n-nodes-caldav/blob/main/README.md#credentials';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			required: true,
			default: '',
			placeholder: 'https://caldav.example.com',
			description: 'Absolute HTTP(S) URL of the CalDAV server',
		},
		{
			displayName: 'Username',
			name: 'username',
			type: 'string',
			required: true,
			default: '',
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			required: true,
			default: '',
		},
		// This is a boolean TLS control, not a secret, despite its security-sensitive name.
		// eslint-disable-next-line @n8n/community-nodes/credential-password-field
		{
			displayName: 'Skip TLS Validation',
			name: 'allowUnauthorizedCerts',
			type: 'boolean',
			default: false,
			description:
				'Whether to skip TLS certificate validation. Enable only for development; keep disabled in production.',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			auth: {
				username: '={{$credentials.username}}',
				password: '={{$credentials.password}}',
			},
			skipSslCertificateValidation: '={{$credentials.allowUnauthorizedCerts}}',
		},
	};
}
