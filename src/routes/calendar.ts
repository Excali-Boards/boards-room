import { getAccessLevel, canManage, canEdit } from '../other/permissions.js';
import { parseZodError, securityUtils } from '../modules/functions.js';
import { getCountryHolidays } from '../modules/holidays.js';
import { json, makeRoute } from '../services/routes.js';
import { countryCodeObject } from '../core/config.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/holidays/:countryCode/:year',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const countryCode = c.req.param('countryCode');
			const year = parseInt(c.req.param('year'));

			const currentYear = new Date().getFullYear();

			if (!countryCode || countryCode.length !== 2) return json(c, 400, { error: 'Invalid country code. Must be 2 letters.' });
			if (!year || year < (currentYear - 5) || year > (currentYear + 5)) return json(c, 400, { error: `Invalid year. Must be between ${currentYear - 5} and ${currentYear + 5}.` });

			const holidays = await getCountryHolidays(countryCode, year).catch(() => null);
			if (!holidays) return json(c, 400, { error: 'Invalid country code or no holidays found for this country.' });

			return json(c, 200, { data: holidays });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/calendar',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const accessLevel = getAccessLevel(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!accessLevel) return json(c, 403, { error: 'You do not have access to this group.' });

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId }, include: { events: { orderBy: { start: 'asc' }, include: { creator: { select: { displayName: true, avatarUrl: true } } } } } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });

			return json(c, 200, {
				data: {
					group: {
						id: DBGroup.groupId,
						name: DBGroup.name,
						index: DBGroup.index,
						calendarCode: DBGroup.calCode,
						accessLevel,
					},
					events: DBGroup.events.map((event) => ({
						id: event.eventId,
						title: event.title,
						color: event.color,
						description: event.description,
						where: event.where,
						start: event.start,
						end: event.end,
						createdAt: event.createdAt,
						updatedAt: event.updatedAt,
						createdBy: event.creator,
					})),
				},
			});
		},
	}),
	makeRoute({
		path: '/groups/:groupId/calendar',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const isValid = eventObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canCreateEvent = canEdit(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!canCreateEvent) return json(c, 403, { error: 'You do not have permission to create events in this group.' });

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });

			const newEvent = await db(manager, 'event', 'create', {
				data: {
					...isValid.data,
					groupId, createdBy: c.var.DBUser.userId,
					eventId: securityUtils.randomString(12),
				},
			});

			if (!newEvent) return json(c, 500, { error: 'Failed to create event.' });

			return json(c, 200, { data: 'Event created successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/calendar',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');

			const isValid = countryCodeObject.partial().safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canUpdateCalendar = canManage(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!canUpdateCalendar) return json(c, 403, { error: 'You do not have permission to update the calendar in this group.' });

			const DBGroup = await db(manager, 'group', 'findUnique', { where: { groupId } });
			if (!DBGroup) return json(c, 404, { error: 'Group not found.' });

			if (!isValid.data.calCode) {
				const updatedGroup = await db(manager, 'group', 'update', { where: { groupId }, data: { calCode: null } });
				if (!updatedGroup) return json(c, 500, { error: 'Failed to update calendar.' });

				return json(c, 200, { data: 'Country code removed successfully.' });
			}

			const holidays = await getCountryHolidays(isValid.data.calCode, new Date().getFullYear()).catch(() => null);
			if (!holidays) return json(c, 400, { error: 'Invalid country code or no holidays found for this country.' });

			const updatedGroup = await db(manager, 'group', 'update', { where: { groupId }, data: { calCode: isValid.data.calCode } });
			if (!updatedGroup) return json(c, 500, { error: 'Failed to update calendar.' });

			return json(c, 200, { data: 'Calendar updated successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/calendar/:eventId',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');
			const eventId = c.req.param('eventId');

			const isValid = eventObject.partial().safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canUpdateEvent = canManage(c.var.DBUser, { type: 'group', data: { groupId } });
			if (!canUpdateEvent) return json(c, 403, { error: 'You do not have permission to update events in this group.' });

			const DBEvent = await db(manager, 'event', 'findUnique', { where: { eventId, groupId } });
			if (!DBEvent) return json(c, 404, { error: 'Event not found.' });

			const isOwner = DBEvent.createdBy === c.var.DBUser.userId;
			if (!canUpdateEvent && !isOwner) return json(c, 403, { error: 'You do not have permission to update this event.' });

			const updatedEvent = await db(manager, 'event', 'update', { where: { eventId, groupId }, data: isValid.data });
			if (!updatedEvent) return json(c, 500, { error: 'Failed to update event.' });

			return json(c, 200, { data: 'Event updated successfully.' });
		},
	}),

	makeRoute({
		path: '/groups/:groupId/calendar/:eventId',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const groupId = c.req.param('groupId');
			const eventId = c.req.param('eventId');

			const canDeleteEvent = canManage(c.var.DBUser, { type: 'group', data: { groupId } });

			const DBEvent = await db(manager, 'event', 'findUnique', { where: { eventId, groupId } });
			if (!DBEvent) return json(c, 404, { error: 'Event not found.' });

			const isOwner = DBEvent.createdBy === c.var.DBUser.userId;
			if (!canDeleteEvent && !isOwner) return json(c, 403, { error: 'You do not have permission to delete this event.' });

			const deletedEvent = await db(manager, 'event', 'delete', { where: { eventId, groupId } });
			if (!deletedEvent) return json(c, 500, { error: 'Failed to delete event.' });

			return json(c, 200, { data: 'Event deleted successfully.' });
		},
	}),
];

// Schemas.
export type EventObject = z.infer<typeof eventObject>;

const eventObject = z.object({
	title: z.string().min(1).max(255),
	start: z.coerce.date(),
	end: z.coerce.date(),
	color: z.string().regex(/^#([0-9a-fA-F]{3}){1,2}$/),
	description: z.string().max(255).optional(),
	where: z.string().max(255).optional(),
});
