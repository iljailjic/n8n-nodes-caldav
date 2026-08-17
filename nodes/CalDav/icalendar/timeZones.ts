import type { ICalendarComponent, ICalendarProperty } from './parser';

export const IANA_TIME_ZONE_DATABASE_VERSION = '2026c' as const;

export const CalDavIanaTimeZoneErrorCode = Object.freeze({
	INVALID_TIME_ZONE: 'INVALID_TIME_ZONE',
	UTC_EQUIVALENT: 'UTC_EQUIVALENT',
	UNREPRESENTABLE_INSTANT: 'UNREPRESENTABLE_INSTANT',
	UNSUPPORTED_DEFINITION: 'UNSUPPORTED_DEFINITION',
} as const);

export type CalDavIanaTimeZoneErrorCode =
	(typeof CalDavIanaTimeZoneErrorCode)[keyof typeof CalDavIanaTimeZoneErrorCode];

const ERROR_MESSAGES: Readonly<Record<CalDavIanaTimeZoneErrorCode, string>> = {
	INVALID_TIME_ZONE: 'The IANA time zone identifier is invalid.',
	UTC_EQUIVALENT: 'The IANA time zone identifier has a zero offset identity.',
	UNREPRESENTABLE_INSTANT: 'The instant cannot be represented by the selected IANA time zone.',
	UNSUPPORTED_DEFINITION: 'The time zone definition is unsupported.',
};

export class CalDavIanaTimeZoneError extends Error {
	readonly code: CalDavIanaTimeZoneErrorCode;

	constructor(code: CalDavIanaTimeZoneErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = 'CalDavIanaTimeZoneError';
		this.code = code;
	}
}

export type IanaTimeZoneId = string & { readonly __ianaTimeZoneId: unique symbol };
export type LocalDateTimeString = string & { readonly __localDateTimeString: unique symbol };

export type CalendarEventTimeZone =
	| { readonly timeZoneMode: 'utc' }
	| { readonly timeZoneMode: 'iana'; readonly timeZone: IanaTimeZoneId };

export type TimeZoneRuleSource = 'intl' | 'vtimezone';

