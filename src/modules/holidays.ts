import axios, { AxiosError } from 'axios';

export type ClosedStatus = 'Public' | 'Bank' | 'School' | 'Authorities' | 'Optional' | 'Observance';

export type HolidayEvent = {
	date: string;
	localName: string;
	name: string;
	countryCode: string;
	global: boolean;
	counties: string[] | null;
	launchYear: number | null;
	types: ClosedStatus[];
};

export type FormattedHoliday = {
	id: string;
	title: string;
	start: Date;
	end: Date;
	color: string;
	description: string;
	types: ClosedStatus[];
};

const holidayCache = new Map<string, { data: FormattedHoliday[]; expiry: number; }>();

const colorBasedOnType: Record<ClosedStatus, string> = {
	'Public': '#f17f7e',
	'Bank': '#f5d76e',
	'School': '#7fa8f5',
	'Authorities': '#7bcba7',
	'Optional': '#cfa6f2',
	'Observance': '#c0c0c0',
};

export function getColorForHoliday(types: ClosedStatus[]): string {
	if (types.includes('Public')) return colorBasedOnType.Public;
	if (types.includes('Bank')) return colorBasedOnType.Bank;
	if (types.includes('School')) return colorBasedOnType.School;
	if (types.includes('Authorities')) return colorBasedOnType.Authorities;
	if (types.includes('Optional')) return colorBasedOnType.Optional;
	if (types.includes('Observance')) return colorBasedOnType.Observance;
	return '#cfa6f2';
}

export async function getCountryHolidays(countryCode: string, year: number): Promise<FormattedHoliday[]> {
	const cacheKey = `${countryCode}-${year}`;
	const cached = holidayCache.get(cacheKey);

	if (cached && cached.expiry > Date.now()) return cached.data;

	const response = await axios.get(`https://date.nager.at/api/v3/PublicHolidays/${year}/${countryCode.toUpperCase()}`).catch((err: AxiosError) => err.response);
	if (!response || response.status !== 200) throw new Error(`Failed to fetch holidays: ${response?.status}`);

	const holidays: HolidayEvent[] = response.data;

	const formattedHolidays: FormattedHoliday[] = holidays.map((holiday) => {
		const utcDate = new Date(`${holiday.date}T00:00:00Z`);

		return {
			id: `holiday-${holiday.countryCode}-${holiday.date}`,
			title: holiday.localName || holiday.name,
			start: utcDate,
			end: new Date(utcDate.getTime() + 24 * 60 * 60 * 1000 - 1),
			color: getColorForHoliday(holiday.types),
			description: `${holiday.name} (${holiday.countryCode})`,
			types: holiday.types,
		};
	});

	holidayCache.set(cacheKey, {
		data: formattedHolidays,
		expiry: Date.now() + 24 * 60 * 60 * 1000,
	});

	return formattedHolidays;
}
