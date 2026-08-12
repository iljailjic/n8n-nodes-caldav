import type { ICredentialDataDecryptedObject } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';

import { CalDavApi, validateAndNormalizeServerUrl } from '../../credentials/CalDavApi.credentials';
import { CalDav } from '../../nodes/CalDav/CalDav.node';
import packageJson from '../../package.json';

describe('CalDAV credentials', () => {
	const credential = new CalDavApi();
	const validCredentials: ICredentialDataDecryptedObject = {
		serverUrl: '  https://credentials.example.test/dav/  ',
		username: ' username-sentinel ',
		password: ' password-sentinel ',
		allowUnauthorizedCerts: false,
	};

	function getAuthenticate() {
		if (typeof credential.authenticate !== 'function') {
			throw new Error('CalDAV credentials must use custom authentication');
		}

		return credential.authenticate;
	}

	async function captureAuthenticationError(
		credentials: ICredentialDataDecryptedObject,
	): Promise<Error> {
		try {
			await getAuthenticate()(credentials, { url: 'https://request.example.test/resource' });
		} catch (error) {
			return error as Error;
		}

		throw new Error('Expected custom authentication to reject invalid credentials');
	}

	it('exposes the accepted credential identity and exact field order', () => {
		expect(credential.name).toBe('calDavApi');
		expect(credential.displayName).toBe('CalDAV');
		expect(credential.properties.map(({ name }) => name)).toEqual([
			'serverUrl',
			'username',
			'password',
			'allowUnauthorizedCerts',
		]);
	});

	it('marks required fields and secret presentation metadata', () => {
		const properties = Object.fromEntries(
			credential.properties.map((property) => [property.name, property]),
		);

		expect(properties.serverUrl).toMatchObject({
			displayName: 'Server URL',
			type: 'string',
			required: true,
			default: '',
		});
		expect(properties.username).toMatchObject({
			displayName: 'Username',
			type: 'string',
			required: true,
			default: '',
		});
		expect(properties.password).toMatchObject({
			displayName: 'Password',
			type: 'string',
			required: true,
			default: '',
			typeOptions: { password: true },
		});
		expect(properties.allowUnauthorizedCerts).toMatchObject({
			displayName: 'Skip TLS Validation',
			type: 'boolean',
			default: false,
		});
		expect(properties.allowUnauthorizedCerts.description).toMatch(/development/i);
	});

	it.each([
		'',
		'   ',
		'/caldav',
		'caldav.example.test',
		'not a url',
		'ftp://caldav.example.test',
		'https://@caldav.example.test',
		'https://:@caldav.example.test',
		'https://user@caldav.example.test',
		'https://user:secret@caldav.example.test',
	])('provides transport-independent rejection for server URL %j', (serverUrl) => {
		expect(validateAndNormalizeServerUrl(serverUrl)).toEqual({
			valid: false,
			errorMessage: 'Server URL must be an absolute HTTP(S) URL without user information',
		});
	});

	it.each([
		['hostname-less HTTP(S) URL', 'https://:443/calendar'],
		['embedded raw whitespace', 'https://caldav.example.test/calendar path'],
		['malformed no-whitespace HTTP(S) URL', 'https://[::1/calendar'],
	])('rejects the %s case', (_caseName, serverUrl) => {
		expect(validateAndNormalizeServerUrl(serverUrl)).toEqual({
			valid: false,
			errorMessage: 'Server URL must be an absolute HTTP(S) URL without user information',
		});
	});

	it.each([
		['https://caldav.example.test', 'https://caldav.example.test'],
		['  http://localhost:5232/dav/  ', 'http://localhost:5232/dav/'],
		[
			'\thttps://caldav.example.test/a%2Fb//?query=a%2Fb#fragment\n',
			'https://caldav.example.test/a%2Fb//?query=a%2Fb#fragment',
		],
		[
			'https://caldav.example.test/user@example.test/?owner=user@example.test#calendar@example.test',
			'https://caldav.example.test/user@example.test/?owner=user@example.test#calendar@example.test',
		],
	])(
		'provides transport-independent whitespace-only normalization for %j',
		(serverUrl, expected) => {
			expect(validateAndNormalizeServerUrl(serverUrl)).toEqual({
				valid: true,
				newValue: expected,
			});
		},
	);

	it('decorates a new request object while preserving unrelated request options', async () => {
		const headers = Object.freeze({ Depth: '0', Accept: 'application/xml' });
		const query = Object.freeze({ page: 2 });
		const body = Object.freeze({ operation: 'discover' });
		const previousAuth = Object.freeze({
			username: 'previous-username',
			password: 'previous-password',
		});
		const requestOptions = Object.freeze({
			url: 'https://request.example.test/principals/user@example.test',
			method: 'POST' as const,
			headers,
			qs: query,
			body,
			auth: previousAuth,
			skipSslCertificateValidation: true,
		});

		const decoratedRequest = await getAuthenticate()(validCredentials, requestOptions);

		expect(decoratedRequest).not.toBe(requestOptions);
		expect(decoratedRequest.url).toBe(requestOptions.url);
		expect(decoratedRequest.method).toBe(requestOptions.method);
		expect(decoratedRequest.headers).toBe(headers);
		expect(decoratedRequest.qs).toBe(query);
		expect(decoratedRequest.body).toBe(body);
		expect(decoratedRequest.auth?.username).toBe(validCredentials.username);
		expect(decoratedRequest.auth?.password).toBe(validCredentials.password);
		expect(decoratedRequest.auth).not.toBe(previousAuth);
		expect(decoratedRequest.skipSslCertificateValidation).toBe(false);
		expect(requestOptions.auth).toBe(previousAuth);
		expect(requestOptions.skipSslCertificateValidation).toBe(true);
		expect(decoratedRequest.headers).not.toHaveProperty('Authorization');
	});

	it.each([
		[true, true],
		[false, false],
		['true', false],
		[1, false],
		[undefined, false],
	])('disables TLS validation only for literal true (%j)', async (credentialValue, expected) => {
		const decoratedRequest = await getAuthenticate()(
			{ ...validCredentials, allowUnauthorizedCerts: credentialValue },
			{ url: 'https://request.example.test/resource' },
		);

		expect(decoratedRequest.skipSslCertificateValidation).toBe(expected);
	});

	it.each([
		[
			'missing username',
			{
				serverUrl: 'https://credentials.example.test',
				password: 'password-sentinel',
			},
			'username-sentinel',
			'password-sentinel',
			'CalDAV username must be a non-empty string',
		],
		[
			'empty password',
			{
				serverUrl: 'https://credentials.example.test',
				username: 'username-sentinel',
				password: '',
			},
			'username-sentinel',
			'password-sentinel',
			'CalDAV password must be a non-empty string',
		],
		[
			'non-string username',
			{
				serverUrl: 'https://credentials.example.test',
				username: 42,
				password: 'password-sentinel',
			},
			'username-sentinel',
			'password-sentinel',
			'CalDAV username must be a non-empty string',
		],
		[
			'non-string password',
			{
				serverUrl: 'https://credentials.example.test',
				username: 'username-sentinel',
				password: false,
			},
			'username-sentinel',
			'password-sentinel',
			'CalDAV password must be a non-empty string',
		],
		[
			'invalid server URL',
			{
				serverUrl: 'https://url-user:url-password@credentials.example.test',
				username: 'username-sentinel',
				password: 'password-sentinel',
			},
			'username-sentinel',
			'password-sentinel',
			'Server URL must be an absolute HTTP(S) URL without user information',
		],
	] as const)(
		'rejects %s with a secret-free error',
		async (_label, credentials, usernameSentinel, passwordSentinel, expectedMessage) => {
			const error = await captureAuthenticationError(credentials);

			expect(error).toBeInstanceOf(Error);
			expect(error.message).toBe(expectedMessage);
			expect(error.message).not.toContain(usernameSentinel);
			expect(error.message).not.toContain(passwordSentinel);
			expect(error.message).not.toContain('url-user');
			expect(error.message).not.toContain('url-password');
		},
	);

	it('does not expose a declarative credential test or provider-specific fields', () => {
		expect('test' in credential).toBe(false);
		expect(credential.properties.some(({ name }) => name === 'provider')).toBe(false);
	});

	it('registers the credential with the node and package manifest', () => {
		const node = new CalDav();

		expect(node.description.credentials).toEqual([
			{ name: 'calDavApi', required: true, testedBy: 'testCalDavApiCredentials' },
		]);
		expect(node.methods.credentialTest).toEqual({
			testCalDavApiCredentials: expect.any(Function),
		});
		expect(packageJson.n8n.credentials).toEqual(['dist/credentials/CalDavApi.credentials.js']);
	});
});