const PRIMARY_ZONES = Object.freeze([
	'Africa/Algiers',
	'Atlantic/Cape_Verde',
	'Africa/Ndjamena',
	'Africa/Abidjan',
	'Africa/Cairo',
	'Africa/Bissau',
	'Africa/Nairobi',
	'Africa/Monrovia',
	'Africa/Tripoli',
	'Indian/Mauritius',
	'Africa/Casablanca',
	'Africa/El_Aaiun',
	'Africa/Maputo',
	'Africa/Windhoek',
	'Africa/Lagos',
	'Africa/Sao_Tome',
	'Africa/Johannesburg',
	'Africa/Khartoum',
	'Africa/Juba',
	'Africa/Tunis',
	'Antarctica/Casey',
	'Antarctica/Davis',
	'Antarctica/Mawson',
	'Antarctica/Troll',
	'Antarctica/Vostok',
	'Antarctica/Rothera',
	'Asia/Kabul',
	'Asia/Yerevan',
	'Asia/Baku',
	'Asia/Dhaka',
	'Asia/Thimphu',
	'Indian/Chagos',
	'Asia/Yangon',
	'Asia/Shanghai',
	'Asia/Urumqi',
	'Asia/Hong_Kong',
	'Asia/Taipei',
	'Asia/Macau',
	'Asia/Nicosia',
	'Asia/Famagusta',
	'Asia/Tbilisi',
	'Asia/Dili',
	'Asia/Kolkata',
	'Asia/Jakarta',
	'Asia/Pontianak',
	'Asia/Makassar',
	'Asia/Jayapura',
	'Asia/Tehran',
	'Asia/Baghdad',
	'Asia/Jerusalem',
	'Asia/Tokyo',
	'Asia/Amman',
	'Asia/Almaty',
	'Asia/Qyzylorda',
	'Asia/Qostanay',
	'Asia/Aqtobe',
	'Asia/Aqtau',
	'Asia/Atyrau',
	'Asia/Oral',
	'Asia/Bishkek',
	'Asia/Seoul',
	'Asia/Pyongyang',
	'Asia/Beirut',
	'Asia/Kuching',
	'Indian/Maldives',
	'Asia/Hovd',
	'Asia/Ulaanbaatar',
	'Asia/Kathmandu',
	'Asia/Karachi',
	'Asia/Gaza',
	'Asia/Hebron',
	'Asia/Manila',
	'Asia/Qatar',
	'Asia/Riyadh',
	'Asia/Singapore',
	'Asia/Colombo',
	'Asia/Damascus',
	'Asia/Dushanbe',
	'Asia/Bangkok',
	'Asia/Ashgabat',
	'Asia/Dubai',
	'Asia/Samarkand',
	'Asia/Tashkent',
	'Asia/Ho_Chi_Minh',
	'Australia/Darwin',
	'Australia/Perth',
	'Australia/Eucla',
	'Australia/Brisbane',
	'Australia/Lindeman',
	'Australia/Adelaide',
	'Australia/Hobart',
	'Australia/Melbourne',
	'Australia/Sydney',
	'Australia/Broken_Hill',
	'Australia/Lord_Howe',
	'Antarctica/Macquarie',
	'Pacific/Fiji',
	'Pacific/Gambier',
	'Pacific/Marquesas',
	'Pacific/Tahiti',
	'Pacific/Guam',
	'Pacific/Tarawa',
	'Pacific/Kanton',
	'Pacific/Kiritimati',
	'Pacific/Kwajalein',
	'Pacific/Kosrae',
	'Pacific/Nauru',
	'Pacific/Noumea',
	'Pacific/Auckland',
	'Pacific/Chatham',
	'Pacific/Rarotonga',
	'Pacific/Niue',
	'Pacific/Norfolk',
	'Pacific/Palau',
	'Pacific/Port_Moresby',
	'Pacific/Bougainville',
	'Pacific/Pitcairn',
	'Pacific/Pago_Pago',
	'Pacific/Apia',
	'Pacific/Guadalcanal',
	'Pacific/Fakaofo',
	'Pacific/Tongatapu',
	'Pacific/Efate',
	'Europe/London',
	'Europe/Dublin',
	'Europe/Tirane',
	'Europe/Andorra',
	'Europe/Vienna',
	'Europe/Minsk',
	'Europe/Brussels',
	'Europe/Sofia',
	'Europe/Prague',
	'Atlantic/Faroe',
	'America/Danmarkshavn',
	'America/Scoresbysund',
	'America/Nuuk',
	'America/Thule',
	'Europe/Tallinn',
	'Europe/Helsinki',
	'Europe/Paris',
	'Europe/Berlin',
	'Europe/Gibraltar',
	'Europe/Athens',
	'Europe/Budapest',
	'Europe/Rome',
	'Europe/Riga',
	'Europe/Vilnius',
	'Europe/Malta',
	'Europe/Chisinau',
	'Europe/Warsaw',
	'Europe/Lisbon',
	'Atlantic/Azores',
	'Atlantic/Madeira',
	'Europe/Bucharest',
	'Europe/Kaliningrad',
	'Europe/Moscow',
	'Europe/Simferopol',
	'Europe/Astrakhan',
	'Europe/Volgograd',
	'Europe/Saratov',
	'Europe/Kirov',
	'Europe/Samara',
	'Europe/Ulyanovsk',
	'Asia/Yekaterinburg',
	'Asia/Omsk',
	'Asia/Barnaul',
	'Asia/Novosibirsk',
	'Asia/Tomsk',
	'Asia/Novokuznetsk',
	'Asia/Krasnoyarsk',
	'Asia/Irkutsk',
	'Asia/Chita',
	'Asia/Yakutsk',
	'Asia/Vladivostok',
	'Asia/Khandyga',
	'Asia/Sakhalin',
	'Asia/Magadan',
	'Asia/Srednekolymsk',
	'Asia/Ust-Nera',
	'Asia/Kamchatka',
	'Asia/Anadyr',
	'Europe/Belgrade',
	'Europe/Madrid',
	'Africa/Ceuta',
	'Atlantic/Canary',
	'Europe/Zurich',
	'Europe/Istanbul',
	'Europe/Kyiv',
	'America/New_York',
	'America/Chicago',
	'America/North_Dakota/Center',
	'America/North_Dakota/New_Salem',
	'America/North_Dakota/Beulah',
	'America/Denver',
	'America/Los_Angeles',
	'America/Juneau',
	'America/Sitka',
	'America/Metlakatla',
	'America/Yakutat',
	'America/Anchorage',
	'America/Nome',
	'America/Adak',
	'Pacific/Honolulu',
	'America/Phoenix',
	'America/Boise',
	'America/Indiana/Indianapolis',
	'America/Indiana/Marengo',
	'America/Indiana/Vincennes',
	'America/Indiana/Tell_City',
	'America/Indiana/Petersburg',
	'America/Indiana/Knox',
	'America/Indiana/Winamac',
	'America/Indiana/Vevay',
	'America/Kentucky/Louisville',
	'America/Kentucky/Monticello',
	'America/Detroit',
	'America/Menominee',
	'America/St_Johns',
	'America/Goose_Bay',
	'America/Halifax',
	'America/Glace_Bay',
	'America/Moncton',
	'America/Toronto',
	'America/Winnipeg',
	'America/Regina',
	'America/Swift_Current',
	'America/Edmonton',
	'America/Vancouver',
	'America/Dawson_Creek',
	'America/Fort_Nelson',
	'America/Iqaluit',
	'America/Resolute',
	'America/Rankin_Inlet',
	'America/Cambridge_Bay',
	'America/Inuvik',
	'America/Whitehorse',
	'America/Dawson',
	'America/Cancun',
	'America/Merida',
	'America/Matamoros',
	'America/Monterrey',
	'America/Mexico_City',
	'America/Ciudad_Juarez',
	'America/Ojinaga',
	'America/Chihuahua',
	'America/Hermosillo',
	'America/Mazatlan',
	'America/Bahia_Banderas',
	'America/Tijuana',
	'America/Barbados',
	'America/Belize',
	'Atlantic/Bermuda',
	'America/Costa_Rica',
	'America/Havana',
	'America/Santo_Domingo',
	'America/El_Salvador',
	'America/Guatemala',
	'America/Port-au-Prince',
	'America/Tegucigalpa',
	'America/Jamaica',
	'America/Martinique',
	'America/Managua',
	'America/Panama',
	'America/Puerto_Rico',
	'America/Miquelon',
	'America/Grand_Turk',
	'America/Argentina/Buenos_Aires',
	'America/Argentina/Cordoba',
	'America/Argentina/Salta',
	'America/Argentina/Tucuman',
	'America/Argentina/La_Rioja',
	'America/Argentina/San_Juan',
	'America/Argentina/Jujuy',
	'America/Argentina/Catamarca',
	'America/Argentina/Mendoza',
	'America/Argentina/San_Luis',
	'America/Argentina/Rio_Gallegos',
	'America/Argentina/Ushuaia',
	'America/La_Paz',
	'America/Noronha',
	'America/Belem',
	'America/Santarem',
	'America/Fortaleza',
	'America/Recife',
	'America/Araguaina',
	'America/Maceio',
	'America/Bahia',
	'America/Sao_Paulo',
	'America/Campo_Grande',
	'America/Cuiaba',
	'America/Porto_Velho',
	'America/Boa_Vista',
	'America/Manaus',
	'America/Eirunepe',
	'America/Rio_Branco',
	'America/Santiago',
	'America/Coyhaique',
	'America/Punta_Arenas',
	'Pacific/Easter',
	'Antarctica/Palmer',
	'America/Bogota',
	'America/Guayaquil',
	'Pacific/Galapagos',
	'Atlantic/Stanley',
	'America/Cayenne',
	'America/Guyana',
	'America/Asuncion',
	'America/Lima',
	'Atlantic/South_Georgia',
	'America/Paramaribo',
	'America/Montevideo',
	'America/Caracas',
	'Etc/UTC',
	'Etc/GMT',
	'Etc/GMT-14',
	'Etc/GMT-13',
	'Etc/GMT-12',
	'Etc/GMT-11',
	'Etc/GMT-10',
	'Etc/GMT-9',
	'Etc/GMT-8',
	'Etc/GMT-7',
	'Etc/GMT-6',
	'Etc/GMT-5',
	'Etc/GMT-4',
	'Etc/GMT-3',
	'Etc/GMT-2',
	'Etc/GMT-1',
	'Etc/GMT+1',
	'Etc/GMT+2',
	'Etc/GMT+3',
	'Etc/GMT+4',
	'Etc/GMT+5',
	'Etc/GMT+6',
	'Etc/GMT+7',
	'Etc/GMT+8',
	'Etc/GMT+9',
	'Etc/GMT+10',
	'Etc/GMT+11',
	'Etc/GMT+12',
] as const);

