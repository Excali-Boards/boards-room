import { canView, canManage, getBoardAccessLevel, canEditBoardWithIds } from '../other/permissions.js';
import { parseZodError, securityUtils } from '../modules/functions.js';
import { json, makeRoute } from '../services/routes.js';
import { db } from '../core/prisma.js';
import manager from '../index.js';
import { z } from 'zod';

export default [
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards',
		method: 'GET',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const accessLevel = getBoardAccessLevel(c.var.DBUser, boardId, categoryId, groupId);
			if (!accessLevel) return json(c, 403, { error: 'You do not have access to this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const DBDeck = await db(manager, 'flashcardDeck', 'findFirst', {
				where: { boardId },
				include: {
					board: { select: { boardId: true, name: true } },
					cards: { orderBy: { index: 'asc' } },
					progress: { where: { userId: c.var.DBUser.userId } },
				},
			});

			if (!DBDeck) return json(c, 404, { error: 'Flashcard deck not found for this board.' });

			const progress = DBDeck.progress[0];

			return json(c, 200, {
				data: {
					board: { id: DBBoard.boardId, name: DBBoard.name, accessLevel },
					deck: { id: DBDeck.deckId, createdAt: DBDeck.createdAt, updatedAt: DBDeck.updatedAt },
					cards: DBDeck.cards.map((card) => ({ id: card.cardId, front: card.front, back: card.back, index: card.index, createdAt: card.createdAt, updatedAt: card.updatedAt })),
					progress: progress ? { completed: progress.completed, lastStudied: progress.lastStudied, currentIndex: progress.currentIndex } : null,
				},
			});
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const isValid = cardArray.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canEditBoard = canEditBoardWithIds(c.var.DBUser, boardId, categoryId, groupId);
			if (!canEditBoard) return json(c, 403, { error: 'You do not have permission to add cards to this deck.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const DBDeck = await db(manager, 'flashcardDeck', 'findFirst', { where: { boardId }, include: { cards: { select: { index: true } } } });
			if (!DBDeck) return json(c, 404, { error: 'Flashcard deck not found for this board.' });

			const maxIndex = DBDeck.cards.length ? Math.max(...DBDeck.cards.map((c) => c.index)) : -1;

			const createPromises = isValid.data.map((card, i) =>
				db(manager, 'flashcardCard', 'create', {
					data: {
						cardId: securityUtils.randomString(12),
						deckId: DBDeck.deckId,
						front: securityUtils.sanitizeInput(card.front),
						back: securityUtils.sanitizeInput(card.back),
						index: maxIndex + 1 + i,
					},
					select: { cardId: true },
				}),
			);

			await Promise.all(createPromises);

			return json(c, 200, { data: 'Cards created successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const isValid = cardUpdateArray.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canEditBoard = canEditBoardWithIds(c.var.DBUser, boardId, categoryId, groupId);
			if (!canEditBoard) return json(c, 403, { error: 'You do not have permission to edit cards in this deck.' });

			const DBDeck = await db(manager, 'flashcardDeck', 'findFirst', { where: { boardId }, include: { cards: { select: { cardId: true } } } });
			if (!DBDeck) return json(c, 404, { error: 'Deck not found.' });

			const cardIds = isValid.data.map((c) => c.id);
			const DBCards = await db(manager, 'flashcardCard', 'findMany', { where: { cardId: { in: cardIds }, deckId: DBDeck.deckId } }) || [];
			if (DBCards.length !== cardIds.length) return json(c, 400, { error: 'Some cards do not belong to this deck.' });

			const updatePromises = isValid.data.map((card) =>
				db(manager, 'flashcardCard', 'update', {
					where: { cardId: card.id },
					data: {
						front: card.front ? securityUtils.sanitizeInput(card.front) : undefined,
						back: card.back ? securityUtils.sanitizeInput(card.back) : undefined,
					},
					select: { cardId: true },
				}),
			);

			await Promise.all(updatePromises);

			return json(c, 200, { data: 'Cards updated successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const isValid = z.array(z.string()).safeParse(await c.req.json().catch(() => []));
			if (!isValid.success || !isValid.data.length) return json(c, 400, { error: 'Invalid card IDs.' });

			const canEditBoard = canEditBoardWithIds(c.var.DBUser, boardId, categoryId, groupId);
			if (!canEditBoard) return json(c, 403, { error: 'You do not have permission to delete cards in this deck.' });

			const DBDeck = await db(manager, 'flashcardDeck', 'findFirst', { where: { boardId } });
			if (!DBDeck) return json(c, 404, { error: 'Deck not found.' });

			const DBCards = await db(manager, 'flashcardCard', 'findMany', { where: { cardId: { in: isValid.data }, deckId: DBDeck.deckId } }) || [];
			if (DBCards.length !== isValid.data.length) return json(c, 400, { error: 'Some cards do not belong to this deck.' });

			const deletePromises = isValid.data.map((cardId) =>
				db(manager, 'flashcardCard', 'delete', {
					where: { cardId },
				}),
			);

			await Promise.all(deletePromises);

			return json(c, 200, { data: 'Cards deleted successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards/initialize',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const canEditBoard = canEditBoardWithIds(c.var.DBUser, boardId, categoryId, groupId);
			if (!canEditBoard) return json(c, 403, { error: 'You do not have permission to initialize a flashcard deck for this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId }, select: { boardId: true, flashcardDeck: true } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });
			else if (DBBoard.flashcardDeck) return json(c, 400, { error: 'Flashcard deck already exists for this board.' });

			const newDeck = await db(manager, 'flashcardDeck', 'create', {
				data: {
					deckId: securityUtils.randomString(12),
					boardId,
				},
				select: { deckId: true },
			});

			if (!newDeck) return json(c, 500, { error: 'Failed to initialize flashcard deck.' });

			return json(c, 200, { data: 'Flashcard deck initialized successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards/destroy',
		method: 'POST',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const canManageBoard = canManage(c.var.DBUser, { type: 'board', data: { groupId, categoryId, boardId } });
			if (!canManageBoard) return json(c, 403, { error: 'You do not have permission to destroy the flashcard deck for this board.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId }, select: { boardId: true, flashcardDeck: true } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });
			else if (!DBBoard.flashcardDeck) return json(c, 400, { error: 'Flashcard deck does not exist for this board.' });

			await db(manager, 'flashcardCard', 'deleteMany', { where: { deckId: DBBoard.flashcardDeck.deckId } });
			await db(manager, 'deckProgress', 'deleteMany', { where: { deckId: DBBoard.flashcardDeck.deckId } });
			await db(manager, 'flashcardDeck', 'delete', { where: { deckId: DBBoard.flashcardDeck.deckId } });

			return json(c, 200, { data: 'Flashcard deck destroyed successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards/override',
		method: 'PUT',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const isValid = cardArray.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const canEditBoard = canEditBoardWithIds(c.var.DBUser, boardId, categoryId, groupId);
			if (!canEditBoard) return json(c, 403, { error: 'You do not have permission to override cards in this deck.' });

			const DBBoard = await db(manager, 'board', 'findUnique', { where: { boardId } });
			if (!DBBoard) return json(c, 404, { error: 'Board not found.' });

			const DBDeck = await db(manager, 'flashcardDeck', 'findFirst', { where: { boardId }, include: { cards: true } });
			if (!DBDeck) return json(c, 404, { error: 'Deck not found.' });

			if (DBDeck.cards.length > 0) await db(manager, 'flashcardCard', 'deleteMany', { where: { deckId: DBDeck.deckId } });

			const createPromises = isValid.data.map((card, i) =>
				db(manager, 'flashcardCard', 'create', {
					data: {
						cardId: securityUtils.randomString(12),
						deckId: DBDeck.deckId,
						front: securityUtils.sanitizeInput(card.front),
						back: securityUtils.sanitizeInput(card.back),
						index: i,
					},
					select: { cardId: true },
				}),
			);

			await Promise.all(createPromises);

			await db(manager, 'deckProgress', 'deleteMany', { where: { deckId: DBDeck.deckId } });

			return json(c, 200, { data: 'Cards overridden successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards/progress',
		method: 'PATCH',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const isValid = progressObject.safeParse(await c.req.json().catch(() => ({})));
			if (!isValid.success) return json(c, 400, { error: parseZodError(isValid.error) });

			const hasAccess = canView(c.var.DBUser, { type: 'board', data: { groupId, categoryId, boardId } });
			if (!hasAccess) return json(c, 403, { error: 'You do not have access to this board.' });

			const DBDeck = await db(manager, 'flashcardDeck', 'findFirst', { where: { boardId }, include: { cards: true } });
			if (!DBDeck) return json(c, 404, { error: 'Deck not found.' });

			if (isValid.data.currentIndex < 0 || isValid.data.currentIndex >= DBDeck.cards.length) return json(c, 400, { error: 'Invalid card index.' });

			const updatedProgress = await db(manager, 'deckProgress', 'upsert', {
				where: { deckId_userId: { deckId: DBDeck.deckId, userId: c.var.DBUser.userId } },
				update: { currentIndex: isValid.data.currentIndex, completed: isValid.data.completed ?? false, lastStudied: new Date() },
				create: { deckId: DBDeck.deckId, userId: c.var.DBUser.userId, currentIndex: isValid.data.currentIndex, completed: isValid.data.completed ?? false, lastStudied: new Date() },
			});

			if (!updatedProgress) return json(c, 500, { error: 'Failed to update progress.' });

			return json(c, 200, { data: 'Progress updated successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards/progress',
		method: 'DELETE',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const hasAccess = canView(c.var.DBUser, { type: 'board', data: { groupId, categoryId, boardId } });
			if (!hasAccess) return json(c, 403, { error: 'You do not have access to this board.' });

			const DBDeck = await db(manager, 'flashcardDeck', 'findFirst', { where: { boardId } });
			if (!DBDeck) return json(c, 404, { error: 'Deck not found.' });

			await db(manager, 'deckProgress', 'delete', { where: { deckId_userId: { deckId: DBDeck.deckId, userId: c.var.DBUser.userId } } });

			return json(c, 200, { data: 'Progress reset successfully.' });
		},
	}),
	makeRoute({
		path: '/groups/:groupId/categories/:categoryId/boards/:boardId/flashcards/reorder',
		method: 'PUT',
		enabled: true,
		auth: true,

		handler: async (c) => {
			const { groupId, categoryId, boardId } = c.req.param();

			const isValid = z.array(z.string()).safeParse(await c.req.json().catch(() => []));
			if (!isValid.success || !isValid.data.length) return json(c, 400, { error: 'Invalid card order.' });

			const canEditBoard = canEditBoardWithIds(c.var.DBUser, boardId, categoryId, groupId);
			if (!canEditBoard) return json(c, 403, { error: 'You do not have permission to reorder cards in this deck.' });

			const DBDeck = await db(manager, 'flashcardDeck', 'findFirst', { where: { boardId } });
			if (!DBDeck) return json(c, 404, { error: 'Deck not found.' });

			const cards = await db(manager, 'flashcardCard', 'findMany', { where: { deckId: DBDeck.deckId, cardId: { in: isValid.data } } }) || [];
			if (cards.length !== isValid.data.length) return json(c, 400, { error: 'Some cards do not belong to this deck.' });

			const updatePromises = isValid.data.map((cardId, index) =>
				db(manager, 'flashcardCard', 'update', {
					where: { cardId },
					data: { index },
					select: { cardId: true },
				}),
			);

			await Promise.all(updatePromises);

			return json(c, 200, { data: 'Cards reordered successfully.' });
		},
	}),
];

// Schemas.
export type CardObject = z.infer<typeof cardObject>;
export type ProgressObject = z.infer<typeof progressObject>;

const cardObject = z.object({
	front: z.string().min(1).max(1000),
	back: z.string().min(1).max(1000),
});

const cardArray = z.array(cardObject);

const cardUpdateObject = z.object({
	id: z.string(),
	front: z.string().min(1).max(1000).optional(),
	back: z.string().min(1).max(1000).optional(),
});

const cardUpdateArray = z.array(cardUpdateObject);

const progressObject = z.object({
	currentIndex: z.number().int().min(0),
	completed: z.boolean().optional(),
});
