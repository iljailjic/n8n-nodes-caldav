import type { IExecuteFunctions, INode } from 'n8n-workflow';
import { describe, expect, it, vi } from 'vitest';

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
	])('rejects invalid server URL %j without network access', (serverUrl) => {
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
	])('normalizes only surrounding whitespace in %j', (serverUrl, expected) => {
		expect(validateAndNormalizeServerUrl(serverUrl)).toEqual({
			valid: true,
			newValue: expected,
		});
	});

	it('uses n8n generic Basic authentication while preserving unrelated request options', () => {
		expect(credential.authenticate).toMatchObject({
			type: 'generic',
			properties: {
				auth: {
					username: '={{$credentials.username}}',
					password: '={{$credentials.password}}',
				},
				skipSslCertificateValidation: '={{$credentials.allowUnauthorizedCerts}}',
			},
		});

		const requestOptions = {
			method: 'PROPFIND',
			url: 'https://caldav.example.test/principals/',
			headers: { Depth: '0' },
		};
		const decoratedRequest = {
			...requestOptions,
			...credential.authenticate.properties,
		};

		expect(decoratedRequest).toMatchObject({
			method: 'PROPFIND',
			url: 'https://caldav.example.test/principals/',
			headers: { Depth: '0' },
		});
		expect(credential.authenticate.properties).not.toHaveProperty('url');
		expect(credential.authenticate.properties).not.toHaveProperty('headers');
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

	it('validates the managed server URL before preserving passthrough output', async () => {
		const node = new CalDav();
		const input = [{ json: { calendarId: 'calendar-1' } }];
		const executionContext = {
			getCredentials: vi.fn().mockResolvedValue({
				serverUrl: '  https://caldav.example.test/dav/  ',
				username: 'calendar-user',
				password: 'synthetic-password',
				allowUnauthorizedCerts: false,
			}),
			getInputData: vi.fn().mockReturnValue(input),
		} as unknown as IExecuteFunctions;

		await expect(node.execute.call(executionContext)).resolves.toEqual([input]);
		expect(executionContext.getCredentials).toHaveBeenCalledWith('calDavApi');
	});

	it('rejects an invalid managed server URL without exposing credentials', async () => {
		const node = new CalDav();
		const password = 'synthetic-password';
		const executionContext = {
			getCredentials: vi.fn().mockResolvedValue({
				serverUrl: 'https://user@caldav.example.test',
				username: 'calendar-user',
				password,
				allowUnauthorizedCerts: false,
			}),
			getNode: vi.fn().mockReturnValue({
				id: 'caldav-node',
				name: 'CalDAV',
				type: 'n8n-nodes-caldav.calDav',
				typeVersion: 1,
				position: [0, 0],
				parameters: {},
			} satisfies INode),
		} as unknown as IExecuteFunctions;

		let thrownError: unknown;
		try {
			await node.execute.call(executionContext);
		} catch (error) {
			thrownError = error;
		}

		expect(thrownError).toBeInstanceOf(Error);
		const errorMessage = (thrownError as Error).message;
		expect(errorMessage).toContain(
			'Server URL must be an absolute HTTP(S) URL without user information',
		);
		expect(errorMessage).not.toContain(password);
		expect(errorMessage).not.toContain('calendar-user');
	});
});