const LINK_ENTRIES = Object.freeze([
	{ name: 'GMT', target: 'Etc/GMT' },
	{ name: 'Australia/ACT', target: 'Australia/Sydney' },
	{ name: 'Australia/LHI', target: 'Australia/Lord_Howe' },
	{ name: 'Australia/NSW', target: 'Australia/Sydney' },
	{ name: 'Australia/North', target: 'Australia/Darwin' },
	{ name: 'Australia/Queensland', target: 'Australia/Brisbane' },
	{ name: 'Australia/South', target: 'Australia/Adelaide' },
	{ name: 'Australia/Tasmania', target: 'Australia/Hobart' },
	{ name: 'Australia/Victoria', target: 'Australia/Melbourne' },
	{ name: 'Australia/West', target: 'Australia/Perth' },
	{ name: 'Australia/Yancowinna', target: 'Australia/Broken_Hill' },
	{ name: 'Brazil/Acre', target: 'America/Rio_Branco' },
	{ name: 'Brazil/DeNoronha', target: 'America/Noronha' },
	{ name: 'Brazil/East', target: 'America/Sao_Paulo' },
	{ name: 'Brazil/West', target: 'America/Manaus' },
	{ name: 'CET', target: 'Europe/Brussels' },
	{ name: 'CST6CDT', target: 'America/Chicago' },
	{ name: 'Canada/Atlantic', target: 'America/Halifax' },
	{ name: 'Canada/Central', target: 'America/Winnipeg' },
	{ name: 'Canada/Eastern', target: 'America/Toronto' },
	{ name: 'Canada/Mountain', target: 'America/Edmonton' },
	{ name: 'Canada/Newfoundland', target: 'America/St_Johns' },
	{ name: 'Canada/Pacific', target: 'America/Vancouver' },
	{ name: 'Canada/Saskatchewan', target: 'America/Regina' },
	{ name: 'Canada/Yukon', target: 'America/Whitehorse' },
	{ name: 'Chile/Continental', target: 'America/Santiago' },
	{ name: 'Chile/EasterIsland', target: 'Pacific/Easter' },
	{ name: 'Cuba', target: 'America/Havana' },
	{ name: 'EET', target: 'Europe/Athens' },
	{ name: 'EST', target: 'America/Panama' },
	{ name: 'EST5EDT', target: 'America/New_York' },
	{ name: 'Egypt', target: 'Africa/Cairo' },
	{ name: 'Eire', target: 'Europe/Dublin' },
	{ name: 'Etc/GMT+0', target: 'Etc/GMT' },
	{ name: 'Etc/GMT-0', target: 'Etc/GMT' },
	{ name: 'Etc/GMT0', target: 'Etc/GMT' },
	{ name: 'Etc/Greenwich', target: 'Etc/GMT' },
	{ name: 'Etc/UCT', target: 'Etc/UTC' },
	{ name: 'Etc/Universal', target: 'Etc/UTC' },
	{ name: 'Etc/Zulu', target: 'Etc/UTC' },
	{ name: 'GB', target: 'Europe/London' },
	{ name: 'GB-Eire', target: 'Europe/London' },
	{ name: 'GMT+0', target: 'Etc/GMT' },
	{ name: 'GMT-0', target: 'Etc/GMT' },
	{ name: 'GMT0', target: 'Etc/GMT' },
	{ name: 'Greenwich', target: 'Etc/GMT' },
	{ name: 'Hongkong', target: 'Asia/Hong_Kong' },
	{ name: 'Iceland', target: 'Africa/Abidjan' },
	{ name: 'Iran', target: 'Asia/Tehran' },
	{ name: 'Israel', target: 'Asia/Jerusalem' },
	{ name: 'Jamaica', target: 'America/Jamaica' },
	{ name: 'Japan', target: 'Asia/Tokyo' },
	{ name: 'Kwajalein', target: 'Pacific/Kwajalein' },
	{ name: 'Libya', target: 'Africa/Tripoli' },
	{ name: 'MET', target: 'Europe/Brussels' },
	{ name: 'MST', target: 'America/Phoenix' },
	{ name: 'MST7MDT', target: 'America/Denver' },
	{ name: 'Mexico/BajaNorte', target: 'America/Tijuana' },
	{ name: 'Mexico/BajaSur', target: 'America/Mazatlan' },
	{ name: 'Mexico/General', target: 'America/Mexico_City' },
	{ name: 'NZ', target: 'Pacific/Auckland' },
	{ name: 'NZ-CHAT', target: 'Pacific/Chatham' },
	{ name: 'Navajo', target: 'America/Denver' },
	{ name: 'PRC', target: 'Asia/Shanghai' },
	{ name: 'Poland', target: 'Europe/Warsaw' },
	{ name: 'Portugal', target: 'Europe/Lisbon' },
	{ name: 'ROC', target: 'Asia/Taipei' },
	{ name: 'ROK', target: 'Asia/Seoul' },
	{ name: 'Singapore', target: 'Asia/Singapore' },
	{ name: 'Turkey', target: 'Europe/Istanbul' },
	{ name: 'UCT', target: 'Etc/UTC' },
	{ name: 'US/Alaska', target: 'America/Anchorage' },
	{ name: 'US/Aleutian', target: 'America/Adak' },
	{ name: 'US/Arizona', target: 'America/Phoenix' },
	{ name: 'US/Central', target: 'America/Chicago' },
	{ name: 'US/East-Indiana', target: 'America/Indiana/Indianapolis' },
	{ name: 'US/Eastern', target: 'America/New_York' },
	{ name: 'US/Hawaii', target: 'Pacific/Honolulu' },
	{ name: 'US/Indiana-Starke', target: 'America/Indiana/Knox' },
	{ name: 'US/Michigan', target: 'America/Detroit' },
	{ name: 'US/Mountain', target: 'America/Denver' },
	{ name: 'US/Pacific', target: 'America/Los_Angeles' },
	{ name: 'US/Samoa', target: 'Pacific/Pago_Pago' },
	{ name: 'UTC', target: 'Etc/UTC' },
	{ name: 'Universal', target: 'Etc/UTC' },
	{ name: 'W-SU', target: 'Europe/Moscow' },
	{ name: 'Zulu', target: 'Etc/UTC' },
	{ name: 'America/Buenos_Aires', target: 'America/Argentina/Buenos_Aires' },
	{ name: 'America/Catamarca', target: 'America/Argentina/Catamarca' },
	{ name: 'America/Cordoba', target: 'America/Argentina/Cordoba' },
	{ name: 'America/Indianapolis', target: 'America/Indiana/Indianapolis' },
	{ name: 'America/Jujuy', target: 'America/Argentina/Jujuy' },
	{ name: 'America/Knox_IN', target: 'America/Indiana/Knox' },
	{ name: 'America/Louisville', target: 'America/Kentucky/Louisville' },
	{ name: 'America/Mendoza', target: 'America/Argentina/Mendoza' },
	{ name: 'America/Virgin', target: 'America/Puerto_Rico' },
	{ name: 'Pacific/Samoa', target: 'Pacific/Pago_Pago' },
	{ name: 'Africa/Accra', target: 'Africa/Abidjan' },
	{ name: 'Africa/Addis_Ababa', target: 'Africa/Nairobi' },
	{ name: 'Africa/Asmara', target: 'Africa/Nairobi' },
	{ name: 'Africa/Bamako', target: 'Africa/Abidjan' },
	{ name: 'Africa/Bangui', target: 'Africa/Lagos' },
	{ name: 'Africa/Banjul', target: 'Africa/Abidjan' },
	{ name: 'Africa/Blantyre', target: 'Africa/Maputo' },
	{ name: 'Africa/Brazzaville', target: 'Africa/Lagos' },
	{ name: 'Africa/Bujumbura', target: 'Africa/Maputo' },
	{ name: 'Africa/Conakry', target: 'Africa/Abidjan' },
	{ name: 'Africa/Dakar', target: 'Africa/Abidjan' },
	{ name: 'Africa/Dar_es_Salaam', target: 'Africa/Nairobi' },
	{ name: 'Africa/Djibouti', target: 'Africa/Nairobi' },
	{ name: 'Africa/Douala', target: 'Africa/Lagos' },
	{ name: 'Africa/Freetown', target: 'Africa/Abidjan' },
	{ name: 'Africa/Gaborone', target: 'Africa/Maputo' },
	{ name: 'Africa/Harare', target: 'Africa/Maputo' },
	{ name: 'Africa/Kampala', target: 'Africa/Nairobi' },
	{ name: 'Africa/Kigali', target: 'Africa/Maputo' },
	{ name: 'Africa/Kinshasa', target: 'Africa/Lagos' },
	{ name: 'Africa/Libreville', target: 'Africa/Lagos' },
	{ name: 'Africa/Lome', target: 'Africa/Abidjan' },
	{ name: 'Africa/Luanda', target: 'Africa/Lagos' },
	{ name: 'Africa/Lubumbashi', target: 'Africa/Maputo' },
	{ name: 'Africa/Lusaka', target: 'Africa/Maputo' },
	{ name: 'Africa/Malabo', target: 'Africa/Lagos' },
	{ name: 'Africa/Maseru', target: 'Africa/Johannesburg' },
	{ name: 'Africa/Mbabane', target: 'Africa/Johannesburg' },
	{ name: 'Africa/Mogadishu', target: 'Africa/Nairobi' },
	{ name: 'Africa/Niamey', target: 'Africa/Lagos' },
	{ name: 'Africa/Nouakchott', target: 'Africa/Abidjan' },
	{ name: 'Africa/Ouagadougou', target: 'Africa/Abidjan' },
	{ name: 'Africa/Porto-Novo', target: 'Africa/Lagos' },
	{ name: 'America/Anguilla', target: 'America/Puerto_Rico' },
	{ name: 'America/Antigua', target: 'America/Puerto_Rico' },
	{ name: 'America/Aruba', target: 'America/Puerto_Rico' },
	{ name: 'America/Atikokan', target: 'America/Panama' },
	{ name: 'America/Blanc-Sablon', target: 'America/Puerto_Rico' },
	{ name: 'America/Cayman', target: 'America/Panama' },
	{ name: 'America/Creston', target: 'America/Phoenix' },
	{ name: 'America/Curacao', target: 'America/Puerto_Rico' },
	{ name: 'America/Dominica', target: 'America/Puerto_Rico' },
	{ name: 'America/Grenada', target: 'America/Puerto_Rico' },
	{ name: 'America/Guadeloupe', target: 'America/Puerto_Rico' },
	{ name: 'America/Kralendijk', target: 'America/Puerto_Rico' },
	{ name: 'America/Lower_Princes', target: 'America/Puerto_Rico' },
	{ name: 'America/Marigot', target: 'America/Puerto_Rico' },
	{ name: 'America/Montserrat', target: 'America/Puerto_Rico' },
	{ name: 'America/Nassau', target: 'America/Toronto' },
	{ name: 'America/Port_of_Spain', target: 'America/Puerto_Rico' },
	{ name: 'America/St_Barthelemy', target: 'America/Puerto_Rico' },
	{ name: 'America/St_Kitts', target: 'America/Puerto_Rico' },
	{ name: 'America/St_Lucia', target: 'America/Puerto_Rico' },
	{ name: 'America/St_Thomas', target: 'America/Puerto_Rico' },
	{ name: 'America/St_Vincent', target: 'America/Puerto_Rico' },
	{ name: 'America/Tortola', target: 'America/Puerto_Rico' },
	{ name: 'Antarctica/DumontDUrville', target: 'Pacific/Port_Moresby' },
	{ name: 'Antarctica/McMurdo', target: 'Pacific/Auckland' },
	{ name: 'Antarctica/Syowa', target: 'Asia/Riyadh' },
	{ name: 'Arctic/Longyearbyen', target: 'Europe/Berlin' },
	{ name: 'Asia/Aden', target: 'Asia/Riyadh' },
	{ name: 'Asia/Bahrain', target: 'Asia/Qatar' },
	{ name: 'Asia/Brunei', target: 'Asia/Kuching' },
	{ name: 'Asia/Kuala_Lumpur', target: 'Asia/Singapore' },
	{ name: 'Asia/Kuwait', target: 'Asia/Riyadh' },
	{ name: 'Asia/Muscat', target: 'Asia/Dubai' },
	{ name: 'Asia/Phnom_Penh', target: 'Asia/Bangkok' },
	{ name: 'Asia/Vientiane', target: 'Asia/Bangkok' },
	{ name: 'Atlantic/Reykjavik', target: 'Africa/Abidjan' },
	{ name: 'Atlantic/St_Helena', target: 'Africa/Abidjan' },
	{ name: 'Europe/Amsterdam', target: 'Europe/Brussels' },
	{ name: 'Europe/Bratislava', target: 'Europe/Prague' },
	{ name: 'Europe/Busingen', target: 'Europe/Zurich' },
	{ name: 'Europe/Copenhagen', target: 'Europe/Berlin' },
	{ name: 'Europe/Guernsey', target: 'Europe/London' },
	{ name: 'Europe/Isle_of_Man', target: 'Europe/London' },
	{ name: 'Europe/Jersey', target: 'Europe/London' },
	{ name: 'Europe/Ljubljana', target: 'Europe/Belgrade' },
	{ name: 'Europe/Luxembourg', target: 'Europe/Brussels' },
	{ name: 'Europe/Mariehamn', target: 'Europe/Helsinki' },
	{ name: 'Europe/Monaco', target: 'Europe/Paris' },
	{ name: 'Europe/Oslo', target: 'Europe/Berlin' },
	{ name: 'Europe/Podgorica', target: 'Europe/Belgrade' },
	{ name: 'Europe/San_Marino', target: 'Europe/Rome' },
	{ name: 'Europe/Sarajevo', target: 'Europe/Belgrade' },
	{ name: 'Europe/Skopje', target: 'Europe/Belgrade' },
	{ name: 'Europe/Stockholm', target: 'Europe/Berlin' },
	{ name: 'Europe/Vaduz', target: 'Europe/Zurich' },
	{ name: 'Europe/Vatican', target: 'Europe/Rome' },
	{ name: 'Europe/Zagreb', target: 'Europe/Belgrade' },
	{ name: 'Indian/Antananarivo', target: 'Africa/Nairobi' },
	{ name: 'Indian/Christmas', target: 'Asia/Bangkok' },
	{ name: 'Indian/Cocos', target: 'Asia/Yangon' },
	{ name: 'Indian/Comoro', target: 'Africa/Nairobi' },
	{ name: 'Indian/Kerguelen', target: 'Indian/Maldives' },
	{ name: 'Indian/Mahe', target: 'Asia/Dubai' },
	{ name: 'Indian/Mayotte', target: 'Africa/Nairobi' },
	{ name: 'Indian/Reunion', target: 'Asia/Dubai' },
	{ name: 'Pacific/Chuuk', target: 'Pacific/Port_Moresby' },
	{ name: 'Pacific/Funafuti', target: 'Pacific/Tarawa' },
	{ name: 'Pacific/Majuro', target: 'Pacific/Tarawa' },
	{ name: 'Pacific/Midway', target: 'Pacific/Pago_Pago' },
	{ name: 'Pacific/Pohnpei', target: 'Pacific/Guadalcanal' },
	{ name: 'Pacific/Saipan', target: 'Pacific/Guam' },
	{ name: 'Pacific/Wake', target: 'Pacific/Tarawa' },
	{ name: 'Pacific/Wallis', target: 'Pacific/Tarawa' },
	{ name: 'Africa/Timbuktu', target: 'Africa/Abidjan' },
	{ name: 'America/Argentina/ComodRivadavia', target: 'America/Argentina/Catamarca' },
	{ name: 'America/Atka', target: 'America/Adak' },
	{ name: 'America/Coral_Harbour', target: 'America/Panama' },
	{ name: 'America/Ensenada', target: 'America/Tijuana' },
	{ name: 'America/Fort_Wayne', target: 'America/Indiana/Indianapolis' },
	{ name: 'America/Montreal', target: 'America/Toronto' },
	{ name: 'America/Nipigon', target: 'America/Toronto' },
	{ name: 'America/Pangnirtung', target: 'America/Iqaluit' },
	{ name: 'America/Porto_Acre', target: 'America/Rio_Branco' },
	{ name: 'America/Rainy_River', target: 'America/Winnipeg' },
	{ name: 'America/Rosario', target: 'America/Argentina/Cordoba' },
	{ name: 'America/Santa_Isabel', target: 'America/Tijuana' },
	{ name: 'America/Shiprock', target: 'America/Denver' },
	{ name: 'America/Thunder_Bay', target: 'America/Toronto' },
	{ name: 'America/Yellowknife', target: 'America/Edmonton' },
	{ name: 'Antarctica/South_Pole', target: 'Pacific/Auckland' },
	{ name: 'Asia/Choibalsan', target: 'Asia/Ulaanbaatar' },
	{ name: 'Asia/Chongqing', target: 'Asia/Shanghai' },
	{ name: 'Asia/Harbin', target: 'Asia/Shanghai' },
	{ name: 'Asia/Kashgar', target: 'Asia/Urumqi' },
	{ name: 'Asia/Tel_Aviv', target: 'Asia/Jerusalem' },
	{ name: 'Atlantic/Jan_Mayen', target: 'Europe/Berlin' },
	{ name: 'Australia/Canberra', target: 'Australia/Sydney' },
	{ name: 'Australia/Currie', target: 'Australia/Hobart' },
	{ name: 'Europe/Belfast', target: 'Europe/London' },
	{ name: 'Europe/Tiraspol', target: 'Europe/Chisinau' },
	{ name: 'Europe/Uzhgorod', target: 'Europe/Kyiv' },
	{ name: 'Europe/Zaporozhye', target: 'Europe/Kyiv' },
	{ name: 'Pacific/Enderbury', target: 'Pacific/Kanton' },
	{ name: 'Pacific/Johnston', target: 'Pacific/Honolulu' },
	{ name: 'Pacific/Yap', target: 'Pacific/Port_Moresby' },
	{ name: 'WET', target: 'Europe/Lisbon' },
	{ name: 'Africa/Asmera', target: 'Africa/Nairobi' },
	{ name: 'America/Godthab', target: 'America/Nuuk' },
	{ name: 'Asia/Ashkhabad', target: 'Asia/Ashgabat' },
	{ name: 'Asia/Calcutta', target: 'Asia/Kolkata' },
	{ name: 'Asia/Chungking', target: 'Asia/Shanghai' },
	{ name: 'Asia/Dacca', target: 'Asia/Dhaka' },
	{ name: 'Asia/Istanbul', target: 'Europe/Istanbul' },
	{ name: 'Asia/Katmandu', target: 'Asia/Kathmandu' },
	{ name: 'Asia/Macao', target: 'Asia/Macau' },
	{ name: 'Asia/Rangoon', target: 'Asia/Yangon' },
	{ name: 'Asia/Saigon', target: 'Asia/Ho_Chi_Minh' },
	{ name: 'Asia/Thimbu', target: 'Asia/Thimphu' },
	{ name: 'Asia/Ujung_Pandang', target: 'Asia/Makassar' },
	{ name: 'Asia/Ulan_Bator', target: 'Asia/Ulaanbaatar' },
	{ name: 'Atlantic/Faeroe', target: 'Atlantic/Faroe' },
	{ name: 'Europe/Kiev', target: 'Europe/Kyiv' },
	{ name: 'Europe/Nicosia', target: 'Asia/Nicosia' },
	{ name: 'HST', target: 'Pacific/Honolulu' },
	{ name: 'PST8PDT', target: 'America/Los_Angeles' },
	{ name: 'Pacific/Ponape', target: 'Pacific/Guadalcanal' },
	{ name: 'Pacific/Truk', target: 'Pacific/Port_Moresby' },
] as const);

