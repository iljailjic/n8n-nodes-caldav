import { describe, expect, it } from 'vitest';

import { CalDavApi, validateAndNormalizeServerUrl } from '../../credentials/CalDavApi.credentials';
import { CalDav } from '../../nodes/CalDav/CalDav.node';
import packageJson from '../../package.json';

describe('CalDAV credentials', () => {
	const credential = new CalDavApi();

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
		'https://user@caldav.example.test',
		'https://user:secret@caldav.example.test',
	])('provides transport-independent rejection for server URL %j', (serverUrl) => {
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
	])(
		'provides transport-independent whitespace-only normalization for %j',
		(serverUrl, expected) => {
			expect(validateAndNormalizeServerUrl(serverUrl)).toEqual({
				valid: true,
				newValue: expected,
			});
		},
	);

	it('declares the exact n8n generic Basic authentication metadata', () => {
		expect(credential.authenticate).toEqual({
			type: 'generic',
			properties: {
				auth: {
					username: '={{$credentials.username}}',
					password: '={{$credentials.password}}',
				},
				skipSslCertificateValidation: '={{$credentials.allowUnauthorizedCerts}}',
			},
		});
		expect(JSON.stringify(credential.authenticate)).not.toContain('Authorization');
	});

	it('does not expose a live credential test or provider-specific fields', () => {
		expect('test' in credential).toBe(false);
		expect(credential.properties.some(({ name }) => name === 'provider')).toBe(false);
	});

	it('registers the credential with the node and package manifest', () => {
		const node = new CalDav();

		expect(node.description.credentials).toEqual([{ name: 'calDavApi', required: true }]);
		expect(packageJson.n8n.credentials).toEqual(['dist/credentials/CalDavApi.credentials.js']);
	});
});