const UTC_EQUIVALENT_PRIMARY_ZONES = new Set<string>(['Etc/GMT', 'Etc/UTC']);
const DISALLOWED_IMPLEMENTATION_IDENTIFIERS = new Set<string>([
	'cet',
	'cst6cdt',
	'eet',
	'est',
	'est5edt',
	'hst',
	'met',
	'mst',
	'mst7mdt',
	'pst8pdt',
	'wet',
]);
const ASCII_TIME_ZONE_PATTERN = /^[A-Za-z0-9._+/-]+$/;
const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/;
const DATE_GET_TIME = Date.prototype.getTime;
const DATE_GET_UTC_FULL_YEAR = Date.prototype.getUTCFullYear;
const DATE_GET_UTC_MONTH = Date.prototype.getUTCMonth;
const DATE_GET_UTC_DATE = Date.prototype.getUTCDate;
const DATE_GET_UTC_HOURS = Date.prototype.getUTCHours;
const DATE_GET_UTC_MINUTES = Date.prototype.getUTCMinutes;
const DATE_GET_UTC_SECONDS = Date.prototype.getUTCSeconds;
const DATE_GET_UTC_MILLISECONDS = Date.prototype.getUTCMilliseconds;

function asciiLower(value: string): string {
	return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

const PRIMARY_BY_LOWER = new Map<string, string>(
	PRIMARY_ZONES.map((zone) => [asciiLower(zone), zone]),
);
const LINK_BY_LOWER = new Map<string, string>(
	LINK_ENTRIES.map(({ name, target }) => [asciiLower(name), target]),
);

function resolvePrimaryName(input: string): string | undefined {
	let candidate = PRIMARY_BY_LOWER.get(asciiLower(input));
	if (candidate !== undefined) return candidate;
	let target = LINK_BY_LOWER.get(asciiLower(input));
	const visited = new Set<string>();
	while (target !== undefined) {
		const lower = asciiLower(target);
		if (visited.has(lower)) return undefined;
		visited.add(lower);
		candidate = PRIMARY_BY_LOWER.get(lower);
		if (candidate !== undefined) return candidate;
		target = LINK_BY_LOWER.get(lower);
	}
	return undefined;
}

function runtimeRecognizesTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone }).format(0);
		return true;
	} catch {
		return false;
	}
}

export function canonicalizeIanaTimeZone(input: string): IanaTimeZoneId {
	if (
		typeof input !== 'string' ||
		!ASCII_TIME_ZONE_PATTERN.test(input) ||
		DISALLOWED_IMPLEMENTATION_IDENTIFIERS.has(asciiLower(input))
	) {
		throw new CalDavIanaTimeZoneError(CalDavIanaTimeZoneErrorCode.INVALID_TIME_ZONE);
	}
	const canonical = resolvePrimaryName(input);
	if (canonical === undefined || !runtimeRecognizesTimeZone(canonical)) {
		throw new CalDavIanaTimeZoneError(CalDavIanaTimeZoneErrorCode.INVALID_TIME_ZONE);
	}
	if (UTC_EQUIVALENT_PRIMARY_ZONES.has(canonical)) {
		throw new CalDavIanaTimeZoneError(CalDavIanaTimeZoneErrorCode.UTC_EQUIVALENT);
	}
	return canonical as IanaTimeZoneId;
}

const CANONICAL_TIME_ZONES = Object.freeze(
	PRIMARY_ZONES.filter((zone) => !UTC_EQUIVALENT_PRIMARY_ZONES.has(zone)).sort(),
) as readonly IanaTimeZoneId[];

export function listCanonicalIanaTimeZones(): readonly IanaTimeZoneId[] {
	return CANONICAL_TIME_ZONES;
}

interface DateParts {
	readonly year: number;
	readonly month: number;
	readonly day: number;
	readonly hour: number;
	readonly minute: number;
	readonly second: number;
}

function invalidInstant(): never {
	throw new CalDavIanaTimeZoneError(CalDavIanaTimeZoneErrorCode.UNREPRESENTABLE_INSTANT);
}

function dateTimestamp(value: Date): number {
	let timestamp: number;
	let milliseconds: number;
	try {
		timestamp = DATE_GET_TIME.call(value);
		milliseconds = DATE_GET_UTC_MILLISECONDS.call(value);
	} catch {
		return invalidInstant();
	}
	if (!Number.isFinite(timestamp) || milliseconds !== 0) return invalidInstant();
	return timestamp;
}

function formatter(timeZone: IanaTimeZoneId): Intl.DateTimeFormat {
	return new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
		timeZone,
		calendar: 'iso8601',
		numberingSystem: 'latn',
		hourCycle: 'h23',
		era: 'short',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
}

function projectedParts(timestamp: number, timeZone: IanaTimeZoneId): DateParts {
	const parts = formatter(timeZone).formatToParts(new Date(timestamp));
	const values = new Map(parts.map(({ type, value }) => [type, value]));
	if (values.get('era') !== 'AD') return invalidInstant();
	const result = {
		year: Number(values.get('year')),
		month: Number(values.get('month')),
		day: Number(values.get('day')),
		hour: Number(values.get('hour')),
		minute: Number(values.get('minute')),
		second: Number(values.get('second')),
	};
	if (
		!Number.isInteger(result.year) ||
		result.year < 1 ||
		result.year > 9999 ||
		!validParts(result)
	) {
		return invalidInstant();
	}
	return result;
}

function pad(value: number, width = 2): string {
	return value.toString().padStart(width, '0');
}

function formatLocal(parts: DateParts): LocalDateTimeString {
	return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}` as LocalDateTimeString;
}

function validParts(parts: DateParts): boolean {
	if (
		parts.year < 1 ||
		parts.year > 9999 ||
		parts.month < 1 ||
		parts.month > 12 ||
		parts.day < 1 ||
		parts.day > 31 ||
		parts.hour < 0 ||
		parts.hour > 23 ||
		parts.minute < 0 ||
		parts.minute > 59 ||
		parts.second < 0 ||
		parts.second > 59
	) {
		return false;
	}
	const date = new Date(0);
	date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
	date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
	return (
		DATE_GET_UTC_FULL_YEAR.call(date) === parts.year &&
		DATE_GET_UTC_MONTH.call(date) === parts.month - 1 &&
		DATE_GET_UTC_DATE.call(date) === parts.day &&
		DATE_GET_UTC_HOURS.call(date) === parts.hour &&
		DATE_GET_UTC_MINUTES.call(date) === parts.minute &&
		DATE_GET_UTC_SECONDS.call(date) === parts.second
	);
}

function parseLocal(value: string): DateParts {
	const match = LOCAL_DATE_TIME_PATTERN.exec(value);
	if (match === null) return invalidInstant();
	const parts = {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
		hour: Number(match[4]),
		minute: Number(match[5]),
		second: Number(match[6]),
	};
	if (!validParts(parts)) return invalidInstant();
	return parts;
}

function wallTimestamp(parts: DateParts): number {
	const date = new Date(0);
	date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
	date.setUTCHours(parts.hour, parts.minute, parts.second, 0);
	return DATE_GET_TIME.call(date);
}

function offsetAt(timestamp: number, timeZone: IanaTimeZoneId): number {
	return wallTimestamp(projectedParts(timestamp, timeZone)) - timestamp;
}

interface DefinitionTransition {
	readonly localMilliseconds: number;
	readonly offsetFromMilliseconds: number;
	readonly offsetToMilliseconds: number;
}

const COMPACT_LOCAL_DATE_TIME_PATTERN = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/;
const WEEKDAY_INDEX: Readonly<Record<string, number>> = {
	SU: 0,
	MO: 1,
	TU: 2,
	WE: 3,
	TH: 4,
	FR: 5,
	SA: 6,
};

function definitionProperties(
	component: ICalendarComponent,
	name: string,
): readonly ICalendarProperty[] {
	const expected = name.toUpperCase();
	return component.entries.filter(
		(entry): entry is ICalendarProperty =>
			entry.kind === 'property' && entry.name.toUpperCase() === expected,
	);
}

function definitionRaw(component: ICalendarComponent, name: string): string | undefined {
	const properties = definitionProperties(component, name);
	return properties.length === 1 && properties[0]!.value.textValues === null
		? properties[0]!.value.raw
		: undefined;
}

function definitionText(component: ICalendarComponent, name: string): string | undefined {
	const properties = definitionProperties(component, name);
	return properties.length === 1 && properties[0]!.value.textValues?.length === 1
		? properties[0]!.value.textValues[0]
		: undefined;
}

function compactLocalTimestamp(raw: string): number | undefined {
	const match = COMPACT_LOCAL_DATE_TIME_PATTERN.exec(raw);
	if (match === null) return undefined;
	const parts = {
		year: Number(match[1]),
		month: Number(match[2]),
		day: Number(match[3]),
		hour: Number(match[4]),
		minute: Number(match[5]),
		second: Number(match[6]),
	};
	return validParts(parts) ? wallTimestamp(parts) : undefined;
}

function definitionOffset(raw: string): number | undefined {
	const match = /^([+-])(\d{2})(\d{2})(?:(\d{2}))?$/.exec(raw);
	if (match === null) return undefined;
	const hours = Number(match[2]);
	const minutes = Number(match[3]);
	const seconds = Number(match[4] ?? '0');
	if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
	const milliseconds = (hours * 3600 + minutes * 60 + seconds) * 1000;
	return match[1] === '-' ? -milliseconds : milliseconds;
}

function monthLength(year: number, month: number): number {
	const date = new Date(0);
	date.setUTCFullYear(year, month, 0);
	return date.getUTCDate();
}

function weekday(year: number, month: number, day: number): number {
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(0, 0, 0, 0);
	return date.getUTCDay();
}

function yearlyDefinitionOccurrence(
	rrule: string,
	start: string,
	year: number,
): string | undefined {
	const startMatch = COMPACT_LOCAL_DATE_TIME_PATTERN.exec(start);
	if (startMatch === null) return undefined;
	const parts = new Map<string, string>();
	for (const part of rrule.split(';')) {
		const delimiter = part.indexOf('=');
		if (delimiter <= 0) return undefined;
		const key = part.slice(0, delimiter).toUpperCase();
		if (parts.has(key)) return undefined;
		parts.set(key, part.slice(delimiter + 1));
	}
	if (parts.get('FREQ') !== 'YEARLY') return undefined;
	const supported = new Set(['FREQ', 'BYMONTH', 'BYMONTHDAY', 'BYDAY']);
	if ([...parts.keys()].some((key) => !supported.has(key))) return undefined;
	const month = Number(parts.get('BYMONTH') ?? startMatch[2]);
	if (!Number.isInteger(month) || month < 1 || month > 12) return undefined;
	let day = Number(parts.get('BYMONTHDAY') ?? startMatch[3]);
	const byDay = parts.get('BYDAY');
	if (byDay !== undefined) {
		if (parts.has('BYMONTHDAY')) return undefined;
		const match = /^([+-]?\d)(SU|MO|TU|WE|TH|FR|SA)$/.exec(byDay);
		if (match === null) return undefined;
		const ordinal = Number(match[1]);
		if (ordinal === 0 || Math.abs(ordinal) > 5) return undefined;
		const weekdayIndex = WEEKDAY_INDEX[match[2]!]!;
		if (ordinal > 0) {
			const firstWeekday = weekday(year, month, 1);
			day = 1 + ((weekdayIndex - firstWeekday + 7) % 7) + (ordinal - 1) * 7;
		} else {
			const last = monthLength(year, month);
			const lastWeekday = weekday(year, month, last);
			day = last - ((lastWeekday - weekdayIndex + 7) % 7) + (ordinal + 1) * 7;
		}
	}
	if (day < 1 || day > monthLength(year, month)) return undefined;
	return `${pad(year, 4)}${pad(month)}${pad(day)}T${startMatch[4]}${startMatch[5]}${startMatch[6]}`;
}

function definitionTransitions(
	definition: ICalendarComponent,
	timeZone: IanaTimeZoneId,
	targetYears: readonly number[],
): readonly DefinitionTransition[] {
	const identifier = definitionText(definition, 'TZID');
	if (
		definition.name.toUpperCase() !== 'VTIMEZONE' ||
		identifier === undefined ||
		canonicalizeIanaTimeZone(identifier) !== timeZone
	) {
		throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
	}
	const observances = definition.entries.filter(
		(entry): entry is ICalendarComponent => entry.kind === 'component',
	);
	if (
		observances.length === 0 ||
		observances.some(
			(observance) => !['STANDARD', 'DAYLIGHT'].includes(observance.name.toUpperCase()),
		)
	) {
		throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
	}
	const transitions: DefinitionTransition[] = [];
	let everyObservanceRecurs = true;
	for (const observance of observances) {
		const start = definitionRaw(observance, 'DTSTART');
		const offsetFrom = definitionOffset(definitionRaw(observance, 'TZOFFSETFROM') ?? '');
		const offsetTo = definitionOffset(definitionRaw(observance, 'TZOFFSETTO') ?? '');
		if (start === undefined || offsetFrom === undefined || offsetTo === undefined) {
			throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
		}
		const dates = [start];
		for (const property of definitionProperties(observance, 'RDATE')) {
			if (property.value.textValues !== null) {
				throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
			}
			dates.push(...property.value.raw.split(','));
		}
		if (new Set(dates).size !== dates.length) {
			throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
		}
		const rules = definitionProperties(observance, 'RRULE');
		if (rules.length > 1 || (rules[0] !== undefined && rules[0].value.textValues !== null)) {
			throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
		}
		if (rules[0] === undefined) everyObservanceRecurs = false;
		if (rules[0] !== undefined) {
			for (const year of new Set(targetYears.flatMap((value) => [value - 1, value, value + 1]))) {
				if (year < Number(start.slice(0, 4)) || year < 1 || year > 9999) continue;
				const occurrence = yearlyDefinitionOccurrence(rules[0].value.raw, start, year);
				if (occurrence === undefined) {
					throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
				}
				if (!dates.includes(occurrence)) dates.push(occurrence);
			}
		}
		for (const date of dates) {
			const localMilliseconds = compactLocalTimestamp(date);
			if (localMilliseconds === undefined) {
				throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
			}
			transitions.push({
				localMilliseconds,
				offsetFromMilliseconds: offsetFrom,
				offsetToMilliseconds: offsetTo,
			});
		}
	}
	transitions.sort((left, right) => left.localMilliseconds - right.localMilliseconds);
	if (
		transitions.some(
			(transition, index) =>
				index > 0 && transition.localMilliseconds === transitions[index - 1]!.localMilliseconds,
		)
	) {
		throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
	}
	if (observances.length > 1 && !everyObservanceRecurs) {
		for (const year of new Set(targetYears)) {
			if (year < 1 || year > 9999) {
				throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
			}
			const yearStart = wallTimestamp({
				year,
				month: 1,
				day: 1,
				hour: 0,
				minute: 0,
				second: 0,
			});
			const nextYearStart = wallTimestamp({
				year: year + 1,
				month: 1,
				day: 1,
				hour: 0,
				minute: 0,
				second: 0,
			});
			if (
				!transitions.some((transition) => transition.localMilliseconds <= yearStart) ||
				!transitions.some((transition) => transition.localMilliseconds >= nextYearStart)
			) {
				throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
			}
		}
	}
	return transitions;
}

function transitionOffsetAtInstant(
	transitions: readonly DefinitionTransition[],
	instant: number,
): number {
	const ordered = transitions
		.map((transition) => ({
			...transition,
			instantMilliseconds: transition.localMilliseconds - transition.offsetFromMilliseconds,
		}))
		.sort((left, right) => left.instantMilliseconds - right.instantMilliseconds);
	let offset = ordered[0]!.offsetFromMilliseconds;
	for (const transition of ordered) {
		if (instant < transition.instantMilliseconds) break;
		offset = transition.offsetToMilliseconds;
	}
	return offset;
}

export function projectInstantInTimeZone(
	instant: Date,
	timeZone: IanaTimeZoneId,
	definition?: ICalendarComponent,
): LocalDateTimeString {
	const timestamp = dateTimestamp(instant);
	if (definition !== undefined) {
		const year = instant.getUTCFullYear();
		const transitions = definitionTransitions(definition, timeZone, [year]);
		if (transitions.length === 0) throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
		const wall = new Date(timestamp + transitionOffsetAtInstant(transitions, timestamp));
		const parts = {
			year: wall.getUTCFullYear(),
			month: wall.getUTCMonth() + 1,
			day: wall.getUTCDate(),
			hour: wall.getUTCHours(),
			minute: wall.getUTCMinutes(),
			second: wall.getUTCSeconds(),
		};
		if (!validParts(parts)) throw new CalDavIanaTimeZoneError('UNREPRESENTABLE_INSTANT');
		return formatLocal(parts);
	}
	return formatLocal(projectedParts(timestamp, timeZone));
}

export function resolveLocalDateTimeInTimeZone(
	localDateTime: string,
	timeZone: IanaTimeZoneId,
	definition?: ICalendarComponent,
): Date {
	const parts = parseLocal(localDateTime);
	const wall = wallTimestamp(parts);
	if (definition !== undefined) {
		const transitions = definitionTransitions(definition, timeZone, [parts.year]);
		if (transitions.length === 0) throw new CalDavIanaTimeZoneError('UNSUPPORTED_DEFINITION');
		const offsets = new Set(
			transitions.flatMap((transition) => [
				transition.offsetFromMilliseconds,
				transition.offsetToMilliseconds,
			]),
		);
		const matching = [...offsets]
			.map((offset) => wall - offset)
			.filter((candidate) => transitionOffsetAtInstant(transitions, candidate) === wall - candidate)
			.sort((left, right) => left - right);
		if (matching[0] !== undefined) return new Date(matching[0]);
		for (const transition of transitions) {
			const gap = transition.offsetToMilliseconds - transition.offsetFromMilliseconds;
			if (
				gap > 0 &&
				wall >= transition.localMilliseconds &&
				wall < transition.localMilliseconds + gap
			) {
				return new Date(wall - transition.offsetFromMilliseconds);
			}
		}
		return invalidInstant();
	}
	const matching: number[] = [];
	for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
		const candidate = wall - offsetMinutes * 60_000;
		if (formatLocal(projectedParts(candidate, timeZone)) === localDateTime)
			matching.push(candidate);
	}
	if (matching.length > 0) return new Date(Math.min(...matching));

	// RFC 5545 resolves a nonexistent wall time with the UTC offset in force before the gap.
	for (let minutesBefore = 1; minutesBefore <= 48 * 60; minutesBefore += 1) {
		const priorWall = wall - minutesBefore * 60_000;
		for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
			const candidate = priorWall - offsetMinutes * 60_000;
			if (wallTimestamp(projectedParts(candidate, timeZone)) === priorWall) {
				return new Date(wall - offsetAt(candidate, timeZone));
			}
		}
	}
	return invalidInstant();
}
